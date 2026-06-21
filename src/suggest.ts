import type { DatabaseSync, StatementSync } from "node:sqlite";
import { normalize } from "./normalize.ts";
import { DistributedCache } from "./cache.ts";
import { SUGGEST_LIMIT, CACHE_TTL_SECONDS, cacheKey, type Rank } from "./config.ts";

export interface Suggestion {
  query: string;
  count: number;
  score: number;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  cache: "hit" | "miss" | "skip";
  node: string;
  rank: Rank;
}

export function prefixUpperBound(p: string): string {
  const lastCp = p.codePointAt(p.length - 1)!;

  if (lastCp >= 0x10ffff) return p + "\u{10ffff}";
  return p.slice(0, -(String.fromCodePoint(lastCp).length)) + String.fromCodePoint(lastCp + 1);
}

export class SuggestService {
  private cache: DistributedCache;

  private byCount: StatementSync;
  private byScore: StatementSync;
  private globalByCount: StatementSync;
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
    this.byCount = prefixed("count");
    this.byScore = prefixed("score");
    this.globalByCount = db.prepare(`SELECT display, count, score FROM queries ORDER BY count DESC LIMIT :k`);
    this.globalByScore = db.prepare(`SELECT display, count, score FROM queries ORDER BY score DESC LIMIT :k`);
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM queries`);
  }

    datasetSize(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

    trending(rank: Rank, limit: number): Suggestion[] {
    const stmt = rank === "recent" ? this.globalByScore : this.globalByCount;
    const rows = stmt.all({ k: limit }) as Array<{ display: string; count: number; score: number }>;
    return rows.map((r) => ({ query: r.display, count: r.count, score: r.score }));
  }

    cacheStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total ? Math.round((this.hits / total) * 100) : 0 };
  }

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

    if (prefix === "") return { suggestions: [], cache: "skip", node: "", rank };

    const key = cacheKey(prefix, rank);
    const node = this.cache.nodeFor(key);

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
