const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};
const post = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const fmt = (n) => (n >= 1000 ? (n / 1000 >= 100 ? Math.round(n / 1000) : +(n / 1000).toFixed(1)) + "k" : "" + n);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function shortName(s) {
  let cut = s.length;
  for (const sep of [" - ", " – ", " — ", " | ", ", "]) {
    const i = s.indexOf(sep);
    if (i > 0 && i < cut) cut = i;
  }
  let name = s.slice(0, cut).trim();
  if (name.length > 52) name = name.slice(0, 52).trim() + "…";
  return name;
}

const NODE_COLORS = ["#4d8fc4", "#957fef", "#f46197", "#34b89a", "#e3c567"];

const state = {
  query: "",
  rank: "count",
  suggestions: [],
  deltaMap: {},
  activeIndex: -1,
  meta: null,
  lat: [],
  ringIds: [],
  ringOwner: null,
  ringKey: null,
  reqSeq: 0,
};

const HISTORY_KEY = "lookahead-history";
const HISTORY_MAX = 50;
const getHistory = () => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
};
function addHistory(q) {
  const query = q.trim();
  if (!query) return;
  try {
    const list = getHistory().filter((h) => h.q.toLowerCase() !== query.toLowerCase());
    list.unshift({ q: query, t: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch {}
}
const clearHistory = () => {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {}
};
const historyMatches = (prefix) => {
  const p = prefix.trim().toLowerCase();
  return getHistory()
    .filter((h) => h.q.toLowerCase().startsWith(p))
    .map((h) => h.q);
};

function mergeWithHistory(prefix, global) {
  const seen = new Set();
  const out = [];
  for (const q of historyMatches(prefix)) {
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const g = global.find((s) => s.query.toLowerCase() === key);
    out.push({ query: g ? g.query : q, count: g ? g.count : null, score: g ? g.score : null, personalized: true });
    if (out.length >= 10) return out;
  }
  for (const s of global) {
    const key = s.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: s.query, count: s.count, score: s.score, personalized: false });
    if (out.length >= 10) break;
  }
  return out;
}

const input = $("searchInput");
let debounceT, respT;

input.addEventListener("input", () => {
  state.query = input.value;
  $("searching").classList.add("show");
  clearTimeout(debounceT);
  debounceT = setTimeout(() => runQuery(input.value), 180);
});
input.addEventListener("keydown", onKey);
input.addEventListener("focus", () => {
  const v = input.value.trim();
  if (!v) renderRecent();
  else if (state.suggestions.length) renderDropdown();
  else runQuery(input.value);
});
input.addEventListener("blur", () => setTimeout(hideDropdowns, 150));
$("searchBtn").addEventListener("click", () => submit());
$("rankAll").addEventListener("click", () => setRank("count"));
$("rankTrend").addEventListener("click", () => setRank("recent"));

function setRank(r) {
  if (state.rank === r) return;
  state.rank = r;
  $("rankAll").classList.toggle("on", r === "count");
  $("rankTrend").classList.toggle("on", r === "recent");
  if (input.value.trim()) runQuery(input.value);
  loadTrending();
}

async function runQuery(raw) {
  const prefix = raw.trim();
  if (!prefix) {
    state.suggestions = [];
    $("searching").classList.remove("show");
    renderRecent();
    state.ringOwner = null;
    state.ringKey = null;
    renderRing();
    return;
  }
  const seq = ++state.reqSeq;
  try {
    const primaryP = api(`/suggest?q=${encodeURIComponent(prefix)}&rank=${state.rank}`);
    const otherP = state.rank === "recent" ? api(`/suggest?q=${encodeURIComponent(prefix)}&rank=count`) : null;
    const primary = await primaryP;
    const other = otherP ? await otherP : null;
    if (seq !== state.reqSeq) return;

    $("searching").classList.remove("show");
    state.suggestions = mergeWithHistory(prefix, primary.suggestions);
    state.meta = primary;
    state.activeIndex = -1;
    recordLatency(primary.latencyMs, primary.cache);

    state.deltaMap = {};
    if (other) {
      const allIdx = {};
      other.suggestions.forEach((s, i) => (allIdx[s.query] = i));
      primary.suggestions.forEach((s, i) => {
        const j = allIdx[s.query];
        if (j != null && j - i > 0) state.deltaMap[s.query] = "▲" + (j - i);
      });
    }
    renderDropdown();
    updateRing(prefix);
  } catch (e) {
    $("searching").classList.remove("show");
    $("dropdown").classList.add("hidden");
    showEmpty(`Error reaching the server — is it running?`);
  }
}

function renderDropdown() {
  const items = state.suggestions;
  $("emptyState").classList.add("hidden");
  if (!items.length) {
    $("dropdown").classList.add("hidden");
    if (state.query.trim()) showEmpty(`No suggestions for “${esc(state.query.trim())}” — press ↵ to search it anyway.`);
    return;
  }
  const m = state.meta || {};
  $("dropNode").textContent = m.node || "—";
  const badge = $("dropBadge");
  badge.style.background = "";
  badge.style.color = "";
  const hit = m.cache === "hit";
  badge.textContent = hit ? "CACHE HIT" : "STORE READ";
  badge.className = "badge " + (hit ? "hit" : "miss");
  $("dropLat").textContent = (m.latencyMs ?? "—") + "ms";

  const pl = state.query.trim().length;
  $("dropList").innerHTML = items
    .map((it, i) => {
      const name = shortName(it.query);
      const k = Math.min(pl, name.length);
      const pre = esc(name.slice(0, k));
      const rest = esc(name.slice(k));
      const delta = state.deltaMap[it.query] ? `<span class="delta">${state.deltaMap[it.query]}</span>` : "";
      const you = it.personalized ? `<span class="you">recent</span>` : "";
      const val = it.count == null ? "" : state.rank === "recent" ? Math.round(it.score) : fmt(it.count);
      return `<div class="sugg-row${i === state.activeIndex ? " active" : ""}" data-i="${i}">
        <span class="idx">${i + 1}</span>
        <span class="q"><b>${pre}</b>${rest}</span>${you}${delta}
        <span class="cnt">${val}</span>
      </div>`;
    })
    .join("");
  $("dropList").querySelectorAll(".sugg-row").forEach((row) => {
    const i = +row.dataset.i;
    row.addEventListener("mouseenter", () => {
      state.activeIndex = i;
      paintActive();
    });
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      submit(items[i].query);
    });
  });
  $("dropdown").classList.remove("hidden");
}

