import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { openDb } from "./db.ts";
import { normalize } from "./normalize.ts";
import { createRedisCache } from "./cache.ts";
import { SuggestService } from "./suggest.ts";
import { BatchWriter } from "./batch.ts";
import { Decayer } from "./decay.ts";
import { cacheKey, HTTP_PORT, MAX_QUERY_LEN, CACHE_TTL_SECONDS, type Rank } from "./config.ts";

const db = openDb();
const cache = createRedisCache();
const suggestService = new SuggestService(db, cache);
const batchWriter = new BatchWriter(db, cache);
batchWriter.start();
const decayer = new Decayer(db);
decayer.start();

/** Parse the ?rank= param; anything but "recent" falls back to the basic "count" ranking. */
const parseRank = (v: unknown): Rank => (String(v) === "recent" ? "recent" : "count");

const app = Fastify({ logger: false }); // Fastify auto-assigns req.id (our correlation id)

// CORS for the Vite frontend + echo the correlation id on every response.
app.addHook("onRequest", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  reply.header("x-request-id", req.id);
});
app.options("/*", async (_req, reply) => reply.send());

/** Consistent error envelope with a correlation id; internal details aren't leaked (api guideline). */
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error(`[${req.id}]`, err);
  reply.code(status).send({
    error: {
      code: err.code ?? (status >= 500 ? "internal_error" : "bad_request"),
      message: status >= 500 ? "Internal Server Error" : err.message,
      request_id: req.id,
    },
  });
});

/** Validation helper: reject empty/over-long input with a 400 (api guideline: validate inputs). */
function requireQuery(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  if (s === "") throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
  if (s.length > MAX_QUERY_LEN)
    throw Object.assign(new Error(`${field} exceeds ${MAX_QUERY_LEN} chars`), { statusCode: 400 });
  return s;
}

/** GET /suggest?q=<prefix>&rank=count|recent — top-10 prefix matches, cache-aside.
 *  rank=count (default): all-time popularity. rank=recent: recency-aware trending. */
app.get("/suggest", async (req) => {
  const query = req.query as Record<string, unknown>;
  const q = String(query.q ?? ""); // empty is allowed -> returns [] gracefully (ass.txt:66)
  if (q.length > MAX_QUERY_LEN)
    throw Object.assign(new Error(`q exceeds ${MAX_QUERY_LEN} chars`), { statusCode: 400 });
  const rank = parseRank(query.rank);
  const t0 = process.hrtime.bigint();
  const r = await suggestService.suggest(q, rank);
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    query: q,
    rank: r.rank, // count | recent
    cache: r.cache, // hit | miss | skip
    node: r.node, // which Redis node served/owns it
    latencyMs: Number(latencyMs.toFixed(3)),
    count: r.suggestions.length,
    suggestions: r.suggestions,
  };
});

/** GET /cache/debug?prefix=<p>&rank= — which node owns the prefix key, and hit/miss (ass.txt:96). */
app.get("/cache/debug", async (req) => {
  const query = req.query as Record<string, unknown>;
  const prefix = normalize(requireQuery(query.prefix, "prefix"));
  const rank = parseRank(query.rank);
  const key = cacheKey(prefix, rank);
  const route = await cache.route(key);
  return { prefix, rank, key, node: route.node, status: route.hit ? "HIT" : "MISS", ring: cache.ringIds() };
});

/** POST /search — dummy response + buffer the query for a batched count update (ass.txt:69). */
app.post("/search", async (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = requireQuery(body.query, "query");
  batchWriter.record(query);
  return { message: "Searched", query };
});

/** GET /trending?rank=count|recent&limit= — global top-N for the Trending panel (ass.txt:152). */
app.get("/trending", async (req) => {
  const query = req.query as Record<string, unknown>;
  const rank = parseRank(query.rank);
  const limit = Math.min(Math.max(Number(query.limit ?? 6) || 6, 1), 50);
  return { rank, suggestions: suggestService.trending(rank, limit) };
});

/** GET /cache/stats — hit rate + per-node key counts for the Distributed Cache panel. */
app.get("/cache/stats", async () => {
  const nodes = await cache.nodeStats();
  return { ...suggestService.cacheStats(), datasetSize: suggestService.datasetSize(), ttl: CACHE_TTL_SECONDS, nodes };
});

/** GET /batch/stats — write-reduction evidence for the performance report (ass.txt:145). */
app.get("/batch/stats", async () => batchWriter.stats());

/** POST /batch/flush — force a flush now (handy for demos: search, flush, see suggestions change). */
app.post("/batch/flush", async () => {
  await batchWriter.flush("manual");
  return batchWriter.stats();
});

/** POST /decay/run — apply one decay step now (demo: crush history, then search to trend). */
app.post("/decay/run", async () => {
  decayer.run();
  return decayer.stats();
});

/** GET /decay/stats — decay factor/interval and how many steps have run. */
app.get("/decay/stats", async () => decayer.stats());

app.get("/health", async () => ({ ok: true }));

// Serve the dashboard SPA from web/ at the root. Explicit API routes above take precedence.
app.register(fastifyStatic, { root: join(import.meta.dirname, "..", "web"), prefix: "/" });

/** GET /api — index of available endpoints. */
app.get("/api", async () => ({
  service: "search-typeahead",
  endpoints: {
    "GET /suggest?q=<prefix>&rank=count|recent": "top-10 suggestions (cache-aside)",
    "POST /search {query}": "dummy response + buffer query for batched count update",
    "GET /cache/debug?prefix=<p>&rank=": "which Redis node owns the prefix + hit/miss",
    "GET /trending?rank=count|recent&limit=": "global top-N suggestions",
    "GET /cache/stats": "cache hit rate + per-node key counts",
    "GET /batch/stats": "write-reduction evidence",
    "POST /batch/flush": "force a batch flush now",
    "GET /decay/stats": "trending decay factor/interval/steps",
    "POST /decay/run": "apply one decay step now",
    "GET /health": "liveness",
  },
}));

// Clean shutdown flushes buffered events first (only a hard crash loses them — doc2:553).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void (async () => {
      batchWriter.stop();
      decayer.stop();
      await batchWriter.flush("shutdown");
      await cache.close();
      db.close();
      process.exit(0);
    })();
  });
}

app
  .listen({ port: HTTP_PORT, host: "0.0.0.0" })
  .then(() => console.log(`typeahead API listening on http://localhost:${HTTP_PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
