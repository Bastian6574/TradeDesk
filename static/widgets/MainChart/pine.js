import { App, indicators } from '../../core/state.js';
import { drawUtility } from '../UtilityPanel/utility.js';

function _pineColorAlpha(color, alpha) {
  const m8 = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (m8) return `rgba(${parseInt(m8[1],16)},${parseInt(m8[2],16)},${parseInt(m8[3],16)},${alpha.toFixed(2)})`;
  const mr = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (mr) return `rgba(${mr[1]},${mr[2]},${mr[3]},${alpha.toFixed(2)})`;
  return color;
}

// ── PINE SCRIPT DEFINITIONS ───────────────────────────────────────────────────
export const PINE_SCRIPTS = [
  // BB and EMA 9/21 moved to native IND popup (chart.js CHART_INDICATORS)
  { id: "stoch_rsi",  name: "STOCH RSI",       overlay: false, script: `//@version=5\nindicator("Stoch RSI",overlay=false)\nrsi1=ta.rsi(close,14)\nk=ta.sma(ta.stoch(rsi1,rsi1,rsi1,14),3)\nd=ta.sma(k,3)\nplot(k,"K")\nplot(d,"D")` },
  { id: "cci",        name: "CCI",             overlay: false, script: `//@version=5\nindicator("CCI",overlay=false)\nsrc=hlc3\nma=ta.sma(src,20)\nsd=ta.stdev(src,20)\nplot(sd>0?(src-ma)/(0.015*sd):0,"CCI")` },
  { id: "williams_r", name: "WILL %R",         overlay: false, script: `//@version=5\nindicator("Will %R",overlay=false)\nhh=ta.highest(high,14)\nll=ta.lowest(low,14)\nplot(hh-ll>0?(hh-close)/(hh-ll)*-100:0,"%R")` },
  { id: "atr",        name: "ATR",             overlay: false, script: `//@version=5\nindicator("ATR",overlay=false)\nplot(ta.atr(14),"ATR")` },
  { id: "custom",     name: "CUSTOM",          overlay: false, script: null },
];

export const pineActive = (() => { try { return JSON.parse(localStorage.getItem("td_pine_active") || "{}"); } catch { return {}; } })();
export function savePineActive() { localStorage.setItem("td_pine_active", JSON.stringify(pineActive)); }

let _pineCustomScript = localStorage.getItem("td_pine_custom") || "";
export function getCustomScript() { return _pineCustomScript; }

// Overlay color palettes per script id
export const OVLY_COLORS = {
  bb: ["#60a8f0", "#3e8ef0", "#60a8f0"],
  ema_cross: ["#f0a030", "#f06080"],
  custom: ["#f0c040", "#f09030"],
  file_bb_multitimeframe: ["#ffffff", "#ffffff", "#f03e3e", "#3e8ef0", "#00d47e"],
  file_candlestick_structure: ["#089981", "#089981", "#f23645"],
  file_curved_smartmoneyconcepts: ["#f23645", "#00d47e", "#f03e3e", "#f03e3e", "#00d47e", "#00d47e", "#3e8ef0", "#3e8ef0"],
  file_dynamicflowribbon: ["#1add7f", "#1add7f", "#1add7f", "#1add7f", "#1add7f", "#e79314", "#e79314", "#e79314", "#e79314", "#e79314", "#e79314"],
  file_dynamicswinganchoredvwap: ["#089981", "#089981", "#f23645"],
  file_gannbox: ["#F44336", "#a5d6a7", "#9598a1", "#0097a7", "#81C784", "#a5d6a7", "#F44336"],
  file_gannsquare144: ["#ef5350", "#e0e0e0", "#2196F3", "#e0e0e0", "#4CAF50", "#FF9800", "#FF9800"],
  file_half_cup: ["#089981", "#f23645", "#e0e0e0", "#089981"],
  file_heatmaptrailingstop: ["#4CAF50", "#4CAF50", "#4CAF50", "#4CAF50", "#76FF03", "#f23645", "#76FF03", "#f23645"],
  file_highvolumepoints: ["#fda05e", "#2fd68e", "#fda05e", "#2fd68e"],
  file_liquidity_swings: ["#f23645", "#26a69a", "#f23645", "#26a69a"],
};

// ── PINE TS LOADER ────────────────────────────────────────────────────────────
let _PineTSModule = null;
export async function loadPineTS() {
  if (_PineTSModule) return _PineTSModule;
  try {
    const mod = await import("https://esm.sh/pinets");
    _PineTSModule = mod.PineTS || mod.default?.PineTS || Object.values(mod).find(v => typeof v === "function" && v.name === "PineTS");
    return _PineTSModule;
  } catch (e) { console.warn("PineTS load failed:", e); return null; }
}

