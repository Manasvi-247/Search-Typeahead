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

interface Pending {
  display: string;
  delta: number;
}

export interface BatchStats {
  flushes: number;
  totalEvents: number;
  totalDbWrites: number;
  totalInvalidations: number;
  pendingEvents: number;
  pendingQueries: number;
  pending: Array<{ q: string; n: number }>;
  writesSavedPct: number;
  batchSize: number;
  flushIntervalSec: number;
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

    async flush(reason: "size" | "interval" | "shutdown" | "manual"): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;

    const snapshot = this.buffer;
    const events = this.pendingEvents;
    this.buffer = new Map();
    this.pendingEvents = 0;

    try {

      this.db.exec("BEGIN");
      for (const [query, p] of snapshot) {
        this.upsert.run({ query, display: p.display, count: p.delta });
      }
      this.db.exec("COMMIT");

      const keys: Set<string> = new Set();
      for (const query of snapshot.keys()) {
        const cap = Math.min(query.length, PREFIX_INVALIDATION_CAP);
        for (let i = MIN_PREFIX; i <= cap; i++) {
          const prefix = query.slice(0, i);
          if (prefix.endsWith(" ")) continue;
          for (const rank of RANKS) keys.add(cacheKey(prefix, rank));
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
      pending: [...this.buffer.entries()].map(([q, p]) => ({ q, n: p.delta })),
      writesSavedPct:
        this.totalEvents > 0 ? Math.round((1 - this.totalDbWrites / this.totalEvents) * 100) : 0,
      batchSize: BATCH_SIZE,
      flushIntervalSec: Math.round(FLUSH_INTERVAL_MS / 1000),
    };
  }
}
