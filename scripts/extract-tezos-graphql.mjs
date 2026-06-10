/**
 * Tezos project extraction via fxhash's GraphQL `objkts` — project-scoped and
 * exact, unlike a TzKT search by generativeUri CID (which over-collects when a
 * generative-code CID is reused across editions/drops; see De/FragV3, Loom).
 *
 * `generativeToken(slug|id){ objkts }` returns precisely the iterations that
 * belong to that one project (objktsCount == on-chain supply), each with its
 * authoritative iteration number, generationHash (fxhash), minter and owner.
 *
 * Output matches the shape produced by extract-tezos.mjs / extract-project.mjs
 * so the viewer and gallery load it identically.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "..", "public", "projects");
const GRAPHQL = "https://api.fxhash.xyz/graphql";
const PAGE = 50; // fxhash caps objkts(take) at 50.

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
  const iteration = o.iteration ?? 0;
  const fxhash = o.generationHash || "";
  const minter = o.minter?.id || "";
  const owner = o.owner?.id || "";
  // Params-based projects carry their input in `inputBytes`; hash-only ones
  // leave it empty. The viewer maps fxparams → fxhash's `inputBytes` param.
  const fxparams = o.inputBytes || "";
  const uri = generativeUri || "";
  return {
    tokenId: o.onChainId ?? 0,
    name: o.name || `${projectName} #${iteration}`,
    iteration,
    fxhash,
    minter,
    fxparams,
    owner,
    thumbnailUri: o.thumbnailUri || "",
    generativeUri: uri,
    viewerParams: { uri, fxhash, iteration, minter, fxparams },
  };
}

const OBJKT_FIELDS =
  "onChainId iteration generationHash thumbnailUri inputBytes name minter{id} owner{id}";

/**
 * Extract a Tezos project by slug or numeric id and write its project JSON.
 * @param {{slug?: string, id?: number}} target
 * @returns {Promise<{name:string, filename:string, count:number, expected:number}>}
 */
export async function extractTezosByGraphQL(target, { onProgress } = {}) {
  const sel = target.slug != null ? `slug:${JSON.stringify(target.slug)}` : `id:${target.id}`;

  const head = await gql(
    `{ generativeToken(${sel}){ name slug gentkContractAddress generativeUri objktsCount author{ name } } }`,
  );
  const p = head.generativeToken;
  if (!p) throw new Error("project not found on fxhash GraphQL");

  const total = p.objktsCount || 0;
  const objkts = [];
  for (let skip = 0; skip < total; skip += PAGE) {
    const d = await gql(
      `{ generativeToken(${sel}){ objkts(take:${PAGE}, skip:${skip}){ ${OBJKT_FIELDS} } } }`,
    );
    const batch = d.generativeToken?.objkts || [];
    objkts.push(...batch);
    if (onProgress) onProgress(objkts.length, total);
    if (batch.length < PAGE) break;
    await new Promise((res) => setTimeout(res, 150));
  }

  const iterations = objkts
    .map((o) => objktToIteration(o, p.generativeUri, p.name))
    .sort((a, b) => a.iteration - b.iteration);

  const output = {
    project: {
      name: p.name,
      artist: p.author?.name || "",
      artists: p.author?.name ? [p.author.name] : [],
      contract: p.gentkContractAddress || "unknown",
      chain: "tezos",
      generativeUri: p.generativeUri || "",
      totalSupply: iterations.length,
      extractedAt: new Date().toISOString(),
      source: "fxhash-graphql",
    },
    iterations,
  };

  if (!existsSync(PROJECTS_DIR)) mkdirSync(PROJECTS_DIR, { recursive: true });
  const filename = `${safeName(p.name)}.json`;
  writeFileSync(join(PROJECTS_DIR, filename), JSON.stringify(output, null, 2));
  writeIndex(PROJECTS_DIR);

  return { name: p.name, filename, count: iterations.length, expected: total };
}
