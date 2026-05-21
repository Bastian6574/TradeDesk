import { App, API } from '../../core/state.js';
import { fmt, fmtVol } from '../../core/utils.js';
import { renderMiniChart, destroyAllByPrefix } from '../MiniChart/minichart.js';

// ── TICKER LISTS ──────────────────────────────────────────────────────────────
const FAVORITES = [
  "AMD","META","PPFB","MSFT","NET","GOOG","IBM","BTC","ETOR","SPY","BRK-B",
  "AAPL","PLTR","CRM","GME","SIE.DE","RIOT","HUT","KO","ANET","QQQ","VOOV",
  "IDEV","CSCO","ORCL","DIS","MARA","NVDA","ETH","TSLA","AMZN","RHM.DE"
];
const ALL_TICKERS = [...new Set([
  ...FAVORITES,
  "NFLX","GOOGL","JPM","GLD","TLT","IWM","VXX","COIN","HOOD","SOFI",
  "MU","INTC","SNOW","UBER","PYPL","ARM","SMCI","SHOP","MSTR","BA",
  "WMT","XLK","XLF","XLE","XLV","XLY","XLI","GS","ADBE","COP"
])];
const MOVERS_UNIVERSE = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AMD","NFLX","CRM",
  "ORCL","PLTR","MSTR","ANET","BA","JPM","GS","WMT","DIS","COIN",
  "SOFI","UBER","PYPL","INTC","MU","ARM","SMCI","SNOW","SHOP","HOOD"
];
const SECTOR_TICKERS = ["SPY","XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU"];
const SECTOR_NAMES = {
  SPY:"GENERAL EQUITIES", XLK:"TECHNOLOGY", XLF:"FINANCIALS", XLE:"ENERGY",
  XLV:"HEALTH CARE", XLY:"CONS. DISC.", XLI:"INDUSTRIAL",
  XLB:"COMMODITIES", XLRE:"REAL ESTATE", XLU:"UTILITIES"
};
const SCAN_UNIVERSE = [...new Set([...FAVORITES, ...MOVERS_UNIVERSE])];

let _active = false, _initialized = false, _refreshTimer = null, _ovMode = "fav", _ovSort = "asc", _ovTf = "1D";
let _ovGen = 0;       // generation counter — kills stale RAF callbacks
let _ovBaseData = null; // cached 1W hourly payload; 1H/1D sliced client-side

// ── HELPERS ───────────────────────────────────────────────────────────────────
const _safe = t => t.replace(/[^a-zA-Z0-9]/g, "-");

function _stamp(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
}

function _setRefreshSpin(panelId, on) {
  const btn = document.getElementById("res-ref-" + panelId);
  if (btn) btn.classList.toggle("spinning", on);
}

async function _batch(tickers, tf = null) {
  try {
    const results = {};
    const chunks = [];
    for (let i = 0; i < tickers.length; i += 50) chunks.push(tickers.slice(i, i + 50));
    await Promise.all(chunks.map(async chunk => {
      const tfParam = tf ? `&tf=${encodeURIComponent(tf)}` : "";
      const r = await fetch(API + `/api/mini/batch?t=${chunk.map(encodeURIComponent).join(",")}${tfParam}`);
      if (!r.ok) return;
      Object.assign(results, await r.json());
    }));
    return results;
  } catch { return {}; }
}

function _loadTickerDynamic(ticker) {
  import('../MainChart/chart.js').then(m => m.loadTicker(ticker)).catch(() => {});
}

// Short TFs are sliced client-side from the cached 1W payload — no extra server fetch.
const _TF_SLICE = { "1H": 8, "1D": 16 }; // 8×30m=4h, 16×30m=1 trading day

