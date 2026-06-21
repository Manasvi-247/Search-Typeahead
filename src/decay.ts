import type { DatabaseSync, StatementSync } from "node:sqlite";
import { DECAY_FACTOR, DECAY_INTERVAL_MS } from "./config.ts";

export class Decayer {
  private decayStmt: StatementSync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runs = 0;

  constructor(db: DatabaseSync) {
    this.decayStmt = db.prepare(`UPDATE queries SET score = score * :f`);
  }

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
