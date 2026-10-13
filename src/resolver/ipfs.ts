import type { ParsedUri } from "./uri";

export interface ResolvedResource {
  body: Uint8Array;
  headers: Headers;
  /**
   * The URL that ended up serving the bytes. Useful for the iframe `<base>`
   * to resolve relative paths, and for debugging which gateway responded.
   */
  finalUrl: string;
}

/**
 * Public IPFS gateways used as fallbacks. They're tried in order and the
 * first responder wins. Users can prepend their own (e.g. a local node at
 * http://127.0.0.1:8080/ipfs/) via env or settings UI in the future.
 *
 * These are deliberately heterogeneous so that the failure of any single
 * provider doesn't break the viewer.
 */
const IPFS_GATEWAYS = [
  // ipfs.io / dweb.link / nftstorage.link rate-limit (429) and pinata refuses
  // HTML (403), so filebase is the one that reliably serves whole artworks.
  "https://ipfs.filebase.io/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://nftstorage.link/ipfs/",
  // fxhash's own gateway — convenient while fxhash is alive, but the whole
  // point of this viewer is to not depend on it, so it sits last.
  "https://gateway.fxhash.xyz/ipfs/",
];

/**
 * Sticky gateway map: CID → gateway URL that previously succeeded.
 *
 * When an artwork loads from IPFS, the root HTML is fetched first via a full
 * gateway race. That winner is remembered here. Subsequent files from the
 * same CID (JS, CSS, GLSL shaders, images...) go directly to the sticky
 * gateway without racing. This prevents the cascade of 301/cancelled
 * requests that happens when 6 gateways are hit simultaneously for every
 * single sub-resource.
 *
 * If the sticky gateway fails on a later request (e.g., rate limit hit after
 * many files), the entry is cleared and a full race is triggered as fallback.
 */
const stickyGateway = new Map<string, string>();

/**
 * Resolves an ipfs:// URI, using a sticky gateway when available.
 */
export async function resolveIpfs(
  parsed: Extract<ParsedUri, { scheme: "ipfs" }>,
): Promise<ResolvedResource> {
  const path = parsed.path.length > 0 ? "/" + parsed.path.join("/") : "";
  const suffix = parsed.cid + path;

  // --- Sticky path: try the gateway that worked for this CID before ---
  const sticky = stickyGateway.get(parsed.cid);
  if (sticky) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);

      const r = await fetch(sticky + suffix, { signal: controller.signal });
      clearTimeout(timeout);

      if (r.ok) {
        const body = new Uint8Array(await r.arrayBuffer());
        return { body, headers: r.headers, finalUrl: sticky + suffix };
      }
      // Non-OK (e.g. 404 for a specific path) — clear sticky and race
      stickyGateway.delete(parsed.cid);
    } catch {
      // Timeout or network error — clear sticky and fall through to race
      stickyGateway.delete(parsed.cid);
    }
  }

  // --- Race path: try all gateways in parallel, first success wins ---
  const controllers = IPFS_GATEWAYS.map(() => new AbortController());

  const requests = IPFS_GATEWAYS.map((gateway, i) =>
    fetch(gateway + suffix, { signal: controllers[i].signal }).then(async (r) => {
      if (!r.ok) throw new Error(`${gateway}: ${r.status}`);
      const body = new Uint8Array(await r.arrayBuffer());
      return { body, headers: r.headers, finalUrl: gateway + suffix, winnerIndex: i };
    }),
  );

  try {
    const result = await Promise.any(requests);
    // Cancel the losers.
    controllers.forEach((c, i) => i !== result.winnerIndex && c.abort());

    // Remember the winner for subsequent files from the same CID.
    stickyGateway.set(parsed.cid, IPFS_GATEWAYS[result.winnerIndex]);

    return { body: result.body, headers: result.headers, finalUrl: result.finalUrl };
  } catch (err) {
    if (err instanceof AggregateError) {
      throw new Error(
        `All IPFS gateways failed: ${err.errors.map((e) => e.message).join("; ")}`,
      );
    }
    throw err;
  }
}