function _sliceForTf(raw, tickers) {
  const limit = _TF_SLICE[_ovTf];
  if (!limit) return raw;
  const out = {};
  for (const t of tickers) {
    const d = raw[t];
    if (!d?.candles?.length) continue;
    const sliced = d.candles.slice(-limit);
    if (sliced.length < 2) continue;
    const first = sliced[0].c, last = sliced[sliced.length - 1].c;
    out[t] = {
      last,
      change_pct: first ? +((last - first) / first * 100).toFixed(2) : 0,
      candles: sliced
    };
  }
  return out;
}

// ── MARKET OVERVIEW ───────────────────────────────────────────────────────────
async function loadOverview() {
  const gen = ++_ovGen;
  _setRefreshSpin("overview", true);
  try {
    const tickers = _ovMode === "fav" ? FAVORITES : ALL_TICKERS;

    let data;
    if (_TF_SLICE[_ovTf] && _ovBaseData) {
      data = _sliceForTf(_ovBaseData, tickers);
    } else {
      const serverTf = _TF_SLICE[_ovTf] ? "1W" : _ovTf;
      const raw = await _batch(tickers, serverTf);
      if (gen !== _ovGen) return;
      if (serverTf === "1W") _ovBaseData = raw;
      data = _sliceForTf(raw, tickers);
    }
    if (gen !== _ovGen) return;

    const body = document.getElementById("res-overview-body");
    if (!body) return;

    destroyAllByPrefix("rmc-");

    const sorted = [...tickers];
    if (_ovSort === "desc") sorted.sort((a, b) => (data[b]?.change_pct ?? -999) - (data[a]?.change_pct ?? -999));
    else if (_ovSort === "asc") sorted.sort((a, b) => (data[a]?.change_pct ?? 999) - (data[b]?.change_pct ?? 999));

    body.innerHTML = `<div class="res-mc-grid">${
      sorted.map(t => {
        const sid = _safe(t);
        const d = data[t];
        const pos = !d || d.change_pct >= 0;
        const chg = d ? (pos ? "+" : "") + d.change_pct.toFixed(2) + "%" : "—";
        return `<div class="res-mc-card ${d ? (pos ? "pos-card" : "neg-card") : ""}" data-ticker="${t}">
          <div class="res-mc-top">
            <span class="res-mc-sym">${t}</span>
            <span class="res-mc-chg ${d ? (pos ? "pos" : "neg") : ""}">${chg}</span>
          </div>
          <div class="res-mc-chart-wrap"><canvas id="rmc-${sid}" height="44"></canvas></div>
          <div class="res-mc-price">${d ? fmt(d.last) : "—"}</div>
        </div>`;
      }).join("")
    }</div>`;

    body.querySelectorAll(".res-mc-card").forEach(card => {
      card.addEventListener("click", () => _loadTickerDynamic(card.dataset.ticker));
    });

    _stamp("res-ts-overview");

    // Double-RAF: first frame commits layout, second frame has correct dimensions for Chart.js
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (gen !== _ovGen) return;
      sorted.forEach(t => {
        const d = data[t];
        if (d?.candles?.length) renderMiniChart("rmc-" + _safe(t), d.candles, d.change_pct);
      });
    }));
  } catch (e) { console.warn("overview error", e); }
  _setRefreshSpin("overview", false);
}

