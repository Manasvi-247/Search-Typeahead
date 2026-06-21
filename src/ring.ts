import { createHash } from "node:crypto";

export function hash32(s: string): number {
  return createHash("md5").update(s).digest().readUInt32BE(0);
}

interface RingEntry {
  hash: number;
  node: string;
}

export class HashRing {
  private ring: RingEntry[] = [];
  private nodes = new Set<string>();
  private readonly vnodes: number;

  constructor(nodes: string[] = [], vnodes = 150) {
    this.vnodes = vnodes;
    for (const n of nodes) this.add(n, false);
    this.resort();
  }

  private resort(): void {
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  add(node: string, resort = true): void {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.vnodes; i++) {
      this.ring.push({ hash: hash32(`${node}#${i}`), node });
    }
    if (resort) this.resort();
  }

  remove(node: string): void {
    if (!this.nodes.delete(node)) return;
    this.ring = this.ring.filter((e) => e.node !== node);
  }

    getNode(key: string): string {
    if (this.ring.length === 0) throw new Error("HashRing is empty");
    const h = hash32(key);
    const last = this.ring[this.ring.length - 1];
    if (h > last.hash) return this.ring[0].node;

    let lo = 0;
    let hi = this.ring.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash >= h) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return this.ring[ans].node;
  }

  nodeIds(): string[] {
    return [...this.nodes];
  }
}
