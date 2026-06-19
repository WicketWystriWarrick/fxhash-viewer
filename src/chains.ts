import { createPublicClient, http, fallback, type Chain, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";

export type ChainKey = "ethereum" | "base" | "tezos";

// Public RPCs as resilient fallbacks. All listed RPCs support browser-origin CORS.
const ETHEREUM_RPCS = [
  import.meta.env.VITE_ETH_RPC,
  "https://eth.drpc.org",
  "https://1rpc.io/eth",
  "https://cloudflare-eth.com",
].filter((url): url is string => Boolean(url));

const BASE_RPCS = [
  import.meta.env.VITE_BASE_RPC,
  "https://base.drpc.org",
  "https://1rpc.io/base",
].filter((url): url is string => Boolean(url));

// Public Tezos RPCs. All verified live + CORS-enabled (Access-Control-Allow-Origin: *)
// as of 2026-06. The previous endpoints (mainnet.ecadinfra.com / rpc.tzbeta.net) went
// dead — ecadinfra's domain no longer resolves — which broke onchfs:// resolution for
// Tezos on-chain projects entirely.
const TEZOS_RPCS = [
  import.meta.env.VITE_TEZOS_RPC,
  "https://mainnet.smartpy.io",
  "https://prod.tcinfra.net/rpc/mainnet",
  "https://rpc.tzkt.io/mainnet",
].filter((url): url is string => Boolean(url));

interface ChainConfig {
  key: ChainKey;
  name: string;
  /** viem Chain definition. Null for non-EVM chains (Tezos). */
  chain: Chain | null;
  rpcs: string[];
  explorer: string;
}

export const CHAINS: Record<ChainKey, ChainConfig> = {
  ethereum: {
    key: "ethereum",
    name: "Ethereum",
    chain: mainnet,
    rpcs: ETHEREUM_RPCS,
    explorer: "https://etherscan.io",
  },
  base: {
    key: "base",
    name: "Base",
    chain: base,
    rpcs: BASE_RPCS,
    explorer: "https://basescan.org",
  },
  tezos: {
    key: "tezos",
    name: "Tezos",
    chain: null, // Non-EVM; onchfs package handles Tezos RPC internally
    rpcs: TEZOS_RPCS,
    explorer: "https://tzkt.io",
  },
};

const clients = new Map<ChainKey, PublicClient>();

/**
 * Get a viem PublicClient for an EVM chain.
 * Throws for non-EVM chains (Tezos) since viem doesn't support them.
 */
export function getClient(key: ChainKey): PublicClient {
  const existing = clients.get(key);
  if (existing) return existing;

  const cfg = CHAINS[key];
  if (!cfg.chain) {
    throw new Error(
      `${cfg.name} is not an EVM chain. Direct RPC calls via viem are not supported. ` +
      `Use the onchfs package or IPFS resolver instead.`,
    );
  }

  const client = createPublicClient({
    chain: cfg.chain,
    transport: fallback(
      cfg.rpcs.map((url) => http(url, { timeout: 10_000 })),
      { rank: true, retryCount: 2 },
    ),
  });

  clients.set(key, client);
  return client;
}
