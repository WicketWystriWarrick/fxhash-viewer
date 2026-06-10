/**
 * EVM (Base/Ethereum) project extraction via fxhash's v2 indexer GraphQL.
 *
 * The public api.fxhash.xyz GraphQL is Tezos-only; fxhash's multichain (EVM)
 * data lives in a separate Hasura indexer at api.v2.fxhash.xyz. Querying the
 * `objkt` table by `issuer_id` (the project contract) returns every iteration
 * with its authoritative iteration number, generation_hash (fxhash), minter and
 * owner — no per-token RPC calls (public Base RPCs rate-limit hard, so scraping
 * tokenURI/ownerOf for thousands of tokens fails in bursts).
 *
 * Output matches extract-project.mjs / extract-tezos-graphql.mjs so the viewer
 * and gallery load it identically.
 *
 * Usage: node scripts/extract-evm-graphql.mjs <0x-contract> [nameOverride]
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "..", "public", "projects");
const GRAPHQL = "https://api.v2.fxhash.xyz/v1/graphql";
const PAGE = 500;

// The indexer keeps a row per objkt across its whole life, including states that
// no longer exist on-chain. For evolving/fx(params) projects that means many
// stale rows: LIQUIDATED (burned) and REGENERATED (superseded by a newer
// iteration). The currently-existing tokens are ACTIVE + EVOLVED + LOCKED —
// summing exactly to the contract's totalSupply (verified on Traces & Inner
// Forms). Simple projects are all ACTIVE, so this filter is a no-op for them.
const LIVE_STATES = ["ACTIVE", "EVOLVED", "LOCKED"];
const STATE_FILTER = `state:{_in:${JSON.stringify(LIVE_STATES)}}`;

async function gql(query, { tries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(GRAPHQL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (r.status === 429) throw new Error("rate limited (429)");
      const j = await r.json();
      if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
      return j.data;
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Mirror the extractors' filename rule. */
export function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

function objktToIteration(o, generativeUri, projectName) {
  const iteration = Number(o.iteration ?? 0);
  const fxhash = o.generation_hash || "";
  const minter = o.minter_id || "";
  const owner = o.owner_id || "";
  // Params-based projects carry their input in `input_bytes`; hash-only ones
  // leave it null. The viewer maps fxparams → fxhash's `inputBytes` param.
  const fxparams = o.input_bytes || "";
  const uri = generativeUri || "";
  // fxhash EVM token ids are 1-indexed and equal the iteration number.
  return {
    tokenId: iteration,
    name: o.name || `${projectName} #${iteration}`,
    iteration,
    fxhash,
    minter,
    fxparams,
    owner,
    thumbnailUri: o.thumbnail_uri || "",
    generativeUri: uri,
    viewerParams: { uri, fxhash, iteration, minter, fxparams },
  };
}

const OBJKT_FIELDS =
  "iteration generation_hash thumbnail_uri input_bytes name minter_id owner_id";

/**
 * Extract an EVM project by contract address and write its project JSON.
 * @param {string} contract  0x project contract (objkt.issuer_id)
 * @param {{nameOverride?: string, onProgress?: Function}} opts
 * @returns {Promise<{name:string, filename:string, count:number, expected:number, chain:string}>}
 */
export async function extractEvmByGraphQL(contract, { nameOverride, onProgress } = {}) {
  const c = JSON.stringify(contract);
  const objWhere = `where:{issuer_id:{_eq:${c}}, ${STATE_FILTER}}`;
  const head = await gql(`{ onchain {
    generative_token(where:{id:{_eq:${c}}}){ id name slug chain metadata wallet_account { username } author { name } }
    objkt_aggregate(${objWhere}){ aggregate { count } }
  } }`);
  const p = head.onchain.generative_token?.[0];
  if (!p) throw new Error(`project not found on fxhash v2 indexer for ${contract}`);

  const meta = p.metadata || {};
  const artist = p.wallet_account?.username || p.author?.name || "";
  const generativeUri = meta.generativeUri || meta.artifactUri?.split("?")[0] || "";
  // Prefer the indexer's top-level `chain` column — it's always set, whereas
  // metadata.chain is absent on some projects (e.g. Yuragi). Getting this wrong
  // breaks onchfs resolution (onchfs is deployed per-chain).
  const chain = (p.chain || meta.chain || "base").toLowerCase();
  const projectName = nameOverride || p.name || contract;
  const total = head.onchain.objkt_aggregate?.aggregate?.count || 0;

  const objkts = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const d = await gql(`{ onchain {
      objkt(${objWhere}, order_by:{iteration:asc}, limit:${PAGE}, offset:${offset}){ ${OBJKT_FIELDS} }
    } }`);
    const batch = d.onchain.objkt || [];
    objkts.push(...batch);
    if (onProgress) onProgress(objkts.length, total);
    if (batch.length < PAGE) break;
    await new Promise((res) => setTimeout(res, 150));
  }

  const iterations = objkts
    .map((o) => objktToIteration(o, generativeUri, projectName))
    .sort((a, b) => a.iteration - b.iteration);

  const output = {
    project: {
      name: projectName,
      artist,
      artists: artist ? [artist] : [],
      contract,
      chain,
      generativeUri,
      totalSupply: iterations.length,
      extractedAt: new Date().toISOString(),
      source: "fxhash-v2-graphql",
    },
    iterations,
  };

  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
  const filename = `${safeName(projectName)}.json`;
  writeFileSync(join(PROJECTS_DIR, filename), JSON.stringify(output, null, 2));
  writeIndex(PROJECTS_DIR);

  return { name: projectName, filename, count: iterations.length, expected: total, chain };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const contract = process.argv[2];
  const nameOverride = process.argv[3];
  if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    console.error("Usage: node scripts/extract-evm-graphql.mjs <0x-contract> [nameOverride]");
    process.exit(1);
  }
  extractEvmByGraphQL(contract, {
    nameOverride,
    onProgress: (got, total) => process.stdout.write(`\r  fetched ${got}/${total} iteration(s)…`),
  })
    .then((r) => {
      process.stdout.write("\n");
      console.log(`Saved ${r.count} iteration(s) to public/projects/${r.filename} (chain: ${r.chain})`);
      if (r.count !== r.expected) console.log(`  (note: fetched ${r.count} of ${r.expected} reported)`);
    })
    .catch((err) => {
      console.error("\nFatal:", err.message);
      process.exit(1);
    });
}
