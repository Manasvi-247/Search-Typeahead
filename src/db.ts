import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const DB_PATH =
  process.env.DB_PATH ?? join(import.meta.dirname, "..", "data", "typeahead.db");

export function openDb(path: string = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(path);

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

  db.exec(`DROP INDEX IF EXISTS idx_queries_score;`);
}

export const UPSERT_QUERY_SQL = `
  INSERT INTO queries (query, display, count, score)
  VALUES (:query, :display, :count, :count)
  ON CONFLICT(query) DO UPDATE SET
    count = count + excluded.count,
    score = score + excluded.count`;
