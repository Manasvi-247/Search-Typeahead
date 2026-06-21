import { createHash } from "node:crypto";

/**
 * Consistent hashing ring (the explicit version of doc2:422-431 "sharding by hash(key)").
 *
 * Key-value stores shard automatically; the assignment (ass.txt:110) asks us to implement
 * that routing ourselves so we control which logical cache node owns each prefix.
 *
 * Design:
 *  - Each physical node is placed on a 2^32 ring at VNODES positions ("virtual nodes").
 *    Virtual nodes spread each physical node's ownership evenly around the ring, so load is
 *    balanced even with only 3 nodes, and adding/removing a node remaps only ~1/N of keys
 *    instead of everything (the whole point of consistent hashing).
 *  - getNode(key): hash the key, then walk CLOCKWISE to the first virtual node at or after
 *    that position (wrapping past the end back to the start). That vnode's physical node owns
 *    the key.
 */

/** Stable 32-bit unsigned hash. md5 is overkill cryptographically but gives an excellent,
 *  well-documented distribution — a common, defensible choice for consistent-hashing rings. */
export function hash32(s: string): number {
  return createHash("md5").update(s).digest().readUInt32BE(0);
}

interface RingEntry {
  hash: number;
  node: string;
}

export class HashRing {
  private ring: RingEntry[] = []; // kept sorted by hash ascending
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

  /** Return the physical node that owns `key` (first vnode clockwise from hash(key)). */
  getNode(key: string): string {
    if (this.ring.length === 0) throw new Error("HashRing is empty");
    const h = hash32(key);
    const last = this.ring[this.ring.length - 1];
    if (h > last.hash) return this.ring[0].node; // wrap around the ring

    // binary search: first entry with hash >= h
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
