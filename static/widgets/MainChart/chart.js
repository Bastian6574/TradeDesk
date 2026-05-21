import { App, indicators, syncState, API, LAYOUT_COUNT, getContextTicker, clearContextOverride, isCrypto } from '../../core/state.js';
import { fmt, fmtVol, LIVE_MAX, N_FC, TF_N_FC, TF_PERIOD, toBinanceSymbol, tfIntervalMs, candleTimeRemaining } from '../../core/utils.js';
import { PINE_SCRIPTS, pineActive, applyActivePineOverlays, applyPineOverlayToPanel, loadPineTS } from './pine.js';
import { drawUtility } from '../UtilityPanel/utility.js';
import { startLiquidationMap, stopLiquidationMap } from '../LiquidationMap/liquidation.js';
import { startLevel2, stopLevel2 } from '../Level2/level2.js';
import { startConsole, stopConsole } from '../Console/console.js';

// ── PROPHET REFRESH CALLBACK (registered by predictions.js to avoid circular import) ──
let _prophetRefreshFn = null;
export function registerProphetRefresh(fn) { _prophetRefreshFn = fn; }

// ── PANEL FACTORY ─────────────────────────────────────────────────────────────
export function mkPanel(idx) {
  return {
    idx, ticker: "BTC", tf: App.state.default_tf || "30m",
    chartZoom: App.state.chart_zoom || 150, rsiPeriod: App.state.rsi_period || 14,
    widgetMode: "candles", widgetSettings: { pineOpacity: 1.0, timerFontSize: 11, l2TapeFontSize: 8 },
    utilityMode: "rsi", mainChart: null, rsiChart: null, candleData: null,
    forecastData: [], forecastAll: null, forecastOffset: 0, prophetData: null,
    liveWS: null, liveInterval: null, tickerInterval: null,
    liveCandles: [], el: null, _gen: 0,
    _offline: false, _offlineTimer: null,
    _pineOverlayCache: {}, _liveCount: 0,
    _xOffset: 0, _yMin: null, _yMax: null, _panLocked: false,
    _liveXStart: 0, _liveStartIdx: 0,
  };
}

// ── PANEL DOM ─────────────────────────────────────────────────────────────────
export function buildPanelEl(p) {
  const i = p.idx;
  const div = document.createElement("div");
  div.className = "chart-panel"; div.id = "chart-panel-" + i;
  div.innerHTML = `
    <div class="chart-header" id="chart-header-${i}">
      <div class="main-ticker" id="main-ticker-${i}">—</div>
      <div class="main-price"  id="main-price-${i}">—</div>
      <div class="main-change" id="main-change-${i}"></div>
      <div id="status-badge-${i}" style="display:none;align-items:center;gap:5px;margin-left:4px;">
        <span id="status-dot-${i}" style="width:7px;height:7px;border-radius:50%;display:inline-block;"></span>
        <span id="status-text-${i}" style="font-size:10px;letter-spacing:1px;"></span>
      </div>
      <button class="reset-view-btn" id="reset-view-btn-${i}" onclick="resetPanelView(${i})" title="Reset chart view">⊙ RESET</button>
      <div class="legend">
        <div class="legend-item" id="avg-legend-${i}" style="display:none">
          <div class="legend-dot" style="background:var(--avg)"></div>
          <span id="avg-legend-val-${i}">AVG —</span>
        </div>
      </div>
      <div class="avg-controls">
        <span class="avg-label">AVG</span>
        <input class="avg-input" id="avg-input-${i}" type="number" step="0.01" placeholder="0.00">
        <button class="btn confirm" onclick="setPanelAverage(${i})">SET</button>
        <button class="btn danger"  onclick="clearPanelAverage(${i})">CLR</button>
      </div>
      <button class="close-panel-btn" id="close-panel-btn-${i}" onclick="closePanel(${i})" title="Close panel">×</button>
    </div>
    <div class="canvas-wrap" id="canvas-wrap-${i}">
      <canvas id="main-canvas-${i}"></canvas>
      <div class="loading hidden" id="loading-${i}"><span class="spinner"></span>LOADING</div>
    </div>
    <div class="utility-panel" id="utility-panel-${i}" style="height:${App.state.utility_height || 90}px;">
      <div class="utility-header">
        <select class="utility-select" id="utility-select-${i}" onchange="setUtilityMode(${i},this.value)">
          <option value="rsi">RSI</option>
          <option value="macd">MACD</option>
        </select>
        <span id="utility-value-${i}" style="color:var(--blue);">—</span>
        <span id="utility-zone-${i}" style="font-size:9px;"></span>
        <span id="utility-pine-lbl-${i}" style="display:none;font-size:9px;color:var(--text3);letter-spacing:1px;"></span>
        <span style="margin-left:auto;font-size:9px;color:var(--text3);">UTILITY</span>
        <button class="utility-gear-btn" id="utility-gear-btn-${i}" onclick="toggleUtilitySettings(${i})" title="Scale settings">⚙</button>
      </div>
      <div class="utility-settings-popup hidden" id="utility-settings-popup-${i}">
        <div class="uset-label">Y SCALE</div>
        <div class="uset-row">
          <span class="uset-lbl">ZOOM</span>
          <input type="range" class="uset-slider" id="uset-yzoom-${i}" min="25" max="400" step="25" value="100" oninput="onUtilityYZoom(${i},this.value)">
          <span class="uset-val" id="uset-yzoom-val-${i}">1.0×</span>
        </div>
      </div>
      <div class="utility-canvas-wrap" id="utility-canvas-wrap-${i}">
        <canvas id="utility-canvas-${i}"></canvas>
      </div>
    </div>
    <div class="chart-footer" id="chart-footer-${i}">
      <button class="tf-btn" onclick="setPanelTF(${i},'1s')">1s</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'1m')">1m</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'5m')">5m</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'15m')">15m</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'30m')">30m</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'1h')">1h</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'1d')">D</button>
      <button class="tf-btn" onclick="setPanelTF(${i},'1wk')">W</button>
      <div class="footer-sep"></div>
      <div class="status-item">O<span class="st-open"  id="st-open-${i}">—</span></div>
      <div class="status-item">H<span class="st-high"  id="st-high-${i}">—</span></div>
      <div class="status-item">L<span class="st-low"   id="st-low-${i}">—</span></div>
      <div class="status-item">C<span class="st-close" id="st-close-${i}">—</span></div>
      <div class="footer-sep"></div>
      <div class="zoom-indicator" id="zoom-indicator-${i}">ZOOM ${p.chartZoom}</div>
      <div class="widget-name" id="widget-name-${i}">CHART ${i + 1}</div>
      <div class="footer-sep"></div>
      <select class="widget-mode-select" id="widget-mode-select-${i}" onchange="setWidgetMode(${i},this.value)">
        <option value="candles">CHART</option>
        <option value="liquidation">LIQ MAP</option>
        <option value="level2">LEVEL 2</option>
        <option value="console">BRAIN v1.0</option>
      </select>
      <button class="pine-btn" id="ind-btn-${i}" onclick="toggleIndPopup()">IND</button>
      <button class="pine-btn" id="pine-btn-${i}" onclick="togglePinePopup()">PINE</button>
      <button class="split-btn" onclick="splitPanel(${i},'H')" title="Add panel beside">+H</button>
      <button class="split-btn" onclick="splitPanel(${i},'V')" title="Add panel below">+V</button>
      <button class="widget-settings-btn" id="wsettings-btn-${i}" onclick="toggleWidgetSettings(${i})">⚙</button>
    </div>
    <div class="widget-settings-popup" id="wsettings-${i}" style="display:none"></div>
  `;
  return div;
}

export function initPanelEvents(p) {
  p.el.addEventListener("mousedown", () => { if (App.activeIdx !== p.idx) setActivePanel(p.idx); });
  const wrap = document.getElementById("canvas-wrap-" + p.idx);
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    p.chartZoom = Math.max(3, Math.min(LIVE_MAX, p.chartZoom + (e.deltaY > 0 ? 10 : -10)));
    document.getElementById("zoom-indicator-" + p.idx).textContent = "ZOOM " + p.chartZoom;
    if (p.tf === "1s") {
      if (p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c);
      if (PINE_SCRIPTS.some(s => s.overlay && pineActive[s.id])) applyActivePineOverlays(p);
      drawUtility(p, p.liveCandles.slice(-p.chartZoom));
    } else if (p.candleData) {
      drawMainChart(p, p.candleData);
      drawUtility(p, p.candleData._liveCandles);
    }
  }, { passive: false });

  // Left-click drag: chart area = 2D free pan; right y-axis strip (last 55px) = y-scale; footer = x-scale
  const _footer = document.getElementById("chart-footer-" + p.idx);
  let _dragging = false, _dm = "pan", _sx = 0, _sy = 0, _so = 0, _sz = 0, _syMin = 0, _syMax = 0;
  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || !p.mainChart) return;
    const r = wrap.getBoundingClientRect();
    _dm = e.clientX > r.right - 55 ? "yscale" : "pan";
    _dragging = true;
    _sx = e.clientX; _sy = e.clientY; _so = p._xOffset;
    _syMin = p._yMin ?? p.mainChart.options.scales.y.min;
    _syMax = p._yMax ?? p.mainChart.options.scales.y.max;
    wrap.style.cursor = _dm === "yscale" ? "ns-resize" : "grab";
    e.preventDefault();
  });
  const _onMove = (e) => {
    if (!_dragging) return;
    if (_dm === "xscale") {
      // Exponential zoom: drag right = zoom out (more candles), drag left = zoom in
      const nz = Math.max(3, Math.min(LIVE_MAX, Math.round(_sz * Math.pow(1.006, e.clientX - _sx))));
      if (nz !== p.chartZoom) {
        p.chartZoom = nz;
        const zi = document.getElementById("zoom-indicator-" + p.idx);
        if (zi) zi.textContent = "ZOOM " + nz;
        _updateChartView(p);
      }
      return;
    }
    if (_dm === "yscale") {
      // drag up → expand range (zoom out), drag down → compress range (zoom in)
      if (_syMax > _syMin) {
        const sf = Math.exp((e.clientY - _sy) * 0.003);
        const mid = (_syMin + _syMax) / 2, hr = (_syMax - _syMin) / 2;
        p._yMin = mid - hr * sf; p._yMax = mid + hr * sf;
      }
    } else {
      wrap.style.cursor = "grabbing";
      // X pan
      const ppc = wrap.clientWidth / Math.max(1, p.chartZoom);
      const n = p.tf === "1s" ? p.liveCandles.length : (p.candleData?._liveCandles?.length || p.chartZoom);
      const maxOff = n - Math.min(p.chartZoom, n);
      const extras = Math.max(
        indicators.arima ? (p.forecastData.length > 0 ? p.forecastData.length : (TF_N_FC[p.tf] || N_FC)) : 0,
        p.prophetData?.forecast?.length ? p.prophetData.forecast.length : (p.prophetData ? (p.prophetData.n_fc || 14) : 0)
      );
      p._xOffset = Math.max(-(extras + 5), Math.min(maxOff, _so + (e.clientX - _sx) / ppc));
      // Y pan — drag down shifts candles up, drag up shifts candles down
      if (_syMax > _syMin) {
        const priceRange = _syMax - _syMin;
        const priceShift = (e.clientY - _sy) / wrap.clientHeight * priceRange;
        p._yMin = _syMin + priceShift;
        p._yMax = _syMax + priceShift;
      }
    }
    if (!p._panLocked) { p._panLocked = true; _showResetBtn(p); }
    _updateChartView(p);
  };
  const _onUp = () => { if (_dragging) { _dragging = false; wrap.style.cursor = ""; if (_footer) _footer.style.cursor = ""; } };
  wrap.addEventListener("mousemove", (e) => { if (!_dragging) { const r = wrap.getBoundingClientRect(); wrap.style.cursor = e.clientX > r.right - 55 ? "ns-resize" : ""; } });
  wrap.addEventListener("mouseleave", () => { if (!_dragging) wrap.style.cursor = ""; });
  // Double-click resets the full view
  wrap.addEventListener("dblclick", () => {
    p._xOffset = 0; p._yMin = null; p._yMax = null; p._panLocked = false;
    _hideResetBtn(p);
    if (p.tf === "1s") { if (p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c); }
    else if (p.candleData) { drawMainChart(p, p.candleData); drawUtility(p, p.candleData._liveCandles); }
  });
  // Footer timeline: drag left/right to scale X axis
  if (_footer) {
    _footer.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") return;
      _dm = "xscale"; _dragging = true; _sx = e.clientX; _sz = p.chartZoom;
      _footer.style.cursor = "ew-resize"; e.preventDefault();
    });
    _footer.addEventListener("mousemove", (e) => {
      if (!_dragging)
        _footer.style.cursor = (e.target.tagName === "BUTTON" || e.target.tagName === "SELECT") ? "" : "ew-resize";
    });
    _footer.addEventListener("mouseleave", () => { if (!_dragging) _footer.style.cursor = ""; });
  }
  document.addEventListener("mousemove", _onMove);
  document.addEventListener("mouseup", _onUp);
}

