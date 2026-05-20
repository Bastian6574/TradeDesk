import { App, syncState, API } from '../../core/state.js';
import { fmt } from '../../core/utils.js';
import { loadTicker, loadTickerAllPanels } from '../MainChart/chart.js';

let _syncOn = false;

// ── WATCHLIST RENDER ──────────────────────────────────────────────────────────
export function renderWatchlist() {
  const container = document.getElementById("watchlist-items");
  container.innerHTML = "";
  App.state.watchlist.forEach(ticker => {
    const item = document.createElement("div");
    item.className = "watch-item" + (ticker === (App.panels[App.activeIdx]?.ticker) ? " active" : "");
    item.id = "wi-" + ticker;
    item.innerHTML = `
      <button class="remove-btn" onclick="removeTicker('${ticker}',event)">×</button>
      <div class="watch-top">
        <span class="watch-symbol">${ticker}</span>
        <span class="watch-live-pct" id="wlp-${ticker}">—</span>
      </div>
      <div class="watch-bottom-row">
        <span class="watch-price" id="wp-${ticker}">…</span>
        <span class="watch-change" id="wc-${ticker}">—</span>
      </div>
      <div class="mini-chart-wrap"><canvas id="mc-${ticker}" height="40"></canvas></div>
    `;
    item.addEventListener("click", () => _syncOn ? loadTickerAllPanels(ticker) : loadTicker(ticker));
    container.appendChild(item);
    loadMiniChart(ticker);
  });
  startWatchlistFeed();
}

export async function loadMiniChart(ticker) {
  try {
    const r = await fetch(API + `/api/mini/${ticker}`);
    const data = await r.json(); if (data.error) return;
    const wpEl = document.getElementById("wp-" + ticker);
    const chEl = document.getElementById("wc-" + ticker);
    if (!wpEl || !chEl) return;
    wpEl.textContent = fmt(data.last);
    const pos = data.change_pct >= 0;
    chEl.textContent = (pos ? "+" : "") + data.change_pct.toFixed(2) + "%";
    chEl.className = "watch-change " + (pos ? "pos" : "neg");
    if (App.miniCharts[ticker]) { App.miniCharts[ticker].destroy(); delete App.miniCharts[ticker]; }
    const canvas = document.getElementById("mc-" + ticker); if (!canvas) return;
    const color = pos ? "#00d47e" : "#f03e3e";
    App.miniCharts[ticker] = new Chart(canvas, {
      type: "line",
      data: { labels: data.candles.map(() => ""), datasets: [{ data: data.candles.map(c => c.c), borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: color + "18", tension: 0.2 }] },
      options: { animation: false, responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { display: false } } }
    });
  } catch (e) {}
}

export function refreshWatchlistMinis() { App.state.watchlist.forEach(t => loadMiniChart(t)); }

// ── WATCHLIST CRUD ────────────────────────────────────────────────────────────
export function openModal() {
  document.getElementById("modal").classList.remove("hidden");
  setTimeout(() => document.getElementById("modal-input").focus(), 50);
}

export function closeModal() {
  document.getElementById("modal").classList.add("hidden");
  document.getElementById("modal-input").value = "";
}

export function modalKey(e) { if (e.key === "Enter") addTicker(); if (e.key === "Escape") closeModal(); }

