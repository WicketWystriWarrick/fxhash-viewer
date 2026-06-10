#!/usr/bin/env node
/**
 * cdp-find-contract.mjs — resolve fxhash EVM (Base/Ethereum) project URLs to
 * their 20-byte contract address by rendering the SPA in headless Chrome.
 *
 * fxhash's public GraphQL (api.fxhash.xyz) is Tezos-only and the project page
 * is a client-rendered SPA, so a plain fetch sees no contract. We drive Chrome
 * over CDP (no playwright), let the page load + issue its API calls, capture
 * every network response body, and grep for a 0x…40 address (plus any
 * basescan/etherscan explorer link in the rendered DOM).
 *
 * Usage: node scripts/cdp-find-contract.mjs <url> [url2 ...]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("Usage: node scripts/cdp-find-contract.mjs <url> [url2 ...]");
  process.exit(1);
}

const PORT = 9300 + Math.floor(Math.random() * 400);
const userDir = mkdtempSync(join(tmpdir(), "cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Chrome CDP did not come up");
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  const listeners = [];
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (const l of listeners) l(m);
    }
  });
  return { send, on: (fn) => listeners.push(fn) };
}

const ADDR = /0x[0-9a-fA-F]{40}/g;
const ZERO = "0x" + "0".repeat(40);

async function resolveOne(send, url) {
  // Fresh target (tab) per URL.
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (method, params) => send(method, params, sessionId);

  const bodies = []; // {url, requestId}
  await S("Network.enable", {});
  await S("Page.enable", {});
  const reqUrls = new Map();
  const responded = [];
  send && null;
  // collect responses
  const collector = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.responseReceived") {
      const t = m.params.type;
      if (t === "XHR" || t === "Fetch" || t === "Document" || t === "Script") {
        responded.push(m.params.requestId);
        reqUrls.set(m.params.requestId, m.params.response.url);
      }
    }
  };
  cdpGlobalOn(collector);

  await S("Page.navigate", { url });
  await sleep(Number(process.env.CDP_WAIT_MS) || 6000); // let the SPA hydrate + fire its API calls

  // Grep all captured response bodies. The token metadata JSON carries the
  // ground-truth contract in `external_link`:
  //   "external_link":"https://fxhash.xyz/generative/0x<40hex>"
  // and the chain in the artifactUri's `fxchain=` param. Those are exact, so we
  // prefer them over a blind address frequency count.
  const EXTLINK = /fxhash\.xyz\/generative\/(0x[0-9a-fA-F]{40})/g;
  const FXCHAIN = /fxchain=([A-Za-z]+)/i;
  const found = new Map(); // addr -> count (fallback signal)
  const extLinks = new Map(); // contract -> count (authoritative)
  let fxchain = "";
  for (const rid of responded) {
    try {
      const { body, base64Encoded } = await S("Network.getResponseBody", { requestId: rid });
      const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      for (const m of text.matchAll(EXTLINK)) extLinks.set(m[1], (extLinks.get(m[1]) || 0) + 1);
      if (!fxchain) { const c = text.match(FXCHAIN); if (c) fxchain = c[1].toLowerCase(); }
      for (const m of text.matchAll(ADDR)) {
        const a = m[0];
        if (a.toLowerCase() === ZERO) continue;
        found.set(a, (found.get(a) || 0) + 1);
      }
    } catch { /* body gone */ }
  }

  // Also scan rendered DOM + explorer links.
  let domAddrs = [];
  let explorer = [];
  try {
    const { result } = await S("Runtime.evaluate", {
      expression: `(() => {
        const html = document.documentElement.outerHTML;
        const addrs = [...html.matchAll(/0x[0-9a-fA-F]{40}/g)].map(m=>m[0]);
        const links = [...document.querySelectorAll('a[href]')].map(a=>a.href)
          .filter(h=>/basescan|etherscan|explorer/i.test(h));
        // fxhash token/collection links carry the contract: /generative/0x<40>
        const gen = [...html.matchAll(/generative\\/(0x[0-9a-fA-F]{40})/g)].map(m=>m[1]);
        return JSON.stringify({addrs, links, gen});
      })()`,
      returnByValue: true,
    });
    const parsed = JSON.parse(result.value);
    domAddrs = parsed.addrs.filter((a) => a.toLowerCase() !== ZERO);
    explorer = parsed.links;
    if (!extLinks.size && parsed.gen?.length) {
      for (const g of parsed.gen) extLinks.set(g, (extLinks.get(g) || 0) + 1);
    }
  } catch { /* ignore */ }

  if (process.env.CDP_DUMP_REQS) {
    const apis = [...reqUrls.values()].filter((u) => /graphql|api|indexer|\.json|hasura/i.test(u));
    console.log("--- API-ish requests ---");
    for (const u of [...new Set(apis)].slice(0, 40)) console.log("   " + u);
  }
  await S("Target.closeTarget", { targetId }).catch(() => {});
  return {
    url,
    contract: [...extLinks.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "",
    fxchain,
    networkAddrs: [...found.entries()].sort((a, b) => b[1] - a[1]),
    domAddrs,
    explorer,
  };
}

// global event fan-out (set after cdp() is built)
let _on = () => {};
function cdpGlobalOn(fn) { const prev = _on; _on = (m) => { prev(m); fn(m); }; }

(async () => {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res) => ws.addEventListener("open", res));
  const client = cdp(ws);
  client.on((m) => _on(m));

  for (const url of urls) {
    try {
      const r = await resolveOne(client.send, url);
      const slug = url.split("/").pop();
      console.log(`\n=== ${slug} ===`);
      if (r.contract) {
        console.log(`CONTRACT: ${r.contract}\tchain: ${r.fxchain || "(unknown)"}`);
      } else {
        console.log("CONTRACT: (not found in external_link)");
        console.log("  top network addrs:", r.networkAddrs.slice(0, 5).map(([a, c]) => `${a}x${c}`).join(" "));
      }
    } catch (e) {
      console.log(`\n=== ${url} ===\n  ERROR: ${e.message}`);
    }
  }

  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error("Fatal:", e); chrome.kill(); process.exit(1); });