// ── TOP MOVERS ────────────────────────────────────────────────────────────────
async function loadMovers() {
  _setRefreshSpin("movers", true);
  try {
    const universe = [...new Set([...MOVERS_UNIVERSE, ...(App.state.watchlist || [])])];
    const data = await _batch(universe);
    const body = document.getElementById("res-movers-body");
    if (!body) return;

    const entries = Object.entries(data)
      .filter(([, d]) => d?.change_pct != null)
      .sort((a, b) => b[1].change_pct - a[1].change_pct);
    const gainers = entries.filter(([, d]) => d.change_pct >= 0).slice(0, 15);
    const losers  = entries.filter(([, d]) => d.change_pct < 0).reverse().slice(0, 15);

    const row = (t, d, i, cls) => {
      const sign = cls === "pos" ? "+" : "";
      return `<div class="res-mover-row" data-ticker="${t}">
        <span class="res-mv-rank">${i + 1}</span>
        <span class="res-mv-sym">${t}</span>
        <span class="res-mv-price">${fmt(d.last)}</span>
        <span class="res-mv-chg ${cls}">${sign}${d.change_pct.toFixed(2)}%</span>
      </div>`;
    };

    body.innerHTML = `
      <div class="res-mv-col">
        <div class="res-mv-hdr pos">▲ GAINERS</div>
        ${gainers.map(([t, d], i) => row(t, d, i, "pos")).join("")}
      </div>
      <div class="res-mv-col">
        <div class="res-mv-hdr neg">▼ LOSERS</div>
        ${losers.map(([t, d], i) => row(t, d, i, "neg")).join("")}
      </div>`;

    body.querySelectorAll(".res-mover-row").forEach(r => {
      r.addEventListener("click", () => _loadTickerDynamic(r.dataset.ticker));
    });

    // Auto-size panel to fit content
    requestAnimationFrame(() => {
      const panel = document.getElementById("res-movers");
      if (!panel) return;
      const hdr = panel.querySelector(".res-card-hdr");
      const hdrH = hdr ? hdr.offsetHeight : 26;
      const totalH = hdrH + body.scrollHeight + 2;
      const maxH = (panel.parentElement?.offsetHeight || 600) * 0.6;
      panel.style.flex = "none";
      panel.style.height = Math.min(totalH, maxH) + "px";
    });

    _stamp("res-ts-movers");
  } catch (e) { console.warn("movers error", e); }
  _setRefreshSpin("movers", false);
}

// ── SECTOR WATCH ──────────────────────────────────────────────────────────────
async function loadSectors() {
  _setRefreshSpin("sectors", true);
  try {
    const data = await _batch(SECTOR_TICKERS);
    const body = document.getElementById("res-sectors-body");
    if (!body) return;
    const entries = SECTOR_TICKERS.map(t => [t, data[t]]).filter(([, d]) => d);
    if (!entries.length) { body.innerHTML = `<div class="res-loading">NO DATA</div>`; return; }
    const maxAbs = Math.max(0.01, ...entries.map(([, d]) => Math.abs(d.change_pct)));
    body.innerHTML = entries.sort((a, b) => b[1].change_pct - a[1].change_pct).map(([t, d]) => {
      const cls = d.change_pct >= 0 ? "pos" : "neg";
      const w = (Math.abs(d.change_pct) / maxAbs * 100).toFixed(1);
      const sign = d.change_pct >= 0 ? "+" : "";
      return `<div class="res-sector-row">
        <span class="res-sec-name">${SECTOR_NAMES[t]}</span>
        <div class="res-sec-bar-wrap"><div class="res-sec-bar ${cls}" style="width:${w}%"></div></div>
        <span class="res-sec-val ${cls}">${sign}${d.change_pct.toFixed(2)}%</span>
      </div>`;
    }).join("");

    requestAnimationFrame(() => {
      const panel = document.getElementById("res-sectors");
      const bdy   = document.getElementById("res-sectors-body");
      if (!panel || !bdy) return;
      const hdrH = panel.querySelector(".res-card-hdr")?.offsetHeight ?? 26;
      panel.style.flex   = "none";
      panel.style.height = (hdrH + bdy.scrollHeight + 2) + "px";
    });
  } catch (e) { console.warn("sectors error", e); }
  _setRefreshSpin("sectors", false);
}

