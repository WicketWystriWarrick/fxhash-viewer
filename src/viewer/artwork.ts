/**
 * Shared viewer logic used by both UIs (classic and gallery).
 *
 * Everything here is presentation-agnostic: turning a project JSON into
 * ArtworkItems, building the Service-Worker iframe URL for an item, and
 * rewriting thumbnail URIs for display. Keeping it in one place means the
 * two UIs can never drift on how an artwork is actually loaded.
 */
import { parseUri } from "../resolver/uri";
import { buildArtworkUrlSuffix } from "../url-params";
import type { ChainKey } from "../chains";
import type { ArtworkItem } from "../discovery";

/** Shape of the JSON produced by extract-project.mjs / extract-tezos.mjs. */
export interface ProjectFile {
  project: {
    name: string;
    contract: string;
    chain: string;
    generativeUri: string;
    totalSupply: number;
  };
  iterations: Array<{
    tokenId: number;
    name: string;
    iteration: number;
    fxhash: string;
    minter: string;
    fxparams?: string;
    owner: string;
    thumbnailUri: string;
    generativeUri: string;
    viewerParams: {
      uri: string;
      fxhash: string;
      iteration: number;
      minter: string;
      fxparams?: string;
    };
  }>;
}

/** One entry of public/projects/_index.json. */
export interface ProjectIndexEntry {
  filename: string;
  name: string;
  chain: string;
  count: number;
  /** Representative thumbnail for the whole project (added by updateIndex). */
  thumbnail?: string;
}

/**
 * Translate a thumbnail URI into a URL the browser can render directly.
 *
 * fxhash returns thumbnails as `ipfs://Qm...` which can't be loaded directly.
 * We rewrite to a public IPFS gateway for display purposes. For images this
 * is acceptable; the actual artwork rendering still goes through our SW.
 */
export function thumbnailUrl(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("ipfs://")) {
    return "https://ipfs.io/ipfs/" + uri.slice("ipfs://".length);
  }
  return uri;
}

/**
 * Build the iframe src URL for an artwork.
 *
 * ALL artworks go through the Service Worker at /view/{scheme}/{cid}/.
 * The SW injects the <base> tag (IPFS) and the Math.pow determinism patch,
 * matching fxhash.xyz's wrapper-page architecture.
 */
export function buildIframeSrc(
  parsed: ReturnType<typeof parseUri>,
  suffix: string,
  chain: ChainKey,
): string {
  const swPath = `/view/${parsed.scheme}/${parsed.cid}${parsed.path.length ? "/" + parsed.path.join("/") : ""}/`;
  return swPath.replace(/\/+$/, "/") + suffix + `&chain=${chain}`;
}

/**
 * Resolve an ArtworkItem to the iframe src that renders it.
 * Throws if the item has no generative URI.
 */
export function itemToIframeSrc(item: ArtworkItem): { iframeSrc: string; uri: string } {
  if (!item.generativeUri) {
    throw new Error(
      "This artwork has no generative URI. Re-extract the project, or use URI mode.",
    );
  }
  const parsed = parseUri(item.generativeUri);
  const suffix = buildArtworkUrlSuffix({
    cid: item.generativeUri,
    fxhash: item.fxhash,
    iteration: item.iteration,
    minter: item.minter || undefined,
    chain: item.chain,
    inputBytes: item.fxparams || undefined,
  });
  return { iframeSrc: buildIframeSrc(parsed, suffix, item.chain), uri: item.generativeUri };
}

/**
 * Map an extract-script project file (format 1) into ArtworkItems.
 * Iterations without any generative URI are dropped.
 */
export function projectFileToItems(data: ProjectFile): ArtworkItem[] {
  const chain = (data.project?.chain as ChainKey) || "ethereum";
  return data.iterations
    .filter((it) => it.viewerParams?.uri || it.generativeUri)
    .map((it) => ({
      key: `${chain}:${data.project?.contract ?? "unknown"}:${it.tokenId}`,
      name: it.name || `#${it.iteration}`,
      projectName: data.project?.name ?? "Unknown",
      artistName: "",
      thumbnailUri: it.thumbnailUri || "",
      generativeUri: it.viewerParams?.uri || it.generativeUri || "",
      fxhash: it.viewerParams?.fxhash || it.fxhash || "",
      iteration: it.viewerParams?.iteration ?? it.iteration ?? it.tokenId,
      minter: it.viewerParams?.minter || it.minter || "",
      chain,
      contract: (data.project?.contract?.toLowerCase() ?? "0x") as `0x${string}`,
      tokenId: String(it.tokenId),
      fxparams: it.viewerParams?.fxparams || it.fxparams || "",
      source: "graphql" as const,
    }));
}

/**
 * Fetch a saved project JSON from public/projects/ and map it to ArtworkItems.
 */
export async function loadSavedProjectItems(
  filename: string,
): Promise<{ projectName: string; items: ArtworkItem[] }> {
  const resp = await fetch(`/projects/${filename}`);
  if (!resp.ok) throw new Error(`Failed to load /projects/${filename}: ${resp.status}`);
  const raw = await resp.json();
  if (!raw.iterations || !Array.isArray(raw.iterations)) {
    throw new Error("Invalid project file: no iterations array.");
  }
  const data = raw as ProjectFile;
  return { projectName: data.project?.name ?? filename, items: projectFileToItems(data) };
}
