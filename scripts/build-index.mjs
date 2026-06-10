/**
 * Single source of truth for the gallery's project index.
 *
 * Scans public/projects/ and (re)writes _index.json — the lightweight list the
 * gallery UI loads to render the collection grid. Each entry's representative
 * thumbnail is the FIRST iteration's thumbnailUri, so editing a project JSON
 * and regenerating the index keeps the grid in sync with the file.
 *
 * Used by:
 *   - the Vite dev plugin (auto-regen on JSON edit, see vite.config.ts)
 *   - the extract scripts (extract-tezos.mjs / extract-project.mjs)
 *   - `npm run index` (manual / CI)
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default location of the saved project JSONs. */
export const PROJECTS_DIR = join(__dirname, "..", "public", "projects");

/** True for a project JSON we should index (skips _index.json, .bak, etc.). */
function isProjectFile(filename) {
  return filename.endsWith(".json") && !filename.startsWith("_");
}

/** Build the index array from the JSON files in `dir` (no write). */
export function buildIndex(dir = PROJECTS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isProjectFile)
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
        // Artists: prefer the canonical array; fall back to the legacy single
        // `artist` string. `artist` stays as a joined display string so older
        // readers keep working.
        const artists = Array.isArray(data.project?.artists)
          ? data.project.artists.filter(Boolean)
          : data.project?.artist
            ? [data.project.artist]
            : [];
        return {
          filename: f,
          name: data.project?.name || f.replace(".json", ""),
          artist: artists.join(" & "),
          artists,
          chain: data.project?.chain || "unknown",
          count: data.iterations?.length || 0,
          // Representative thumbnail for the whole project (first iteration),
          // used by the gallery UI's collection grid.
          thumbnail: data.iterations?.[0]?.thumbnailUri || "",
        };
      } catch {
        return { filename: f, name: f.replace(".json", ""), chain: "unknown", count: 0, thumbnail: "" };
      }
    });
}

/** Regenerate _index.json in `dir`. Returns the number of projects indexed. */
export function writeIndex(dir = PROJECTS_DIR) {
  if (!existsSync(dir)) return 0;
  const index = buildIndex(dir);
  writeFileSync(join(dir, "_index.json"), JSON.stringify(index, null, 2));
  return index.length;
}

// Run directly (`node scripts/build-index.mjs`) → regenerate and report.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const n = writeIndex();
  console.log(`Updated project index: ${n} project(s) available.`);
}