// ── LAYOUT MANAGEMENT ─────────────────────────────────────────────────────────
const LAYOUT_ROWS = { "1": [[0]], "2h": [[0,1]], "2v": [[0],[1]], "4": [[0,1],[2,3]] };

export function setLayout(mode) {
  App.currentLayout = mode;
  const prevCfgs = App.panels.map(p => ({ ticker: p.ticker, tf: p.tf, utilityMode: p.utilityMode, widgetMode: p.widgetMode || "candles", widgetSettings: { ...p.widgetSettings }, chartZoom: p.chartZoom }));
  App.panels.forEach(p => stopPanel(p));
  App.layoutRows = JSON.parse(JSON.stringify(LAYOUT_ROWS[mode] || [[0]]));
  const n = App.layoutRows.flat().length;
  App.panels = Array.from({ length: n }, (_, i) => {
    const p = mkPanel(i);
    if (prevCfgs[i]) { p.ticker = prevCfgs[i].ticker; p.tf = prevCfgs[i].tf; p.utilityMode = prevCfgs[i].utilityMode; p.widgetMode = prevCfgs[i].widgetMode || "candles"; p.widgetSettings = { ...p.widgetSettings, ...prevCfgs[i].widgetSettings }; p.chartZoom = prevCfgs[i].chartZoom; }
    return p;
  });
  renderChartContainer();
  setActivePanel(0);
  App.panels.forEach(p => _startPanelWidget(p));
  App.priceFeedBusy = false;
  App.priceFeedMs = 0; startPriceFeed();
  updateLayoutButtons(mode);
  saveMonitorPreset();
}

export function renderChartContainer() {
  const container = document.getElementById("charts-container");
  container.className = "";
  container.innerHTML = "";
  App.layoutRows.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = "layout-row";
    container.appendChild(rowEl); // must be in DOM before initPanelEvents uses getElementById
    row.forEach(idx => {
      const p = App.panels[idx]; if (!p) return;
      p.el = buildPanelEl(p);
      rowEl.appendChild(p.el);
      initPanelEvents(p);
      applyTFButtons(p); applyUtilitySelect(p); applyWidgetModeSelect(p);
    });
  });
  _updateCloseButtons();
}

// Move existing panel DOM nodes into new row wrappers without destroying them
function _rerenderLayout() {
  const container = document.getElementById("charts-container");
  // Detach all panel elements while preserving them
  App.panels.forEach(p => { if (p.el?.parentNode) p.el.parentNode.removeChild(p.el); });
  container.innerHTML = "";
  App.layoutRows.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = "layout-row";
    row.forEach(idx => { const p = App.panels[idx]; if (p?.el) rowEl.appendChild(p.el); });
    container.appendChild(rowEl);
  });
  _updateCloseButtons();
}

function _updateCloseButtons() {
  const show = App.panels.length > 1;
  App.panels.forEach(p => {
    const btn = document.getElementById("close-panel-btn-" + p.idx);
    if (btn) btn.style.display = show ? "" : "none";
  });
}

export function updateLayoutButtons(mode) {
  document.querySelectorAll(".layout-btn").forEach(b => b.classList.toggle("active", b.dataset.layout === mode));
}

// ── SPLIT & CLOSE PANELS ──────────────────────────────────────────────────────
export function splitPanel(panelIdx, dir) {
  const src = App.panels[panelIdx]; if (!src) return;
  const newIdx = App.panels.length;
  const newP = mkPanel(newIdx);
  newP.ticker = src.ticker; newP.tf = src.tf; newP.utilityMode = src.utilityMode;
  App.panels.push(newP);

  const ri = App.layoutRows.findIndex(r => r.includes(panelIdx));
  if (ri === -1) { App.panels.pop(); return; }

  if (dir === "H") {
    // Insert right after source in same row
    const pos = App.layoutRows[ri].indexOf(panelIdx);
    App.layoutRows[ri].splice(pos + 1, 0, newIdx);
  } else {
    // New row below the source row
    App.layoutRows.splice(ri + 1, 0, [newIdx]);
  }

  // Build DOM for new panel only, rewrap so it's in the DOM, then init events
  newP.el = buildPanelEl(newP);
  _rerenderLayout(); // puts newP.el in DOM before initPanelEvents uses getElementById
  initPanelEvents(newP); applyTFButtons(newP); applyUtilitySelect(newP); applyWidgetModeSelect(newP);

  // Resize existing chart-mode panels whose canvas dimensions changed
  App.panels.forEach((p, i) => {
    if (i === newIdx) return;
    if ((p.widgetMode || "candles") === "candles" && p.candleData?._liveCandles?.length) {
      if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
      drawMainChart(p, p.candleData);
      drawUtility(p, p.candleData._liveCandles);
    }
    // liq / level2 use pane.clientWidth in their own RAF — auto-correct next frame
  });

  setActivePanel(newIdx);
  _startPanelWidget(newP);
  startPriceFeed();
  saveMonitorPreset();
  updateLayoutButtons(null); // custom layout — deactivate preset buttons
}

export function closePanel(panelIdx) {
  if (App.panels.length <= 1) return;

  // Stop every panel (increments _gen, clears feeds)
  App.panels.forEach(p => stopPanel(p));

  // Remove closed panel from layout rows
  App.layoutRows = App.layoutRows
    .map(r => r.filter(i => i !== panelIdx))
    .filter(r => r.length > 0);

  // Remove from flat array and re-index
  App.panels.splice(panelIdx, 1);
  App.panels.forEach((p, i) => { p.idx = i; });
  // Shift layout row indices down past the removed slot
  App.layoutRows.forEach(r => r.forEach((v, j, a) => { if (v > panelIdx) a[j]--; }));

  renderChartContainer();
  setActivePanel(0);
  App.panels.forEach(p => _startPanelWidget(p));
  App.priceFeedBusy = false; App.priceFeedMs = 0; startPriceFeed();
  saveMonitorPreset();
  updateLayoutButtons(null);
}

// ── ACTIVE PANEL ──────────────────────────────────────────────────────────────
export function setActivePanel(idx) {
  App.activeIdx = idx;
  App.panels.forEach((p, i) => p.el.classList.toggle("focused", i === idx));
  const p = App.panels[idx]; if (!p) return;
  document.querySelectorAll(".watch-item").forEach(el => el.classList.toggle("active", el.id === "wi-" + p.ticker));
  const ai = document.getElementById("avg-input-" + idx);
  if (ai) ai.value = App.state.averages[p.ticker] || "";
  updateAvgLegend(p);
  clearContextOverride();
  const t = p.ticker;
  import('../InfoPanel/info.js').then(m => { m.updateRpContextRow(t); m.fetchDetails(t); });
  import('../FundingOI/funding.js').then(m => m.fetchFunding(t));
}

// ── MONITOR MANAGEMENT ────────────────────────────────────────────────────────
export function switchMonitor(n) {
  App.panels.forEach(p => stopPanel(p));
  App.state.active_monitor = n;
  updateMonitorTabs();
  const preset = getMonitorPreset(n);
  restorePreset(preset);
  syncState();
}

export function updateMonitorTabs() {
  document.querySelectorAll(".monitor-tab").forEach((b, i) => b.classList.toggle("active", i + 1 === parseInt(App.state.active_monitor)));
}

export function getMonitorPreset(n) {
  const saved = App.state.monitors?.[String(n)];
  if (saved && typeof saved === "object" && (saved.layout || saved.layoutRows)) return saved;
  const ticker = typeof saved === "string" ? saved : "BTC";
  return { layoutRows: [[0]], charts: [{ ticker, tf: App.state.default_tf || "30m", utilityMode: "rsi", widgetMode: "candles" }] };
}

const _OLD_ROWS = { "1": [[0]], "2h": [[0,1]], "2v": [[0],[1]], "4": [[0,1],[2,3]] };

export function restorePreset(preset) {
  App.layoutRows = preset.layoutRows
    ? JSON.parse(JSON.stringify(preset.layoutRows))
    : (_OLD_ROWS[preset.layout || "1"] || [[0]]);
  App.currentLayout = preset.layout || null;
  const n = App.layoutRows.flat().length;
  App.panels = Array.from({ length: n }, (_, i) => {
    const p = mkPanel(i);
    const cfg = preset.charts?.[i];
    if (cfg) { p.ticker = cfg.ticker || "BTC"; p.tf = cfg.tf || App.state.default_tf || "30m"; p.utilityMode = cfg.utilityMode || "rsi"; p.widgetMode = cfg.widgetMode || "candles"; if (cfg.widgetSettings) p.widgetSettings = { ...p.widgetSettings, ...cfg.widgetSettings }; }
    return p;
  });
  renderChartContainer();
  updateLayoutButtons(App.currentLayout);
  setActivePanel(0);
  App.panels.forEach(p => _startPanelWidget(p));
  App.priceFeedBusy = false;
  App.priceFeedMs = 0; startPriceFeed();
}

export function saveMonitorPreset() {
  App.state.monitors[String(App.state.active_monitor)] = {
    layoutRows: JSON.parse(JSON.stringify(App.layoutRows)),
    charts: App.panels.map(p => ({ ticker: p.ticker, tf: p.tf, utilityMode: p.utilityMode, widgetMode: p.widgetMode || "candles", widgetSettings: { ...p.widgetSettings } }))
  };
  syncState();
}

// ── LOAD TICKER ───────────────────────────────────────────────────────────────
export function loadTicker(ticker) {
  const p = App.panels[App.activeIdx]; if (!p) return;
  p._pineOverlayCache = {};
  stopPanel(p);
  p.ticker = ticker;
  document.querySelectorAll(".watch-item").forEach(el => el.classList.toggle("active", el.id === "wi-" + ticker));
  _startPanelWidget(p);
  saveMonitorPreset();
  clearContextOverride();
  import('../InfoPanel/info.js').then(m => { m.updateRpContextRow(ticker); m.fetchDetails(ticker); });
  import('../FundingOI/funding.js').then(m => m.fetchFunding(ticker));
}

// ── SYNC ALL PANELS TO TICKER ─────────────────────────────────────────────────
export function loadTickerAllPanels(ticker) {
  App.panels.forEach(p => {
    p._pineOverlayCache = {};
    p.candleData = null;
    p.ticker = ticker;
  });
  document.querySelectorAll(".watch-item").forEach(el => el.classList.toggle("active", el.id === "wi-" + ticker));
  App.panels.forEach(p => { stopPanel(p); _startPanelWidget(p); });
  saveMonitorPreset();
  import('../InfoPanel/info.js').then(m => m.fetchDetails(ticker));
}

// ── TIMEFRAME ─────────────────────────────────────────────────────────────────
export function setPanelTF(idx, tf) {
  const p = App.panels[idx]; if (!p) return;
  p._pineOverlayCache = {};
  stopPanel(p); p.tf = tf; applyTFButtons(p); loadMainChart(p); saveMonitorPreset();
}

export function setUtilityMode(idx, mode) {
  const p = App.panels[idx]; if (!p) return;
  p.utilityMode = mode;
  if (p.rsiChart) { p.rsiChart.destroy(); p.rsiChart = null; }
  const candles = p.tf === "1s" ? p.liveCandles.slice(-p.chartZoom) : p.candleData?._liveCandles;
  if (candles) drawUtility(p, candles);
  saveMonitorPreset();
}

export function applyTFButtons(p) {
  const footer = document.getElementById("chart-footer-" + p.idx); if (!footer) return;
  footer.querySelectorAll(".tf-btn").forEach(b => {
    const lbl = b.textContent.trim().toLowerCase();
    b.classList.toggle("active", lbl === p.tf.toLowerCase() || (p.tf === "1d" && lbl === "d") || (p.tf === "1wk" && lbl === "w"));
  });
}

