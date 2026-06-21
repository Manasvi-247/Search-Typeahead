import { test } from "node:test";
import assert from "node:assert/strict";
import { SuggestService } from "../src/suggest.ts";
import { DistributedCache, type CacheNode } from "../src/cache.ts";
import { makeDb, makeCache } from "./helpers.ts";

const seed = [
  { q: "iphone charger", count: 100 },
  { q: "iphone case", count: 50 },
  { q: "iphone 15", count: 200 },
  { q: "ipad mini", count: 70 },
  { q: "yoga mat", count: 30 },
];

test("cache-aside: miss computes from DB (sorted by count), hit serves from cache", async () => {
  const svc = new SuggestService(makeDb(seed), makeCache());
  const r1 = await svc.suggest("iphone");
  assert.equal(r1.cache, "miss");
  assert.equal(r1.suggestions.length, 3);
  assert.equal(r1.suggestions[0].query, "iphone 15");
  assert.equal(r1.suggestions[1].query, "iphone charger");

  const r2 = await svc.suggest("iphone");
  assert.equal(r2.cache, "hit");
  assert.deepEqual(r2.suggestions, r1.suggestions);
});

test("mixed-case prefix maps to the same normalized cache entry", async () => {
  const svc = new SuggestService(makeDb(seed), makeCache());
  await svc.suggest("iphone");
  assert.equal((await svc.suggest("IPHONE")).cache, "hit");
});

test("empty / whitespace input returns [] gracefully (skip)", async () => {
  const svc = new SuggestService(makeDb(seed), makeCache());
  const r = await svc.suggest("   ");
  assert.equal(r.cache, "skip");
  assert.equal(r.suggestions.length, 0);
});

test("prefix with no matches returns []", async () => {
  const svc = new SuggestService(makeDb(seed), makeCache());
  assert.equal((await svc.suggest("zzz")).suggestions.length, 0);
});

test("rank=recent orders by score, rank=count orders by count", async () => {
  const db = makeDb([
    { q: "iphone big", count: 1000, score: 1 },
    { q: "iphone trend", count: 10, score: 999 },
  ]);
  const svc = new SuggestService(db, makeCache());
  assert.equal((await svc.suggest("iphone", "count")).suggestions[0].query, "iphone big");
  assert.equal((await svc.suggest("iphone", "recent")).suggestions[0].query, "iphone trend");
});

test("fail-open: a cache error still returns DB results (no cascade)", async () => {
  class ThrowingNode implements CacheNode {
    id = "boom";
    async get(): Promise<string | null> {
      throw new Error("cache down");
    }
    async set(): Promise<void> {
      throw new Error("cache down");
    }
    async del(): Promise<void> {}
    async delMany(): Promise<number> {
      return 0;
    }
  }
  const svc = new SuggestService(makeDb(seed), new DistributedCache([new ThrowingNode()]));
  const r = await svc.suggest("iphone");
  assert.equal(r.cache, "miss");
  assert.equal(r.suggestions[0].query, "iphone 15");
});
