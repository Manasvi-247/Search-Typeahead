import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/normalize.ts";
import { prefixUpperBound } from "../src/suggest.ts";

test("normalize lowercases, trims, and collapses internal whitespace", () => {
  assert.equal(normalize("  IPhone   15  "), "iphone 15");
  assert.equal(normalize("YOGA"), "yoga");
  assert.equal(normalize("a\t b"), "a b");
  assert.equal(normalize(""), "");
});

test("prefixUpperBound is the smallest string greater than all strings with the prefix", () => {
  assert.equal(prefixUpperBound("iph"), "ipi");
  assert.equal(prefixUpperBound("a"), "b");

  assert.ok("iphone" >= "iph" && "iphone" < prefixUpperBound("iph"));

  assert.ok(!("ipi" < prefixUpperBound("iph")));
});
