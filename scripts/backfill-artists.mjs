/**
 * Backfill `project.artist` into every public/projects/*.json.
 *
 * Artist names aren't on the contract, so we read them from fxhash:
 *   - Tezos: api.fxhash.xyz `objkt(id:<firstTokenId>){ issuer{ author{ name } } }`
 *     (the v3 gentk contract is shared, so we resolve via an actual token).
 *   - EVM:   api.v2.fxhash.xyz `generative_token(id:<contract>)` →
 *     `wallet_account.username` (best), falling back to `author.name`.
 *
 * Idempotent: re-running just refreshes the field. Rebuilds _index.json after.
 *
 * Usage: node scripts/backfill-artists.mjs [--force]
 *   By default, projects that already have a non-empty artist are skipped.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "..", "public", "projects");
const TZ_GQL = "https://api.fxhash.xyz/graphql";
const EVM_GQL = "https://api.v2.fxhash.xyz/v1/graphql";
const force = process.argv.includes("--force");

async function gql(url, query, { tries = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (r.status === 429) throw new Error("429");
      const j = await r.json();
      if (j.errors) throw new Error(j.errors.map((e) => e.message).join("; "));
      return j.data;
    } catch (err) {
      lastErr = err;
      await new Promise((res) => setTimeout(res, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function tezosArtist(firstTokenId) {
  // objkt(id:) is a numeric ObjktId scalar — must be an unquoted number.
  if (firstTokenId == null || !Number.isFinite(Number(firstTokenId))) return "";
  const d = await gql(TZ_GQL, `{ objkt(id:${Number(firstTokenId)}){ issuer { author { name } } } }`)
    .catch(() => null);
  return d?.objkt?.issuer?.author?.name || "";
}

async function evmArtist(contract) {
  if (!contract) return "";
  const d = await gql(
    EVM_GQL,
    `{ onchain { generative_token(where:{id:{_eq:${JSON.stringify(contract)}}}){ wallet_account { username } author { name } } } }`,
  ).catch(() => null);
  const g = d?.onchain?.generative_token?.[0];
  return g?.wallet_account?.username || g?.author?.name || "";
}

async function main() {
  const files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  let updated = 0, missing = [];
  for (const f of files) {
    const path = join(PROJECTS_DIR, f);
    let data;
    try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    if (!data.project) continue;
    if (data.project.artist && !force) continue;

    const chain = (data.project.chain || "").toLowerCase();
    let artist = "";
    try {
      if (chain === "tezos") artist = await tezosArtist(data.project.contract && data.iterations?.[0]?.tokenId);
      else artist = await evmArtist(data.project.contract);
    } catch { /* leave empty */ }

    data.project.artist = artist;
    writeFileSync(path, JSON.stringify(data, null, 2));
    if (artist) { updated++; console.log(`✓ ${data.project.name.padEnd(34)} → ${artist}`); }
    else { missing.push(data.project.name); console.log(`✗ ${data.project.name.padEnd(34)} → (none)`); }
    // Light pacing to stay under fxhash's rate limits.
    await new Promise((r) => setTimeout(r, 250));
  }
  writeIndex(PROJECTS_DIR);
  console.log(`\nDone. ${updated} named, ${missing.length} without a name.`);
  if (missing.length) console.log("No name:", missing.join(", "));
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