function paintActive() {
  $("dropList")
    .querySelectorAll(".sugg-row")
    .forEach((r, i) => r.classList.toggle("active", i === state.activeIndex));
}

function showEmpty(msg) {
  const el = $("emptyState");
  el.textContent = msg;
  el.classList.remove("hidden");
}
function clearDropdown() {
  state.suggestions = [];
  $("searching").classList.remove("show");
  hideDropdowns();
}
function hideDropdowns() {
  $("dropdown").classList.add("hidden");
  $("emptyState").classList.add("hidden");
}

function renderRecent() {
  const hist = getHistory();
  $("emptyState").classList.add("hidden");
  if (!hist.length) {
    $("dropdown").classList.add("hidden");
    return;
  }
  $("dropNode").textContent = "on this device";
  const badge = $("dropBadge");
  badge.textContent = "RECENT";
  badge.className = "badge";
  badge.style.background = "color-mix(in srgb,var(--accent) 20%,transparent)";
  badge.style.color = "var(--accent)";
  $("dropLat").textContent = `${hist.length} saved`;
  const clock = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
  $("dropList").innerHTML =
    hist
      .slice(0, 6)
      .map(
        (h, i) => `<div class="sugg-row" data-rec="${i}">
        <span class="idx">${clock}</span>
        <span class="q">${esc(shortName(h.q))}</span><span class="you">recent</span>
        <span class="cnt"></span>
      </div>`
      )
      .join("") + `<button class="rec-clear" id="recClear">Clear recent searches</button>`;
  $("dropList")
    .querySelectorAll(".sugg-row")
    .forEach((row) => {
      const i = +row.dataset.rec;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        submit(hist[i].q);
      });
    });
  $("recClear").addEventListener("mousedown", (e) => {
    e.preventDefault();
    clearHistory();
    hideDropdowns();
  });
  $("dropdown").classList.remove("hidden");
}

function onKey(e) {
  const n = state.suggestions.length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.activeIndex = Math.min(state.activeIndex + 1, n - 1);
    paintActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.activeIndex = Math.max(state.activeIndex - 1, -1);
    paintActive();
  } else if (e.key === "Enter") {
    const i = state.activeIndex;
    submit(i >= 0 && state.suggestions[i] ? state.suggestions[i].query : undefined);
  } else if (e.key === "Escape") {
    clearDropdown();
  }
}

