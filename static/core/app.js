import { App, loadState } from './state.js';
import { initResearch } from '../widgets/Research/research.js';
import './settings.js';
import { loadMainChart, getMonitorPreset, restorePreset, updateMonitorTabs, drawMainChart, drawLiveChart } from '../widgets/MainChart/chart.js';
import { loadPineTS, loadPineFileScripts } from '../widgets/MainChart/pine.js';
import { drawUtility } from '../widgets/UtilityPanel/utility.js';
import { renderWatchlist, refreshWatchlistMinis, initSidebarResize } from '../widgets/Sidebar/sidebar.js';
import { initNewsTooltip, scheduleSentiment, scheduleDetails, initIndicatorUI } from '../widgets/InfoPanel/info.js';
import { initPredictions } from '../widgets/Predictions/predictions.js';
import { initFunding } from '../widgets/FundingOI/funding.js';

// ── CLOCK ─────────────────────────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById("clock");
  setInterval(() => { el.textContent = new Date().toLocaleTimeString("en-US", { hour12: false }); }, 1000);
}

// ── AUTO REFRESH ──────────────────────────────────────────────────────────────
function scheduleRefresh() {
  App.refreshTimer = setTimeout(() => { refreshWatchlistMinis(); scheduleRefresh(); }, 60000);
}

// ── WINDOW RESIZE ─────────────────────────────────────────────────────────────
let _resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    App.panels.forEach(p => {
      if (p.tf === "1s") {
        if (p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c);
        drawUtility(p, p.liveCandles.slice(-p.chartZoom));
      } else if (p.candleData) {
        drawMainChart(p, p.candleData);
        drawUtility(p, p.candleData._liveCandles);
      }
    });
  }, 300);
});

// ── MODAL CLOSE ON BACKDROP ───────────────────────────────────────────────────
function wireModalBackdrops() {
  document.getElementById("modal").addEventListener("click", e => { if (e.target.id === "modal") window.closeModal(); });
  document.getElementById("settings-popup").addEventListener("click", e => { if (e.target.id === "settings-popup") window.closeSettings(); });
  document.getElementById("pine-modal").addEventListener("click", e => { if (e.target.id === "pine-modal") window.closePineEditor(); });
}

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadState();
  initSidebarResize();
  if (window.sidebarRestore) window.sidebarRestore(App.state.sidebar_width);
  renderWatchlist();
  startClock();
  initNewsTooltip();
  scheduleSentiment();
  scheduleDetails();
  scheduleRefresh();
  const preset = getMonitorPreset(App.state.active_monitor);
  restorePreset(preset);
  updateMonitorTabs();
  initIndicatorUI();
  initPredictions();
  initFunding();
  wireModalBackdrops();
  loadPineTS();
  loadPineFileScripts();
  initResearch();
}

init();
