import { Redis } from "ioredis";
import { HashRing } from "./ring.ts";
import { CACHE_NODES } from "./config.ts";

/**
 * Top Suggestions DB (doc2:111) — the distributed CACHE, sitting in front of the
 * Frequency DB. Stores `prefix -> top-k suggestions` (as JSON).
 *
 * The CacheNode interface keeps the consistent-hashing ring independent of the backend, so
 * the 3 logical nodes could be Redis, in-memory maps, etc. without touching routing logic.
 */
export interface CacheNode {
  id: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

class RedisCacheNode implements CacheNode {
  id: string;
  private client: Redis;

  constructor(id: string, host: string, port: number) {
    this.id = id;
    this.client = new Redis({ host, port, lazyConnect: false });
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}

export interface RoutingInfo {
  node: string; // which logical node owns this key
  hit: boolean; // was the key present on that node
}

export class DistributedCache {
  private ring: HashRing;
  private byId: Map<string, RedisCacheNode> = new Map();

  constructor() {
    for (const c of CACHE_NODES) {
      this.byId.set(c.id, new RedisCacheNode(c.id, c.host, c.port));
    }
    this.ring = new HashRing(CACHE_NODES.map((c) => c.id));
  }

  /** The logical node responsible for this key, per the consistent-hashing ring. */
  nodeFor(key: string): CacheNode {
    const id = this.ring.getNode(key);
    return this.byId.get(id)!;
  }

  async get(key: string): Promise<string | null> {
    return this.nodeFor(key).get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.nodeFor(key).set(key, value, ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.nodeFor(key).del(key);
  }

  /** Backs GET /cache/debug: which node owns the key, and whether it's currently a hit. */
  async route(key: string): Promise<RoutingInfo> {
    const node = this.nodeFor(key);
    const value = await node.get(key);
    return { node: node.id, hit: value !== null };
  }

  ringIds(): string[] {
    return this.ring.nodeIds();
  }

  async close(): Promise<void> {
    await Promise.all([...this.byId.values()].map((n) => n.quit()));
  }
}
