import { App, indicators } from '../../core/state.js';
import { N_FC, TF_N_FC, calcRSI, calcMACD } from '../../core/utils.js';

// Mirrors _xBounds in chart.js — use Math.max so both forecasts active = same range as one alone
function _extras(p) {
  const arimaFC = (indicators.arima && p.tf !== "1s")
    ? (p.forecastData?.length > 0 ? p.forecastData.length : (TF_N_FC[p.tf] || N_FC))
    : 0;
  const prophetFC = p.prophetData?.forecast?.length
    ? p.prophetData.forecast.length
    : (p.prophetData ? (p.prophetData.n_fc || 14) : 0);
  return Math.max(arimaFC, prophetFC);
}
import { PINE_SCRIPTS, pineActive, loadPineTS, getCustomScript } from '../MainChart/pine.js';

// ── Y-AXIS DRAG + X PAN ───────────────────────────────────────────────────────
function _ensureYDrag(p) {
  const wrap = document.getElementById("utility-canvas-wrap-" + p.idx);
  if (!wrap || wrap._yDragBound) return;
  wrap._yDragBound = true;

  let startX = null, startY = null, startZoom = 1.0, startOff = 0, _isYDrag = false;

  const _onYAxis = (e) => {
    const canvas = document.getElementById("utility-canvas-" + p.idx);
    if (!canvas || !p.rsiChart?.chartArea) return false;
    const rect = canvas.getBoundingClientRect();
    return (e.clientX - rect.left) >= p.rsiChart.chartArea.right;
  };

  wrap.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    _isYDrag = _onYAxis(e);
    startX = e.clientX; startY = e.clientY;
    startZoom = p.widgetSettings?.utilityYZoom ?? 1.0;
    startOff = p._xOffset || 0;
  });

  wrap.addEventListener("mousemove", (e) => {
    if (startY !== null) return; // active drag — let window handler own cursor
    wrap.style.cursor = _onYAxis(e) ? "ns-resize" : "grab";
  });

  wrap.addEventListener("dblclick", (e) => {
    if (!_onYAxis(e)) return;
    if (!p.widgetSettings) p.widgetSettings = {};
    p.widgetSettings.utilityYZoom = 1.0;
    drawUtility(p, p._lastUtilityCandles);
  });

  window.addEventListener("mousemove", (e) => {
    if (startY === null) return;
    if (_isYDrag) {
      wrap.style.cursor = "ns-resize";
      const dy = startY - e.clientY;
      const zoom = Math.max(1.0, Math.min(12, startZoom * Math.pow(1.018, dy)));
      if (!p.widgetSettings) p.widgetSettings = {};
      p.widgetSettings.utilityYZoom = zoom;
      drawUtility(p, p._lastUtilityCandles);
    } else {
      wrap.style.cursor = "grabbing";
      const candles = p._lastUtilityCandles;
      if (!candles || !p.mainChart?.chartArea) return;
      const chartW = p.mainChart.chartArea.right - p.mainChart.chartArea.left;
      const ppc = chartW / Math.max(1, p.chartZoom);
      const dx = e.clientX - startX;
      const maxOff = candles.length - Math.min(p.chartZoom, candles.length);
      const newOff = Math.max(-(_extras(p) + 5), Math.min(maxOff, startOff + dx / ppc));
      p._applyPanOffset?.(newOff);
    }
  });

  window.addEventListener("mouseup", () => { startY = null; startX = null; wrap.style.cursor = ""; });
}

export function drawUtility(p, candles) {
  if (!candles || !candles.length) return;
  p._lastUtilityCandles = candles;
  const activePineOsc = PINE_SCRIPTS.find(s => !s.overlay && pineActive[s.id]);
  if (activePineOsc) { drawPineOscillator(p, activePineOsc, candles); return; }
  if (p.utilityMode === "macd") drawMACD(p, candles);
  else drawRSI(p, candles);
}

