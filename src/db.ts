import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * Search Frequency DB (doc2:108–113) — the primary, durable store of `query -> count`.
 * This is NOT the suggestions cache; it only holds counts. Suggestions are computed from
 * here on a cache miss and served from Redis (the "Top Suggestions DB" / cache).
 */
export const DB_PATH =
  process.env.DB_PATH ?? join(import.meta.dirname, "..", "data", "typeahead.db");

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  // WAL = better concurrent read/write; NORMAL sync is fine because the NFRs allow a tiny
  // amount of data loss on crash (doc1:305–308).
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      query   TEXT PRIMARY KEY,  -- normalized: lowercased, trimmed, single-spaced
      display TEXT NOT NULL,      -- original product title, shown to the user
      count   INTEGER NOT NULL,   -- all-time popularity (basic ranking, 60%)
      score   REAL NOT NULL       -- recency-decayed popularity (trending ranking, 20%)
    );
  `);
  // Index on score so the recency-ranked prefix scan can sort efficiently.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_queries_score ON queries(score);`);
  // The PRIMARY KEY on `query` gives an ordered index, which is exactly what a prefix
  // range scan needs:  WHERE query >= :p AND query < :p || x  (the cache-miss compute path).
}
