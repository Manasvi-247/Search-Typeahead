import type { DatabaseSync, StatementSync } from "node:sqlite";
import { normalize } from "./normalize.ts";
import { DistributedCache } from "./cache.ts";
import { SUGGEST_LIMIT, CACHE_TTL_SECONDS, cacheKey, type Rank } from "./config.ts";

/**
 * Suggestion serving — the cache-aside read path (Approach 2).
 *
 *   normalize(prefix) -> ring picks a Redis node -> GET
 *     hit  : return cached top-k          (the fast path, doc2:240-252)
 *     miss : compute top-k from the Frequency DB (SQLite prefix range scan),
 *            cache it with a TTL, return  (fallback to primary store, ass.txt:106)
 */

export interface Suggestion {
  query: string;
  count: number; // all-time
  score: number; // recency-decayed
}

export interface SuggestResult {
  suggestions: Suggestion[];
  cache: "hit" | "miss" | "skip";
  node: string;
  rank: Rank;
}

/** Smallest string strictly greater than every string starting with `p`.
 *  Lets the prefix match become an indexed range scan: query >= p AND query < upperBound(p). */
export function prefixUpperBound(p: string): string {
  const lastCp = p.codePointAt(p.length - 1)!;
  // Bump the final code point by one. (Guard: U+10FFFF is the max code point; normalized
  // product titles never end there, so this branch is effectively unreachable.)
  if (lastCp >= 0x10ffff) return p + "\u{10ffff}";
  return p.slice(0, -(String.fromCodePoint(lastCp).length)) + String.fromCodePoint(lastCp + 1);
}

export class SuggestService {
  private cache: DistributedCache;
  // One prepared statement per ranking mode (the ORDER BY column can't be bound as a param).
  private byCount: StatementSync;
  private byScore: StatementSync;
  private globalByCount: StatementSync; // global top-N (no prefix) for the trending panel
  private globalByScore: StatementSync;
  private countStmt: StatementSync;
  private hits = 0;
  private misses = 0;

  constructor(db: DatabaseSync, cache: DistributedCache) {
    this.cache = cache;
    const prefixed = (orderCol: string) =>
      db.prepare(
        `SELECT display, count, score FROM queries
         WHERE query >= :lo AND query < :hi
         ORDER BY ${orderCol} DESC
         LIMIT :k`
      );
    this.byCount = prefixed("count"); // basic ranking (60%)
    this.byScore = prefixed("score"); // recency-aware ranking (20%)
    this.globalByCount = db.prepare(`SELECT display, count, score FROM queries ORDER BY count DESC LIMIT :k`);
    this.globalByScore = db.prepare(`SELECT display, count, score FROM queries ORDER BY score DESC LIMIT :k`);
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM queries`);
  }

  /** Total number of queries loaded — shown in the header. */
  datasetSize(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /** Global top-N (no prefix) — powers the "Trending now" panel (ass.txt:152). */
  trending(rank: Rank, limit: number): Suggestion[] {
    const stmt = rank === "recent" ? this.globalByScore : this.globalByCount;
    const rows = stmt.all({ k: limit }) as Array<{ display: string; count: number; score: number }>;
    return rows.map((r) => ({ query: r.display, count: r.count, score: r.score }));
  }

  /** Cumulative cache hit/miss counters for the cache panel + perf report (ass.txt:160). */
  cacheStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total ? Math.round((this.hits / total) * 100) : 0 };
  }

  /** Compute top-k for a (normalized, non-empty) prefix directly from the Frequency DB. */
  computeFromDb(prefix: string, rank: Rank): Suggestion[] {
    const stmt = rank === "recent" ? this.byScore : this.byCount;
    const rows = stmt.all({
      lo: prefix,
      hi: prefixUpperBound(prefix),
      k: SUGGEST_LIMIT,
    }) as Array<{ display: string; count: number; score: number }>;
    return rows.map((r) => ({ query: r.display, count: r.count, score: r.score }));
  }

  async suggest(rawPrefix: string, rank: Rank = "count"): Promise<SuggestResult> {
    const prefix = normalize(rawPrefix);
    // Empty/missing input -> return nothing gracefully (ass.txt:66).
    if (prefix === "") return { suggestions: [], cache: "skip", node: "", rank };

    const key = cacheKey(prefix, rank);
    const node = this.cache.nodeFor(key);

    // Fail-open: a cache error must NOT break suggestions — fall back to the DB (guideline §10).
    try {
      const cached = await node.get(key);
      if (cached !== null) {
        this.hits++;
        return { suggestions: JSON.parse(cached), cache: "hit", node: node.id, rank };
      }
    } catch (err) {
      console.error(`[cache] get failed for ${key}, serving from DB:`, (err as Error).message);
    }

    this.misses++;
    const suggestions = this.computeFromDb(prefix, rank);
    try {
      await node.set(key, JSON.stringify(suggestions), CACHE_TTL_SECONDS);
    } catch (err) {
      console.error(`[cache] set failed for ${key}:`, (err as Error).message);
    }
    return { suggestions, cache: "miss", node: node.id, rank };
  }
}