async function submit(q) {
  const query = (q != null ? q : input.value).trim();
  if (!query) return;
  clearTimeout(debounceT);
  input.value = shortName(query);
  state.query = query;
  clearDropdown();
  try {
    const r = await post("/search", { query });
    addHistory(query);
    $("responseBody").textContent = `{ "message": "${r.message}", "query": "${esc(r.query)}" }`;
    $("responseCard").classList.remove("hidden");
    clearTimeout(respT);
    respT = setTimeout(() => $("responseCard").classList.add("hidden"), 3400);
    refreshLivePanels();
  } catch (e) {
    showEmpty(`Search failed (${e.message}).`);
  }
}

function recordLatency(ms, cache) {
  if (typeof ms === "number") {
    state.lat.push(ms);
    if (state.lat.length > 40) state.lat.shift();
  }
  const arr = state.lat;
  const last = arr.length ? arr[arr.length - 1] : null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const p50 = arr.length ? pct(0.5).toFixed(1) : "—";
  const p95 = arr.length ? pct(0.95).toFixed(1) : "—";
  $("latLast").innerHTML = (last != null ? last : "—") + "<small>ms</small>";
  $("latP50").innerHTML = p50 + "<small>ms</small>";
  $("latP95").innerHTML = p95 + "<small>ms</small>";
  $("p95Badge").textContent = p95;

  const fast = cache === "hit";
  const badge = $("latBadge");
  badge.textContent = last == null ? "idle" : fast ? "CACHE HIT" : "STORE READ";
  badge.className = "badge";
  badge.style.background = last == null ? "var(--cardAlt)" : fast ? "var(--cyan)" : "var(--clay)";
  badge.style.color = last == null ? "var(--muted)" : "#06251e";

  const W = 320, H = 50, max = Math.max(60, ...arr, 1);
  let pts = "", area = "0,50 ";
  arr.forEach((v, i) => {
    const x = arr.length === 1 ? 0 : i * (W / (arr.length - 1));
    const y = H - 4 - (v / max) * (H - 8);
    pts += (i ? " " : "") + x.toFixed(0) + "," + y.toFixed(1);
    area += x.toFixed(0) + "," + y.toFixed(1) + " ";
  });
  area += W + ",50";
  $("latLine").setAttribute("points", pts || "0,46");
  $("latArea").setAttribute("points", area);
}

async function updateRing(prefix) {
  try {
    const d = await api(`/cache/debug?prefix=${encodeURIComponent(prefix)}&rank=${state.rank}`);
    state.ringIds = d.ring;
    state.ringOwner = d.node;
    state.ringKey = prefix.length > 10 ? prefix.slice(0, 10) + "…" : prefix;
    renderRing();
  } catch {}
}

