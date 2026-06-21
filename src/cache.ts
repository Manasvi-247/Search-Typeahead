import { Redis } from "ioredis";
import { HashRing } from "./ring.ts";
import { CACHE_NODES, CACHE_COMMAND_TIMEOUT_MS } from "./config.ts";

export interface CacheNode {
  id: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  delMany(keys: string[]): Promise<number>;
  size(): Promise<number>;
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
      commandTimeout: CACHE_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });

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

    async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  size(): Promise<number> {
    return this.client.dbsize();
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

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

  async size(): Promise<number> {
    return this.store.size;
  }
}

export interface RoutingInfo {
  node: string;
  hit: boolean;
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

    async route(key: string): Promise<RoutingInfo> {
    const node = this.nodeFor(key);
    const value = await node.get(key);
    return { node: node.id, hit: value !== null };
  }

  ringIds(): string[] {
    return this.ring.nodeIds();
  }

    async nodeStats(): Promise<Array<{ id: string; keys: number; ok: boolean }>> {
    return Promise.all(
      this.ring.nodeIds().map(async (id) => {
        try {
          return { id, keys: await this.byId.get(id)!.size(), ok: true };
        } catch {
          return { id, keys: 0, ok: false };
        }
      })
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.byId.values()].map((n) => n.close?.() ?? Promise.resolve()));
  }
}

export function createRedisCache(): DistributedCache {
  return new DistributedCache(CACHE_NODES.map((c) => new RedisCacheNode(c.id, c.host, c.port)));
}
