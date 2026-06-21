/** Central config for the cache layer and suggestion serving. */

export interface NodeConfig {
  id: string;
  host: string;
  port: number;
}

/** The 3 logical Redis cache nodes (started by scripts/redis-start.sh). */
export const CACHE_NODES: NodeConfig[] = [
  { id: "redis-0", host: "127.0.0.1", port: 6379 },
  { id: "redis-1", host: "127.0.0.1", port: 6380 },
  { id: "redis-2", host: "127.0.0.1", port: 6381 },
];

/** Max suggestions returned (assignment: at most 10). */
export const SUGGEST_LIMIT = 10;

/** Cache entry TTL. Satisfies "cache should support expiry" (ass.txt:108) and bounds how
 *  stale a suggestion list can be after counts change (eventual consistency, doc1:260-265). */
export const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 300);

/** Ranking modes: "count" = all-time popularity (basic, 60%); "recent" = recency-aware
 *  decayed score (trending, 20%). The same /suggest API serves both (ass.txt:124). */
export type Rank = "count" | "recent";
export const RANKS: Rank[] = ["count", "recent"];

/** Redis key for a prefix's cached suggestion list. Keyed by rank too, since the two
 *  rankings produce different lists for the same prefix. */
export const cacheKey = (prefix: string, rank: Rank = "count"): string => `sug:${rank}:${prefix}`;

export const HTTP_PORT = Number(process.env.PORT ?? 3000);

/* ---- Batch writes (doc2:464-553) ----------------------------------------- *
 * Search events are buffered and flushed in one go, instead of writing the DB +
 * cache on every request. Kept small by default so flushes are visible in a demo. */

/** Flush once this many buffered search EVENTS accumulate (the "batch size"). */
export const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);

/** Also flush on this timer, so a half-full buffer doesn't sit forever. */
export const FLUSH_INTERVAL_MS = Number(process.env.FLUSH_INTERVAL_MS ?? 2000);

/** Shortest prefix we serve/invalidate. Notes start at 3 (doc1:152-154); we use 1 so the
 *  demo shows suggestions from the first letter. */
export const MIN_PREFIX = Number(process.env.MIN_PREFIX ?? 1);

/** On flush we invalidate the changed query's prefixes. Real users never type a 100-char
 *  prefix, so cap the work; longer cached prefixes still expire via TTL. */
export const PREFIX_INVALIDATION_CAP = Number(process.env.PREFIX_INVALIDATION_CAP ?? 40);

/* ---- Trending / recency decay (doc2:712-737) ----------------------------- *
 * Every interval, score := score * DECAY_FACTOR. Historical popularity fades; freshly
 * searched queries rise. Default interval is short so trending is visible in a demo. */
export const DECAY_FACTOR = Number(process.env.DECAY_FACTOR ?? 0.9);
export const DECAY_INTERVAL_MS = Number(process.env.DECAY_INTERVAL_MS ?? 60000);
