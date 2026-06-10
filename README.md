# fxhash-viewer

A browser-based viewer for **fxhash** generative art, designed to keep working **after fxhash itself disappears**.

It resolves artwork bytes directly from where they actually live — **onchfs** (on-chain file system) and **IPFS** — and runs the original generator in a sandboxed iframe. No fxhash servers are involved at view time.

> **Status:** work in progress (pre-1.0). Public, but the rough edges are still being smoothed out.

---

## Why

fxhash stores generative artworks as content-addressed files (onchfs on EVM chains, IPFS on Tezos and elsewhere). The official viewer, however, reaches those files through fxhash's own gateways and APIs. The day those endpoints go offline, the art stops loading — even though the bytes are still on-chain / on IPFS forever.

This project removes every runtime dependency on fxhash:

> If `fxhash.xyz`, `media.fxhash.xyz`, `onchfs.fxhash2.xyz`, and `api.v2.fxhash.xyz` all stopped responding tomorrow, this viewer would still load the same artworks correctly.

See [`_legacy/onchfs-viewer/ARCHITECTURE.md`](./_legacy/onchfs-viewer/ARCHITECTURE.md) for the full on-chain investigation notes the design is based on.

## Features

- **Content-addressed resolution** — reads artwork files straight from onchfs (Ethereum / Base) and IPFS, never from fxhash endpoints.
- **Resilient transports** — multiple public RPCs (viem `fallback`) and a racing/sticky pool of IPFS gateways, so no single provider is a point of failure. Large onchfs files are read chunk-by-chunk to stay under `eth_call` gas limits.
- **Service Worker rendering** — a SW intercepts `/view/{scheme}/{cid}/…` and serves the artwork (and its sub-resources) with the same environment patches fxhash applies (e.g. the `Math.pow` base58 determinism fix), so generators render identically.
- **Two ways to load** — paste an `onchfs://` / `ipfs://` URI directly, or load a project JSON and pick an iteration from a thumbnail grid.
- **Gallery with artist tags** — browse the bundled collection as a grid (collection → tiles → live). Each project is tagged with its artist(s) and chain; clicking an artist filters the whole collection to their work, **across chains** (e.g. one artist's Tezos and Base pieces together).
- **Offline archive** — export any artwork you've viewed as a self-contained `.zip` (all files + a standalone launcher), so it survives even if every gateway disappears.
- **Persistent cache** — resolved bytes are cached in IndexedDB; once seen, an artwork loads fully offline.

## How it works

```
URI / project JSON
        │
        ▼
  parse onchfs:// or ipfs://
        │
        ▼
  iframe src = /view/{scheme}/{cid}/?fxhash=…&fxiteration=…&chain=…
        │
        ▼
  Service Worker (sw.js)
   ├─ resolve bytes  ── onchfs (viem)  or  IPFS (gateway race)
   ├─ inject patches (Math.pow / <base> / crossOrigin)
   └─ cache (IndexedDB)
        │
        ▼
  sandboxed iframe runs the original generator
```

## Requirements

- **Node.js 18+**
- A modern browser with Service Worker support

## Getting started

```bash
npm install
npm run build      # builds the app AND the Service Worker (sw.js)
npm run preview    # serves the production build at http://localhost:4173
```

Open the printed URL.

> **Use `build` + `preview`, not `dev`.** The Service Worker (`/sw.js`) is a separate build artifact and only exists after `npm run build`. Under `npm run dev` it 404s, so artwork rendering won't work.

Other scripts:

| Script | What it does |
|---|---|
| `npm run build` | Type-check, build the app, then build `sw.js` (dynamic imports inlined) |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | Type-check only |

## Usage

**URI mode** — choose the chain, paste an `onchfs://…` or `ipfs://…` URI, fill in the generation `fxhash` seed (and optionally iteration / minter), and hit **Load**.

**File mode** — load a project JSON (see below). Saved projects under `public/projects/` appear in the sidebar; pick an iteration from the thumbnail grid to view it.

The app ships with two interchangeable UIs — the **classic** sidebar above, and a full-screen **gallery** (collection → tiles → live view) where each project shows its artist(s) and chain, and clicking an artist tag filters the collection. Switch with the on-screen toggle or `?ui=gallery` / `?ui=classic`; your last choice is remembered.

## Preparing artwork data (optional)

The viewer works without any bundled data (URI mode resolves anything directly). To browse a whole project by thumbnail, extract its iteration list into `public/projects/`.

**One command, any chain** — paste an fxhash URL (or slug). It resolves the project via fxhash's GraphQL, detects the chain (`KT1…` ⇒ Tezos, `0x…` ⇒ EVM, with Base/Ethereum told apart by RPC probe), and runs the right extractor:

```bash
node extract-url.mjs https://www.fxhash.xyz/generative/slug/<slug>
node extract-url.mjs <slug>            # short form
node extract-url.mjs <url> --dry-run   # resolve + detect chain only, write nothing
node extract-url.mjs <url> --force      # overwrite an existing public/projects/<Name>.json
```

By default it refuses to overwrite an already-extracted project (so manual cleanup isn't clobbered).

Under the hood:

- **Tezos** iterations are read straight from fxhash's GraphQL `objkts` (project-scoped, so the count matches on-chain supply exactly). This avoids the over-collection you get from a TzKT search by generative-code CID when that CID is reused across editions/drops.
- **EVM** dispatches to `extract-project.mjs`, reading each token from the contract over RPC.

**EVM via the fxhash indexer (recommended for Base / Ethereum).** Public EVM RPCs rate-limit hard, so scraping `tokenURI` for thousands of tokens is slow and lossy. `extract-evm-graphql.mjs` instead reads every iteration from fxhash's v2 indexer (`api.v2.fxhash.xyz`) in a couple of paginated queries — no per-token RPC — and keeps only the live token states (`ACTIVE`/`EVOLVED`/`LOCKED`), so the count matches on-chain supply even for evolving collections:

```bash
node scripts/extract-evm-graphql.mjs <0x-contract> [nameOverride]
```

The per-chain scripts can also be run directly:

```bash
# EVM (Ethereum / Base) project, by contract address or metadata file (RPC path)
node extract-project.mjs <contract-address> [ethereum|base]

# Tezos project, by name (legacy TzKT path; extract-url.mjs is preferred)
node extract-tezos.mjs --name "Project Name"

# Resolve a project name / fxhash URL to its contract address
node find-contract.mjs "Project Name"
```

Each writes `public/projects/<Name>.json` and refreshes `public/projects/_index.json`, which the File-mode sidebar and the gallery read. These scripts use only on-chain / public-indexer data and Node built-ins (no extra dependencies). A starter set of extracted projects is checked into `public/projects/`; running the scripts adds more. (Local `*.bak` snapshots and the raw `metadata/` dumps stay git-ignored.)

**Artist names.** Extractors record the artist into `project.artists` automatically. To (re)fill the field for already-extracted projects, or to apply manual names where fxhash has none (collab contracts, unset usernames):

```bash
node scripts/backfill-artists.mjs   # fetch names from fxhash for every project
node scripts/apply-artists.mjs      # apply the manual-override table + normalize
```

`scripts/apply-artists.mjs` holds the manual-name overrides as a small, version-controlled map — the source of truth for names fxhash got wrong or couldn't resolve.

During `npm run dev`, a Vite plugin watches `public/projects/*.json` and regenerates `_index.json` automatically on any edit; `npm run index` does the same manually.

## Supported chains & storage

| Chain | Storage in practice | How it's read |
|---|---|---|
| Ethereum | onchfs (on-chain) | viem `readContract`, chunked for large files |
| Base | onchfs / IPFS | viem / gateway |
| Tezos | IPFS | gateway race (via the `onchfs` package's resolver) |

## Project structure

```
src/
  resolver/    onchfs + IPFS resolution (chunked reads, gateway race)
  cache/       IndexedDB content cache
  sw/          Service Worker (intercepts /view/*) + registration
  archive/     ZIP export of viewed artworks
  discovery/   shared ArtworkItem type (live wallet discovery intentionally dropped)
  viewer/      shared artwork-resolution helpers used by both UIs
  ui/
    classic/   sidebar form (URI / File modes) + inline viewer
    gallery/   full-screen collection → tiles → live view
  App.tsx      shell that switches between the classic and gallery UIs
extract-*.mjs  offline data-extraction entry points (extract-url / -project / -tezos, find-contract)
scripts/       index build (build-index) · per-chain GraphQL extractors
               (extract-tezos-graphql, extract-evm-graphql) · artist tools
               (backfill-artists, apply-artists) · headless-Chrome helpers (cdp-*)
_legacy/       reference: the original prototype + ARCHITECTURE notes
docs/          migration log
```

## Configuration

Optional — copy `.env.example` to `.env` to use your own RPC endpoints (they take priority over the public fallbacks):

```
VITE_ETH_RPC=
VITE_BASE_RPC=
```

The extraction scripts honour their own overrides when scraping over RPC: `BASE_RPC`, `ETH_RPC`, and `IPFS_GW` (the gateway for token metadata). The indexer-based extractor (`extract-evm-graphql.mjs`) needs none of these.

## License

[MIT](./LICENSE)
