import { Redis } from "ioredis";
import { HashRing } from "./ring.ts";
import { CACHE_NODES, CACHE_COMMAND_TIMEOUT_MS } from "./config.ts";

/**
 * Top Suggestions DB (doc2:111) — the distributed CACHE in front of the Frequency DB.
 * Stores `prefix -> top-k suggestions` (JSON).
 *
 * The CacheNode interface keeps the consistent-hashing ring independent of the backend, so the
 * logical nodes can be Redis (prod) or in-memory maps (tests / the assignment's "logical
 * nodes" option) without touching routing logic. DistributedCache takes its nodes by
 * injection, which is what makes the suggest/batch services unit-testable.
 */
export interface CacheNode {
  id: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  delMany(keys: string[]): Promise<number>;
  close?(): Promise<void>;
}

export class RedisCacheNode implements CacheNode {
  id: string;
  private client: Redis;

  constructor(id: string, host: string, port: number) {
    this.id = id;
    this.client = new Redis({
      host,
      port,
      lazyConnect: false,
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS, // fail fast instead of hanging the request
      enableOfflineQueue: false, // when the node is down, error now rather than queue forever
      maxRetriesPerRequest: 1,
    });
    // Without a listener, ioredis throws unhandled 'error' events when a node is down.
    this.client.on("error", () => {});
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

  /** One variadic DEL command for all keys on this node (Redis DEL is variadic). */
  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/** In-memory cache node — used by tests (no Redis needed) and usable as a "logical node". */
export class InMemoryCacheNode implements CacheNode {
  id: string;
  private store: Map<string, { value: string; expireAt: number }> = new Map();

  constructor(id: string) {
    this.id = id;
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expireAt !== 0 && e.expireAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expireAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0 });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delMany(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
}

export interface RoutingInfo {
  node: string; // which logical node owns this key
  hit: boolean; // was the key present on that node
}

export class DistributedCache {
  private ring: HashRing;
  private byId: Map<string, CacheNode> = new Map();

  constructor(nodes: CacheNode[], vnodes?: number) {
    for (const n of nodes) this.byId.set(n.id, n);
    this.ring = new HashRing(
      nodes.map((n) => n.id),
      vnodes
    );
  }

  /** The logical node responsible for this key, per the consistent-hashing ring. */
  nodeFor(key: string): CacheNode {
    return this.byId.get(this.ring.getNode(key))!;
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

  /** Delete many keys with the fewest round-trips: group by owning node (via the ring),
   *  then one variadic DEL per node. Turns an N+1 (one DEL per key) into <=#nodes commands. */
  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const byNode: Map<string, string[]> = new Map();
    for (const key of keys) {
      const id = this.ring.getNode(key);
      const bucket = byNode.get(id);
      if (bucket) bucket.push(key);
      else byNode.set(id, [key]);
    }
    const counts = await Promise.all(
      [...byNode.entries()].map(([id, ks]) => this.byId.get(id)!.delMany(ks))
    );
    return counts.reduce((a, b) => a + b, 0);
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
    await Promise.all([...this.byId.values()].map((n) => n.close?.() ?? Promise.resolve()));
  }
}

/** Production cache: 3 Redis-backed logical nodes (started by scripts/redis-start.sh). */
export function createRedisCache(): DistributedCache {
  return new DistributedCache(CACHE_NODES.map((c) => new RedisCacheNode(c.id, c.host, c.port)));
}
