export interface NodeConfig {
  id: string;
  host: string;
  port: number;
}

function loadCacheNodes(): NodeConfig[] {
  const raw = process.env.REDIS_NODES?.trim();
  if (raw) {
    return raw.split(",").map((entry, i) => {
      const [host, port] = entry.trim().split(":");
      return { id: `redis-${i}`, host, port: Number(port ?? 6379) };
    });
  }
  return [
    { id: "redis-0", host: "127.0.0.1", port: 6379 },
    { id: "redis-1", host: "127.0.0.1", port: 6380 },
    { id: "redis-2", host: "127.0.0.1", port: 6381 },
  ];
}

export const CACHE_NODES: NodeConfig[] = loadCacheNodes();

export const SUGGEST_LIMIT = 10;

export const MAX_QUERY_LEN = Number(process.env.MAX_QUERY_LEN ?? 512);

export const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 300);

export const CACHE_COMMAND_TIMEOUT_MS = Number(process.env.CACHE_COMMAND_TIMEOUT_MS ?? 100);

export type Rank = "count" | "recent";
export const RANKS: Rank[] = ["count", "recent"];

export const cacheKey = (prefix: string, rank: Rank = "count"): string => `sug:${rank}:${prefix}`;

export const HTTP_PORT = Number(process.env.PORT ?? 3000);

export const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);

export const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 2000);

export const MIN_PREFIX = Number(process.env.MIN_PREFIX ?? 1);

export const PREFIX_INVALIDATION_CAP = Number(process.env.PREFIX_INVALIDATION_CAP ?? 40);

export const DECAY_FACTOR = Number(process.env.DECAY_FACTOR ?? 0.9);
export const DECAY_INTERVAL_MS = Number(process.env.DECAY_INTERVAL_MS ?? 60000);
