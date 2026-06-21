# Search Typeahead — Design & Viva Reference

> Keep this open while building. It maps the **class notes** (doc1, doc2 by Pragy Agarwal)
> → the **assignment** (ass.txt) → **what you implement**, and gives you the viva answer
> for every design choice. Every decision here traces back to a line in the notes — that
> traceability is what protects you in the viva (assignment §11: you must defend every choice).

---

## 1. The architecture in one picture

```
                    POST /search                         GET /suggest?q=<prefix>
                         │                                        │
                         ▼                                        ▼
                  ┌─────────────┐                      ┌────────────────────┐
                  │  buffer /   │                      │ consistent-hash ring│
                  │  queue      │                      │ hash(prefix)→node   │
                  └──────┬──────┘                      └──────────┬─────────┘
                batch flush (time or size)                        │
                         │                            ┌───────────▼───────────┐
                         ▼                            │  Redis node 0 / 1 / 2  │  ← Top Suggestions DB (CACHE)
              ┌────────────────────┐   miss/refresh   │  key: prefix           │     prefix → top-10
              │   SQLite            │◄─────────────────┤  val: [ {q,score}... ] │
              │  Search Frequency DB│                  └───────────┬───────────┘
              │  query → count      │                       hit    │
              └─────────┬──────────┘                              ▼
                        │ build / recompute top-k            return top-10
                        ▼
              ┌────────────────────┐
              │  in-memory Trie     │  augmented: each node stores its own top-k
              │  (compute on miss)  │
              └────────────────────┘
```

**Two stores, from doc2:94–101 ("prefix == TrieNode, data-augmentation == cache"):**

| Notes term | Assignment component | Tech | Holds |
|---|---|---|---|
| **Search Frequency DB** | primary data store | SQLite (`better-sqlite3`) | `query → count` — every query, durable |
| **Top Suggestions DB** *(= cache)* | distributed cache | Redis × 3 logical nodes | `prefix → top-10` — served fast |
| (compute engine) | — | in-memory augmented Trie | computes top-k on cache miss / for seeding |

---

## 2. Requirement → notes → implementation map

| Assignment requirement | Notes source | Implementation |
|---|---|---|
| Top-10 suggestions by count (60%) | doc2 Approach 1 & 2 | Trie computes top-k; Redis serves it |
| `/suggest` low latency (<10ms goal) | doc2:240–252 | Cache-aside; Redis lookup is O(key len), ~<1ms |
| Cache before primary store | doc2:97–101, 437–442 | Cache-aside read path |
| **Distributed cache + consistent hashing** | doc2:422–431 | **Implement the ring yourself** (see §4) |
| `GET /cache/debug?prefix=` | assignment §5 | Return owning node + hit/miss |
| Batch writes (20%) | doc2:464–553 | Adopt their batching algorithm (§5) |
| Trending / recency (20%) | doc2:663–753 | Adopt their decay formula (§6) |
| `/search` updates counts | doc2:254–278 | `log_search` increments frequency DB |
| Eventual consistency / stale reads OK | doc1:249–308 | The justification for caching + batching (§7) |
| Graceful empty/no-match/mixed-case | assignment §4.1 | Normalize prefix (lowercase, trim); return `[]` cleanly |
| Debounce UI calls | assignment §4.1 | 300ms debounce on the search box |

---

## 3. The Trie (compute engine) — doc2:19–60

- Node stores: `children`, `isTerminal`, `count` (if terminal).
- `typeahead(prefix)`: walk to the prefix node, then collect top-k from its subtree.
- **Critical optimization (doc2:49–53):** pre-compute & store **top-k at every node**
  ("data-augmentation"). Walking the whole subtree is too slow — *"potentially billions of
  entries."* Trade-off: lookups become O(prefix length), but updates must propagate top-k
  up to the root.
- **Viva trap:** if you claim "trie gives O(prefix length)" without the augmentation, that's
  wrong — gathering+sorting the subtree is not free. Always mention the augmentation.

---

## 4. Consistent hashing — the one thing you implement explicitly

**Why it's on you:** the notes say KV sharding is *automatic* — *"Sharding is automatic, based
on hash(key)"* (doc2:423). The assignment instead asks you to implement that hashing yourself
with **consistent hashing** (ass.txt:110).

**Viva line:** *"Key-value stores shard automatically by hash(key); I implemented consistent
hashing manually to expose that mechanism and control which logical node owns each prefix."*

Implementation:
- A hash ring (0 … 2³²). Each physical Redis node gets **~100–150 virtual nodes** placed on
  the ring (even distribution).
- `getNode(prefix)` = hash the prefix, walk clockwise to the next virtual node → its physical node.
- Benefit to state in viva: adding/removing a node remaps only ~`1/N` of keys, not all of them.
- `GET /cache/debug?prefix=` returns: the owning node + whether the key was a hit or miss.

> Note on "logical": assignment §6 says *logical* cache nodes — 3 real Redis instances **or**
> 3 in-process maps both satisfy it. Redis makes a stronger demo. The graded part is the ring,
> not whether nodes are separate processes.

---

## 5. Batch writes — doc2:464–553 (adopt almost verbatim)

Notes algorithm:
```
log_search(query):
    new_count = frequency_db.inc(query)     # ALWAYS update count → no data loss
    if new_count % BATCH_SIZE == 0:         # e.g. 1000
        update_prefixes(query)              # only now refresh the cache
```

Local-demo variant (what you build): buffer `/search` events in a queue, flush on
**time interval OR batch size**, aggregate repeated queries into one increment each, then
increment SQLite and invalidate/refresh affected prefix cache entries.

**Only prefixes of that query are affected** (doc2:264–273) — not the whole cache.

