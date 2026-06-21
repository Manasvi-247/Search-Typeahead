import { HashRing } from "../src/ring.ts";

const N = 20000;
const keys = Array.from({ length: N }, (_, i) => "sug:" + ((i * 2654435761) >>> 0).toString(36).slice(0, 4));

const ring = new HashRing(["redis-0", "redis-1", "redis-2"]);
const dist: Record<string, number> = {};
const owner = new Map<string, string>();
for (const k of keys) {
  const n = ring.getNode(k);
  dist[n] = (dist[n] || 0) + 1;
  owner.set(k, n);
}

console.log(`distribution over 3 nodes (${N.toLocaleString()} keys):`);
for (const n of Object.keys(dist).sort()) {
  console.log(`  ${n}: ${((100 * dist[n]) / N).toFixed(1)}%`);
}

ring.add("redis-3");
let moved = 0;
let elsewhere = 0;
for (const k of keys) {
  const n = ring.getNode(k);
  if (n !== owner.get(k)) {
    moved++;
    if (n !== "redis-3") elsewhere++;
  }
}
console.log(
  `adding a 4th node: ${((100 * moved) / N).toFixed(1)}% of keys remapped` +
    ` (theory ~1/4), ${elsewhere} moved to a node other than the new one`
);
