#!/usr/bin/env node
/**
 * extract-project.mjs
 *
 * Extracts all iteration data for a fxhash project, producing a JSON file
 * that the onchfs-viewer can use to load any iteration without fxhash.
 *
 * Usage:
 *   node extract-project.mjs <metadata-file.json>
 *   node extract-project.mjs <contract-address> [ethereum|base]
 *
 * Mode 1 (from metadata file):
 *   Provide a JSON file containing the project metadata (as seen on fxhash).
 *   The script extracts the contract address and generativeUri automatically.
 *
 * Mode 2 (from contract address):
 *   Provide the contract address directly. The generativeUri will be read
 *   from the first token's metadata.
 *
 * Output:
 *   A file named `project-<name>.json` in the current directory, containing
 *   an array of iteration records, each with the URI, fxhash, iteration,
 *   and minter needed to view it in the onchfs-viewer.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./scripts/build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "public", "projects");

// drpc's free tier times out under load; default Base to the official public
// RPC and allow per-chain overrides via env (BASE_RPC / ETH_RPC).
const RPCS = {
  ethereum: process.env.ETH_RPC || "https://eth.drpc.org",
  base: process.env.BASE_RPC || "https://mainnet.base.org",
};

// --- ABI selectors ---
const SEL_TOTAL_SUPPLY = "0x18160ddd";   // totalSupply()
const SEL_TOKEN_URI    = "0xc87b56dd";   // tokenURI(uint256)
const SEL_NAME         = "0x06fdde03";   // name()
const SEL_OWNER_OF     = "0x6352211e";   // ownerOf(uint256)

// --- Helpers ---
async function rpc(chain, method, params) {
  const r = await fetch(RPCS[chain], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

function ethCall(chain, to, data) {
  return rpc(chain, "eth_call", [{ to, data }, "latest"]);
}

function encodeUint256(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

function decodeString(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 128) return "";
  const offset = parseInt(h.slice(0, 64), 16) * 2;
  const length = parseInt(h.slice(offset, offset + 64), 16);
  const bytes = h.slice(offset + 64, offset + 64 + length * 2);
  const arr = new Uint8Array(bytes.match(/.{2}/g).map(b => parseInt(b, 16)));
  return new TextDecoder().decode(arr);
}

function decodeUint256(hex) {
  return parseInt(hex, 16);
}

/**
 * Convert any URI scheme to an HTTP-fetchable URL.
 * ipfs:// → public gateway, onchfs:// → fxhash proxy, https:// → as-is.
 */
// ipfs.io aggressively rate-limits bursts (whole batches fail); fxhash's own
// gateway serves the pinned project metadata fast. Override with IPFS_GW.
const IPFS_GW = (process.env.IPFS_GW || "https://gateway.fxhash2.xyz").replace(/\/$/, "");
function toFetchUrl(uri) {
  if (uri.startsWith("ipfs://")) {
    return `${IPFS_GW}/ipfs/` + uri.slice("ipfs://".length);
  }
  if (uri.startsWith("onchfs://")) {
    return "https://onchfs.fxhash2.xyz/" + uri.slice("onchfs://".length);
  }
  return uri;
}

