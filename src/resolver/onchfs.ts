import Onchfs, { type ChainAliases } from "onchfs";
import { CHAINS, type ChainKey } from "../chains";
import type { ParsedUri } from "./uri";
import type { ResolvedResource } from "./ipfs";
import { readLargeFileAcrossChains } from "./large-file";

/**
 * Maps our internal ChainKey to onchfs's blockchain alias per CAIP-2.
 */
const ONCHFS_BLOCKCHAIN: Partial<Record<ChainKey, ChainAliases>> = {
  ethereum: "eip155:1",
  base: "eip155:8453",
};

let resolverInstance: ((uri: string) => Promise<Awaited<ReturnType<typeof callOnce>>>) | null = null;

async function callOnce(_uri: string) {
  return Onchfs.resolver.create([])("");
}

function getResolver() {
  if (resolverInstance) return resolverInstance;

  const evmControllers = (Object.keys(CHAINS) as ChainKey[])
    .filter((key) => ONCHFS_BLOCKCHAIN[key] !== undefined)
    .map((key) => ({
      blockchain: ONCHFS_BLOCKCHAIN[key]!,
      rpcs: CHAINS[key].rpcs,
    }));

  const tezosController = {
    blockchain: "tezos:mainnet" as const,
    rpcs: CHAINS.tezos.rpcs,
  };

  resolverInstance = Onchfs.resolver.create([...evmControllers, tezosController]);
  return resolverInstance;
}

/**
 * Detect whether an onchfs package resolution failure is one we can recover
 * from by falling back to chunk-by-chunk reading.
 *
 * The package wraps the underlying RPC error in its own error message, and
 * by the time we see it, the original "out of gas" detail has been replaced
 * with a generic "searched all available blockchains" string. So we have to
 * look for either pattern and trust that retrying with chunked reads is safe.
 */
function isLargeFileFailure(err: unknown): { cid: `0x${string}` } | null {
  const msg = err instanceof Error ? err.message : String(err);

  // The package's wrapped error pattern:
  //   "An error occurred when reading the content of the file of cid <hex>: ..."
  const m = msg.match(/reading the content of the file of cid ([0-9a-fA-F]{64})/);
  if (m) {
    return { cid: `0x${m[1].toLowerCase()}` };
  }
  return null;
}

/**
 * Resolves an onchfs:// URI by trying the official onchfs package first,
 * and falling back to chunked reads when the file is too large for the
 * package's single-call readFile().
 *
 * Two-tier strategy:
 *   1. Package resolution handles most cases: small files, directory
 *      traversal, HPACK metadata decoding, gzip decompression, multi-chain
 *      lookup. Just delegate to it.
 *
 *   2. When the package errors out on a specific file CID (typically due to
 *      eth_call gas exhaustion when readFile tries to return >100KB in one
 *      shot), we extract that file's CID from the error message and use our
 *      own batched chunk reader to fetch the content directly. Metadata is
 *      read from the inode and decoded via the package's HPACK helper.
 */
export async function resolveOnchfs(
  parsed: Extract<ParsedUri, { scheme: "onchfs" }>,
  _chainPreference: ChainKey,
): Promise<ResolvedResource> {
  const resolve = getResolver();
  const pathPart = parsed.path.length > 0 ? "/" + parsed.path.join("/") : "/";
  const input = `/${parsed.cid}${pathPart}`;

  let response: Awaited<ReturnType<typeof resolve>>;
  try {
    response = await resolve(input);
  } catch (err) {
    // The resolver call itself shouldn't normally throw — it puts errors in
    // response.error — but defensively handle it the same way as in-response
    // errors.
    const msg = err instanceof Error ? err.message : String(err);
    response = {
      status: 500,
      content: new Uint8Array(),
      headers: {},
      error: { code: 500, name: "ResolverThrew", message: msg },
    };
  }

  // Happy path: package returned successfully.
  if (response.status < 400 && !response.error) {
    return toResolvedResource(response, parsed, pathPart);
  }

  // Try to detect a large-file gas failure and recover.
  const errStr = response.error
    ? typeof response.error === "string"
      ? response.error
      : response.error.message ?? response.error.name
    : `HTTP ${response.status}`;

  const recoverable = isLargeFileFailure(errStr);
  if (recoverable) {
    console.info(
      `[onchfs] package failed on file ${recoverable.cid}, trying chunked read...`,
    );
    const fallback = await readLargeFileAcrossChains(recoverable.cid);
    if (fallback) {
      // Decode HPACK metadata into a Headers object via the package's
      // helper, then return the bytes we read ourselves.
      const headers = new Headers();
      try {
        const meta = Onchfs.metadata.decode(fallback.metadata);
        for (const [k, v] of Object.entries(meta)) {
          if (typeof v === "string") headers.set(k, v);
        }
      } catch {
        // Metadata decoding is best-effort; without it the browser will
        // sniff the content-type from the bytes themselves.
      }

      console.info(
        `[onchfs] chunked read succeeded on ${fallback.chain}: ${fallback.body.length} bytes`,
      );

      return {
        body: fallback.body,
        headers,
        finalUrl: `onchfs://${parsed.cid}${pathPart}`,
      };
    }
  }

  // Neither path worked.
  throw new Error(`onchfs resolution failed: ${errStr}`);
}

function toResolvedResource(
  response: { content: Uint8Array; headers: Record<string, string | undefined> | object },
  parsed: Extract<ParsedUri, { scheme: "onchfs" }>,
  pathPart: string,
): ResolvedResource {
  const headers = new Headers();
  for (const [k, v] of Object.entries(response.headers as Record<string, unknown>)) {
    if (typeof v === "string") headers.set(k, v);
  }
  return {
    body: response.content,
    headers,
    finalUrl: `onchfs://${parsed.cid}${pathPart}`,
  };
}