// ── OVERLAY DETECTION ─────────────────────────────────────────────────────────
export function detectPineOverlay(script) {
  const m = /indicator\s*\([^)]*\boverlay\s*=\s*(true|false)/i.exec(script);
  if (m) return m[1].toLowerCase() === "true";
  const sm = /\bstudy\s*\(([^)]*)\)/.exec(script);
  if (sm) {
    const inner = sm[1];
    if (/\boverlay\s*=\s*true/i.test(inner)) return true;
    if (/\boverlay\s*=\s*false/i.test(inner)) return false;
    const args = inner.split(',').map(a => a.trim());
    if (args.length >= 3) return args[2] === "true";
    return false;
  }
  return false;
}

// Restore custom script overlay flag on startup
if (_pineCustomScript) {
  const _customDef = PINE_SCRIPTS.find(s => s.id === "custom");
  if (_customDef) _customDef.overlay = detectPineOverlay(_pineCustomScript);
}

// ── TOGGLE INDICATOR ──────────────────────────────────────────────────────────
export function togglePineIndicator(id, active) {
  const def = PINE_SCRIPTS.find(s => s.id === id); if (!def) return;
  if (!def.overlay && active) {
    PINE_SCRIPTS.filter(s => !s.overlay && s.id !== id && pineActive[s.id]).forEach(s => {
      pineActive[s.id] = false;
      const cb = document.getElementById("pine-cb-" + s.id); if (cb) cb.checked = false;
      App.panels.forEach(p => { const l = document.getElementById("utility-pine-lbl-" + p.idx); if (l) l.style.display = "none"; });
    });
    if (id === "custom" && !_pineCustomScript) {
      openPineEditor(); active = false; pineActive[id] = false;
      const cb = document.getElementById("pine-cb-custom"); if (cb) cb.checked = false;
      savePineActive(); return;
    }
  }
  pineActive[id] = active; savePineActive();
  if (def.overlay) {
    App.panels.forEach(p => {
      if (!p.mainChart || !p.candleData) return;
      if (active) applyPineOverlayToPanel(p, def);
      else { p.mainChart.data.datasets = p.mainChart.data.datasets.filter(d => d._pineId !== id); p.mainChart.update("none"); }
    });
  } else {
    App.panels.forEach(p => {
      const l = document.getElementById("utility-pine-lbl-" + p.idx); if (!l) return;
      if (active) { l.textContent = def.name; l.style.display = ""; } else l.style.display = "none";
    });
    App.panels.forEach(p => {
      const candles = p.tf === "1s" ? p.liveCandles.slice(-p.chartZoom) : p.candleData?._liveCandles;
      if (candles) drawUtility(p, candles);
    });
  }
}

// ── OVERLAY APPLICATION ───────────────────────────────────────────────────────
export async function applyPineOverlayToPanel(p, def) {
  if (!p.mainChart) return;
  if (def.id === "file_dynamicswinganchoredvwap") { p.mainChart.update("none"); return; }
  const is1s = p.tf === "1s";
  const visCandles = is1s ? p.liveCandles.slice(-p.chartZoom) : p.candleData?._liveCandles;
  if (!visCandles || !visCandles.length) return;
  const allCandles = is1s ? p.liveCandles : (p.candleData?.candles || visCandles);
  const computeLen = allCandles.length;
  const lastT = visCandles[visCandles.length - 1]?.t || 0;
  const cacheKey = `${computeLen}:${lastT}`;
  const cached = p._pineOverlayCache[def.id];
  if (cached && cached.key === cacheKey && cached.zoom === p.chartZoom) {
    p.mainChart.data.datasets = p.mainChart.data.datasets.filter(d => d._pineId !== def.id);
    cached.sets.forEach(d => p.mainChart.data.datasets.push(Object.assign({}, d, { data: [...d.data] })));
    p.mainChart.update("none");
    return;
  }
  const gen = p._gen;
  const PineTS = await loadPineTS();
  if (!PineTS || p._gen !== gen || !p.mainChart) return;
  try {
    const pineCandles = allCandles.map(c => ({ open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v || 0, openTime: c.t }));
    const { plots } = await new PineTS(pineCandles).run(def.script);
    if (p._gen !== gen || !p.mainChart) return;
    p.mainChart.data.datasets = p.mainChart.data.datasets.filter(d => d._pineId !== def.id);
    const palette = OVLY_COLORS[def.id] || OVLY_COLORS[def.id.toLowerCase()] || ["#f0c040", "#f09030", "#f0c040"];
    const visible = visCandles.length;
    const opacity = p.widgetSettings?.pineOpacity ?? 1;
    const newSets = [];
    Object.entries(plots).filter(([, pl]) => pl?.data?.length).forEach(([name, pl], i) => {
      const pineColor = pl.data.slice().reverse().find(pt => pt?.options?.color)?.options?.color;
      const seriesColor = pineColor || palette[i % palette.length];
      const visData = pl.data.slice(-visible);
      const nullFrac = visData.filter(pt => pt == null || pt.value == null).length / Math.max(visData.length, 1);
      const isSparse = nullFrac > 0.8;
      // Cache stores raw colors; chart dataset uses opacity-adjusted colors
      const rawDs = {
        _pineId: def.id, label: name,
        data: visData.map((pt, j) => ({ x: j, y: pt?.value ?? null })),
        borderColor: seriesColor, borderWidth: isSparse ? 0 : 1.5,
        pointRadius: isSparse ? 4 : 0, pointBackgroundColor: seriesColor,
        tension: 0.2, showLine: !isSparse, spanGaps: false,
        borderDash: i > 0 && def.id === "bb" ? [3, 3] : []
      };
      newSets.push(rawDs);
      const chartDs = opacity < 1 ? {
        ...rawDs, data: [...rawDs.data],
        borderColor: _pineColorAlpha(seriesColor, opacity),
        pointBackgroundColor: _pineColorAlpha(seriesColor, opacity),
      } : { ...rawDs, data: [...rawDs.data] };
      p.mainChart.data.datasets.push(chartDs);
    });
    p._pineOverlayCache[def.id] = { key: cacheKey, zoom: p.chartZoom, sets: newSets.map(d => Object.assign({}, d, { data: [...d.data] })) };
    p.mainChart.update("none");
  } catch (e) { console.warn("Pine overlay", def.id, ":", e.message || e); }
}

