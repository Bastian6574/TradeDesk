import { App, API } from '../../core/state.js';
import { fmt } from '../../core/utils.js';

// ── TICKER UNIVERSES ──────────────────────────────────────────────────────────
const OVERVIEW_TICKERS = ["SPY","QQQ","IWM","DIA","BTC","GLD","USO","VXX"];
const OVERVIEW_LABELS  = {
  SPY:"S&P 500", QQQ:"NASDAQ 100", IWM:"RUSSELL 2K", DIA:"DOW JONES",
  BTC:"BITCOIN",  GLD:"GOLD",       USO:"OIL",        VXX:"VOLATILITY"
};
const MOVERS_UNIVERSE = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AMD","NFLX","CRM",
  "ORCL","PLTR","MSTR","ANET","BA","JPM","GS","WMT","DIS","COIN",
  "SOFI","UBER","PYPL","INTC","MU","ARM","SMCI","SNOW","SHOP","HOOD"
];
const SECTOR_TICKERS = ["XLK","XLF","XLE","XLV","XLY","XLI","XLB","XLRE","XLU"];
const SECTOR_NAMES   = {
  XLK:"TECHNOLOGY", XLF:"FINANCIALS", XLE:"ENERGY",    XLV:"HEALTH CARE",
  XLY:"CONS. DISC.", XLI:"INDUSTRIAL", XLB:"MATERIALS", XLRE:"REAL ESTATE",
  XLU:"UTILITIES"
};

let _refreshTimer = null;
let _active       = false;
let _initialized  = false;

// ── BATCH FETCH ───────────────────────────────────────────────────────────────
async function _batch(tickers) {
  try {
    const r = await fetch(API + `/api/mini/batch?t=${tickers.join(",")}`);
    if (!r.ok) return {};
    return await r.json();
  } catch (_e) { return {}; }
}

// ── MARKET OVERVIEW ───────────────────────────────────────────────────────────
async function loadOverview() {
  const data = await _batch(OVERVIEW_TICKERS);
  const body = document.getElementById("res-overview-body");
  if (!body) return;
  body.innerHTML = OVERVIEW_TICKERS.map(t => {
    const d   = data[t];
    const chg = d?.change_pct ?? null;
    const cls = chg === null ? "" : chg >= 0 ? "pos" : "neg";
    const sign = chg !== null && chg >= 0 ? "+" : "";
    return `<div class="res-ticker-card ${cls}">
      <span class="res-tc-label">${OVERVIEW_LABELS[t] || t}</span>
      <span class="res-tc-sym">${t}</span>
      <span class="res-tc-price">${d ? fmt(d.last) : "—"}</span>
      <span class="res-tc-chg ${cls}">${chg !== null ? sign + chg.toFixed(2) + "%" : "—"}</span>
    </div>`;
  }).join("");
  _stamp("res-ts-overview");
}

// ── TOP MOVERS ────────────────────────────────────────────────────────────────
async function loadMovers() {
  const universe = [...new Set([...MOVERS_UNIVERSE, ...(App.state.watchlist || [])])];
  const data     = await _batch(universe);
  const body     = document.getElementById("res-movers-body");
  if (!body) return;

  const entries = Object.entries(data)
    .filter(([, d]) => d?.change_pct != null)
    .sort((a, b) => b[1].change_pct - a[1].change_pct);

  const gainers = entries.filter(([, d]) => d.change_pct >= 0).slice(0, 12);
  const losers  = entries.filter(([, d]) => d.change_pct < 0).reverse().slice(0, 12);

  const row = (t, d, i, cls) => {
    const sign = cls === "pos" ? "+" : "";
    return `<div class="res-mover-row">
      <span class="res-mv-rank">${i + 1}</span>
      <span class="res-mv-sym">${t}</span>
      <span class="res-mv-price">${fmt(d.last)}</span>
      <span class="res-mv-chg ${cls}">${sign}${d.change_pct.toFixed(2)}%</span>
    </div>`;
  };

  body.innerHTML = `
    <div class="res-mv-col">
      <div class="res-mv-hdr pos">▲ GAINERS</div>
      ${gainers.map(([ t, d], i) => row(t, d, i, "pos")).join("")}
    </div>
    <div class="res-mv-col">
      <div class="res-mv-hdr neg">▼ LOSERS</div>
      ${losers.map(([t, d], i) => row(t, d, i, "neg")).join("")}
    </div>`;
  _stamp("res-ts-movers");
}

