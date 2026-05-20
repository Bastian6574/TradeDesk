export const API = "";
export const LAYOUT_COUNT = { "1":1, "2h":2, "2v":2, "4":4 };

// All mutable runtime state lives here — modules import and mutate this object
export const App = {
  state: {
    watchlist: ["BTC","AAPL","NVDA","TSLA","MSFT","AMZN","META","GOOGL","SPY"],
    averages: {},
    monitors: {},
    active_monitor: 1,
    update_interval: 1000,
    chart_zoom: 150,
    default_tf: "30m",
    rsi_period: 14,
    utility_height: 90,
    sidebar_width: 260,
  },
  panels: [],
  layoutRows: [[0]],    // array of rows; each row = array of panel indices
  activeIdx: 0,
  currentLayout: "1",
  updateIntervalMs: 1000,
  miniCharts: {},
  refreshTimer: null,
  newsHeadlines: [],
  priceFeed: null,
  priceFeedMs: 0,
  priceFeedBusy: false,
};

// Indicator toggles — persisted to localStorage
export const indicators = (() => {
  const d = { arima: true, volume: true, arimaHeuristic: true, prophetHeuristic: true };
  try { return { ...d, ...JSON.parse(localStorage.getItem("td_indicators") || "{}") }; }
  catch { return { ...d }; }
})();
export function saveIndicators() { localStorage.setItem("td_indicators", JSON.stringify(indicators)); }

const _BACKUP_KEY = "td_state_backup";
const _EMPTY_MONITORS = { "1": { charts: [{ ticker: "BTC", tf: "30m", utilityMode: "rsi", widgetMode: "candles", widgetSettings: {} }] } };

function _looksLikeDefaults(s) {
  // Server returned reset state: no saved monitors or a bare single BTC entry
  if (!s.monitors) return true;
  const keys = Object.keys(s.monitors);
  if (keys.length === 0) return true;
  const m1 = s.monitors["1"];
  if (!m1 || typeof m1 === "string") return true;  // old format "BTC"
  const charts = m1.charts || [];
  if (charts.length === 1 && !m1.layoutRows) return true;  // bare default
  return false;
}

export function saveStateBackup() {
  const { state } = App;
  if (!state.monitors || Object.keys(state.monitors).length === 0) return;
  try {
    localStorage.setItem(_BACKUP_KEY, JSON.stringify({
      monitors:       state.monitors,
      watchlist:      state.watchlist,
      averages:       state.averages || {},
      active_monitor: state.active_monitor,
      sidebar_width:  state.sidebar_width ?? 260,
    }));
  } catch (_e) {}
}

export function loadStateBackup() {
  try { return JSON.parse(localStorage.getItem(_BACKUP_KEY) || "null"); }
  catch { return null; }
}

export async function loadState() {
  const defaults = {
    watchlist: ["BTC","ANET","MSTR","ORCL","PLTR"],
    averages: {}, monitors: {}, active_monitor: 1,
    update_interval: 1000, chart_zoom: 150, default_tf: "30m",
    rsi_period: 14, utility_height: 90, sidebar_width: 260,
  };
  try {
    const r = await fetch(API + "/api/state");
    const s = await r.json();
    App.state = { ...defaults, ...s };
    if (s.update_interval) App.updateIntervalMs = s.update_interval;
    // If server returned bare defaults, silently restore from localStorage backup
    if (_looksLikeDefaults(s)) {
      const backup = loadStateBackup();
      if (backup?.monitors && !_looksLikeDefaults(backup)) {
        App.state.monitors       = backup.monitors;
        App.state.watchlist      = backup.watchlist  || App.state.watchlist;
        App.state.averages       = backup.averages   || {};
        App.state.active_monitor = backup.active_monitor ?? 1;
        App.state.sidebar_width  = backup.sidebar_width  ?? 260;
      }
    } else {
      saveStateBackup(); // good state from server — update backup
    }
  } catch (e) { App.state = { ...defaults }; }
}

// ── MONITOR TICKER CONTEXT ────────────────────────────────────────────────────
const _CRYPTO_SET = new Set(["BTC","ETH","BNB","SOL","DOGE","ADA","XRP","AVAX","DOT","LINK","MATIC","LTC","BCH","XLM","UNI","AAVE","ATOM"]);
export const isCrypto = t => _CRYPTO_SET.has((t || "").toUpperCase());

export function getMonitorTicker() {
  const counts = {};
  for (const p of App.panels) counts[p.ticker] = (counts[p.ticker] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return (best && best[1] >= 2) ? best[0] : null;
}

export function getContextTicker() {
  return getMonitorTicker() ?? App.panels[App.activeIdx]?.ticker ?? "BTC";
}

export async function syncState() {
  const { state } = App;
  saveStateBackup();
  await fetch(API + "/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      monitors: state.monitors,
      active_monitor: state.active_monitor,
      sidebar_width: state.sidebar_width ?? 260,
      update_interval: App.updateIntervalMs,
      chart_zoom: state.chart_zoom || 150,
      default_tf: state.default_tf || "30m",
      rsi_period: state.rsi_period || 14,
      utility_height: state.utility_height || 90,
    }),
  });
}