// ── VOLUME SCANNER ────────────────────────────────────────────────────────────
async function loadVolumeScanner() {
  _setRefreshSpin("volscan", true);
  try {
    const scanUniverse = _ovMode === "fav" ? FAVORITES : SCAN_UNIVERSE;
    const data = await _batch(scanUniverse, "1W"); // always needs multi-day hourly candles
    const body = document.getElementById("res-volscan-body");
    if (!body) return;

    const results = [];
    for (const [t, d] of Object.entries(data)) {
      if (!d?.candles?.length) continue;
      // Group hourly candles by day, sum volumes per day
      const dayVols = {};
      d.candles.forEach(c => {
        const day = new Date(c.t).toDateString();
        dayVols[day] = (dayVols[day] || 0) + (c.v || 0);
      });
      const vols = Object.values(dayVols);
      if (vols.length < 2) continue;
      const todayVol = vols[vols.length - 1];
      const priorVols = vols.slice(0, -1).filter(v => v > 0);
      if (!priorVols.length || todayVol <= 0) continue;
      const avgVol = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;
      const ratio = avgVol > 0 ? todayVol / avgVol : 0;
      if (ratio >= 1.5) {
        results.push({ t, last: d.last, change_pct: d.change_pct, todayVol, avgVol, ratio });
      }
    }

    if (_ovSort === "desc") results.sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0));
    else if (_ovSort === "asc") results.sort((a, b) => (a.change_pct || 0) - (b.change_pct || 0));
    else results.sort((a, b) => b.ratio - a.ratio);

    if (!results.length) {
      body.innerHTML = `<div class="res-loading">NO UNUSUAL VOLUME DETECTED</div>`;
      _stamp("res-ts-volscan"); return;
    }

    body.innerHTML = `
      <div class="res-vs-hdr">
        <span>TICKER</span><span>CHG</span><span>VOL TODAY</span><span>RATIO</span>
      </div>
      ${results.slice(0, 25).map(r => {
        const cls = (r.change_pct || 0) >= 0 ? "pos" : "neg";
        const sign = (r.change_pct || 0) >= 0 ? "+" : "";
        const hot = r.ratio >= 3 ? " vs-hot" : r.ratio >= 2 ? " vs-warm" : "";
        return `<div class="res-vs-row${hot}" data-ticker="${r.t}">
          <span class="res-vs-sym">${r.t}</span>
          <span class="res-vs-chg ${cls}">${sign}${(r.change_pct || 0).toFixed(2)}%</span>
          <span class="res-vs-vol">${fmtVol(r.todayVol)}</span>
          <span class="res-vs-ratio${hot}">${r.ratio.toFixed(1)}×</span>
        </div>`;
      }).join("")}`;

    body.querySelectorAll(".res-vs-row").forEach(r => {
      r.addEventListener("click", () => _loadTickerDynamic(r.dataset.ticker));
    });

    _stamp("res-ts-volscan");
  } catch (e) { console.warn("volscan error", e); }
  _setRefreshSpin("volscan", false);
}