// ── SECTOR WATCH ──────────────────────────────────────────────────────────────
async function loadSectors() {
  const data = await _batch(SECTOR_TICKERS);
  const body = document.getElementById("res-sectors-body");
  if (!body) return;

  const entries = SECTOR_TICKERS.map(t => [t, data[t]]).filter(([, d]) => d);
  if (!entries.length) return;
  const maxAbs = Math.max(0.01, ...entries.map(([, d]) => Math.abs(d.change_pct)));

  body.innerHTML = entries
    .sort((a, b) => b[1].change_pct - a[1].change_pct)
    .map(([t, d]) => {
      const cls  = d.change_pct >= 0 ? "pos" : "neg";
      const w    = (Math.abs(d.change_pct) / maxAbs * 100).toFixed(1);
      const sign = d.change_pct >= 0 ? "+" : "";
      return `<div class="res-sector-row">
        <span class="res-sec-name">${SECTOR_NAMES[t]}</span>
        <div class="res-sec-bar-wrap"><div class="res-sec-bar ${cls}" style="width:${w}%"></div></div>
        <span class="res-sec-val ${cls}">${sign}${d.change_pct.toFixed(2)}%</span>
      </div>`;
    }).join("");
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function _stamp(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
}

function _runAll() { loadOverview(); loadMovers(); loadSectors(); }

// ── LIFECYCLE ─────────────────────────────────────────────────────────────────
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
  const mainEl     = document.getElementById("main");
  const researchEl = document.getElementById("research");
  document.querySelectorAll(".tab-btn")
    .forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "research") {
    mainEl.style.display     = "none";
    researchEl.style.display = "flex";
    activateResearch();
  } else {
    mainEl.style.display     = "flex";
    researchEl.style.display = "none";
    deactivateResearch();
  }
}
window.switchTab = switchTab;

// ── BUILD DOM ─────────────────────────────────────────────────────────────────
export function initResearch() {
  if (_initialized) return;
  _initialized = true;

  const el = document.getElementById("research");
  if (!el) return;

  el.innerHTML = `
    <div id="research-grid">

      <!-- LEFT COL -->
      <div class="res-card" id="res-overview">
        <div class="res-card-hdr">
          MARKET OVERVIEW
          <span class="res-ts" id="res-ts-overview"></span>
        </div>
        <div class="res-card-body" id="res-overview-body">
          <div class="res-loading">SCANNING…</div>
        </div>
      </div>

      <div class="res-card" id="res-sectors">
        <div class="res-card-hdr">SECTOR WATCH</div>
        <div class="res-card-body" id="res-sectors-body">
          <div class="res-loading">SCANNING…</div>
        </div>
      </div>

      <!-- CENTER COL -->
      <div class="res-card" id="res-movers">
        <div class="res-card-hdr">
          TOP MOVERS
          <span class="res-card-sub">DAILY % CHANGE</span>
          <span class="res-ts" id="res-ts-movers"></span>
        </div>
        <div class="res-card-body" id="res-movers-body">
          <div class="res-loading">SCANNING…</div>
        </div>
      </div>

      <!-- RIGHT COL (flex wrapper) -->
      <div id="res-right-col">

        <div class="res-card res-card-dim" id="res-heatmap">
          <div class="res-card-hdr">MARKET HEATMAP</div>
          <div class="res-card-body res-coming-soon">
            <div class="res-cs-icon">▦</div>
            <div class="res-cs-title">COMING SOON</div>
            <div class="res-cs-desc">Color-coded grid sized by<br>market cap, intensity by<br>daily % change</div>
          </div>
        </div>

        <div class="res-card res-card-dim" id="res-gaps">
          <div class="res-card-hdr">GAP SCANNER</div>
          <div class="res-card-body res-coming-soon">
            <div class="res-cs-icon">↑↓</div>
            <div class="res-cs-title">COMING SOON</div>
            <div class="res-cs-desc">Pre/post market gaps<br>with volume + catalyst<br>filter</div>
          </div>
        </div>

        <div class="res-card res-card-dim" id="res-volume">
          <div class="res-card-hdr">VOLUME MAP</div>
          <div class="res-card-body res-coming-soon">
            <div class="res-cs-icon">▊▊</div>
            <div class="res-cs-title">COMING SOON</div>
            <div class="res-cs-desc">Real-time unusual volume<br>scanner across sectors</div>
          </div>
        </div>

      </div><!-- end right col -->

    </div>`;
}
