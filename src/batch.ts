import type { DatabaseSync, StatementSync } from "node:sqlite";
import { normalize } from "./normalize.ts";
import { UPSERT_QUERY_SQL } from "./db.ts";
import { DistributedCache } from "./cache.ts";
import {
  cacheKey,
  RANKS,
  BATCH_SIZE,
  FLUSH_INTERVAL_MS,
  MIN_PREFIX,
  PREFIX_INVALIDATION_CAP,
} from "./config.ts";

/**
 * Batch writer (doc2:464-553).
 *
 * `record()` does NOT touch the DB — it just buffers the event in memory, aggregating
 * repeated queries (ass.txt:143). A flush (triggered by BATCH_SIZE events or a timer) then:
 *   1. writes one aggregated UPSERT per unique query to the Frequency DB, in a single
 *      transaction  -> this is the write reduction;
 *   2. invalidates the cached suggestion lists for the affected prefixes, so the next
 *      /suggest recomputes fresh (cache-aside form of the notes' update_prefixes).
 *
 * Crash trade-off (ass.txt:146): events buffered but not yet flushed are lost on a hard
 * crash -> counts off by a small amount, acceptable per the NFRs (doc1:305-308). A clean
 * shutdown flushes first. Mitigations in prod: shorter interval, or a write-ahead log.
 */

interface Pending {
  display: string;
  delta: number;
}

export interface BatchStats {
  flushes: number;
  totalEvents: number; // search events recorded (cumulative)
  totalDbWrites: number; // aggregated upserts actually executed (cumulative)
  totalInvalidations: number;
  pendingEvents: number; // currently buffered, not yet flushed
  pendingQueries: number;
}

export class BatchWriter {
  private db: DatabaseSync;
  private cache: DistributedCache;
  private upsert: StatementSync;

  private buffer: Map<string, Pending> = new Map();
  private pendingEvents = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private flushes = 0;
  private totalEvents = 0;
  private totalDbWrites = 0;
  private totalInvalidations = 0;

  constructor(db: DatabaseSync, cache: DistributedCache) {
    this.db = db;
    this.cache = cache;
    this.upsert = db.prepare(UPSERT_QUERY_SQL);
  }

  /** Buffer one search. Aggregates repeats. No DB write here (that's the point). */
  record(rawQuery: string): void {
    const query = normalize(rawQuery);
    if (query === "") return;
    const existing = this.buffer.get(query);
    if (existing) existing.delta += 1;
    else this.buffer.set(query, { display: rawQuery.trim(), delta: 1 });
    this.pendingEvents += 1;
    if (this.pendingEvents >= BATCH_SIZE) void this.flush("size");
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => void this.flush("interval"), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Apply the buffer to the DB (one transaction) and invalidate affected prefixes. */
  async flush(reason: "size" | "interval" | "shutdown" | "manual"): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    // Snapshot + clear synchronously so concurrent record()s land in the next batch.
    const snapshot = this.buffer;
    const events = this.pendingEvents;
    this.buffer = new Map();
    this.pendingEvents = 0;

    try {
      // (1) Batched, aggregated write to the Frequency DB — one upsert per unique query.
      this.db.exec("BEGIN");
      for (const [query, p] of snapshot) {
        this.upsert.run({ query, display: p.display, count: p.delta });
      }
      this.db.exec("COMMIT");

      // (2) Invalidate the cached suggestion lists for every affected prefix.
      // Build a DEDUPED key set (prefixes overlap across queries), then hand it to
      // delMany, which issues one variadic DEL per node — not one DEL per key (N+1).
      const keys: Set<string> = new Set();
      for (const query of snapshot.keys()) {
        const cap = Math.min(query.length, PREFIX_INVALIDATION_CAP);
        for (let i = MIN_PREFIX; i <= cap; i++) {
          const prefix = query.slice(0, i);
          if (prefix.endsWith(" ")) continue; // never a real normalized cache key
          for (const rank of RANKS) keys.add(cacheKey(prefix, rank)); // both rankings stale
        }
      }
      await this.cache.delMany([...keys]);

      this.flushes += 1;
      this.totalEvents += events;
      this.totalDbWrites += snapshot.size;
      this.totalInvalidations += keys.size;
      console.log(
        `[batch] flush(${reason}): events=${events} dbWrites=${snapshot.size} ` +
          `invalidations=${keys.size} (reduction ${events}->${snapshot.size})`
      );
    } catch (err) {
      console.error("[batch] flush failed:", err);
    } finally {
      this.flushing = false;
    }
  }

  stats(): BatchStats {
    return {
      flushes: this.flushes,
      totalEvents: this.totalEvents,
      totalDbWrites: this.totalDbWrites,
      totalInvalidations: this.totalInvalidations,
      pendingEvents: this.pendingEvents,
      pendingQueries: this.buffer.size,
    };
  }
}
