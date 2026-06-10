/// <reference lib="webworker" />

import { resolve } from "../resolver";
import { getCached, setCached } from "../cache/chunks";
import type { ChainKey } from "../chains";

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener("install", () => {
  void sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(sw.clients.claim());
});

const ROUTE = /^\/view\/(onchfs|ipfs)\/([^/]+)(?:\/(.*))?$/;
const VIEWER_ASSETS = /^\/(assets\/|sw\.js$|index\.html$|projects\/)/;

/**
 * Patches injected into artwork HTML. Matches fxhash.xyz's live viewer.
 *
 * 1. Math.pow: deterministic base58 decoding
 * 2. <base>: sub-resources load from IPFS gateway (solves XHR issue)
 * 3. crossOrigin: WebGL textures work cross-origin (solves Richter)
 * 4. SW suppression: artwork's own SW won't fail (solves Richter)
 *
 * Gateway: ipfs.io — operated by Protocol Labs, most stable CORS support.
 */
function buildInjection(scheme: string, cid: string): string {
  // Math.pow patch (all artworks)
  let s = `<script>(function(){Math.pow=(a,b)=>(a===58&&b===11)?24986644000165536000:a**b})();</script>`;

  if (scheme === "ipfs") {
    // <base> tag
    s += `\n<base href="https://ipfs.io/ipfs/${cid}/">`;
    // crossOrigin for WebGL textures
    // NB: coerce the tag with String(t), not t.toLowerCase() — some artworks
    // call createElement as a tagged template (`createElement\`canvas\``), so t
    // arrives as a TemplateStringsArray, not a string (breaks GEOMORPHISM).
    s += `\n<script>(function(){var OI=window.Image;window.Image=function(w,h){var i=new OI(w,h);i.crossOrigin='anonymous';return i};window.Image.prototype=OI.prototype;var OC=document.createElement.bind(document);document.createElement=function(t,o){var e=OC(t,o);if((''+t).toLowerCase()==='img')e.crossOrigin='anonymous';return e}})();</script>`;
    // SW registration suppression
    s += `\n<script>(function(){if(navigator.serviceWorker)navigator.serviceWorker.register=function(){return Promise.resolve(null)}})();</script>`;
  }
  return s;
}

/**
 * Inject patch bytes into the HTML byte array without text decoding.
 * This preserves binary data embedded in the HTML (base64 fonts, etc.)
 * that would be corrupted by a TextDecoder→TextEncoder round-trip.
 */
function injectPatchBytes(html: Uint8Array, patch: Uint8Array): Uint8Array {
  // Check first 500 bytes for HTML markers
  const header = new TextDecoder().decode(html.slice(0, Math.min(500, html.length)));
  const isHtml = /<!doctype\s+html|<html|<head/i.test(header);
  if (!isHtml) return html;

  // Find injection point in the byte array
  const headerLower = header.toLowerCase();
  let insertPos = -1;
  let wrapHead = false;

  // Try <head> first
  const headIdx = headerLower.indexOf("<head");
  if (headIdx !== -1) {
    const closeIdx = header.indexOf(">", headIdx);
    if (closeIdx !== -1) insertPos = closeIdx + 1;
  }

  // Fall back to <html>
  if (insertPos === -1) {
    const htmlIdx = headerLower.indexOf("<html");
    if (htmlIdx !== -1) {
      const closeIdx = header.indexOf(">", htmlIdx);
      if (closeIdx !== -1) {
        insertPos = closeIdx + 1;
        wrapHead = true;
      }
    }
  }

  // Fall back to start of file
  if (insertPos === -1) insertPos = 0;

  // Build injection with optional <head> wrapper
  const nl = new TextEncoder().encode("\n");
  const headOpen = wrapHead ? new TextEncoder().encode("<head>") : new Uint8Array(0);
  const headClose = wrapHead ? new TextEncoder().encode("</head>") : new Uint8Array(0);

  // Combine: [before] + \n + <head>? + patch + </head>? + \n + [after]
  const totalLen = html.length + nl.length * 2 + headOpen.length + patch.length + headClose.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;

  result.set(html.slice(0, insertPos), offset); offset += insertPos;
  result.set(nl, offset); offset += nl.length;
  result.set(headOpen, offset); offset += headOpen.length;
  result.set(patch, offset); offset += patch.length;
  result.set(headClose, offset); offset += headClose.length;
  result.set(nl, offset); offset += nl.length;
  result.set(html.slice(insertPos), offset);

  return result;
}

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  if (VIEWER_ASSETS.test(url.pathname)) return;

  const match = url.pathname.match(ROUTE);
  if (!match) return;

  const [, scheme, cid, rest] = match;
  const pathPart = rest ? "/" + rest : "";
  const uri = `${scheme}://${cid}${pathPart}`;
  const chainPreference = (url.searchParams.get("chain") as ChainKey) ?? "base";
  const isRootDoc = !rest || rest === "" || rest === "index.html";

  if (isRootDoc) {
    // Root HTML: inject patches (Math.pow + IPFS-specific if applicable)
    event.respondWith(handleRoot(uri, scheme, cid, chainPreference));
  } else if (scheme === "ipfs") {
    // IPFS sub-resources: served via <base> tag from gateway, SW not needed.
    // If request reaches here, it's a fallback — resolve normally.
    event.respondWith(handleSubResource(uri, scheme, cid + pathPart, chainPreference));
  } else {
    // onchfs sub-resources: always served by SW
    event.respondWith(handleSubResource(uri, scheme, cid + pathPart, chainPreference));
  }
});