// ── RSI ───────────────────────────────────────────────────────────────────────
export function drawRSI(p, candles) {
  const panel = document.getElementById("utility-panel-" + p.idx);
  if (!panel || panel.style.display === "none") return;
  const wrap = document.getElementById("utility-canvas-wrap-" + p.idx);
  if (!wrap) return;
  const rsiVals = calcRSI(candles, p.rsiPeriod);
  const lastRSI = rsiVals.filter(v => v !== null).pop();
  if (lastRSI !== undefined) {
    const valEl = document.getElementById("utility-value-" + p.idx);
    const zoneEl = document.getElementById("utility-zone-" + p.idx);
    if (valEl) valEl.textContent = lastRSI.toFixed(1);
    if (zoneEl) {
      if (lastRSI >= 70) { zoneEl.textContent = "OVERBOUGHT"; zoneEl.style.color = "var(--red)"; }
      else if (lastRSI <= 30) { zoneEl.textContent = "OVERSOLD"; zoneEl.style.color = "var(--green)"; }
      else { zoneEl.textContent = ""; zoneEl.style.color = ""; }
    }
  }
  const xOff = p._xOffset || 0;
  const n = candles.length, zoom = Math.min(p.chartZoom, n);
  const isLive1s = p.tf === "1s";
  const xStart = isLive1s ? (p._liveXStart || 0) : 0;
  const rsiXMin = isLive1s ? -0.3 : n - zoom - xOff - 0.3;
  const rsiXMax = isLive1s ? p.chartZoom - 0.7 : n - xOff - 0.7 + _extras(p);
  const yZoom = p.widgetSettings?.utilityYZoom || 1.0;
  let rsiYMin = 0, rsiYMax = 100;
  if (yZoom > 1.01) {
    const half = 50 / yZoom;
    rsiYMin = Math.max(0, 50 - half);
    rsiYMax = Math.min(100, 50 + half);
  }
  if (p.rsiChart && document.contains(p.rsiChart.canvas)) {
    p.rsiChart.data.datasets[0].data = rsiVals.map((v, i) => ({ x: xStart + i, y: v }));
    p.rsiChart.options.scales.x.min = rsiXMin;
    p.rsiChart.options.scales.x.max = rsiXMax;
    p.rsiChart.options.scales.y.min = rsiYMin;
    p.rsiChart.options.scales.y.max = rsiYMax;
    p.rsiChart.update("none");
    return;
  }
  const W = wrap.clientWidth - 20, H = wrap.clientHeight - 4;
  if (W <= 0 || H <= 0) return;
  if (p.rsiChart) { p.rsiChart.destroy(); p.rsiChart = null; }
  const oldC = document.getElementById("utility-canvas-" + p.idx);
  if (!oldC) return;
  const canvas = document.createElement("canvas");
  canvas.id = "utility-canvas-" + p.idx; canvas.width = W; canvas.height = H;
  oldC.replaceWith(canvas);
  const zonesPlugin = {
    id: "rsiZones-" + p.idx,
    beforeDatasetsDraw(chart) {
      const { ctx, scales: { x, y }, chartArea: { left, right } } = chart;
      const y70 = y.getPixelForValue(70), y30 = y.getPixelForValue(30);
      const yTop = y.getPixelForValue(100), yBot = y.getPixelForValue(0);
      ctx.save();
      ctx.fillStyle = "rgba(240,62,62,0.06)"; ctx.fillRect(left, yTop, right - left, y70 - yTop);
      ctx.fillStyle = "rgba(0,212,126,0.06)"; ctx.fillRect(left, y30, right - left, yBot - y30);
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(240,62,62,0.3)"; ctx.beginPath(); ctx.moveTo(left, y70); ctx.lineTo(right, y70); ctx.stroke();
      ctx.strokeStyle = "rgba(0,212,126,0.3)"; ctx.beginPath(); ctx.moveTo(left, y30); ctx.lineTo(right, y30); ctx.stroke();
      ctx.strokeStyle = "rgba(100,128,153,0.2)";
      const y50 = y.getPixelForValue(50); ctx.beginPath(); ctx.moveTo(left, y50); ctx.lineTo(right, y50); ctx.stroke();
      ctx.setLineDash([]); ctx.restore();
    }
  };
  p.rsiChart = new Chart(canvas, {
    type: "scatter",
    data: { labels: candles.map((_, i) => xStart + i), datasets: [{ data: rsiVals.map((v, i) => ({ x: xStart + i, y: v })), borderColor: "#3e8ef0", borderWidth: 1.5, pointRadius: 0, showLine: true, tension: 0.3, spanGaps: false }] },
    options: {
      animation: false, responsive: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: (ctx) => `RSI: ${ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) : "—"}`, title: (items) => { const c = candles[items[0].dataIndex]; return c ? new Date(c.t).toLocaleString() : ""; } },
        backgroundColor: "#0f1318", borderColor: "#2a3340", borderWidth: 1,
        titleColor: "#6a8099", bodyColor: "#3e8ef0",
        titleFont: { family: "'JetBrains Mono'" }, bodyFont: { family: "'JetBrains Mono'", size: 11 }
      }},
      scales: {
        x: { type: "linear", min: rsiXMin, max: rsiXMax, grid: { color: "#1e253011" }, ticks: { display: false } },
        y: { min: rsiYMin, max: rsiYMax, position: "right", grid: { color: "#1e253011" }, ticks: { color: "#3d5066", font: { family: "'JetBrains Mono'", size: 8 }, callback: (v) => v === 30 || v === 70 || v === 50 ? v : "" } }
      }
    },
    plugins: [zonesPlugin]
  });
  _ensureYDrag(p);
}

