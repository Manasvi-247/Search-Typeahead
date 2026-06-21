import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchWriter } from "../src/batch.ts";
import { SuggestService } from "../src/suggest.ts";
import { cacheKey } from "../src/config.ts";
import { makeDb, makeCache } from "./helpers.ts";

type Row = { count: number };

test("buffers + aggregates repeats; flush writes once per unique query (write reduction)", async () => {
  const db = makeDb([{ q: "iphone 15", count: 200 }]);
  const bw = new BatchWriter(db, makeCache());

  for (let i = 0; i < 5; i++) bw.record("iphone 15");
  bw.record("brand new gadget");

  assert.equal((db.prepare("SELECT count FROM queries WHERE query='iphone 15'").get() as Row).count, 200);

  await bw.flush("manual");

  const stats = bw.stats();
  assert.equal(stats.totalEvents, 6);
  assert.equal(stats.totalDbWrites, 2, "6 events should collapse to 2 unique upserts");

  assert.equal((db.prepare("SELECT count FROM queries WHERE query='iphone 15'").get() as Row).count, 205);

  assert.equal(
    (db.prepare("SELECT count FROM queries WHERE query='brand new gadget'").get() as Row).count,
    1
  );
});

test("flush invalidates cached prefixes for BOTH rankings", async () => {
  const db = makeDb([{ q: "iphone 15", count: 200 }]);
  const cache = makeCache();
  const svc = new SuggestService(db, cache);

  await svc.suggest("iphone", "count");
  await svc.suggest("iphone", "recent");
  assert.equal((await cache.route(cacheKey("iphone", "count"))).hit, true);
  assert.equal((await cache.route(cacheKey("iphone", "recent"))).hit, true);

  const bw = new BatchWriter(db, cache);
  bw.record("iphone 15");
  await bw.flush("manual");

  assert.equal((await cache.route(cacheKey("iphone", "count"))).hit, false);
  assert.equal((await cache.route(cacheKey("iphone", "recent"))).hit, false);
});

test("empty flush is a no-op", async () => {
  const bw = new BatchWriter(makeDb([]), makeCache());
  await bw.flush("manual");
  assert.equal(bw.stats().flushes, 0);
});