export function applyUtilitySelect(p) {
  const sel = document.getElementById("utility-select-" + p.idx);
  if (sel) sel.value = p.utilityMode;
}

// ── STOP PANEL ────────────────────────────────────────────────────────────────
export function stopPanel(p) {
  p._gen++;
  p._offline = false;
  p.candleData = null;
  p._liveCount = 0;
  stopLiquidationMap(p);
  stopLevel2(p);
  stopConsole(p);
  if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
  if (p.rsiChart) { p.rsiChart.destroy(); p.rsiChart = null; }
  if (p._offlineTimer) { clearTimeout(p._offlineTimer); p._offlineTimer = null; }
  if (p.liveWS) { p.liveWS.close(); p.liveWS = null; }
  if (p.liveInterval) { clearInterval(p.liveInterval); p.liveInterval = null; }
  if (p.tickerInterval) { clearInterval(p.tickerInterval); p.tickerInterval = null; }
  setPanelTradingBadge(p, false);
  // Close aggTrade WS if no other non-1s panel still uses this ticker
  if (App._tradeFeeds?.has(p.ticker)) {
    const others = App.panels.filter(q => q !== p && q.ticker === p.ticker && q.tf !== "1s");
    if (!others.length) closeTradeWS(p.ticker);
  }
}

// ── LOAD MAIN CHART ───────────────────────────────────────────────────────────
export async function loadMainChart(p) {
  stopPanel(p);
  p._xOffset = 0; p._yMin = null; p._yMax = null; p._panLocked = false;
  p.prophetData = null;  // always clear stale prophet for old TF
  _hideResetBtn(p);
  const myGen = p._gen;
  if (p.tf === "1s") { await startLiveStream(p); return; }
  showLoading(p, true);
  const period = TF_PERIOD[p.tf] || "5d";
  try {
    // Fetch chart history and live price in parallel — draw once with fresh price baked in
    const [chartRes, priceRes] = await Promise.all([
      fetch(API + `/api/chart/${p.ticker}?period=${period}&interval=${p.tf}`),
      fetch(API + `/api/price/${p.ticker}`).catch(() => null),
    ]);
    if (p._gen !== myGen) { showLoading(p, false); return; }
    const data = await chartRes.json();
    if (data.error) { showLoading(p, false); return; }
    const priceData = priceRes ? await priceRes.json().catch(() => null) : null;
    const freshPrice = (priceData && !priceData.error && priceData.last) ? priceData.last : data.last;
    const freshPct   = (priceData && !priceData.error) ? (priceData.change_pct ?? 0) : (data.change_pct ?? 0);
    p.forecastData = []; p.forecastAll = null; p.forecastOffset = 0;
    updateHeader(p, { ...data, last: freshPrice, change_pct: freshPct });
    p.candleData = data;
    drawMainChart(p, data);
    // Seed live candle with fresh price before first render — no visible jump
    if (freshPrice) updateLiveCandle(p, freshPrice, freshPct);
    drawUtility(p, data._liveCandles);
    startTickerPoll(p);
    const ai = document.getElementById("avg-input-" + p.idx);
    if (ai) ai.value = App.state.averages[p.ticker] || "";
    updateAvgLegend(p);
    if (_prophetRefreshFn) _prophetRefreshFn(p, myGen);
  } catch (e) { console.warn(e); }
  if (p._gen === myGen) showLoading(p, false);
}

// ── LIVE 1s STREAM ────────────────────────────────────────────────────────────
async function startLiveStream(p) {
  p.liveCandles = [];
  p._xOffset = 0; p._panLocked = false; p._yMin = null; p._yMax = null;
  showLoading(p, true);
  const myGen = p._gen;
  const binSym = toBinanceSymbol(p.ticker);
  try {
    const r = await fetch(API + `/api/chart/${p.ticker}?period=1d&interval=1m`);
    const seed = await r.json();
    if (p._gen !== myGen) { showLoading(p, false); return; }
    if (!seed.error) { p.liveCandles = seed.candles.slice(-60).map(c => ({ ...c, live: false })); updateHeader(p, seed); }
  } catch (e) { if (p._gen !== myGen) return; }
  if (binSym) {
    p.liveWS = new WebSocket(`wss://stream.binance.com:9443/ws/${binSym}@kline_1s`);
    p.liveWS.onopen = () => { if (p._gen !== myGen) { p.liveWS.close(); return; } showLoading(p, false); setPanelTradingBadge(p, "trading"); };
    p.liveWS.onmessage = (evt) => {
      if (p._gen !== myGen) return;
      const k = JSON.parse(evt.data).k;
      const candle = { t: k.t, o: parseFloat(k.o), h: parseFloat(k.h), l: parseFloat(k.l), c: parseFloat(k.c), v: parseFloat(k.v), live: !k.x };
      const prevLive = p.liveCandles.length && p.liveCandles[p.liveCandles.length - 1].live;
      if (prevLive) { p.liveCandles[p.liveCandles.length - 1] = candle; }
      else { p.liveCandles.push(candle); if (p._panLocked) p._xOffset++; }
      if (p.liveCandles.length > LIVE_MAX) { p.liveCandles.shift(); if (p._panLocked && p._xOffset > 0) p._xOffset--; }
      drawLiveChart(p, candle.c);
      drawUtility(p, p.liveCandles.slice(-p.chartZoom));
    };
    p.liveWS.onerror = () => { if (p._gen !== myGen) return; showLoading(p, false); startStockPoll(p); };
  } else { showLoading(p, false); startStockPoll(p); }
}

async function startStockPoll(p) {
  setPanelTradingBadge(p, "trading");
  const myGen = p._gen;
  let curSec = null, sOpen = null, sHigh = null, sLow = null;
  p.liveInterval = setInterval(async () => {
    if (p._gen !== myGen) return;
    try {
      const r = await fetch(API + `/api/chart/${p.ticker}?period=1d&interval=1m`);
      const d = await r.json();
      if (p._gen !== myGen || d.error || !d.candles.length) return;
      const price = d.last, now = Math.floor(Date.now() / 1000) * 1000;
      if (curSec !== now) {
        if (curSec !== null) { const prev = p.liveCandles[p.liveCandles.length - 1]; if (prev && prev.live) prev.live = false; }
        curSec = now; sOpen = price; sHigh = price; sLow = price;
      }
      sHigh = Math.max(sHigh, price); sLow = Math.min(sLow, price);
      const candle = { t: now, o: sOpen, h: sHigh, l: sLow, c: price, live: true };
      const prevLiveS = p.liveCandles.length && p.liveCandles[p.liveCandles.length - 1].live;
      if (prevLiveS) { p.liveCandles[p.liveCandles.length - 1] = candle; }
      else { p.liveCandles.push(candle); if (p._panLocked) p._xOffset++; }
      if (p.liveCandles.length > LIVE_MAX) { p.liveCandles.shift(); if (p._panLocked && p._xOffset > 0) p._xOffset--; }
      drawLiveChart(p, price); updateHeader(p, d);
    } catch (e) {}
  }, 1000);
}

// ── SHARED PRICE FEED ─────────────────────────────────────────────────────────
export function startPriceFeed() {
  if (App.priceFeed && App.priceFeedMs === App.updateIntervalMs) return;
  if (App.priceFeed) clearInterval(App.priceFeed);
  App.priceFeedMs = App.updateIntervalMs;
  App.priceFeed = setInterval(_priceTick, App.updateIntervalMs);
}

async function _priceTick() {
  if (App.priceFeedBusy) return;
  App.priceFeedBusy = true;
  try {
    App.panels.forEach(p => {
      if (p.tf !== "1s" && p.candleData && !p.mainChart) {
        try { drawMainChart(p, p.candleData); } catch (e) {}
      }
    });
    const byTicker = {};
    App.panels.forEach(p => {
      if (p.tf === "1s" || !p.candleData || !p.mainChart) return;
      if (!byTicker[p.ticker]) byTicker[p.ticker] = [];
      byTicker[p.ticker].push(p);
    });
    for (const [ticker, ps] of Object.entries(byTicker)) {
      try {
        const ac = new AbortController();
        const tid = setTimeout(() => ac.abort(), 5000);
        const r = await fetch(API + `/api/price/${ticker}`, { signal: ac.signal });
        clearTimeout(tid);
        const d = await r.json();
        if (d.error || !d.last) continue;
        const price = d.last, pct = d.change_pct ?? 0;
        ps.forEach(p => {
          if (!p.candleData || !p.mainChart) return;
          // For crypto with active aggTrade WS: only update header, not candle
          if (isCrypto(ticker) && App._tradeFeeds?.has(ticker)) {
            const chEl = document.getElementById("main-change-" + p.idx);
            if (chEl) {
              const pos = pct >= 0;
              chEl.textContent = (pos ? "▲ +" : "▼ ") + pct.toFixed(2) + "%";
              chEl.className = "main-change " + (pos ? "pos" : "neg");
            }
          } else {
            updateLiveCandle(p, price, pct);
          }
        });
      } catch (e) {}
    }
  } finally { App.priceFeedBusy = false; }
}

// ── BINANCE AGGTRADE WEBSOCKET ────────────────────────────────────────────────
function _ensureTradeWS(ticker) {
  if (!App._tradeFeeds) App._tradeFeeds = new Map();
  if (App._tradeFeeds.has(ticker)) return;
  const binSym = toBinanceSymbol(ticker);
  if (!binSym) return;
  const feed = { ws: null, latestPrice: null, timer: null };
  feed.ws = new WebSocket(`wss://stream.binance.com:9443/ws/${binSym}@aggTrade`);
  feed.ws.onmessage = (evt) => {
    try { feed.latestPrice = parseFloat(JSON.parse(evt.data).p); } catch { return; }
    if (feed.timer) return;
    feed.timer = setTimeout(() => {
      feed.timer = null;
      const price = feed.latestPrice;
      if (price == null) return;
      App.panels.forEach(p => {
        if (p.tf === "1s" || p.ticker !== ticker || !p.candleData || !p.mainChart) return;
        updateLiveCandle(p, price);
      });
    }, App.updateIntervalMs);
  };
  feed.ws.onerror = () => { try { feed.ws.close(); } catch {} App._tradeFeeds.delete(ticker); };
  feed.ws.onclose = () => { App._tradeFeeds.delete(ticker); };
  App._tradeFeeds.set(ticker, feed);
}

export function closeTradeWS(ticker) {
  if (!App._tradeFeeds?.has(ticker)) return;
  const feed = App._tradeFeeds.get(ticker);
  if (feed.timer) { clearTimeout(feed.timer); feed.timer = null; }
  try { feed.ws.close(); } catch {}
  App._tradeFeeds.delete(ticker);
}

function startTickerPoll(p) {
  startPriceFeed();
  if (isCrypto(p.ticker) && p.tf !== "1s") _ensureTradeWS(p.ticker);
}


