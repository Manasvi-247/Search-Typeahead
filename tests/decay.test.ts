import { test } from "node:test";
import assert from "node:assert/strict";
import { Decayer } from "../src/decay.ts";
import { DECAY_FACTOR } from "../src/config.ts";
import { makeDb } from "./helpers.ts";

type Row = { score: number; count: number };

test("decay multiplies every score by the factor and preserves relative order", () => {
  const db = makeDb([
    { q: "a", count: 100, score: 100 },
    { q: "b", count: 100, score: 50 },
  ]);
  const d = new Decayer(db);
  d.run();

  const a = db.prepare("SELECT score, count FROM queries WHERE query='a'").get() as Row;
  const b = db.prepare("SELECT score, count FROM queries WHERE query='b'").get() as Row;

  assert.ok(Math.abs(a.score - 100 * DECAY_FACTOR) < 1e-6);
  assert.ok(Math.abs(b.score - 50 * DECAY_FACTOR) < 1e-6);
  assert.ok(a.score > b.score, "uniform decay must preserve order");
  assert.equal(d.stats().runs, 1);
});

test("decay leaves all-time count untouched", () => {
  const db = makeDb([{ q: "a", count: 100, score: 100 }]);
  new Decayer(db).run();
  assert.equal((db.prepare("SELECT count FROM queries WHERE query='a'").get() as Row).count, 100);
});
