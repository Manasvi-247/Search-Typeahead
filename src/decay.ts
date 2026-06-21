import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DECAY_FACTOR, DECAY_INTERVAL_MS } from "./config.ts";

/**
 * Recency decay (doc2:712-737).
 *
 * Periodically multiplies every query's `score` by DECAY_FACTOR (< 1). All-time `count` is
 * untouched. So historical popularity fades, while queries that were just searched (their
 * score bumped by the batch writer) stay high — that's what makes `score` a *trending*
 * signal rather than an all-time one. Matches the notes' "new = 0.9*old + today" model:
 * the decay supplies the 0.9*old, the batch writer supplies the +today.
 *
 * Why decay needs no cache invalidation: multiplying every score by the same factor
 * preserves their relative ORDER. Rankings only change when fresh searches add to specific
 * queries (handled by the batch writer's invalidation). Absolute cached scores may lag by up
 * to one TTL — acceptable under eventual consistency (doc1:260-265).
 *
 * Avoiding permanent over-ranking (ass.txt:121): a query that spikes then goes quiet keeps
 * getting multiplied down every interval and is overtaken by currently-active queries.
 */
export class Decayer {
  private decayStmt: StatementSync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runs = 0;

  constructor(db: DatabaseSync) {
    this.decayStmt = db.prepare(`UPDATE queries SET score = score * :f`);
  }

  /** Apply one decay step to every query's score. */
  run(): void {
    this.decayStmt.run({ f: DECAY_FACTOR });
    this.runs += 1;
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.run();
        console.log(`[decay] applied factor ${DECAY_FACTOR} (run #${this.runs})`);
      }, DECAY_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stats(): { runs: number; factor: number; intervalMs: number } {
    return { runs: this.runs, factor: DECAY_FACTOR, intervalMs: DECAY_INTERVAL_MS };
  }
}