/**
 * Handle root HTML document: fetch, inject patches, return.
 */
async function handleRoot(
  uri: string,
  scheme: string,
  cid: string,
  chainPreference: ChainKey,
): Promise<Response> {
  try {
    const { body, headers } = await resolve(uri, chainPreference);
    const decompressed = await decompressIfNeeded(body, headers);

    // Inject patches at the byte level to avoid corrupting binary data
    // embedded in the HTML (e.g., base64 fonts, compressed assets).
    // TextDecoder/TextEncoder round-trips corrupt non-UTF-8 bytes.
    const patchBytes = new TextEncoder().encode(buildInjection(scheme, cid));
    const responseBody = injectPatchBytes(decompressed, patchBytes);
    const responseHeaders = new Headers();
    responseHeaders.set("content-type", "text/html; charset=utf-8");
    for (const [k, v] of Object.entries(sandboxHeaders())) {
      responseHeaders.set(k, v);
    }

    return new Response(responseBody.slice().buffer, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Resolver error: ${message}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

/**
 * Handle sub-resources (JS, CSS, images, GLSL, etc.): resolve + cache.
 */
async function handleSubResource(
  uri: string,
  scheme: string,
  cacheAddr: string,
  chainPreference: ChainKey,
): Promise<Response> {
  const cached = await getCached(scheme, cacheAddr);
  if (cached) {
    return new Response(cached.body.slice().buffer, {
      headers: { ...cached.headers, ...sandboxHeaders() },
    });
  }

  try {
    const { body, headers } = await resolve(uri, chainPreference);
    const decompressed = await decompressIfNeeded(body, headers);

    const responseHeaders = new Headers(headers);
    responseHeaders.delete("content-encoding");
    for (const [k, v] of Object.entries(sandboxHeaders())) {
      responseHeaders.set(k, v);
    }

    await setCached(scheme, cacheAddr, decompressed, responseHeaders);

    return new Response(decompressed.slice().buffer, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Resolver error: ${message}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

async function decompressIfNeeded(
  body: Uint8Array,
  headers: Headers,
): Promise<Uint8Array> {
  const encoding = headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") return body;

  const algo: CompressionFormat | null =
    encoding === "gzip" ? "gzip" : encoding === "deflate" ? "deflate" : null;
  if (!algo) return body;

  try {
    const blob = new Blob([body as BlobPart]);
    const stream = blob.stream().pipeThrough(new DecompressionStream(algo));
    const decompressed = await new Response(stream).arrayBuffer();
    return new Uint8Array(decompressed);
  } catch (err) {
    console.warn("[sw] decompression failed, returning raw bytes", err);
    return body;
  }
}

function sandboxHeaders(): Record<string, string> {
  return {
    "content-security-policy":
      "default-src * 'unsafe-inline' 'unsafe-eval' blob: data:; " +
      "img-src * blob: data:; " +
      "media-src * blob: data:; " +
      "connect-src * blob: data:; " +
      "font-src * data:; " +
      "frame-ancestors 'self'",
    "cache-control": "no-store, no-cache, must-revalidate",
  };
}

export {};
