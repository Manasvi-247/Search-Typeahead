import type { DatabaseSync } from "node:sqlite";
import { openDb, initSchema } from "../src/db.ts";
import { DistributedCache, InMemoryCacheNode } from "../src/cache.ts";
import { normalize } from "../src/normalize.ts";

export interface SeedRow {
  q: string;
  count: number;
  score?: number; // defaults to count
}

/** Fresh in-memory Frequency DB seeded with rows. Each call is fully isolated. */
export function makeDb(rows: SeedRow[]): DatabaseSync {
  const db = openDb(":memory:");
  initSchema(db);
  const ins = db.prepare("INSERT INTO queries (query, display, count, score) VALUES (?,?,?,?)");
  for (const r of rows) ins.run(normalize(r.q), r.q, r.count, r.score ?? r.count);
  return db;
}

/** Distributed cache backed by N in-memory nodes (no Redis needed in tests). */
export function makeCache(nodes = 3): DistributedCache {
  return new DistributedCache(
    Array.from({ length: nodes }, (_, i) => new InMemoryCacheNode(`mem-${i}`))
  );
}
