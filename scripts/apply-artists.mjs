/**
 * Normalize every project JSON to the canonical `project.artists` (string[])
 * and apply manual artist overrides for projects fxhash couldn't resolve
 * automatically (collab contracts, unset EVM usernames).
 *
 * - artists[] is the source of truth (one filterable chip each in the gallery).
 * - artist (string) is kept as a joined "A & B" display string for back-compat.
 *
 * Idempotent. Rebuilds _index.json after. Run: node scripts/apply-artists.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIndex } from "./build-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(__dirname, "..", "public", "projects");

// Manual artist names/corrections, keyed by exact project.name. Collabs list
// every member. This map is the source of truth for names fxhash got wrong or
// couldn't resolve; re-running normalizes everything to it.
const OVERRIDES = {
  // — originally-unresolved (collab contracts / unset EVM usernames) —
  "DOM2": ["Leander Herzog"],
  "Genomes": ["Ciphrd"],
  "INTUIT": ["Olga Fradina"],
  "Acequia": ["Rich Poole", "ThePaperCrane"],
  "Gerhard": ["Leander Herzog"],
  "Holons": ["flight 404"],
  "Reconnaissance": ["Nat Sarkissian"],
  "Richter": ["Leander Herzog"],
  "Toccata": ["Marcelo Soria-Rodriguez", "Andreas Rau"],
  "a fortiori": ["Thomas Noya"],
  "horizon(te)s": ["IskraVelitchkova", "zachlieberman"],
  "(kinder)Garden, Monuments": ["zancan", "Yazid"],
  // — corrections to wrong auto-resolved names —
  "Biomechanika": ["nekropunk"],
  "Bistable Perception": ["Landlines Art"],
  "Charcoal Seeds": ["zancan"],
  "Device 1": ["Andreas Gysin"],
  "Towers": ["Andreas Gysin"],
  "Smooth Steps": ["Andreas Gysin"],
  "DOM1": ["Leander Herzog"], // typo "Herzorg" → unified to "Herzog"
  "Dragons": ["William Mapan"],
  "el inefable momento": ["Marcelo Soria-Rodriguez"],
  "contrapuntos": ["Marcelo Soria-Rodriguez"],
  "hollow": ["Jacek Markusiewicz"],
  "Elektrobotanika": ["nekropunk"],
  "reŠerosvit": ["nekropunk"],
  "Elevation": ["Andreas Rau"],
  "Loom": ["Andreas Rau"],
  "adrift": ["Jacek Markusiewicz"],
  "Proxima": ["Jacek Markusiewicz"],
  "Emotional Shell": ["William Watkins"],
  "let me fall": ["Eric Andwer"],
  "Rückkopplung": ["pxlshrd"],
  "Turner Light": ["Aluan Wang"],
  "Collage": ["Aluan Wang", "Jinyao Lin", "YI-WEN LIN"],
  "Entangled": ["Bjørn Staal"],
  "Self, Ego": ["Ty Vek"], // typo "Ty Ver" → unified to "Ty Vek"
  "Self, Id": ["Ty Vek"],
  "Self, Superego": ["Ty Vek"],
};

// Project display-name fixes, keyed by exact current project.name.
const NAME_FIXES = {
  '"unfinished"': "unfinished",
};

const files = readdirSync(PROJECTS_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
let applied = 0, normalized = 0, stillEmpty = [];
for (const f of files) {
  const path = join(PROJECTS_DIR, f);
  let data;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  if (!data.project) continue;

  // Display-name fix (do before artist lookup so OVERRIDES key still matches
  // the *current* name).
  if (NAME_FIXES[data.project.name]) {
    console.log(`~ rename "${data.project.name}" → "${NAME_FIXES[data.project.name]}"`);
    data.project.name = NAME_FIXES[data.project.name];
  }

  let artists;
  if (OVERRIDES[data.project.name]) {
    artists = OVERRIDES[data.project.name];
    applied++;
    console.log(`+ ${data.project.name.padEnd(30)} → ${artists.join(" & ")}`);
  } else if (Array.isArray(data.project.artists)) {
    artists = data.project.artists.filter(Boolean);
  } else {
    artists = data.project.artist ? [data.project.artist] : [];
    normalized++;
  }

  data.project.artists = artists;
  data.project.artist = artists.join(" & "); // joined display string
  if (!artists.length) stillEmpty.push(data.project.name);
  writeFileSync(path, JSON.stringify(data, null, 2));
}

writeIndex(PROJECTS_DIR);
console.log(`\nApplied ${applied} overrides, normalized ${normalized} others.`);
console.log(stillEmpty.length ? `Still without an artist: ${stillEmpty.join(", ")}` : "Every project has an artist.");