function updateLiveCandle(p, livePrice, changePct) {
  if (!p.candleData || !p.mainChart || !p.candleData._liveCandles) return;
  const candles = p.candleData._liveCandles;
  if (!candles.length) return;
  const last = candles[candles.length - 1], ivMs = tfIntervalMs(p.tf);
  if (ivMs > 0 && Date.now() >= last.t + ivMs) {
    if (Date.now() - last.t > ivMs * 5) { setOffline(p); return; }
    // Use previous close as the new candle's open so a wick forms immediately
    const prevClose = last.c;
    const newC = { t: last.t + ivMs, o: prevClose, h: Math.max(prevClose, livePrice), l: Math.min(prevClose, livePrice), c: livePrice, v: 0 };
    candles.push(newC);
    if (candles.length > p.chartZoom + 500) candles.shift();
    if (p.forecastData.length > 0) { p.forecastData.shift(); }
    p.forecastOffset = candles.length;
    if (indicators.arima) loadForecast(p, true);
    if (PINE_SCRIPTS.some(s => s.overlay && pineActive[s.id])) applyActivePineOverlays(p);
  }
  const cur = candles[candles.length - 1];
  cur.c = livePrice; cur.h = Math.max(cur.h, livePrice); cur.l = Math.min(cur.l, livePrice);
  document.getElementById("main-price-" + p.idx).textContent = fmt(livePrice);
  if (changePct !== undefined) {
    const chEl = document.getElementById("main-change-" + p.idx);
    const pos = changePct >= 0;
    chEl.textContent = (pos ? "▲ +" : "▼ ") + changePct.toFixed(2) + "%";
    chEl.className = "main-change " + (pos ? "pos" : "neg");
  }
  updateStatusBar(p, cur);
  if (p.mainChart) {
    // y-bounds from VISIBLE window only — not all 650 historical candles
    if (p._yMin === null) {
      const n = candles.length, zoom = Math.min(p.chartZoom, n);
      const xOff = Math.max(0, p._xOffset || 0);
      const vs = Math.max(0, n - zoom - Math.ceil(xOff));
      const ve = Math.max(vs + 1, n - Math.floor(xOff));
      const vc = candles.slice(vs, ve);
      const vp = (vc.length ? vc : candles).flatMap(c => [c.h, c.l]);
      const avg = App.state.averages[p.ticker]; if (avg) vp.push(avg);
      const minC = Math.min(...vp), maxC = Math.max(...vp);
      const cr = (maxC - minC) || minC * 0.02;
      p.mainChart.options.scales.y.min = minC - cr * 0.08;
      p.mainChart.options.scales.y.max = maxC + cr * 0.08;
    }
    if (!p._panLocked) p._xOffset = 0;
    const { xMin, xMax } = _xBounds(p, candles);
    p.mainChart.options.scales.x.min = xMin;
    p.mainChart.options.scales.x.max = xMax;
    p.mainChart.data.datasets[0].data = candles.map((c, i) => ({ x: i, y: c.c }));
    p.mainChart.update("none");
    drawUtility(p, candles);
  }
}

// ── DRAW MAIN CHART ───────────────────────────────────────────────────────────
export function drawMainChart(p, data) {
  // Keep full history for panning — cap at chartZoom + 500 to avoid excess memory
  const maxHistory = p.chartZoom + 500;
  if (!data._liveCandles || !data._liveCandles.length) {
    data._liveCandles = data.candles.slice(-maxHistory);
  } else {
    const cur = data._liveCandles;
    const firstCurT = cur[0]?.t ?? Infinity;
    const prefix = data.candles.filter(c => c.t < firstCurT);
    if (prefix.length) {
      const take = Math.max(0, maxHistory - cur.length);
      if (take > 0) data._liveCandles = [...prefix.slice(-take), ...cur];
    }
  }
  const candles = data._liveCandles;
  const avg = App.state.averages[p.ticker];
  // compute y-bounds from visible window only so off-screen history doesn't compress the y-range
  const _n = candles.length, _zoom = Math.min(p.chartZoom, _n);
  const _xOff = Math.max(0, p._xOffset || 0);
  const visStart = Math.max(0, _n - _zoom - Math.ceil(_xOff));
  const visEnd   = Math.max(visStart + 1, _n - Math.floor(_xOff));
  const visCandles = candles.slice(visStart, visEnd);
  const visPrices = (visCandles.length ? visCandles : candles).flatMap(c => [c.h, c.l]);
  if (avg) visPrices.push(avg);
  const minC = Math.min(...visPrices), maxC = Math.max(...visPrices);
  const cRange = (maxC - minC) || minC * 0.02;
  let minP = minC - cRange * 0.08, maxP = maxC + cRange * 0.08;
  // Include forecast CI in y-bounds but cap expansion to 1× cRange per side
  // so candles always fill at least ~50% of the chart height
  if (_xOff <= 0) {
    const center = (minC + maxC) / 2;
    if (indicators.arima && p.forecastData.length) {
      p.forecastData.forEach(f => {
        minP = Math.max(Math.min(minP, f.ci_lo), center - cRange);
        maxP = Math.min(Math.max(maxP, f.ci_hi), center + cRange);
      });
    }
    if (p.prophetData) {
      const fb = (indicators.prophetHeuristic !== false && p.prophetData.forecast_biased)
        ? p.prophetData.forecast_biased : p.prophetData.forecast;
      fb.forEach(f => {
        minP = Math.max(Math.min(minP, f.yhat_lower), center - cRange);
        maxP = Math.min(Math.max(maxP, f.yhat_upper), center + cRange);
      });
    }
  }
  const canvas = makePanelCanvas(p);
  if (!canvas) return;
  updateStatusBar(p, candles[candles.length - 1]);
  p.forecastOffset = candles.length;
  p.mainChart = new Chart(canvas, {
    type: "scatter",
    data: { labels: candles.map((_, i) => i), datasets: [{ data: candles.map((c, i) => ({ x: i, y: c.c })), pointRadius: 0, showLine: false }] },
    options: buildChartOptions(p, candles, minP, maxP, false),
    plugins: [...buildCandlePlugins(candles, avg, false), buildForecastPlugin(p), buildProphetPlugin(p), buildVPVRPlugin(p, candles), buildPriceLinePlugin(p, candles), buildDynamicSwingVWAPPlugin(p)]
  });
  PINE_SCRIPTS.filter(s => s.overlay && pineActive[s.id]).forEach(def => {
    const cached = p._pineOverlayCache[def.id];
    if (cached && cached.zoom === p.chartZoom) _pushCachedPineSets(p, cached.sets);
  });
  if (p.mainChart.data.datasets.length > 1) p.mainChart.update("none");
  if (indicators.arima) loadForecast(p);
  applyActivePineOverlays(p);
  _applyActiveInds(p);
}

export function drawLiveChart(p, lastPrice) {
  const n = p.liveCandles.length;
  const xOff = Math.max(0, Math.round(p._xOffset || 0));
  const zoom = p.chartZoom;
  const endIdx = Math.max(0, n - xOff);
  const startIdx = Math.max(0, endIdx - zoom);
  const candles = p.liveCandles.slice(startIdx, endIdx);
  if (!candles.length) return;
  // Right-align candles: pad left with empty space so chart width is always zoom-wide
  const xStart = Math.max(0, zoom - candles.length);
  p._liveXStart = xStart; p._liveStartIdx = startIdx;
  const avg = App.state.averages[p.ticker];
  const prices = candles.flatMap(c => [c.h, c.l]); if (avg) prices.push(avg);
  const autoMin = Math.min(...prices) * 0.999, autoMax = Math.max(...prices) * 1.001;
  const minP = p._yMin ?? autoMin, maxP = p._yMax ?? autoMax;
  const canvas = makePanelCanvas(p);
  if (!canvas) return;
  updateStatusBar(p, candles[candles.length - 1]);
  document.getElementById("main-price-" + p.idx).textContent = fmt(lastPrice);
  p.mainChart = new Chart(canvas, {
    type: "scatter",
    data: { labels: candles.map((_, j) => xStart + j), datasets: [{ data: candles.map((c, j) => ({ x: xStart + j, y: c.c })), pointRadius: 0, showLine: false }] },
    options: buildChartOptions(p, candles, minP, maxP, true, xStart, zoom),
    plugins: [...buildCandlePlugins(candles, avg, true, xStart), buildVPVRPlugin(p, candles), buildPriceLinePlugin(p, candles), buildDynamicSwingVWAPPlugin(p)]
  });
  PINE_SCRIPTS.filter(s => s.overlay && pineActive[s.id]).forEach(def => {
    const cached = p._pineOverlayCache[def.id];
    if (cached && cached.zoom === p.chartZoom) _pushCachedPineSets(p, cached.sets);
  });
  if (p.mainChart.data.datasets.length > 1) p.mainChart.update("none");
  const lc = p.liveCandles.length;
  if (lc !== (p._liveCount || 0)) { p._liveCount = lc; applyActivePineOverlays(p); _applyActiveInds(p); }
  drawUtility(p, candles);
}

// Push cached pine sets onto p.mainChart with opacity applied
function _pushCachedPineSets(p, sets) {
  const opacity = p.widgetSettings?.pineOpacity ?? 1;
  sets.forEach(d => {
    const ds = Object.assign({}, d, { data: [...d.data] });
    if (opacity < 1) {
      if (typeof ds.borderColor === "string") ds.borderColor = _colorWithAlpha(ds.borderColor, opacity);
      if (typeof ds.pointBackgroundColor === "string") ds.pointBackgroundColor = _colorWithAlpha(ds.pointBackgroundColor, opacity);
    }
    p.mainChart.data.datasets.push(ds);
  });
}

// ── CANVAS HELPER ─────────────────────────────────────────────────────────────
function makePanelCanvas(p) {
  const wrap = document.getElementById("canvas-wrap-" + p.idx);
  if (!wrap) return null;
  const W = Math.max(10, wrap.clientWidth - 20), H = Math.max(10, wrap.clientHeight - 16);
  if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
  const old = document.getElementById("main-canvas-" + p.idx);
  if (!old) return null;
  const canvas = document.createElement("canvas");
  canvas.id = "main-canvas-" + p.idx; canvas.width = W; canvas.height = H;
  old.replaceWith(canvas); return canvas;
}

// ── CHART OPTIONS ─────────────────────────────────────────────────────────────
function _xBounds(p, candles) {
  const n = candles.length;
  const zoom = Math.min(p.chartZoom, n);
  const xOff = p._xOffset || 0;
  const arimaFC = (indicators.arima && p.tf !== "1s")
    ? (p.forecastData.length > 0 ? p.forecastData.length : (TF_N_FC[p.tf] || N_FC))
    : 0;
  const prophetFC = p.prophetData?.forecast?.length
    ? (p.prophetData.forecast.length)
    : (p.prophetData ? (p.prophetData.n_fc || 14) : 0);
  const extras = Math.max(arimaFC, prophetFC);
  return { xMin: n - zoom - xOff - 0.3, xMax: n - xOff - 0.7 + extras };
}

function buildChartOptions(p, candles, minP, maxP, isLive, xStart = 0, fixedZoom = 0) {
  let xMin, xMax;
  if (isLive && fixedZoom > 0) {
    xMin = -0.3;
    xMax = fixedZoom - 0.7;
  } else {
    ({ xMin, xMax } = _xBounds(p, candles));
  }
  return {
    animation: false, responsive: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => { const c = candles[ctx.dataIndex]; return c ? [`O:${fmt(c.o)} H:${fmt(c.h)} L:${fmt(c.l)} C:${fmt(c.c)}`] : ""; },
          title: (items) => { const c = candles[items[0].dataIndex]; return c ? new Date(c.t).toLocaleString() : ""; },
        },
        backgroundColor: "#0f1318", borderColor: "#2a3340", borderWidth: 1,
        titleColor: "#6a8099", bodyColor: "#c8d8e8",
        titleFont: { family: "'JetBrains Mono'" }, bodyFont: { family: "'JetBrains Mono'", size: 11 }
      }
    },
    scales: {
      x: { type: "linear", min: xMin, max: xMax, grid: { color: "#1e253022" }, ticks: { color: "#3d5066", font: { family: "'JetBrains Mono'", size: 9 }, maxTicksLimit: 8, callback: (v) => { const c = candles[Math.round(v) - xStart]; if (!c) return ""; const d = new Date(c.t); if (p.tf === "1wk") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); if (p.tf === "1d")  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }); } } },
      y: { min: p._yMin ?? minP, max: p._yMax ?? maxP, position: "right", grid: { color: "#1e253022" }, ticks: { color: "#6a8099", font: { family: "'JetBrains Mono'", size: 9 }, callback: (v) => fmt(v) } }
    }
  };
}