// ── MACD ──────────────────────────────────────────────────────────────────────
export function drawMACD(p, candles) {
  if (!candles || candles.length < 3) return;
  const { macdLine, signal, hist } = calcMACD(candles);
  const wrap = document.getElementById("utility-canvas-wrap-" + p.idx);
  if (!wrap) return;
  const lastM = macdLine.filter(v => v != null).pop();
  const lastH = hist.filter(v => v != null).pop();
  const valEl = document.getElementById("utility-value-" + p.idx);
  const zoneEl = document.getElementById("utility-zone-" + p.idx);
  if (valEl && lastM != null) valEl.textContent = lastM.toFixed(4);
  if (zoneEl && lastH != null) { zoneEl.textContent = lastH >= 0 ? "BULL" : "BEAR"; zoneEl.style.color = lastH >= 0 ? "var(--green)" : "var(--red)"; }
  const xOff = p._xOffset || 0;
  const n = candles.length, zoom = Math.min(p.chartZoom, n);
  const isLive1s = p.tf === "1s";
  const xStart = isLive1s ? (p._liveXStart || 0) : 0;
  const macdXMin = isLive1s ? -0.3 : n - zoom - xOff - 0.3;
  const macdXMax = isLive1s ? p.chartZoom - 0.7 : n - xOff - 0.7 + _extras(p);
  const yZoom = p.widgetSettings?.utilityYZoom || 1.0;
  let macdYMin, macdYMax;
  if (yZoom > 1.01) {
    const allVals = [...macdLine, ...signal, ...hist].filter(v => v != null && isFinite(v));
    if (allVals.length) {
      const extent = Math.max(Math.abs(Math.min(...allVals)), Math.abs(Math.max(...allVals)));
      const half = extent / yZoom * 1.1;
      macdYMin = -half; macdYMax = half;
    }
  }
  if (p.rsiChart && document.contains(p.rsiChart.canvas)) {
    p.rsiChart._hist = hist;
    p.rsiChart.data.datasets[0].data = macdLine.map((v, i) => ({ x: xStart + i, y: v }));
    p.rsiChart.data.datasets[1].data = signal.map((v, i) => ({ x: xStart + i, y: v }));
    p.rsiChart.options.scales.x.min = macdXMin;
    p.rsiChart.options.scales.x.max = macdXMax;
    if (macdYMin !== undefined) { p.rsiChart.options.scales.y.min = macdYMin; p.rsiChart.options.scales.y.max = macdYMax; }
    else { delete p.rsiChart.options.scales.y.min; delete p.rsiChart.options.scales.y.max; }
    p.rsiChart._xStart = xStart;
    p.rsiChart.update("none");
    return;
  }
  const W = wrap.clientWidth - 20, H = wrap.clientHeight - 4;
  if (W <= 0 || H <= 0) return;
  if (p.rsiChart) { p.rsiChart.destroy(); p.rsiChart = null; }
  const oldC = document.getElementById("utility-canvas-" + p.idx);
  if (!oldC) return;
  const canvas = document.createElement("canvas");
  canvas.id = "utility-canvas-" + p.idx; canvas.width = W; canvas.height = H;
  oldC.replaceWith(canvas);
  const histPlugin = {
    id: "macdHist-" + p.idx,
    beforeDatasetsDraw(chart) {
      const h = chart._hist || [];
      const { ctx, scales: { x, y } } = chart;
      const hxStart = chart._xStart || 0;
      h.forEach((hv, i) => {
        if (hv == null) return;
        const xPos = x.getPixelForValue(hxStart + i);
        const barW = Math.max(1, (x.getPixelForValue(hxStart + 1) - x.getPixelForValue(hxStart)) * 0.6);
        const zero = y.getPixelForValue(0), top = y.getPixelForValue(hv);
        const bTop = Math.min(zero, top), bH = Math.abs(zero - top);
        if (bH < 1) return;
        ctx.fillStyle = hv >= 0 ? "#00d47e44" : "#f03e3e44";
        ctx.strokeStyle = hv >= 0 ? "#00d47e88" : "#f03e3e88";
        ctx.lineWidth = 0.5;
        ctx.fillRect(xPos - barW / 2, bTop, barW, bH);
        ctx.strokeRect(xPos - barW / 2, bTop, barW, bH);
      });
    }
  };
  p.rsiChart = new Chart(canvas, {
    type: "scatter",
    data: { labels: candles.map((_, i) => xStart + i), datasets: [
      { data: macdLine.map((v, i) => ({ x: xStart + i, y: v })), borderColor: "#3e8ef0", borderWidth: 1.5, pointRadius: 0, showLine: true, tension: 0.3, spanGaps: false },
      { data: signal.map((v, i) => ({ x: xStart + i, y: v })), borderColor: "#f0a03e", borderWidth: 1, pointRadius: 0, showLine: true, tension: 0.3, spanGaps: false }
    ]},
    options: {
      animation: false, responsive: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: (ctx) => `${ctx.datasetIndex === 0 ? "MACD" : "Sig"}: ${ctx.parsed.y?.toFixed(4) ?? "—"}` },
        backgroundColor: "#0f1318", borderColor: "#2a3340", borderWidth: 1,
        titleColor: "#6a8099", bodyColor: "#c8d8e8",
        titleFont: { family: "'JetBrains Mono'" }, bodyFont: { family: "'JetBrains Mono'", size: 11 }
      }},
      scales: {
        x: { type: "linear", min: macdXMin, max: macdXMax, grid: { color: "#1e253011" }, ticks: { display: false } },
        y: { ...(macdYMin !== undefined ? { min: macdYMin, max: macdYMax } : {}), position: "right", grid: { color: "#1e253011" }, ticks: { color: "#3d5066", font: { family: "'JetBrains Mono'", size: 8 }, callback: (v) => v === 0 ? "0" : v.toFixed(2) } }
      }
    },
    plugins: [histPlugin]
  });
  p.rsiChart._hist = hist;
  p.rsiChart._xStart = xStart;
  _ensureYDrag(p);
}