**Viva answers the notes hand you:**
- *"Batching doesn't cause data loss (freq data is always up to date) — it just delays
  suggestion updates (stale reads)."* (doc2:553)
- *"We can't go below the frequency-DB write rate."* (doc2:550)
- **Crash trade-off (assignment §8 asks this):** events buffered but not yet flushed are lost
  on crash → counts off by a small amount → acceptable per NFRs (§7). Mitigation in prod:
  write-ahead log / shorter flush interval / accept eventual consistency.

*(Sampling — doc2:555–659 — is the alternative the assignment also allows. Mention it as a
trade-off: forces data loss but drops 99.9% of writes. Rare queries vanish, which is "a
feature not a bug" since they'd never be suggested anyway.)*

---

## 6. Trending / recency — doc2:663–753 (adopt the decay)

> *"After each day, decrease the total count for each query by 10%."* (doc2:715)

`new_score = 0.9 * old_score + today_count`. The notes prove the behaviour:
- Steady 1000/day query → converges to ~10,000 (bounded, won't dominate forever).
- Fresh spike (Wimbledon) → shoots up fast, decays if not sustained.

**This directly answers the assignment's hardest trending question** (ass.txt:121 — "avoid
permanently over-ranking a short-lived spike"): decay does exactly that.

Demo note: decay per **minute** instead of per day so the effect is visible in a live demo.
Show before/after ranking with logs (assignment §7 requires demonstrating the difference).

Cache interaction: when decay changes rankings, the affected prefix cache entries must be
invalidated/refreshed (assignment §7 asks "how is the cache updated when rankings change").

---

## 7. Non-functional justifications (your viva answers) — doc1:223–321

These are *why* the design is allowed to cut corners. Memorize the reasoning:

| NFR question | Answer (from notes) |
|---|---|
| Can we afford stale reads? | Yes — users don't know/care about true counts; strict order not needed (doc1:260–265) |
| Can we afford data loss? | Yes — counts off by a tiny amount is fine (doc1:305–308) |
| Consistency model | Eventual consistency is acceptable → enables cache + batching |
| Latency target | Ultra-low, competing with typing speed; <10ms per typeahead (doc1:313–315) |
| Read vs write heavy | Read-heavy (reads ~10× writes) → absorb reads in cache, optimize DB for writes (doc1:514–527) |
| How would it scale? | Shard more — sharding improves both reads & writes (doc2:456–457) |

Scale numbers (doc1:374–512) — understand, don't implement: ~1B DAU → 20B searches/day →
200k searches/s → 2M typeaheads/s → 10M/s peak; ~160 TB over 20y; needs ~100 Redis servers.
**Your build is a local single-machine demo of these patterns, not the scale.**

---

## 8. APIs (assignment §5)

| API | Behaviour |
|---|---|
| `GET /suggest?q=<prefix>` | top-10 prefix matches by score; cache-aside via the ring |
| `POST /search` | returns `{"message":"Searched"}`; buffers event for batch write |
| `GET /cache/debug?prefix=<p>` | owning ring node + hit/miss |

---

## 9. Build phases (notes-aligned)

1. **Seed** — load dataset → SQLite frequency DB → build augmented trie (top-k per node).
2. **`/suggest`** — consistent-hash(prefix) → Redis node → hit returns; miss computes from trie, caches w/ TTL.
3. **`/search`** — returns dummy response, pushes event to buffer.
4. **Batch worker** — flush by time/size → increment SQLite → invalidate/refresh affected prefixes.
5. **Trending** — periodic decay; ranking uses decayed score; show before/after logs.
6. **`/cache/debug`** + measure p95 latency, cache hit rate, write reduction.
7. **Frontend** — debounced search box, dropdown, keyboard nav, trending section, loading/error states.
8. **Docs** — README, architecture diagram, API docs, perf report, screenshots/demo.

---

## 10. Stack & open items

- **Backend:** Node 25 + TypeScript (run natively, no compile step) + Fastify ·
  **Primary:** SQLite via built-in **`node:sqlite`** (no native build, replaces `better-sqlite3`) ·
  **Cache:** Redis ×3 logical nodes (free, local) · **Frontend:** React + Vite.
- **Dataset (CONFIRMED):** Amazon Products 2023 (`asaniczka/amazon-products-dataset-2023-1-4m-products`).
  Downloaded to `data/amazon.zip` (99 MB zip → `amazon_products.csv`, 376 MB, **1,426,337 rows**).
  - Columns: `asin, title, imgUrl, productURL, stars, reviews, price, listPrice, category_id, isBestSeller, boughtInLastMonth`
  - **query = `title`**, **count = `reviews`**. `boughtInLastMonth` rejected (too sparse).
  - **Ingestion (DONE):** keep rows where `reviews > 0`. Across the FULL 1.4M rows only
    **295,834 qualify** (~20.7% — the first 300k rows were unusually review-dense, which
    misled an early head-sample estimate). After aggregating duplicate titles →
    **288,682 unique queries**, count range **1–346,563**. No sampling needed
    (`SAMPLE_EVERY=1`); 288k is ~3× the minimum and trivial for SQLite. Loaded by `src/ingest.ts`.
  - CSV parsing caveat: `title` contains commas and is quoted — parse with a real CSV reader,
    OR index numeric columns from the end (`reviews` = field NF-5, since the last 7 fields have no commas).

---

## Grading recap (assignment §13)

- **60** — dataset + UI + `/suggest` + `/search` + count updates + distributed cache w/ consistent hashing
- **20** — trending (decay) with clear explanation
- **20** — batch writes with write-reduction evidence + crash trade-off discussion