// ── CANDLE PLUGINS ────────────────────────────────────────────────────────────
function buildCandlePlugins(candles, avg, isLive, xStart = 0) {
  const candlePlugin = {
    id: "candles",
    beforeDatasetsDraw(chart) {
      const { ctx, scales: { x, y }, chartArea: { top, bottom, left, right } } = chart;
      const barW = Math.max(2, (x.getPixelForValue(xStart + 1) - x.getPixelForValue(xStart)) * 0.6);
      const maxVol = candles.reduce((m, c) => Math.max(m, c.v || 0), 1);
      const volZoneH = (bottom - top) * 0.18;
      if (indicators.volume) candles.forEach((c, i) => {
        const xPos = x.getPixelForValue(xStart + i);
        if (xPos < left - barW || xPos > right + barW) return;
        const volH = c.v > 0 ? Math.max(2, ((c.v || 0) / maxVol) * volZoneH) : 1;
        const bull = c.c >= c.o;
        ctx.fillStyle = bull ? "#00d47e44" : "#f03e3e44"; ctx.strokeStyle = bull ? "#00d47e88" : "#f03e3e88"; ctx.lineWidth = 0.5;
        ctx.fillRect(xPos - barW / 2, bottom - volH, barW, volH);
        ctx.strokeRect(xPos - barW / 2, bottom - volH, barW, volH);
      });
      candles.forEach((c, i) => {
        const xPos = x.getPixelForValue(xStart + i);
        if (xPos < left - barW || xPos > right + barW) return;
        const openY = y.getPixelForValue(c.o), closeY = y.getPixelForValue(c.c);
        const highY = y.getPixelForValue(c.h), lowY = y.getPixelForValue(c.l);
        const bull = c.c >= c.o;
        if (isLive && c.live) { ctx.shadowColor = bull ? "#00d47e" : "#f03e3e"; ctx.shadowBlur = 6; }
        ctx.strokeStyle = bull ? "#00d47e" : "#f03e3e"; ctx.fillStyle = bull ? "#00d47e33" : "#f03e3e33"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xPos, highY); ctx.lineTo(xPos, lowY); ctx.stroke();
        const bTop = Math.min(openY, closeY), bH = Math.max(1, Math.abs(closeY - openY));
        ctx.fillRect(xPos - barW / 2, bTop, barW, bH); ctx.strokeRect(xPos - barW / 2, bTop, barW, bH);
        ctx.shadowBlur = 0;
      });
    }
  };
  const avgPlugin = {
    id: "avgLine",
    afterDatasetsDraw(chart) {
      if (!avg) return;
      const { ctx, scales: { y }, chartArea: { left, right } } = chart;
      const yPos = y.getPixelForValue(avg);
      ctx.save();
      ctx.strokeStyle = "#f05050"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(left, yPos); ctx.lineTo(right, yPos); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f05050"; ctx.font = "10px 'JetBrains Mono'";
      ctx.fillText("AVG " + fmt(avg), right - 90, yPos - 4);
      ctx.restore();
    }
  };
  return [candlePlugin, avgPlugin];
}

// ── PRICE LINE PLUGIN ─────────────────────────────────────────────────────────
function buildPriceLinePlugin(p, candles) {
  return {
    id: "priceLine-" + p.idx,
    afterDraw(chart) {
      if (!candles || !candles.length) return;
      const { ctx, scales: { x, y }, chartArea: { left, right } } = chart;
      const last = candles[candles.length - 1];
      const price = last.c, bull = last.c >= last.o;
      const color = bull ? "#00d47e" : "#f03e3e";
      const yPos = y.getPixelForValue(price);
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = color + "99"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, yPos); ctx.lineTo(right, yPos); ctx.stroke();
      ctx.setLineDash([]);
      const cW = chart.width, cH = chart.height;
      const labelW = Math.max(42, cW - right - 4), labelH = 16, labelX = right + 2;
      // Solid color fill, black text — matches reference dashboard style
      ctx.fillStyle = color; ctx.fillRect(labelX, yPos - labelH / 2, labelW, labelH);
      ctx.beginPath(); ctx.moveTo(labelX, yPos - 4); ctx.lineTo(labelX - 5, yPos); ctx.lineTo(labelX, yPos + 4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#000"; ctx.font = "bold 10px 'JetBrains Mono'";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(fmt(price), labelX + labelW / 2, yPos);
      const rem = candleTimeRemaining(p.tf, last.t);
      const tsz = p.widgetSettings?.timerFontSize ?? 11;
      if (rem) {
        ctx.font = `bold ${tsz}px 'JetBrains Mono'`; ctx.textAlign = "center"; ctx.textBaseline = "top";
        const tx = labelX + labelW / 2;
        const tw = ctx.measureText(rem).width;
        const boxH = tsz + 4;
        const belowY = yPos + labelH / 2 + 2;
        const rawTy = (belowY + boxH < cH - 4) ? belowY : yPos - labelH / 2 - boxH - 2;
        const ty = Math.max(2, Math.min(cH - boxH - 2, rawTy));
        // Darker grey background, solid colored border, colored text
        ctx.fillStyle = "#1a2230";
        ctx.fillRect(tx - tw / 2 - 4, ty - 1, tw + 8, boxH);
        ctx.strokeStyle = color; ctx.lineWidth = 0.5;
        ctx.strokeRect(tx - tw / 2 - 4, ty - 1, tw + 8, boxH);
        ctx.fillStyle = color;
        ctx.fillText(rem, tx, ty + 1);
      }
      ctx.restore();
    }
  };
}

// ── DYNAMIC SWING ANCHORED VWAP PLUGIN ───────────────────────────────────────
const _dsvwapCache = new WeakMap();

const _dsvwapSettings = (() => {
  try { return JSON.parse(localStorage.getItem("td_dsvwap_settings") || "null") || { period: 50, apt: 20, volatBias: 10, adaptApt: true }; }
  catch { return { period: 50, apt: 20, volatBias: 10, adaptApt: true }; }
})();
function _saveDsvwapSettings() { localStorage.setItem("td_dsvwap_settings", JSON.stringify(_dsvwapSettings)); }

function _computeATRLast(candles, period = 14) {
  const n = candles.length;
  if (n < 2) return 0;
  const start = Math.max(1, n - period);
  let sum = 0;
  for (let i = start; i < n; i++) {
    const prev = candles[i - 1].c;
    sum += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - prev), Math.abs(candles[i].l - prev));
  }
  return sum / (n - start);
}

function _emaSmooth(pts, period) {
  if (period <= 1 || pts.length === 0) return pts;
  const k = 2 / (period + 1);
  let emaVal = pts[0].y;
  return pts.map((pt, i) => {
    if (i === 0) { emaVal = pt.y; return pt; }
    emaVal = pt.y * k + emaVal * (1 - k);
    return { idx: pt.idx, y: emaVal };
  });
}

function _computeDSVWAP(candles) {
  const n = candles.length;
  const halfPeriod = Math.floor(_dsvwapSettings.period / 2);
  const atrRatio = n >= 15 ? _computeATRLast(candles) / Math.max(1, (candles[n-1].h + candles[n-1].l) / 2) : 0.01;
  const atrAdj = _dsvwapSettings.volatBias > 0 ? Math.round(_dsvwapSettings.volatBias * atrRatio * halfPeriod) : 0;
  const leftLen = halfPeriod + atrAdj;
  const rightLen = halfPeriod + atrAdj;

  const pivots = [];
  for (let i = leftLen; i < n - rightLen; i++) {
    const hi = candles[i].h, lo = candles[i].l;
    let isPH = true, isPL = true;
    for (let j = i - leftLen; j <= i + rightLen; j++) {
      if (j === i) continue;
      if (candles[j].h >= hi) isPH = false;
      if (candles[j].l <= lo) isPL = false;
    }
    if (isPH) pivots.push({ idx: i, type: "H", price: hi });
    if (isPL) pivots.push({ idx: i, type: "L", price: lo });
  }
  pivots.sort((a, b) => a.idx - b.idx);

  let lastH = null, lastL = null;
  const swings = [];
  for (const pv of pivots) {
    if (pv.type === "H") {
      pv.label = (lastH === null || pv.price > lastH) ? "HH" : "LH";
      lastH = pv.price;
    } else {
      pv.label = (lastL === null || pv.price > lastL) ? "HL" : "LL";
      lastL = pv.price;
    }
    swings.push(pv);
  }

  const aptPeriod = _dsvwapSettings.adaptApt
    ? Math.max(1, Math.round(_dsvwapSettings.apt * (1 + atrRatio * _dsvwapSettings.volatBias)))
    : _dsvwapSettings.apt;

  const segments = [];
  for (let s = 0; s < swings.length; s++) {
    const sw = swings[s];
    const endIdx = s + 1 < swings.length ? swings[s + 1].idx : n - 1;
    let cumPV = 0, cumV = 0;
    const pts = [];
    for (let i = sw.idx; i <= endIdx && i < n; i++) {
      const c = candles[i];
      const hlc3 = (c.h + c.l + c.c) / 3;
      const vol = c.v || 1;
      cumPV += hlc3 * vol; cumV += vol;
      pts.push({ idx: i, y: cumPV / cumV });
    }
    const smoothed = aptPeriod > 1 ? _emaSmooth(pts, aptPeriod) : pts;
    if (smoothed.length >= 2) segments.push({ ...sw, color: sw.type === "H" ? "#089981" : "#f23645", pts: smoothed });
  }
  return { swings, segments };
}