export async function addTicker() {
  const val = document.getElementById("modal-input").value.trim().toUpperCase();
  if (!val || App.state.watchlist.includes(val)) { closeModal(); return; }
  App.state.watchlist.push(val); closeModal();
  await fetch(API + "/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: App.state.watchlist }) });
  renderWatchlist();
}

export async function removeTicker(ticker, e) {
  e.stopPropagation();
  App.state.watchlist = App.state.watchlist.filter(t => t !== ticker);
  if (App.miniCharts[ticker]) { App.miniCharts[ticker].destroy(); delete App.miniCharts[ticker]; }
  await fetch(API + "/api/watchlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: App.state.watchlist }) });
  renderWatchlist();
}

export function toggleWatchlistSync() {
  _syncOn = !_syncOn;
  const btn = document.getElementById("sidebar-sync-btn");
  if (btn) btn.classList.toggle("active", _syncOn);
}

export function searchTicker(e) {
  if (e.key !== "Enter") return;
  const val = e.target.value.trim().toUpperCase(); if (!val) return;
  e.target.value = ""; loadTicker(val);
}

// ── SIDEBAR RESIZE ────────────────────────────────────────────────────────────
export function initSidebarResize() {
  const resizer = document.getElementById("sidebar-resizer");
  const sidebar = document.getElementById("sidebar");
  const collapseBtn = document.getElementById("sidebar-collapse-btn");
  const MIN_W = 80, MAX_W = 480;
  let dragging = false, startX = 0, startW = 0, collapsed = false, lastW = 260;

  function redrawPanels() {
    clearTimeout(window._sbRedraw);
    window._sbRedraw = setTimeout(() => {
      import('../MainChart/chart.js').then(({ drawMainChart, drawLiveChart }) => {
        import('../UtilityPanel/utility.js').then(({ drawUtility }) => {
          App.panels.forEach(p => {
            if (p.tf === "1s") {
              if (p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c);
              drawUtility(p, p.liveCandles.slice(-p.chartZoom));
            } else if (p.candleData) {
              drawMainChart(p, p.candleData);
              drawUtility(p, p.candleData._liveCandles);
            }
          });
        });
      });
    }, 150);
  }

  function setCollapsed(val, save = true) {
    collapsed = val;
    if (val) {
      lastW = sidebar.offsetWidth || lastW;
      sidebar.style.width = "0px";
      resizer.classList.add("collapsed");
      collapseBtn.textContent = "▶"; collapseBtn.title = "Expand watchlist";
      if (save) { App.state.sidebar_width = 0; syncState(); redrawPanels(); }
    } else {
      sidebar.style.width = lastW + "px";
      resizer.classList.remove("collapsed");
      collapseBtn.textContent = "◀"; collapseBtn.title = "Collapse watchlist";
      if (save) { App.state.sidebar_width = lastW; syncState(); redrawPanels(); }
    }
  }

  window.sidebarRestore = (w) => {
    if (w === 0) { lastW = 260; setCollapsed(true, false); }
    else if (w && w !== 260) { lastW = w; sidebar.style.width = w + "px"; }
  };

  collapseBtn.addEventListener("click", () => setCollapsed(!collapsed));

  resizer.addEventListener("click", e => { if (collapsed && !dragging) setCollapsed(false); });

  resizer.addEventListener("mousedown", e => {
    if (collapsed) return;
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  window.addEventListener("mousemove", e => {
    if (!dragging) return;
    const w = Math.min(MAX_W, Math.max(MIN_W, startW + (e.clientX - startX)));
    sidebar.style.width = w + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    lastW = sidebar.offsetWidth;
    App.state.sidebar_width = lastW;
    syncState();
    redrawPanels();
  });
}

// ── LIVE PRICE FEED ───────────────────────────────────────────────────────────
let _liveFeedTimer = null;

async function _updateLivePrices() {
  for (const ticker of App.state.watchlist) {
    try {
      const r = await fetch(API + `/api/price/${ticker}`);
      if (!r.ok) continue;
      const d = await r.json();
      if (d.error) continue;
      const pctEl  = document.getElementById("wlp-" + ticker);
      const priceEl = document.getElementById("wp-" + ticker);
      if (!pctEl) continue;
      const pos  = d.change_pct >= 0;
      const sign = pos ? "+" : "";
      pctEl.textContent = sign + d.change_pct.toFixed(2) + "%";
      pctEl.className   = "watch-live-pct " + (pos ? "pos" : "neg");
      if (priceEl) priceEl.textContent = fmt(d.last);
    } catch (_e) {}
  }
}

export function startWatchlistFeed() {
  _updateLivePrices();
  clearInterval(_liveFeedTimer);
  _liveFeedTimer = setInterval(_updateLivePrices, 10_000);
}

export function stopWatchlistFeed() {
  clearInterval(_liveFeedTimer);
  _liveFeedTimer = null;
}

// Expose for inline HTML handlers
window.openModal = openModal;
window.closeModal = closeModal;
window.addTicker = addTicker;
window.removeTicker = removeTicker;
window.modalKey = modalKey;
window.searchTicker = searchTicker;
window.toggleWatchlistSync = toggleWatchlistSync;