// ── DRAG-TO-RESIZE ────────────────────────────────────────────────────────────
function _setupDrags() {
  // Horizontal handles — resize left or right fixed-width column
  document.querySelectorAll("#research-grid > .res-drag-h").forEach(h => {
    h.addEventListener("mousedown", e => {
      e.preventDefault();
      const target = document.getElementById(h.dataset.target);
      if (!target) return;
      const startX = e.clientX, startW = target.offsetWidth;
      const dir = parseInt(h.dataset.dir || "1");
      document.body.style.cursor = "ew-resize";
      const move = ev => {
        target.style.width = Math.max(160, startW + (ev.clientX - startX) * dir) + "px";
      };
      const up = () => {
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });

  // Vertical handles — resize the panel above the handle
  document.querySelectorAll(".res-drag-v").forEach(h => {
    h.addEventListener("mousedown", e => {
      e.preventDefault();
      const target = document.getElementById(h.dataset.target);
      if (!target) return;
      const startY = e.clientY, startH = target.offsetHeight;
      document.body.style.cursor = "ns-resize";
      const move = ev => {
        target.style.flex = "none";
        target.style.height = Math.max(60, startH + (ev.clientY - startY)) + "px";
      };
      const up = () => {
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}

// ── REFRESH ───────────────────────────────────────────────────────────────────
window._resRefresh = function(panel) {
  switch (panel) {
    case "overview": loadOverview(); break;
    case "movers":   loadMovers();   break;
    case "sectors":  loadSectors();  break;
    case "volscan":  loadVolumeScanner(); break;
  }
};

// ── OVERVIEW TAB TOGGLE ───────────────────────────────────────────────────────
window._resOvTab = function(mode) {
  _ovMode = mode;
  _ovBaseData = null; // ticker set changed — discard cached 1W data
  document.querySelectorAll(".res-ov-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  loadOverview();
  loadVolumeScanner();
};

// ── OVERVIEW SORT ─────────────────────────────────────────────────────────────
window._resOvSort = function(dir) {
  _ovSort = _ovSort === dir ? null : dir;
  document.getElementById("res-sort-up")?.classList.toggle("active", _ovSort === "desc");
  document.getElementById("res-sort-down")?.classList.toggle("active", _ovSort === "asc");
  loadOverview();
  loadVolumeScanner();
};

// ── OVERVIEW TIMEFRAME ────────────────────────────────────────────────────────
window._resOvTf = function(tf) {
  _ovTf = tf;
  document.querySelectorAll(".res-tf-btn").forEach(b => b.classList.toggle("active", b.dataset.tf === tf));
  loadOverview();
};

// ── LIFECYCLE ─────────────────────────────────────────────────────────────────
function _runAll() { _ovBaseData = null; loadOverview(); loadMovers(); loadSectors(); loadVolumeScanner(); }

export function activateResearch() {
  _active = true;
  _runAll();
  _scheduleRefresh();
}

export function deactivateResearch() {
  _active = false;
  if (_refreshTimer) { clearTimeout(_refreshTimer); _refreshTimer = null; }
}

function _scheduleRefresh() {
  _refreshTimer = setTimeout(() => {
    if (_active) { _runAll(); _scheduleRefresh(); }
  }, 60_000);
}

// ── TAB SWITCH ────────────────────────────────────────────────────────────────
export function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  const mainEl = document.getElementById("main");
  const resEl  = document.getElementById("research");
  if (tab === "research") {
    mainEl.style.display = "none";
    resEl.style.display  = "flex";
    activateResearch();
  } else {
    mainEl.style.display = "flex";
    resEl.style.display  = "none";
    deactivateResearch();
  }
}
window.switchTab = switchTab;

// ── HELPERS: HEADER WITH REFRESH ──────────────────────────────────────────────
function _hdr(title, panelId, extra = "") {
  return `<div class="res-card-hdr">
    <span>${title}</span>${extra}
    <span class="res-ts" id="res-ts-${panelId}"></span>
    <button class="res-ref-btn" id="res-ref-${panelId}" onclick="window._resRefresh('${panelId}')" title="Refresh">↻</button>
  </div>`;
}

// ── BUILD DOM ─────────────────────────────────────────────────────────────────
export function initResearch() {
  if (_initialized) return;
  _initialized = true;
  const el = document.getElementById("research");
  if (!el) return;

  const ovTabs = `<div class="res-ov-tabs">
    <button class="res-ov-tab active" data-mode="fav" onclick="window._resOvTab('fav')">FAV</button>
    <button class="res-ov-tab" data-mode="all" onclick="window._resOvTab('all')">ALL</button>
  </div>`;

  el.innerHTML = `
<div id="research-grid">

  <!-- LEFT COLUMN -->
  <div id="res-left">

    <div class="res-panel" id="res-overview">
      <div class="res-card-hdr">
        <span>MARKET OVERVIEW</span>
        ${ovTabs}
        <button class="res-sort-btn pos" id="res-sort-up"   onclick="window._resOvSort('desc')" title="Sort best performers first">▲</button>
        <button class="res-sort-btn neg active" id="res-sort-down" onclick="window._resOvSort('asc')"  title="Sort worst performers first">▼</button>
        <span class="res-ts" id="res-ts-overview"></span>
        <button class="res-ref-btn" id="res-ref-overview" onclick="window._resRefresh('overview')" title="Refresh">↻</button>
      </div>
      <div class="res-card-body" id="res-overview-body">
        <div class="res-loading">SCANNING…</div>
      </div>
      <div class="res-ov-tf-bar">
        <button class="res-tf-btn" data-tf="1H" onclick="window._resOvTf('1H')">1H</button>
        <button class="res-tf-btn active" data-tf="1D" onclick="window._resOvTf('1D')">1D</button>
        <button class="res-tf-btn" data-tf="1W" onclick="window._resOvTf('1W')">1W</button>
        <button class="res-tf-btn" data-tf="1M" onclick="window._resOvTf('1M')">1M</button>
        <button class="res-tf-btn" data-tf="3M" onclick="window._resOvTf('3M')">3M</button>
      </div>
    </div>

    <div class="res-drag res-drag-v" data-target="res-overview"></div>

    <div class="res-panel" id="res-sectors">
      ${_hdr("SECTOR WATCH", "sectors")}
      <div class="res-card-body" id="res-sectors-body">
        <div class="res-loading">SCANNING…</div>
      </div>
    </div>

  </div>

  <div class="res-drag res-drag-h" data-target="res-left" data-dir="1"></div>

  <!-- CENTER COLUMN -->
  <div id="res-center">

    <div class="res-panel" id="res-movers">
      <div class="res-card-hdr">
        TOP MOVERS
        <span class="res-card-sub">DAILY % CHG</span>
        <span class="res-ts" id="res-ts-movers"></span>
        <button class="res-ref-btn" id="res-ref-movers" onclick="window._resRefresh('movers')" title="Refresh">↻</button>
      </div>
      <div class="res-card-body" id="res-movers-body">
        <div class="res-loading">SCANNING…</div>
      </div>
    </div>

    <div class="res-drag res-drag-v" data-target="res-movers"></div>

    <div class="res-panel" id="res-volscan">
      ${_hdr("VOLUME SCANNER", "volscan")}
      <div class="res-card-body" id="res-volscan-body">
        <div class="res-loading">SCANNING…</div>
      </div>
    </div>

  </div>

  <div class="res-drag res-drag-h" data-target="res-right" data-dir="-1"></div>

  <!-- RIGHT COLUMN -->
  <div id="res-right">

    <div class="res-panel res-panel-dim" id="res-heatmap">
      <div class="res-card-hdr">MARKET HEATMAP</div>
      <div class="res-card-body res-coming-soon">
        <div class="res-cs-icon">▦</div>
        <div class="res-cs-title">COMING SOON</div>
        <div class="res-cs-desc">Color-coded grid by<br>market cap &amp; daily % chg</div>
      </div>
    </div>

    <div class="res-drag res-drag-v" data-target="res-heatmap"></div>

    <div class="res-panel res-panel-dim" id="res-gaps">
      <div class="res-card-hdr">GAP SCANNER</div>
      <div class="res-card-body res-coming-soon">
        <div class="res-cs-icon">↑↓</div>
        <div class="res-cs-title">COMING SOON</div>
        <div class="res-cs-desc">Pre/post market gaps<br>with volume + catalyst</div>
      </div>
    </div>

    <div class="res-drag res-drag-v" data-target="res-gaps"></div>

    <div class="res-panel res-panel-dim" id="res-rsi-scan">
      <div class="res-card-hdr">RSI SCAN</div>
      <div class="res-card-body res-coming-soon">
        <div class="res-cs-icon">◆</div>
        <div class="res-cs-title">COMING SOON</div>
        <div class="res-cs-desc">Multi-timeframe RSI<br>extremes scanner</div>
      </div>
    </div>

  </div>

</div>`;

  _setupDrags();
}