function buildDynamicSwingVWAPPlugin(p) {
  return {
    id: "dsvwap-" + p.idx,
    afterDraw(chart) {
      if (!indActive["ind_dsvwap"] && !pineActive["file_dynamicswinganchoredvwap"]) return;
      const candles = p.tf === "1s" ? p.liveCandles : p.candleData?._liveCandles;
      if (!candles || candles.length < 25) return;

      const settingsKey = JSON.stringify(_dsvwapSettings);
      const cacheKey = candles.length + ":" + (candles[candles.length - 1]?.t || 0) + ":" + settingsKey;
      let cached = _dsvwapCache.get(chart);
      if (!cached || cached.key !== cacheKey) {
        cached = { key: cacheKey, ..._computeDSVWAP(candles) };
        _dsvwapCache.set(chart, cached);
      }
      const { swings, segments } = cached;
      const { ctx, scales: { x, y }, chartArea } = chart;

      // Map full-array index → x-axis value (accounts for ticker-tape xStart offset)
      const xStart = p.tf === "1s" ? (p._liveXStart || 0) : 0;
      const startIdx = p.tf === "1s" ? (p._liveStartIdx || 0) : 0;
      const idxToX = (idx) => xStart + (idx - startIdx);

      ctx.save();
      ctx.beginPath();
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
      ctx.clip();

      for (const seg of segments) {
        ctx.beginPath();
        ctx.strokeStyle = seg.color + "cc";
        ctx.lineWidth = 2.5;
        let started = false;
        for (const pt of seg.pts) {
          const px = x.getPixelForValue(idxToX(pt.idx)), py = y.getPixelForValue(pt.y);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.font = "bold 9px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      for (const sw of swings) {
        const px = x.getPixelForValue(idxToX(sw.idx));
        const isH = sw.type === "H";
        const dotY = y.getPixelForValue(sw.price);
        const lblY = dotY + (isH ? -10 : 10);
        ctx.fillStyle = sw.type === "H" ? "#089981" : "#f23645";
        ctx.beginPath(); ctx.arc(px, dotY, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.textBaseline = isH ? "bottom" : "top";
        ctx.fillText(sw.label, px, lblY);
      }
      ctx.restore();
    }
  };
}

// ── NATIVE CHART INDICATORS ───────────────────────────────────────────────────
const CHART_INDICATORS = [
  { id: "ind_dsvwap", name: "SWING ANCHORED VWAP", desc: "Dynamic swing-anchored VWAP" },
  { id: "ind_bb",     name: "BOLLINGER BANDS",      desc: "SMA 20  ±2σ" },
  { id: "ind_ema",    name: "EMA 9 / 21",           desc: "Exponential moving averages" },
];
const indActive = (() => { try { return JSON.parse(localStorage.getItem("td_ind_active") || "{}"); } catch { return {}; } })();
function _saveIndActive() { localStorage.setItem("td_ind_active", JSON.stringify(indActive)); }

function _computeBB(candles, period = 20, mult = 2) {
  const cl = candles.map(c => c.c);
  return cl.map((_, i) => {
    if (i < period - 1) return { b: null, u: null, l: null };
    const sl = cl.slice(i - period + 1, i + 1);
    const mean = sl.reduce((a, v) => a + v, 0) / period;
    const std = Math.sqrt(sl.reduce((a, v) => a + (v - mean) ** 2, 0) / period);
    return { b: mean, u: mean + mult * std, l: mean - mult * std };
  });
}

function _computeEMA(candles, period) {
  const k = 2 / (period + 1), out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;
  out[period - 1] = candles.slice(0, period).reduce((a, c) => a + c.c, 0) / period;
  for (let i = period; i < candles.length; i++) out[i] = candles[i].c * k + out[i - 1] * (1 - k);
  return out;
}

function _applyIndToPanel(p, id) {
  if (!p.mainChart) return;
  const candles = p.tf === "1s" ? p.liveCandles.slice(-p.chartZoom) : p.candleData?._liveCandles;
  if (!candles?.length) return;
  p.mainChart.data.datasets = p.mainChart.data.datasets.filter(d => d._indId !== id);
  if (id === "ind_dsvwap") { p.mainChart.update("none"); return; }
  const push = (data, color, name) => p.mainChart.data.datasets.push({
    _indId: id, label: name,
    data: data.map((v, i) => ({ x: i, y: v })),
    borderColor: color, borderWidth: 1.5, pointRadius: 0, showLine: true, spanGaps: false, tension: 0.2
  });
  if (id === "ind_bb") {
    const bb = _computeBB(candles);
    push(bb.map(r => r.u), "#60a8f080", "BB Upper");
    push(bb.map(r => r.b), "#3e8ef0cc", "BB Basis");
    push(bb.map(r => r.l), "#60a8f080", "BB Lower");
  }
  if (id === "ind_ema") {
    push(_computeEMA(candles, 9),  "#f0a030", "EMA 9");
    push(_computeEMA(candles, 21), "#f06080", "EMA 21");
  }
  p.mainChart.update("none");
}

function _applyActiveInds(p) {
  CHART_INDICATORS.forEach(ind => { if (indActive[ind.id]) _applyIndToPanel(p, ind.id); });
}

export function toggleChartIndicator(id, active) {
  indActive[id] = active; _saveIndActive();
  App.panels.forEach(p => {
    if (!p.mainChart) return;
    if (active) _applyIndToPanel(p, id);
    else if (id === "ind_dsvwap") p.mainChart.update("none");
    else { p.mainChart.data.datasets = p.mainChart.data.datasets.filter(d => d._indId !== id); p.mainChart.update("none"); }
  });
}

// ── FORECAST PLUGIN ───────────────────────────────────────────────────────────
function buildForecastPlugin(p) {
  return {
    id: "forecast-" + p.idx,
    afterDatasetsDraw(chart) {
      if (!p.forecastData.length || !indicators.arima) return;
      const { ctx, scales: { x, y }, chartArea: { top, bottom, left, right } } = chart;
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
      const sepX = x.getPixelForValue(p.forecastOffset - 0.5);
      ctx.strokeStyle = "#6a809955"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sepX, top); ctx.lineTo(sepX, bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#3e8ef0"; ctx.globalAlpha = 0.07;
      ctx.beginPath();
      p.forecastData.forEach((f, i) => {
        const px = x.getPixelForValue(p.forecastOffset + i), py = y.getPixelForValue(f.ci_hi);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      [...p.forecastData].reverse().forEach((f, i) => {
        const idx = p.forecastData.length - 1 - i;
        ctx.lineTo(x.getPixelForValue(p.forecastOffset + idx), y.getPixelForValue(f.ci_lo));
      });
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.45;
      p.forecastData.forEach((f, i) => {
        const xi = p.forecastOffset + i;
        const xPos = x.getPixelForValue(xi);
        const barW = Math.max(2, (x.getPixelForValue(1) - x.getPixelForValue(0)) * 0.6);
        const openY = y.getPixelForValue(f.o), closeY = y.getPixelForValue(f.c);
        const highY = y.getPixelForValue(f.h), lowY = y.getPixelForValue(f.l);
        const bull = f.c >= f.o;
        ctx.strokeStyle = bull ? "#00d47e" : "#f03e3e"; ctx.fillStyle = bull ? "#00d47e22" : "#f03e3e22"; ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.moveTo(xPos, highY); ctx.lineTo(xPos, lowY); ctx.stroke();
        ctx.setLineDash([]);
        const bTop = Math.min(openY, closeY), bH = Math.max(1, Math.abs(closeY - openY));
        ctx.fillRect(xPos - barW / 2, bTop, barW, bH); ctx.strokeRect(xPos - barW / 2, bTop, barW, bH);
      });
      ctx.restore();
    }
  };
}

// ── VOLUME PROFILE (VPVR) PLUGIN ──────────────────────────────────────────────
function buildVPVRPlugin(p, candles) {
  return {
    id: "vpvr-" + p.idx,
    afterDatasetsDraw(chart) {
      if (!p.widgetSettings?.vpvrOn) return;
      const { ctx, scales: { y }, chartArea: { top, bottom, left, right } } = chart;

      // Visible candle slice — same window as y-bounds
      const _n = candles.length, _zoom = Math.min(p.chartZoom, _n);
      const _xOff = Math.max(0, p._xOffset || 0);
      const visStart = Math.max(0, _n - _zoom - Math.ceil(_xOff));
      const visEnd   = Math.max(visStart + 1, _n - Math.floor(_xOff));
      const vis = candles.slice(visStart, visEnd);
      if (!vis.length) return;

      const N = 80;
      const lo = Math.min(...vis.map(c => c.l));
      const hi = Math.max(...vis.map(c => c.h));
      const range = hi - lo;
      if (!range) return;

      const bSz = range / N;
      const vols = new Float64Array(N);
      for (const c of vis) {
        const vol = c.v || 0;
        if (!vol) continue;
        const b0 = Math.max(0, Math.floor((c.l - lo) / bSz));
        const b1 = Math.min(N - 1, Math.floor((c.h - lo) / bSz));
        const nB = Math.max(1, b1 - b0 + 1);
        const vPer = vol / nB;
        for (let b = b0; b <= b1; b++) vols[b] += vPer;
      }

      const maxVol = Math.max(...vols);
      if (!maxVol) return;

      const BAR_MAX_W = (right - left) * 0.14;
      const pocIdx = Array.from(vols).indexOf(maxVol);

      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();

      for (let i = 0; i < N; i++) {
        if (!vols[i]) continue;
        const barW = (vols[i] / maxVol) * BAR_MAX_W;
        const yBot = y.getPixelForValue(lo + i * bSz);
        const yTop = y.getPixelForValue(lo + (i + 1) * bSz);
        const barH = Math.max(1, yBot - yTop);
        // Gradient: blue (#4489cc) at low volume → yellow (#ffcc44) at high volume
        const t = vols[i] / maxVol;
        const cr = Math.round(68  + t * (255 - 68));
        const cg = Math.round(137 + t * (204 - 137));
        const cb = Math.round(204 + t * (68  - 204));
        ctx.globalAlpha = 0.08 + t * 0.32;
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.fillRect(right - barW, yTop, barW, barH);
      }

      // POC dashed line + label
      if (pocIdx >= 0) {
        const pocPrice = lo + pocIdx * bSz + bSz / 2;
        const yPoc = y.getPixelForValue(pocPrice);
        ctx.globalAlpha = 0.6; ctx.strokeStyle = "#ffcc44"; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(left, yPoc); ctx.lineTo(right - 2, yPoc); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.85; ctx.fillStyle = "#ffcc44";
        ctx.font = "8px 'JetBrains Mono'"; ctx.textAlign = "left";
        ctx.fillText("POC " + fmt(pocPrice), left + 4, yPoc - 3);
      }

      ctx.restore();
    }
  };
}

// ── PROPHET PLUGIN ────────────────────────────────────────────────────────────
function buildProphetPlugin(p) {
  return {
    id: "prophet-" + p.idx,
    afterDatasetsDraw(chart) {
      if (!p.prophetData) return;
      const { ctx, scales: { x, y }, chartArea: { top, bottom, left, right } } = chart;
      const fc  = p.prophetData.forecast;
      const fcB = (indicators.prophetHeuristic !== false && p.prophetData.forecast_biased)
        ? p.prophetData.forecast_biased : fc;
      const n   = p.candleData?._liveCandles?.length ?? 0;
      if (!n || !fc.length) return;
      const bias  = p.prophetData.bias_score ?? 0;
      const bLabel = p.prophetData.bias_label || "";
      const bColor = bias > 0.1 ? "#00d47e" : bias < -0.1 ? "#f03e3e" : "#6a8099";
      ctx.save();
      ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();

      // Separator
      const sepX = x.getPixelForValue(n - 0.5);
      ctx.strokeStyle = "#4dd9e044"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(sepX, top); ctx.lineTo(sepX, bottom); ctx.stroke();
      ctx.setLineDash([]);

      // Bias label
      ctx.font = "bold 8px 'JetBrains Mono'"; ctx.fillStyle = bColor;
      ctx.textAlign = "left"; ctx.globalAlpha = 0.9;
      ctx.fillText(bLabel, sepX + 5, top + 14);

      // Raw ETS baseline (dim gray)
      ctx.globalAlpha = 0.25; ctx.strokeStyle = "#6a8099"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      fc.forEach((f, i) => { const px = x.getPixelForValue(n + i); i === 0 ? ctx.moveTo(px, y.getPixelForValue(f.yhat)) : ctx.lineTo(px, y.getPixelForValue(f.yhat)); });
      ctx.stroke(); ctx.setLineDash([]);

      // Biased CI band
      ctx.globalAlpha = 0.08; ctx.fillStyle = "#4dd9e0";
      ctx.beginPath();
      fcB.forEach((f, i) => { const px = x.getPixelForValue(n + i); i === 0 ? ctx.moveTo(px, y.getPixelForValue(f.yhat_upper)) : ctx.lineTo(px, y.getPixelForValue(f.yhat_upper)); });
      [...fcB].reverse().forEach((f, i) => { ctx.lineTo(x.getPixelForValue(n + fcB.length - 1 - i), y.getPixelForValue(f.yhat_lower)); });
      ctx.closePath(); ctx.fill();

      // Biased forecast line
      ctx.globalAlpha = 1; ctx.strokeStyle = "#4dd9e0"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      ctx.beginPath();
      fcB.forEach((f, i) => { const px = x.getPixelForValue(n + i); i === 0 ? ctx.moveTo(px, y.getPixelForValue(f.yhat)) : ctx.lineTo(px, y.getPixelForValue(f.yhat)); });
      ctx.stroke(); ctx.setLineDash([]);

      // Day dots
      ctx.fillStyle = "#4dd9e0"; ctx.globalAlpha = 0.85;
      fcB.forEach((f, i) => { ctx.beginPath(); ctx.arc(x.getPixelForValue(n + i), y.getPixelForValue(f.yhat), 2.5, 0, Math.PI * 2); ctx.fill(); });

      ctx.restore();
    }
  };
}

// Fast-path view update for pan/y-scale — avoids full chart recreation
function _updateChartView(p) {
  if (!p.mainChart) return;
  if (p.tf === "1s") {
    if (p.liveCandles.length) { drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c); drawUtility(p, p.liveCandles.slice(-p.chartZoom)); }
    return;
  }
  const candles = p.candleData?._liveCandles;
  if (!candles?.length) return;
  const { xMin, xMax } = _xBounds(p, candles);
  p.mainChart.options.scales.x.min = xMin;
  p.mainChart.options.scales.x.max = xMax;
  if (p._yMin !== null && p._yMax !== null) {
    p.mainChart.options.scales.y.min = p._yMin;
    p.mainChart.options.scales.y.max = p._yMax;
  }
  p.mainChart.update("none");
  if (p.rsiChart) {
    p.rsiChart.options.scales.x.min = xMin;
    p.rsiChart.options.scales.x.max = xMax;
    p.rsiChart.update("none");
  }
}

function _showResetBtn(p) {
  const btn = document.getElementById("reset-view-btn-" + p.idx);
  if (btn) btn.classList.add("active");
}
function _hideResetBtn(p) {
  const btn = document.getElementById("reset-view-btn-" + p.idx);
  if (btn) btn.classList.remove("active");
}

export function resetPanelView(idx) {
  const p = App.panels[idx]; if (!p) return;
  p._xOffset = 0; p._yMin = null; p._yMax = null; p._panLocked = false;
  p.chartZoom = 150;
  const ziEl = document.getElementById("zoom-indicator-" + p.idx);
  if (ziEl) ziEl.textContent = "ZOOM 150";
  _hideResetBtn(p);
  if (p.tf === "1s") { if (p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c); }
  else if (p.candleData) { drawMainChart(p, p.candleData); drawUtility(p, p.candleData._liveCandles); }
}

export async function loadForecast(p, nocache = false) {
  if (!indicators.arima || !p.mainChart || p.tf === "1s") return;
  const myGen = p._gen;
  const period = TF_PERIOD[p.tf] || "5d";
  const offset = p.candleData?._liveCandles?.length ?? p.chartZoom;
  try {
    const nc = nocache ? "&nocache=1" : "";
    const r = await fetch(API + `/api/forecast/${p.ticker}?interval=${p.tf}&period=${period}&n=${TF_N_FC[p.tf] || N_FC}${nc}`);
    if (!r.ok || p._gen !== myGen) return;
    const d = await r.json();
    if (d.error || !d.forecast?.length || p._gen !== myGen) return;
    p.forecastAll  = d;
    p.forecastData = (indicators.arimaHeuristic !== false && d.forecast_biased?.length)
      ? d.forecast_biased : d.forecast;
    p.forecastOffset = offset;
    if (!p.mainChart) return;
    p.mainChart.update("none");
  } catch (e) {}
}

// ── PANEL HELPERS ─────────────────────────────────────────────────────────────
export function updateHeader(p, data) {
  document.getElementById("main-ticker-" + p.idx).textContent = data.ticker;
  document.getElementById("main-price-" + p.idx).textContent = fmt(data.last);
  const chEl = document.getElementById("main-change-" + p.idx);
  const pos = data.change_pct >= 0;
  chEl.textContent = (pos ? "▲ +" : "▼ ") + data.change_pct.toFixed(2) + "%";
  chEl.className = "main-change " + (pos ? "pos" : "neg");
}

function updateStatusBar(p, c) {
  if (!c) return;
  document.getElementById("st-open-" + p.idx).textContent = fmt(c.o);
  document.getElementById("st-high-" + p.idx).textContent = fmt(c.h);
  document.getElementById("st-low-" + p.idx).textContent = fmt(c.l);
  document.getElementById("st-close-" + p.idx).textContent = fmt(c.c);
}

export function showLoading(p, v) { const el = document.getElementById("loading-" + p.idx); if (el) el.classList.toggle("hidden", !v); }

export function setPanelTradingBadge(p, mode) {
  const badge = document.getElementById("status-badge-" + p.idx); if (!badge) return;
  if (!mode) { badge.style.display = "none"; return; }
  const dot = document.getElementById("status-dot-" + p.idx);
  const txt = document.getElementById("status-text-" + p.idx);
  badge.style.display = "flex";
  if (mode === "offline") {
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:var(--red);display:inline-block;animation:none;";
    txt.style.color = "var(--red)"; txt.textContent = "OFFLINE";
  } else {
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:var(--green);display:inline-block;animation:pulse 1s infinite;";
    txt.style.color = "var(--green)"; txt.textContent = "TRADING";
  }
}

function setOffline(p) {
  if (p._offline) return;
  p._offline = true;
  if (p.tickerInterval) { clearInterval(p.tickerInterval); p.tickerInterval = null; }
  setPanelTradingBadge(p, "offline");
  startOfflineCheck(p);
}

function startOfflineCheck(p) {
  if (p._offlineTimer) clearTimeout(p._offlineTimer);
  const myGen = p._gen;
  p._offlineTimer = setTimeout(async () => {
    if (p._gen !== myGen) return;
    try {
      const r = await fetch(API + `/api/chart/${p.ticker}?period=1d&interval=1m`);
      const d = await r.json();
      if (p._gen !== myGen) return;
      if (!d.error && d.candles && d.candles.length) {
        const lastTs = d.candles[d.candles.length - 1].t;
        if (Date.now() - lastTs < 5 * 60 * 1000) { p._offline = false; loadMainChart(p); return; }
      }
    } catch (e) {}
    startOfflineCheck(p);
  }, 5 * 60 * 1000);
}

export function updateAvgLegend(p) {
  const avg = App.state.averages[p.ticker];
  const el = document.getElementById("avg-legend-" + p.idx); if (el) el.style.display = avg ? "flex" : "none";
  if (avg) { const v = document.getElementById("avg-legend-val-" + p.idx); if (v) v.textContent = "AVG " + fmt(avg); }
}

export async function setPanelAverage(idx) {
  const p = App.panels[idx]; if (!p) return;
  const val = parseFloat(document.getElementById("avg-input-" + idx).value);
  if (isNaN(val) || val <= 0) return;
  App.state.averages[p.ticker] = val; updateAvgLegend(p); loadMainChart(p);
  await fetch(API + `/api/average/${p.ticker}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ price: val }) });
}

export async function clearPanelAverage(idx) {
  const p = App.panels[idx]; if (!p) return;
  delete App.state.averages[p.ticker];
  const el = document.getElementById("avg-input-" + idx); if (el) el.value = "";
  updateAvgLegend(p); loadMainChart(p);
  await fetch(API + `/api/average/${p.ticker}`, { method: "DELETE" });
}

export function applyUtilityHeight(h) {
  if (!h) return;
  App.panels.forEach(p => {
    const el = document.getElementById("utility-panel-" + p.idx);
    if (el) el.style.height = h + "px";
  });
}

// ── WIDGET MODE ───────────────────────────────────────────────────────────────
export function applyWidgetModeSelect(p) {
  const sel = document.getElementById("widget-mode-select-" + p.idx);
  if (sel) sel.value = p.widgetMode || "candles";
  const isChart = (p.widgetMode || "candles") === "candles";
  const utPanel = document.getElementById("utility-panel-" + p.idx);
  if (utPanel) utPanel.style.display = isChart ? "" : "none";
  const footer = document.getElementById("chart-footer-" + p.idx);
  if (footer) {
    footer.querySelectorAll(".tf-btn").forEach(b => b.style.display = isChart ? "" : "none");
    const pineBtn = document.getElementById("pine-btn-" + p.idx);
    if (pineBtn) pineBtn.style.display = isChart ? "" : "none";
  }
}

export function setWidgetMode(idx, mode) {
  const p = App.panels[idx]; if (!p) return;
  p.widgetMode = mode;

  // Sync select
  const sel = document.getElementById("widget-mode-select-" + idx);
  if (sel) sel.value = mode;

  // Show / hide utility and TF buttons
  const isChart = mode === "candles";
  const utPanel = document.getElementById("utility-panel-" + idx);
  if (utPanel) utPanel.style.display = isChart ? "" : "none";
  const footer = document.getElementById("chart-footer-" + idx);
  if (footer) {
    footer.querySelectorAll(".tf-btn").forEach(b => b.style.display = isChart ? "" : "none");
    const pineBtn = document.getElementById("pine-btn-" + idx);
    if (pineBtn) pineBtn.style.display = isChart ? "" : "none";
  }

  if (isChart) {
    // Stop non-chart widgets and restore canvas-wrap if needed
    stopLiquidationMap(p);
    stopLevel2(p);
    stopConsole(p);
    const canvasWrap = document.getElementById("canvas-wrap-" + idx);
    if (canvasWrap && !document.getElementById("main-canvas-" + idx)) {
      canvasWrap.style.flexDirection = "";
      canvasWrap.style.padding = "";
      canvasWrap.innerHTML = `<canvas id="main-canvas-${idx}"></canvas><div class="loading hidden" id="loading-${idx}"><span class="spinner"></span>LOADING</div>`;
    }
    if (p.candleData?._liveCandles?.length) {
      drawMainChart(p, p.candleData);
      drawUtility(p, p.candleData._liveCandles);
    } else {
      loadMainChart(p);
    }
  } else {
    // Stop chart live feeds
    if (p.liveWS) { p.liveWS.close(); p.liveWS = null; }
    if (p.liveInterval) { clearInterval(p.liveInterval); p.liveInterval = null; }
    if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
    stopLiquidationMap(p);
    stopLevel2(p);
    stopConsole(p);
    if (mode === "liquidation") startLiquidationMap(p);
    else if (mode === "level2") startLevel2(p);
    else if (mode === "console") startConsole(p);
  }

  saveMonitorPreset();
}

// Internal: start the correct widget for a panel after layout/restore
function _startPanelWidget(p) {
  const mode = p.widgetMode || "candles";
  if (mode === "liquidation") { startLiquidationMap(p); }
  else if (mode === "level2") { startLevel2(p); }
  else if (mode === "console") { startConsole(p); }
  else { loadMainChart(p); }
}

// ── PER-PANEL SETTINGS ────────────────────────────────────────────────────────
export function toggleWidgetSettings(idx) {
  const popup = document.getElementById("wsettings-" + idx);
  const p = App.panels[idx];
  if (!popup || !p) return;
  const opening = popup.style.display === "none";
  App.panels.forEach(q => {
    const el = document.getElementById("wsettings-" + q.idx); if (el) el.style.display = "none";
    const btn = document.getElementById("wsettings-btn-" + q.idx); if (btn) btn.classList.remove("active");
  });
  if (opening) {
    _buildSettingsPopup(p, popup);
    popup.style.display = "block";
    const btn = document.getElementById("wsettings-btn-" + idx); if (btn) btn.classList.add("active");
    setTimeout(() => {
      const close = (e) => {
        if (!popup.contains(e.target) && e.target.id !== "wsettings-btn-" + idx) {
          popup.style.display = "none";
          const btn2 = document.getElementById("wsettings-btn-" + idx); if (btn2) btn2.classList.remove("active");
          document.removeEventListener("click", close);
        }
      };
      document.addEventListener("click", close);
    }, 0);
  }
}

function _buildSettingsPopup(p, popup) {
  const ws = p.widgetSettings, i = p.idx, mode = p.widgetMode || "candles";
  const curMs = App.updateIntervalMs;
  const rates = [100, 250, 500, 1000];
  let html = '<div class="wsp-title">PANEL SETTINGS</div>';
  html += `
    <div class="wsp-row">
      <span class="wsp-lbl">UPDATE RATE</span>
      <div style="display:flex;gap:4px;">
        ${rates.map(ms => `<button class="wsp-rate-btn${curMs===ms?' active':''}" onclick="setWidgetSetting(${i},'updateRate',${ms})">${ms<1000?ms+'ms':'1s'}</button>`).join('')}
      </div>
    </div>`;
  if (mode === "candles") {
    html += `
      <div class="wsp-row">
        <span class="wsp-lbl">TIMER SIZE</span>
        <input type="range" class="wsp-range" min="8" max="18" value="${ws.timerFontSize}"
               oninput="setWidgetSetting(${i},'timerFontSize',+this.value)">
        <span class="wsp-val" id="wsp-timerFontSize-${i}">${ws.timerFontSize}px</span>
      </div>
      <div class="wsp-row">
        <span class="wsp-lbl">PINE OPACITY</span>
        <input type="range" class="wsp-range" min="5" max="100" value="${Math.round(ws.pineOpacity * 100)}"
               oninput="setWidgetSetting(${i},'pineOpacity',this.value/100)">
        <span class="wsp-val" id="wsp-pineOpacity-${i}">${Math.round(ws.pineOpacity * 100)}%</span>
      </div>
      <div class="wsp-row">
        <span class="wsp-lbl">VOLUME</span>
        <label class="wsp-check-lbl">
          <input type="checkbox" class="ind-cb" ${indicators.volume ? "checked" : ""} onchange="setIndicator('volume',this.checked)">
          <span>BARS</span>
        </label>
      </div>
      <div class="wsp-row">
        <span class="wsp-lbl">VOL PROFILE</span>
        <label class="wsp-check-lbl">
          <input type="checkbox" class="ind-cb" ${ws.vpvrOn ? "checked" : ""} onchange="setWidgetSetting(${i},'vpvrOn',this.checked)">
          <span>VISIBLE RANGE</span>
        </label>
      </div>`;
  } else if (mode === "level2") {
    html += `
      <div class="wsp-row">
        <span class="wsp-lbl">TAPE FONT</span>
        <input type="range" class="wsp-range" min="7" max="13" value="${ws.l2TapeFontSize}"
               oninput="setWidgetSetting(${i},'l2TapeFontSize',+this.value)">
        <span class="wsp-val" id="wsp-l2TapeFontSize-${i}">${ws.l2TapeFontSize}px</span>
      </div>`;
  } else {
    html += '<div class="wsp-empty">NO SETTINGS</div>';
  }
  popup.innerHTML = html;
}

export function setWidgetSetting(idx, key, value) {
  const p = App.panels[idx]; if (!p) return;
  const v = typeof value === "boolean" ? value : typeof value === "string" ? parseFloat(value) : value;
  if (key === "updateRate") {
    App.updateIntervalMs = v;
    App.state.update_interval = v;
    startPriceFeed();
    syncState();
    // Refresh button states in popup
    document.querySelectorAll(".wsp-rate-btn").forEach(b => b.classList.toggle("active", parseInt(b.textContent) === v || (b.textContent === "1s" && v === 1000)));
    return;
  }
  p.widgetSettings[key] = v;
  const valEl = document.getElementById("wsp-" + key + "-" + idx);
  if (valEl) valEl.textContent = key === "pineOpacity" ? Math.round(v * 100) + "%" : v + "px";
  if (key === "timerFontSize" && p.mainChart) {
    p.mainChart.update("none");
  } else if (key === "l2TapeFontSize") {
    const buysEl  = document.getElementById("l2-tape-buys-"  + idx);
    const sellsEl = document.getElementById("l2-tape-sells-" + idx);
    const paneEl  = document.getElementById("l2-tape-pane-"  + idx);
    if (buysEl)  buysEl.style.fontSize  = v + "px";
    if (sellsEl) sellsEl.style.fontSize = v + "px";
    if (paneEl)  paneEl.style.flex = `0 0 ${Math.round(v * 26)}px`;
  } else if (key === "vpvrOn" && p.mainChart) {
    p.mainChart.update("none");
  } else if (key === "pineOpacity" && p.mainChart) {
    p.mainChart.data.datasets.forEach((ds, di) => {
      if (di === 0) return;
      if (ds.borderColor && typeof ds.borderColor === "string")
        ds.borderColor = _colorWithAlpha(ds.borderColor, v);
      if (ds.backgroundColor && typeof ds.backgroundColor === "string")
        ds.backgroundColor = _colorWithAlpha(ds.backgroundColor, v * 0.35);
    });
    p.mainChart.update("none");
  }
  saveMonitorPreset();
}

function _colorWithAlpha(color, alpha) {
  const m8 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (m8) return `rgba(${parseInt(m8[1],16)},${parseInt(m8[2],16)},${parseInt(m8[3],16)},${alpha.toFixed(2)})`;
  const mr = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (mr) return `rgba(${mr[1]},${mr[2]},${mr[3]},${alpha.toFixed(2)})`;
  return color;
}

// ── FLOATING PINE POPUP ───────────────────────────────────────────────────────
let _pinePopupEl = null;

export function togglePinePopup() {
  if (!_pinePopupEl) {
    _pinePopupEl = _buildPinePopupEl();
    document.body.appendChild(_pinePopupEl);
  }
  const showing = _pinePopupEl.style.display !== "none";
  _pinePopupEl.style.display = showing ? "none" : "";
  if (!showing) _refreshPinePopup();
}

function _buildPinePopupEl() {
  const el = document.createElement("div");
  el.className = "pine-popup";
  el.style.cssText = "right:290px;top:56px;";
  el.innerHTML = `
    <div class="pine-popup-head" id="pine-popup-head">
      PINE SCRIPTS
      <button class="pine-popup-close" onclick="togglePinePopup()">×</button>
    </div>
    <div class="pine-popup-body" id="pine-popup-body"></div>
  `;
  _makeDraggable(el, el.querySelector(".pine-popup-head"));
  return el;
}

function _refreshPinePopup() {
  const body = document.getElementById("pine-popup-body");
  if (!body) return;
  body.innerHTML = "";
  const HIDDEN_FROM_PINE = new Set(["bb", "ema_cross", "file_dynamicswinganchoredvwap"]);
  const overlays = PINE_SCRIPTS.filter(s => s.overlay && !HIDDEN_FROM_PINE.has(s.id));
  const oscs = PINE_SCRIPTS.filter(s => !s.overlay && !HIDDEN_FROM_PINE.has(s.id));
  if (overlays.length) {
    const sec = document.createElement("div");
    sec.className = "pine-popup-section"; sec.textContent = "OVERLAY";
    body.appendChild(sec);
    overlays.forEach(def => body.appendChild(_makePineRow(def)));
  }
  if (oscs.length) {
    const sec = document.createElement("div");
    sec.className = "pine-popup-section"; sec.textContent = "OSCILLATOR";
    body.appendChild(sec);
    oscs.forEach(def => body.appendChild(_makePineRow(def)));
  }
}

function _makePineRow(def) {
  const row = document.createElement("label");
  row.className = "pine-popup-row";
  const isCustom = def.id === "custom";
  const typeTag = def.overlay
    ? `<span class="pine-popup-tag ovr">OVR</span>`
    : `<span class="pine-popup-tag osc">OSC</span>`;
  const editBtn = isCustom
    ? `<button class="pine-popup-edit" onclick="openPineEditor(event)">✎</button>`
    : "";
  row.innerHTML = `<input type="checkbox" class="ind-cb" id="pine-cb-${def.id}" ${pineActive[def.id] ? "checked" : ""} onchange="togglePineIndicator('${def.id}',this.checked)"><span>${def.name}</span>${typeTag}${editBtn}`;
  return row;
}

// ── FLOATING INDICATORS POPUP ─────────────────────────────────────────────────
let _indPopupEl = null;

export function toggleIndPopup() {
  if (!_indPopupEl) {
    _indPopupEl = _buildIndPopupEl();
    document.body.appendChild(_indPopupEl);
  }
  const showing = _indPopupEl.style.display !== "none";
  _indPopupEl.style.display = showing ? "none" : "";
  if (!showing) _refreshIndPopup();
}

function _buildIndPopupEl() {
  const el = document.createElement("div");
  el.className = "pine-popup";
  el.style.cssText = "right:390px;top:56px;min-width:210px;";
  el.innerHTML = `
    <div class="pine-popup-head" id="ind-popup-head">INDICATORS <button class="pine-popup-close" onclick="toggleIndPopup()">×</button></div>
    <div class="pine-popup-body" id="ind-popup-body"></div>
  `;
  _makeDraggable(el, el.querySelector(".pine-popup-head"));
  return el;
}

function _refreshIndPopup() {
  const body = document.getElementById("ind-popup-body");
  if (!body) return;
  body.innerHTML = "";
  CHART_INDICATORS.forEach(ind => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;display:flex;align-items:center;";
    const row = document.createElement("label");
    row.className = "pine-popup-row";
    row.style.cssText = "flex:1;margin:0;";
    row.innerHTML = `<input type="checkbox" class="ind-cb" id="ind-cb-${ind.id}" ${indActive[ind.id] ? "checked" : ""} onchange="toggleChartIndicator('${ind.id}',this.checked)"><span>${ind.name}</span><span class="pine-popup-tag ovr" style="font-size:7px;letter-spacing:.5px;opacity:.65">${ind.desc}</span>`;
    wrap.appendChild(row);
    if (ind.id === "ind_dsvwap") {
      const gear = document.createElement("button");
      gear.textContent = "⚙"; gear.title = "DSVWAP settings";
      gear.style.cssText = "background:none;border:none;color:var(--text3);cursor:pointer;font-size:11px;padding:0 4px;flex-shrink:0;";
      gear.onclick = (e) => { e.stopPropagation(); _toggleDsvwapSettingsPopup(wrap); };
      wrap.appendChild(gear);
      const sp = _buildDsvwapSettingsPopup();
      sp.id = "dsvwap-settings-popup";
      sp.style.display = "none";
      wrap.appendChild(sp);
    }
    body.appendChild(wrap);
  });
}

function _buildDsvwapSettingsPopup() {
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;right:0;top:100%;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:10px 12px;z-index:999;min-width:200px;font-size:10px;color:var(--text2);";
  const s = _dsvwapSettings;
  el.innerHTML = `
    <div style="font-size:9px;letter-spacing:1px;color:var(--text3);margin-bottom:8px;">DSVWAP SETTINGS</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="min-width:110px;">Swing Period</span>
        <input type="range" min="10" max="200" step="5" value="${s.period}" id="dsvwap-period-sl" style="flex:1;" oninput="document.getElementById('dsvwap-period-v').textContent=this.value;_onDsvwapSetting('period',+this.value)">
        <span id="dsvwap-period-v" style="min-width:24px;text-align:right;">${s.period}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="min-width:110px;">Adaptive Price Track</span>
        <input type="range" min="1" max="50" step="1" value="${s.apt}" id="dsvwap-apt-sl" style="flex:1;" oninput="document.getElementById('dsvwap-apt-v').textContent=this.value;_onDsvwapSetting('apt',+this.value)">
        <span id="dsvwap-apt-v" style="min-width:24px;text-align:right;">${s.apt}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="min-width:110px;">Volatility Bias</span>
        <input type="range" min="0" max="50" step="1" value="${s.volatBias}" id="dsvwap-vb-sl" style="flex:1;" oninput="document.getElementById('dsvwap-vb-v').textContent=this.value;_onDsvwapSetting('volatBias',+this.value)">
        <span id="dsvwap-vb-v" style="min-width:24px;text-align:right;">${s.volatBias}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="min-width:110px;">Adapt APT by ATR</span>
        <input type="checkbox" ${s.adaptApt ? "checked" : ""} id="dsvwap-adapt-cb" onchange="_onDsvwapSetting('adaptApt',this.checked)">
      </div>
    </div>
  `;
  return el;
}

function _toggleDsvwapSettingsPopup(wrap) {
  const sp = wrap.querySelector("#dsvwap-settings-popup");
  if (!sp) return;
  const open = sp.style.display !== "none";
  sp.style.display = open ? "none" : "";
  if (!open) {
    const outside = (e) => { if (!sp.contains(e.target) && !e.target.closest("[title='DSVWAP settings']")) { sp.style.display = "none"; document.removeEventListener("click", outside); } };
    setTimeout(() => document.addEventListener("click", outside), 0);
  }
}

function _onDsvwapSetting(key, val) {
  _dsvwapSettings[key] = val;
  _saveDsvwapSettings();
  App.panels.forEach(p => {
    if (p.mainChart) _dsvwapCache.delete(p.mainChart);
    if (p.tf === "1s" && p.liveCandles.length) drawLiveChart(p, p.liveCandles[p.liveCandles.length - 1].c);
    else if (p.candleData) drawMainChart(p, p.candleData);
  });
}

function _makeDraggable(el, handle) {
  let ox = 0, oy = 0;
  handle.addEventListener("mousedown", e => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    ox = e.clientX - rect.left; oy = e.clientY - rect.top;
    el.style.right = "auto";
    const move = ev => { el.style.left = (ev.clientX - ox) + "px"; el.style.top = (ev.clientY - oy) + "px"; };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

// ── UTILITY SETTINGS ─────────────────────────────────────────────────────────
function toggleUtilitySettings(idx) {
  const popup = document.getElementById("utility-settings-popup-" + idx);
  if (!popup) return;
  const opening = popup.classList.contains("hidden");
  document.querySelectorAll(".utility-settings-popup").forEach(el => el.classList.add("hidden"));
  if (opening) {
    popup.classList.remove("hidden");
    const outside = (e) => {
      if (!popup.contains(e.target) && e.target.id !== "utility-gear-btn-" + idx) {
        popup.classList.add("hidden");
        document.removeEventListener("click", outside);
      }
    };
    setTimeout(() => document.addEventListener("click", outside), 0);
  }
}

function onUtilityYZoom(idx, val) {
  const p = App.panels[idx]; if (!p) return;
  const zoom = parseFloat(val) / 100;
  p.widgetSettings = p.widgetSettings || {};
  p.widgetSettings.utilityYZoom = zoom;
  const valEl = document.getElementById("uset-yzoom-val-" + idx);
  if (valEl) valEl.textContent = zoom.toFixed(2).replace(/\.?0+$/, "") + "×";
  if (p._lastUtilityCandles) drawUtility(p, p._lastUtilityCandles);
}

// Expose inline-HTML onclick functions
window.setPanelTF = setPanelTF;
window.setUtilityMode = setUtilityMode;
window.setLayout = setLayout;
window.switchMonitor = switchMonitor;
window.setPanelAverage = setPanelAverage;
window.clearPanelAverage = clearPanelAverage;
window.setWidgetMode = setWidgetMode;
window.toggleWidgetSettings = toggleWidgetSettings;
window.setWidgetSetting = setWidgetSetting;
window.splitPanel = splitPanel;
window.closePanel = closePanel;
window.togglePinePopup = togglePinePopup;
window.toggleIndPopup = toggleIndPopup;
window.toggleChartIndicator = toggleChartIndicator;
window.resetPanelView = resetPanelView;
window.toggleUtilitySettings = toggleUtilitySettings;
window.onUtilityYZoom = onUtilityYZoom;
window._onDsvwapSetting = _onDsvwapSetting;
window._toggleDsvwapSettingsPopup = _toggleDsvwapSettingsPopup;
