import { test } from "node:test";
import assert from "node:assert/strict";
import { HashRing } from "../src/ring.ts";

test("distributes keys across all nodes", () => {
  const ring = new HashRing(["a", "b", "c"]);
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 6000; i++) counts[ring.getNode("k" + i)]++;
  for (const n of ["a", "b", "c"]) {
    assert.ok(counts[n] > 6000 * 0.2, `node ${n} under-loaded: ${counts[n]}`);
  }
});

test("getNode is deterministic across ring instances", () => {
  const r1 = new HashRing(["a", "b", "c"]);
  const r2 = new HashRing(["a", "b", "c"]);
  for (let i = 0; i < 200; i++) {
    const k = "x" + i;
    assert.equal(r1.getNode(k), r2.getNode(k));
  }
});

test("adding a node remaps only a minority of keys, and only TO the new node", () => {
  const keys = Array.from({ length: 5000 }, (_, i) => "k" + i);
  const ring = new HashRing(["a", "b", "c"]);
  const before = new Map(keys.map((k) => [k, ring.getNode(k)]));
  ring.add("d");
  let moved = 0;
  let movedElsewhere = 0;
  for (const k of keys) {
    const now = ring.getNode(k);
    if (now !== before.get(k)) {
      moved++;
      if (now !== "d") movedElsewhere++;
    }
  }
  assert.ok(moved / keys.length < 0.4, `too many keys remapped: ${moved}`);
  assert.equal(movedElsewhere, 0, "consistent hashing must only move keys to the new node");
});

test("single node owns everything; empty ring throws", () => {
  assert.equal(new HashRing(["solo"]).getNode("anything"), "solo");
  assert.throws(() => new HashRing([]).getNode("x"));
});
