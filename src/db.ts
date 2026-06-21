import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * Search Frequency DB (doc2:108-113) — the primary, durable store of `query -> count`.
 * This is NOT the suggestions cache; it only holds counts/scores. Suggestions are computed
 * from here on a cache miss and served from Redis (the "Top Suggestions DB" / cache).
 */
export const DB_PATH =
  process.env.DB_PATH ?? join(import.meta.dirname, "..", "data", "typeahead.db");

export function openDb(path: string = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(path);
  // WAL = concurrent reads during a write; NORMAL sync is fine because the NFRs allow a tiny
  // amount of data loss on crash (doc1:305-308).
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
  // No secondary index on `score`: EXPLAIN QUERY PLAN shows the suggest queries filter by the
  // `query` PK range and then sort the (already small) matched set, so an index on `score` is
  // never used for reads — it would only add write overhead (every search + every decay step
  // would have to maintain it). Drop it if a previous build created it.
  db.exec(`DROP INDEX IF EXISTS idx_queries_score;`);
}

/**
 * Shared UPSERT for recording searches: insert a new query (count = score = delta) or add the
 * delta to an existing one. Used by both ingestion and the batch writer (single source of truth).
 * A search bumps BOTH all-time `count` and recency `score` by the same delta — the "+ today's
 * count" half of the notes' `score = 0.9*old + today` model (doc2:713-715).
 */
export const UPSERT_QUERY_SQL = `
  INSERT INTO queries (query, display, count, score)
  VALUES (:query, :display, :count, :count)
  ON CONFLICT(query) DO UPDATE SET
    count = count + excluded.count,
    score = score + excluded.count`;