function renderRing() {
  const ids = state.ringIds.length ? state.ringIds : ["redis-0", "redis-1", "redis-2"];
  const cx = 110, cy = 110, R = 82;
  const ang = (i) => (i / ids.length) * 2 * Math.PI - Math.PI / 2;
  let nodesSvg = "";
  let ownerXY = null;
  ids.forEach((id, i) => {
    const a = ang(i);
    const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
    const lr = R + 16, lx = cx + lr * Math.cos(a), ly = cy + lr * Math.sin(a) + 3;
    const right = Math.cos(a) >= -0.1;
    const active = id === state.ringOwner;
    if (active) ownerXY = { x, y };
    const color = NODE_COLORS[i % NODE_COLORS.length];
    nodesSvg += active
      ? `<circle cx="${x}" cy="${y}" r="11" fill="none" stroke="var(--accent)" stroke-width="2" style="transform-origin:${x}px ${y}px;animation:ping 1.4s ease-out infinite"/>`
      : "";
    nodesSvg += `<circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="var(--card)" stroke-width="2"/>
      <text x="${lx}" y="${ly}" text-anchor="${right ? "start" : "end"}" font-family="JetBrains Mono" font-size="9.5" font-weight="600" fill="${active ? "var(--accent)" : "var(--muted)"}">${id}</text>`;
  });
  let beam = "";
  if (ownerXY) {
    beam = `<path d="M110,110 L${ownerXY.x.toFixed(1)},${ownerXY.y.toFixed(1)}" stroke="var(--accent)" stroke-width="2.5" fill="none" stroke-dasharray="2 7" style="animation:flowDash .8s linear infinite"/>
      <circle cx="${ownerXY.x.toFixed(1)}" cy="${ownerXY.y.toFixed(1)}" r="9" fill="none" stroke="var(--gold)" stroke-width="2" style="transform-origin:${ownerXY.x.toFixed(1)}px ${ownerXY.y.toFixed(1)}px;animation:ping 1.6s ease-out infinite"/>`;
  }
  $("ringHost").innerHTML = `<svg width="100%" style="max-width:300px" height="236" viewBox="-30 -8 290 244">
    <g style="transform-origin:110px 110px;animation:spin 30s linear infinite"><circle cx="110" cy="110" r="82" fill="none" stroke="var(--border)" stroke-width="1.5" stroke-dasharray="3 9"/></g>
    <circle cx="110" cy="110" r="82" fill="none" stroke="var(--ring)" stroke-width="2" opacity="0.35"/>
    ${beam}
    <circle cx="110" cy="110" r="30" fill="var(--cardAlt)" stroke="var(--border)"/>
    <text x="110" y="106" text-anchor="middle" font-family="Space Grotesk" font-weight="700" font-size="15" fill="var(--text)">${ids.length}</text>
    <text x="110" y="120" text-anchor="middle" font-family="DM Sans" font-size="8" letter-spacing="1" fill="var(--muted)">NODES</text>
    ${nodesSvg}
  </svg>`;
  $("ringKey").textContent = state.ringKey ? `“${state.ringKey}”` : "∅";
  $("ringOwner").textContent = state.ringOwner || "—";
}

async function loadTrending() {
  try {
    const [recent, all] = await Promise.all([
      api("/trending?rank=recent&limit=6"),
      api("/trending?rank=count&limit=50"),
    ]);
    const allIdx = {};
    all.suggestions.forEach((s, i) => (allIdx[s.query] = i));
    const items = recent.suggestions;
    const maxScore = items.length ? Math.max(...items.map((s) => s.score), 1) : 1;
    $("trendingList").innerHTML = items
      .map((it, i) => {
        const j = allIdx[it.query];
        let delta = "—", dc = "var(--muted)";
        if (j != null) {
          const d = j - i;
          if (d > 0) { delta = "▲" + d; dc = "var(--cyan)"; }
          else if (d < 0) { delta = "▼" + -d; dc = "var(--clay)"; }
        }
        const w = Math.max(8, (it.score / maxScore) * 100).toFixed(0);
        return `<div class="trend-row" data-q="${esc(it.query)}">
          <span class="rk">${i + 1}</span>
          <span class="flame" style="animation-duration:${(1.1 + i * 0.12).toFixed(2)}s"><svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor"><path d="M183.89,153.34a57.6,57.6,0,0,1-46.56,46.55A8.75,8.75,0,0,1,136,200a8,8,0,0,1-1.32-15.89c16.57-2.79,30.63-16.85,33.44-33.45a8,8,0,0,1,15.78,2.68ZM216,144a88,88,0,0,1-176,0c0-27.92,11-56.47,32.66-84.85a8,8,0,0,1,11.63-1.09l24.13,21.41,22-60.54a8,8,0,0,1,12.13-3.9C160.92,30.2,216,77.05,216,144Z"/></svg></span>
          <span class="q">${esc(shortName(it.query))}</span>
          <span class="delta" style="color:${dc}">${delta}</span>
          <span class="track"><span class="fill" style="width:${w}%"></span></span>
        </div>`;
      })
      .join("");
    $("trendingList").querySelectorAll(".trend-row").forEach((row) =>
      row.addEventListener("click", () => submit(row.dataset.q))
    );
  } catch {}
}