export async function applyActivePineOverlays(p) {
  const active = PINE_SCRIPTS.filter(s => s.overlay && pineActive[s.id]);
  for (const def of active) await applyPineOverlayToPanel(p, def);
}

// ── FILE SCRIPTS ──────────────────────────────────────────────────────────────
export async function loadPineFileScripts() {
  try {
    const r = await fetch("/api/pine/scripts");
    const scripts = await r.json();
    if (!Array.isArray(scripts) || !scripts.length) return;
    scripts.forEach(s => {
      s.overlay = detectPineOverlay(s.script);
      const existing = PINE_SCRIPTS.findIndex(p => p.id === s.id);
      if (existing >= 0) PINE_SCRIPTS[existing] = s; else PINE_SCRIPTS.push(s);
    });
  } catch (e) { console.warn("Pine file scripts:", e); }
}

// ── PINE EDITOR ───────────────────────────────────────────────────────────────
function _updatePineTypeBadge() {
  const ta = document.getElementById("pine-editor-ta");
  const badge = document.getElementById("pine-type-badge");
  if (!ta || !badge || !ta.value.trim()) { if (badge) badge.textContent = ""; return; }
  const isOverlay = detectPineOverlay(ta.value);
  badge.textContent = isOverlay ? "▸ CHART OVERLAY" : "▸ UTILITY OSCILLATOR";
  badge.style.color = isOverlay ? "var(--blue)" : "var(--amber)";
}

export function openPineEditor(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const ta = document.getElementById("pine-editor-ta");
  if (ta && _pineCustomScript) ta.value = _pineCustomScript;
  document.getElementById("pine-err").textContent = "";
  _updatePineTypeBadge();
  if (ta && !ta._pineBadgeWired) { ta._pineBadgeWired = true; ta.addEventListener("input", _updatePineTypeBadge); }
  document.getElementById("pine-modal").classList.remove("hidden");
  setTimeout(() => ta && ta.focus(), 50);
}

export function closePineEditor() { document.getElementById("pine-modal").classList.add("hidden"); }

export function runCustomPine() {
  const ta = document.getElementById("pine-editor-ta");
  if (!ta || !ta.value.trim()) { document.getElementById("pine-err").textContent = "Empty script."; return; }
  _pineCustomScript = ta.value;
  localStorage.setItem("td_pine_custom", _pineCustomScript);
  const isOverlay = detectPineOverlay(_pineCustomScript);
  const customDef = PINE_SCRIPTS.find(s => s.id === "custom");
  customDef.overlay = isOverlay;
  pineActive["custom"] = true; savePineActive();
  const cb = document.getElementById("pine-cb-custom"); if (cb) cb.checked = true;
  closePineEditor();
  if (isOverlay) {
    App.panels.forEach(p => { if (p.mainChart && (p.candleData || p.tf === "1s")) applyPineOverlayToPanel(p, customDef); });
  } else {
    PINE_SCRIPTS.filter(s => !s.overlay && s.id !== "custom" && pineActive[s.id]).forEach(s => {
      pineActive[s.id] = false;
      const scb = document.getElementById("pine-cb-" + s.id); if (scb) scb.checked = false;
    });
    App.panels.forEach(p => {
      const l = document.getElementById("utility-pine-lbl-" + p.idx);
      if (l) { l.textContent = "CUSTOM"; l.style.display = ""; }
      const candles = p.tf === "1s" ? p.liveCandles.slice(-p.chartZoom) : p.candleData?._liveCandles;
      if (candles) drawUtility(p, candles);
    });
  }
}

// Expose for inline HTML handlers
window.togglePineIndicator = togglePineIndicator;
window.openPineEditor = openPineEditor;
window.closePineEditor = closePineEditor;
window.runCustomPine = runCustomPine;