/** Fetch + parse JSON with a few retries — the metadata host rate-limits in bursts. */
async function fetchJsonWithRetry(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// --- Main ---
async function main() {
  // `--resume`: keep an existing public/projects/<Name>.json and only fetch the
  // tokenIds it's missing (recovers rate-limit failures without redoing everything).
  const resume = process.argv.includes("--resume");
  if (resume) process.argv = process.argv.filter((a) => a !== "--resume");
  let contractAddress, chain, generativeUri, projectName;

  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage:");
    console.error("  node extract-project.mjs <metadata-file.json>");
    console.error("  node extract-project.mjs <contract-address> [ethereum|base]");
    process.exit(1);
  }

  // Detect mode: file or address
  if (arg.endsWith(".json")) {
    // Mode 1: from metadata file
    console.log(`Reading metadata from ${arg}...`);
    const raw = JSON.parse(readFileSync(arg, "utf8"));
    generativeUri = raw.generativeUri || raw.generatorUri || "";
    projectName = raw.name || raw.symbol || "unknown";

    // Auto-detect chain from metadata
    // Priority: metadata.chain field > artifactUri fxchain param > CLI arg > default
    const artifactUri = raw.artifactUri || "";
    const fxchainMatch = artifactUri.match(/[?&]fxchain=(\w+)/i);
    const metaChain = raw.chain?.toLowerCase() || fxchainMatch?.[1]?.toLowerCase() || "";
    chain = metaChain || process.argv[3] || "ethereum";
    console.log(`Chain: ${chain} (${metaChain ? "from metadata" : "default/CLI"})`);

    // Extract contract address — try multiple sources
    const extLink = raw.external_link || raw.external_url || "";
    const extUrl = raw.animation_url || "";
    const allText = extLink + " " + extUrl;
    const addrMatch = allText.match(/(0x[0-9a-fA-F]{40})/);

    if (addrMatch) {
      contractAddress = addrMatch[1];
    } else if (process.argv[3] && process.argv[3].startsWith("0x")) {
      // User provided contract as second arg
      contractAddress = process.argv[3];
      chain = process.argv[4] || chain;
    } else {
      console.error("\nCould not find contract address in metadata.");
      console.error("This project's metadata doesn't include an external_link with the contract.");
      console.error("\nPlease provide the contract address manually:");
      console.error(`  node extract-project.mjs ${arg} <0x-contract-address> [chain]`);
      console.error("\nTo find the contract address:");
      console.error("  1. Open the project on fxhash.xyz");
      console.error("  2. Look at the URL or project details for the 0x... address");
      console.error("  3. Or check the blockchain explorer (Etherscan/Basescan)");
      process.exit(1);
    }
  } else if (arg.startsWith("0x") && arg.length === 42) {
    // Mode 2: from contract address
    contractAddress = arg;
    chain = process.argv[3] || "ethereum";
  } else {
    console.error("First argument must be a .json file or a 0x contract address.");
    process.exit(1);
  }

  console.log(`\nProject: ${projectName || "(will read from contract)"}`);
  console.log(`Contract: ${contractAddress}`);
  console.log(`Chain: ${chain}`);
  console.log(`Generative URI: ${generativeUri || "(will read from first token)"}`);

  // Get project name from contract if not known
  if (!projectName) {
    try {
      const nameResult = await ethCall(chain, contractAddress, SEL_NAME);
      projectName = decodeString(nameResult) || "unknown";
      console.log(`Project name (from contract): ${projectName}`);
    } catch {
      projectName = "unknown";
    }
  }

  // Get total supply
  console.log("\nFetching total supply...");
  const supplyHex = await ethCall(chain, contractAddress, SEL_TOTAL_SUPPLY);
  const totalSupply = decodeUint256(supplyHex);
  console.log(`Total supply: ${totalSupply} iterations`);

  if (totalSupply === 0) {
    console.log("No iterations found.");
    process.exit(0);
  }

  // For each token, fetch tokenURI → metadata
  console.log(`\nFetching metadata for ${totalSupply} iteration(s)...`);
  console.log("(This calls fxhash's metadata server. Run while fxhash is online.)\n");

  // Resume: load what we already have and skip those tokenIds.
  let existing = [];
  const present = new Set();
  if (resume) {
    const safeName0 = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const existingPath = join(PROJECTS_DIR, `${safeName0}.json`);
    if (existsSync(existingPath)) {
      try {
        existing = JSON.parse(readFileSync(existingPath, "utf8")).iterations || [];
        for (const it of existing) present.add(it.tokenId);
        if (!generativeUri && existing[0]?.generativeUri) generativeUri = existing[0].generativeUri;
        console.log(`Resume: ${present.size} already extracted; fetching the missing ${totalSupply - present.size}.`);
      } catch { /* fall back to a full run */ }
    }
  }

  const iterations = [];
  let failures = 0;

  // Scan 0..totalSupply inclusive: fxhash collections are 1-indexed (token 0
  // reverts), so the real range is 1..totalSupply. The one out-of-range probe
  // (token 0 here, or `totalSupply` for a 0-indexed contract) just fails harmlessly.
  for (let tokenId = 0; tokenId <= totalSupply; tokenId++) {
    if (resume && present.has(tokenId)) continue;
    // Show progress
    if (tokenId % 10 === 0 || tokenId === totalSupply - 1) {
      process.stdout.write(`  [${tokenId + 1}/${totalSupply}]\r`);
    }

    try {
      // Get tokenURI
      const uriHex = await ethCall(chain, contractAddress, SEL_TOKEN_URI + encodeUint256(tokenId));
      const tokenUri = decodeString(uriHex);

      if (!tokenUri) {
        failures++;
        continue;
      }

      // Fetch the metadata JSON from the URI (with retries for rate-limit bursts)
      let metadata;
      try {
        metadata = await fetchJsonWithRetry(toFetchUrl(tokenUri));
      } catch (err) {
        failures++;
        continue;
      }

      // Extract the key fields
      const artifactUri = metadata.artifactUri || metadata.animation_url || "";
      const iterationHash = metadata.iterationHash || metadata.generationHash || "";
      const thumbnailUri = metadata.thumbnailUri || metadata.displayUri || metadata.image || "";

      // Parse fxhash params from artifactUri query string
      let fxhash = iterationHash;
      let iteration = metadata.iteration || tokenId;
      let minter = "";

      const qsMatch = artifactUri.match(/\?(.+)$/);
      if (qsMatch) {
        const params = new URLSearchParams(qsMatch[1]);
        fxhash = fxhash || params.get("fxhash") || "";
        iteration = iteration || parseInt(params.get("fxiteration") || "0");
        minter = params.get("fxminter") || "";
      }

      // Get current owner
      let owner = "";
      try {
        const ownerHex = await ethCall(chain, contractAddress, SEL_OWNER_OF + encodeUint256(tokenId));
        owner = "0x" + ownerHex.slice(-40);
      } catch { /* skip */ }

      // If we don't have generativeUri yet, extract from the first successful token
      if (!generativeUri && artifactUri) {
        const baseUri = artifactUri.split("?")[0];
        generativeUri = baseUri;
        console.log(`\nGenerative URI (from token ${tokenId}): ${generativeUri}`);
      }

      iterations.push({
        tokenId,
        name: metadata.name || `${projectName} #${iteration}`,
        iteration,
        fxhash,
        minter,
        owner,
        thumbnailUri,
        generativeUri: generativeUri || "",
        // Pre-formatted for direct paste into the viewer
        viewerParams: {
          uri: generativeUri || "",
          fxhash,
          iteration,
          minter,
        },
      });
    } catch (err) {
      failures++;
    }

    // Small delay to avoid rate limiting
    if (tokenId % 5 === 4) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Merge with any resumed iterations and order by tokenId.
  const allIterations = (resume ? [...existing, ...iterations] : iterations)
    .sort((a, b) => a.tokenId - b.tokenId);
  console.log(
    `\n\nExtracted ${iterations.length} new iteration(s), ${failures} failure(s); ${allIterations.length} total.`,
  );

  // Write output
  const output = {
    project: {
      name: projectName,
      contract: contractAddress,
      chain,
      generativeUri,
      totalSupply,
      extractedAt: new Date().toISOString(),
    },
    iterations: allIterations,
  };

  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const filename = `${safeName}.json`;
  const filepath = join(PROJECTS_DIR, filename);

  // Ensure output directory exists
  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });

  writeFileSync(filepath, JSON.stringify(output, null, 2));
  console.log(`\nSaved to public/projects/${filename}`);

  // Update the project index so the viewer UI can list available projects
  updateIndex();

  console.log(`\nExample — to view iteration ${iterations[0]?.iteration ?? 0} in the viewer:`);
  console.log(`  URI:       ${iterations[0]?.viewerParams.uri}`);
  console.log(`  fxhash:    ${iterations[0]?.viewerParams.fxhash}`);
  console.log(`  Iteration: ${iterations[0]?.viewerParams.iteration}`);
  console.log(`  Minter:    ${iterations[0]?.viewerParams.minter}`);
  console.log(`\nIn the viewer: select "By File" mode → your project appears in the list.`);
}

/**
 * Scan public/projects/ and write _index.json listing all available project files.
 * The viewer UI reads this to show a list of saved projects.
 */
function updateIndex() {
  const n = writeIndex(PROJECTS_DIR);
  console.log(`Updated project index: ${n} project(s) available.`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
