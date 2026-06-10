#!/usr/bin/env node
/**
 * cdp-render-check.mjs — load one artwork through the built viewer's Service
 * Worker in headless Chrome and report whether it renders, capturing the
 * iframe's console errors and any sub-resource (e.g. untitled.js) fetch status.
 *
 * Usage: node scripts/cdp-render-check.mjs <viewPath>
 *   viewPath = the SW route + query, e.g.
 *   "/view/ipfs/<cid>/?cid=ipfs://<cid>&fxhash=...&fxiteration=1&chain=tezos"
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:4173";
const viewPath = process.argv[2];
if (!viewPath) { console.error("Usage: cdp-render-check.mjs <viewPath>"); process.exit(1); }

const PORT = 9400 + Math.floor(Math.random() * 400);
const userDir = mkdtempSync(join(tmpdir(), "cdp-render-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  "--no-first-run", "--no-default-browser-check", "--enable-unsafe-swiftshader",
  "--use-gl=angle", "--window-size=900,900",
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try { const j = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {}
    await sleep(250);
  }
  throw new Error("CDP not up");
}
function cdp(ws) {
  let id = 0; const pending = new Map(); const listeners = [];
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  });
  return { send, on: (fn) => listeners.push(fn) };
}

(async () => {
  const ws = new WebSocket(await getWs());
  await new Promise((r) => ws.addEventListener("open", r));
  const { send, on } = cdp(ws);
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);

  const logs = []; const netErr = [];
  on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled") {
      const t = m.params.type; const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (t === "error" || t === "warning" || /error|fail|exception/i.test(txt)) logs.push(`[${t}] ${txt}`.slice(0, 300));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const e = m.params.exceptionDetails; logs.push(`[exception] ${e.exception?.description || e.text}`.slice(0, 300));
    }
    if (m.method === "Network.responseReceived") {
      const r = m.params.response; if (r.status >= 400) netErr.push(`${r.status} ${r.url}`.slice(0, 160));
    }
    if (m.method === "Network.loadingFailed") netErr.push(`FAILED ${m.params.errorText} ${m.params.requestId}`);
  });
  await S("Runtime.enable", {}); await S("Network.enable", {}); await S("Page.enable", {});

  // 1) register SW via the app root
  await S("Page.navigate", { url: BASE + "/" });
  await sleep(3500);
  // 2) navigate straight to the artwork view (SW now controls the origin)
  await S("Page.navigate", { url: BASE + viewPath });
  await sleep(Number(process.env.RENDER_WAIT_MS) || 9000); // some works compute for many seconds

  // inspect render
  const { result } = await S("Runtime.evaluate", {
    expression: `(() => {
      const c = document.querySelector('canvas');
      const img = document.querySelector('img');
      let canvasInfo = null;
      if (c) { try { const t=document.createElement('canvas'); t.width=32;t.height=32;
        t.getContext('2d').drawImage(c,0,0,32,32); const d=t.getContext('2d').getImageData(0,0,32,32).data;
        let lum=0,nonblack=0; for(let i=0;i<d.length;i+=4){const L=d[i]+d[i+1]+d[i+2];lum+=L;if(L>20)nonblack++;}
        canvasInfo={w:c.width,h:c.height,avgLum:(lum/(d.length/4)/3).toFixed(1),nonblackPct:(100*nonblack/(d.length/4)).toFixed(0)};
      } catch(e){ canvasInfo={error:String(e)}; } }
      return JSON.stringify({
        hasCanvas: !!c, hasImg: !!img,
        imgSrcHead: img ? (img.src||'').slice(0,40) : null,
        imgComplete: img ? img.complete : null, imgNatural: img ? (img.naturalWidth+'x'+img.naturalHeight) : null,
        bodyHtmlLen: document.body ? document.body.innerHTML.length : 0,
        canvas: canvasInfo,
        title: document.title,
      });
    })()`, returnByValue: true,
  }).catch((e) => ({ result: { value: JSON.stringify({ evalError: e.message }) } }));

  const shot = await S("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) { const fs = await import("node:fs"); fs.writeFileSync("/tmp/geo-render.png", Buffer.from(shot.data, "base64")); }

  console.log("RENDER:", result.value);
  console.log("CONSOLE ERRORS:", logs.length ? "\n  " + logs.join("\n  ") : "(none)");
  console.log("NET >=400/FAILED:", netErr.length ? "\n  " + [...new Set(netErr)].join("\n  ") : "(none)");
  console.log("screenshot: /tmp/geo-render.png");

  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error("Fatal:", e); chrome.kill(); process.exit(1); });