// ── PINE OSCILLATOR ───────────────────────────────────────────────────────────
export async function drawPineOscillator(p, def, candles) {
  if (!candles || candles.length < 10) return;
  const gen = p._gen;
  const src = def.id === "custom" ? getCustomScript() : def.script;
  if (!src) return;
  const PineTS = await loadPineTS();
  if (!PineTS || p._gen !== gen) return;
  try {
    const pineCandles = candles.map(c => ({ open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0, openTime: c.t }));
    const { plots } = await new PineTS(pineCandles).run(src);
    if (p._gen !== gen) return;
    renderPineOscillator(p, plots, candles);
  } catch (e) {
    if (p._gen !== gen) return;
    const v = document.getElementById("utility-value-" + p.idx); if (v) v.textContent = "ERR";
    console.warn("Pine OSC:", e.message || e);
  }
}

export function renderPineOscillator(p, plots, candles) {
  const wrap = document.getElementById("utility-canvas-wrap-" + p.idx); if (!wrap) return;
  const W = wrap.clientWidth - 20, H = wrap.clientHeight - 4;
  if (W <= 0 || H <= 0) return;
  if (p.rsiChart) { p.rsiChart.destroy(); p.rsiChart = null; }
  const oldC = document.getElementById("utility-canvas-" + p.idx);
  const canvas = document.createElement("canvas");
  canvas.id = "utility-canvas-" + p.idx; canvas.width = W; canvas.height = H;
  oldC.replaceWith(canvas);
  const entries = Object.entries(plots).filter(([, pl]) => {
    if (!pl?.data?.length) return false;
    const vals = pl.data.map(d => d.value).filter(v => v != null && isFinite(v) && !Number.isNaN(v));
    if (vals.length < 2) return false;
    return Math.max(...vals) - Math.min(...vals) > 0;
  });
  if (!entries.length) return;
  const COLORS = ["#3e8ef0", "#f03e3e", "#00d47e", "#f0a03e", "#a060f0"];
  const _xOff = p._xOffset || 0;
  const _n = candles.length, _zoom = Math.min(p.chartZoom, _n);
  const xMin = _n - _zoom - _xOff - 0.3, xMax = _n - _xOff - 0.7 + _extras(p);
  const datasets = entries.map(([name, pl], i) => {
    const pineColor = pl.data.slice().reverse().find(pt => pt?.options?.color)?.options?.color;
    return { label: name, data: pl.data.map((pt, j) => ({ x: j, y: pt.value ?? null })), borderColor: pineColor || COLORS[i % COLORS.length], borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: false, showLine: true, spanGaps: false };
  });
  const yVals = datasets.flatMap(ds => ds.data.map(d => d.y).filter(v => v != null && isFinite(v)));
  const rawMin = yVals.length ? Math.min(...yVals) : 0, rawMax = yVals.length ? Math.max(...yVals) : 100;
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const lastPt = entries[0][1].data.slice(-1)[0];
  const valEl = document.getElementById("utility-value-" + p.idx);
  if (valEl && lastPt?.value != null) valEl.textContent = lastPt.value.toFixed(2);
  p.rsiChart = new Chart(canvas, {
    type: "scatter", data: { datasets },
    options: {
      animation: false, responsive: false,
      plugins: { legend: { display: entries.length > 1 }, tooltip: { enabled: false } },
      scales: {
        x: { type: "linear", min: xMin, max: xMax, grid: { color: "#1e253011" }, ticks: { display: false } },
        y: { min: rawMin - pad, max: rawMax + pad, position: "right", grid: { color: "#1e253011" }, ticks: { color: "#3d5066", font: { family: "'JetBrains Mono'", size: 8 }, maxTicksLimit: 3 } }
      }
    }
  });
  _ensureYDrag(p);
}
