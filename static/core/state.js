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

export async function loadState() {
  const defaults = {
    watchlist: ["BTC","AAPL","NVDA","TSLA","MSFT","AMZN","META","GOOGL","SPY"],
    averages: {}, monitors: {}, active_monitor: 1,
    update_interval: 1000, chart_zoom: 150, default_tf: "30m",
    rsi_period: 14, utility_height: 90, sidebar_width: 260,
  };
  try {
    const r = await fetch(API + "/api/state");
    const s = await r.json();
    App.state = { ...defaults, ...s };
    if (s.update_interval) App.updateIntervalMs = s.update_interval;
  } catch (e) { App.state = { ...defaults }; }
}

export async function syncState() {
  const { state } = App;
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