async function loadCache() {
  try {
    const d = await api("/cache/stats");
    $("datasetBadge").textContent = d.datasetSize.toLocaleString();
    $("cacheRate").textContent = d.hitRate;
    $("cacheBar").style.width = d.hitRate + "%";
    $("cacheHits").textContent = d.hits;
    $("cacheMisses").textContent = d.misses;
    $("cacheTtl").textContent = d.ttl;
    const maxKeys = Math.max(1, ...d.nodes.map((n) => n.keys));
    $("cacheNodes").innerHTML = d.nodes
      .map((n, i) => {
        const c = NODE_COLORS[i % NODE_COLORS.length];
        const st = n.ok ? "UP" : "DOWN";
        const stColor = n.ok ? "var(--cyan)" : "var(--clay)";
        return `<div class="cache-row" style="background:var(--cardAlt);border:1px solid var(--border)">
          <span class="nd" style="background:${c};box-shadow:0 0 8px ${c}"></span>
          <span class="nm">${n.id}</span>
          <span class="ld"><span style="display:block;height:100%;width:${((n.keys / maxKeys) * 100).toFixed(0)}%;background:${c};border-radius:999px;transition:width .4s"></span></span>
          <span class="kc">${n.keys} keys</span>
          <span class="st" style="background:${n.ok ? "transparent" : "var(--clay)"};color:${stColor}">${st}</span>
        </div>`;
      })
      .join("");
  } catch {}
}

async function loadBatch() {
  try {
    const d = await api("/batch/stats");
    $("batchCfg").textContent = `flush ≥${d.batchSize} or ${d.flushIntervalSec}s`;
    $("batchBufCount").textContent = `${d.pendingEvents}/${d.batchSize}`;

    const shown = Math.min(d.batchSize, 24);
    const filled = d.batchSize ? Math.round((d.pendingEvents / d.batchSize) * shown) : 0;
    let slots = "";
    for (let i = 0; i < shown; i++) slots += `<div class="slot${i < filled ? " full" : ""}"></div>`;
    $("batchSlots").innerHTML = slots;
    $("batchPending").innerHTML = d.pending
      .map((p) => `<span class="chip">${esc(p.q.length > 16 ? p.q.slice(0, 16) + "…" : p.q)} <b>×${p.n}</b></span>`)
      .join("");
    $("batchSearches").textContent = d.totalEvents;
    $("batchWrites").textContent = d.totalDbWrites;
    $("batchSaved").textContent = d.writesSavedPct + "%";
  } catch {}
}

async function loadDecay() {
  try {
    const d = await api("/decay/stats");
    $("decayCfg").textContent = `factor ${d.factor} · every ${Math.round(d.intervalMs / 1000)}s`;
    $("decayRuns").textContent = d.runs;
  } catch {}
}
$("decayBtn").addEventListener("click", async () => {
  await post("/decay/run", {});
  await Promise.all([loadDecay(), loadTrending(), loadCache()]);
});

function refreshLivePanels() {
  loadBatch();
  loadTrending();
  loadCache();
}

const MOON = `<svg width="14" height="14" viewBox="0 0 256 256" fill="#eaf3f0"><path d="M233.54,142.23a8,8,0,0,0-8-2,88.08,88.08,0,0,1-109.8-109.8,8,8,0,0,0-10-10,104.84,104.84,0,0,0-52.91,37A104,104,0,0,0,136,224a103.09,103.09,0,0,0,62.52-20.88,104.84,104.84,0,0,0,37-52.91A8,8,0,0,0,233.54,142.23Z"/></svg>`;
const SUN = `<svg width="14" height="14" viewBox="0 0 256 256" fill="#1a2238"><path d="M120,40V16a8,8,0,0,1,16,0V40a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-16-16A8,8,0,0,0,42.34,53.66Zm0,116.68-16,16a8,8,0,0,0,11.32,11.32l16-16a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l16-16a8,8,0,0,0-11.32-11.32l-16,16A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l16,16a8,8,0,0,0,11.32-11.32ZM48,128a8,8,0,0,0-8-8H16a8,8,0,0,0,0,16H40A8,8,0,0,0,48,128Zm80,80a8,8,0,0,0-8,8v24a8,8,0,0,0,16,0V216A8,8,0,0,0,128,208Zm112-88H216a8,8,0,0,0,0,16h24a8,8,0,0,0,0-16Z"/></svg>`;
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("knob").innerHTML = theme === "dark" ? MOON : SUN;
  try {
    localStorage.setItem("lookahead-theme", theme);
  } catch {}
}
$("themeToggle").addEventListener("click", () =>
  setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark")
);

setTheme(localStorage.getItem("lookahead-theme") || "dark");
recordLatency();
renderRing();
refreshLivePanels();
loadDecay();
setInterval(() => {
  loadCache();
  loadBatch();
  loadDecay();
}, 1500);
setInterval(loadTrending, 4000);
