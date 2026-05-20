import { App, indicators, saveIndicators, API } from '../../core/state.js';
import { fmt } from '../../core/utils.js';
import { drawMainChart, registerProphetRefresh } from '../MainChart/chart.js';
import { drawUtility } from '../UtilityPanel/utility.js';

// ── STATE ─────────────────────────────────────────────────────────────────────
let _prophetCache = null;   // { ticker, data } — invalidated on ticker change
let _prophetLoading = false;
let _arimaPopupEl = null;
let _prophetPopupEl = null;
let _heuristicPopupEl = null;

// ── POPUP HELPERS ─────────────────────────────────────────────────────────────
function _getOrCreatePopup(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id; el.className = "pred-popup";
    document.body.appendChild(el);
  }
  return el;
}

function _positionPopup(popup, wrapEl) {
  const rect = wrapEl.getBoundingClientRect();
  const pad = 8;
  let left = rect.left - popup.offsetWidth - pad;
  if (left < pad) left = rect.right + pad;
  let top = rect.top;
  if (top + popup.offsetHeight > window.innerHeight - pad)
    top = window.innerHeight - popup.offsetHeight - pad;
  popup.style.left = left + "px";
  popup.style.top  = top + "px";
}

function _showPopup(popup, wrapEl, html) {
  popup.innerHTML = html;
  popup.style.display = "block";
  _positionPopup(popup, wrapEl);
}

function _hidePopup(popup) {
  popup.style.display = "none";
}

// ── ARIMA BUTTON SYNC ─────────────────────────────────────────────────────────
function _syncARIMAButton() {
  const btn = document.getElementById("pred-arima-btn");
  const lbl = document.getElementById("pred-arima-label");
  if (!btn || !lbl) return;
  const on = !!indicators.arima;
  btn.classList.toggle("active", on);
  lbl.textContent = on ? "LIVE" : "OFFLINE";
}

// ── PROPHET BUTTON SYNC ───────────────────────────────────────────────────────
function _syncProphetButton(loading = false) {
  const btn = document.getElementById("pred-prophet-btn");
  const lbl = document.getElementById("pred-prophet-label");
  if (!btn || !lbl) return;
  const on = _prophetCache !== null && !loading;
  btn.classList.toggle("active", on && !loading);
  btn.classList.toggle("pred-loading", loading);
  lbl.textContent = loading ? "COMPUTING..." : on ? "LIVE" : "OFFLINE";
}

// ── ARIMA CONTENT ─────────────────────────────────────────────────────────────
function _buildARIMAContent() {
  const p = App.panels[App.activeIdx];
  if (!p || !p.forecastData || !p.forecastData.length)
    return '<div class="pred-popup-note">NO FORECAST DATA</div>';
  const fc = p.forecastData;
  const last = p.candleData?._liveCandles?.slice(-1)[0]?.c || null;
  const first = fc[0], final = fc[fc.length - 1];
  const delta = last ? ((final.c - last) / last * 100) : null;
  const dir = delta !== null ? (delta >= 0 ? "up" : "dn") : "";
  const model = "ARIMA(2,1,2)";
  let html = `<div class="pred-popup-title">ARIMA FORECAST · ${p.ticker} · ${p.tf.toUpperCase()}</div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">MODEL</span><span class="pred-popup-val">${model}</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">STEPS</span><span class="pred-popup-val">${fc.length}</span></div>`;
  if (last) html += `<div class="pred-popup-row"><span class="pred-popup-key">NOW</span><span class="pred-popup-val">${fmt(last)}</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">TARGET</span><span class="pred-popup-val pred-popup-${dir}">${fmt(final.c)}</span></div>`;
  if (delta !== null) html += `<div class="pred-popup-row"><span class="pred-popup-key">CHANGE</span><span class="pred-popup-val pred-popup-${dir}">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">CI LO</span><span class="pred-popup-val pred-popup-dn">${fmt(final.ci_lo)}</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">CI HI</span><span class="pred-popup-val pred-popup-up">${fmt(final.ci_hi)}</span></div>`;
  return html;
}

// ── PROPHET CONTENT ───────────────────────────────────────────────────────────
function _buildProphetContent() {
  if (!_prophetCache) return '<div class="pred-popup-note">NO DATA</div>';
  const { ticker, last_close, bias_score, bias_label, signals, forecast_biased, forecast } = _prophetCache;
  const fc = forecast_biased || forecast;
  if (!fc || !fc.length) return '<div class="pred-popup-note">NO FORECAST</div>';
  const final = fc[fc.length - 1];
  const delta = last_close ? ((final.yhat - last_close) / last_close * 100) : null;
  const dir   = delta !== null ? (delta >= 0 ? "up" : "dn") : "";
  const bs    = bias_score ?? 0;
  const bColor = bs > 0.1 ? "var(--green)" : bs < -0.1 ? "var(--red)" : "var(--text3)";

  let html = `<div class="pred-popup-title">HEURISTIC PROPHET · ${ticker} · 14D</div>`;

  // Bias header
  html += `<div class="pred-popup-row" style="background:var(--bg3)">
    <span class="pred-popup-key">BIAS</span>
    <span class="pred-popup-val" style="color:${bColor};font-weight:bold">${bias_label ?? "—"} <span style="opacity:.6">(${bs >= 0 ? "+" : ""}${(bs * 100).toFixed(0)}%)</span></span>
  </div>`;

  // Summary
  html += `<div class="pred-popup-row"><span class="pred-popup-key">NOW</span><span class="pred-popup-val">${fmt(last_close)}</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">TARGET</span><span class="pred-popup-val pred-popup-${dir}">${fmt(final.yhat)}</span></div>`;
  if (delta !== null) html += `<div class="pred-popup-row"><span class="pred-popup-key">CHANGE</span><span class="pred-popup-val pred-popup-${dir}">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%</span></div>`;
  html += `<div class="pred-popup-row"><span class="pred-popup-key">RANGE</span><span class="pred-popup-val"><span class="pred-popup-dn">${fmt(final.yhat_lower)}</span> – <span class="pred-popup-up">${fmt(final.yhat_upper)}</span></span></div>`;

  // Signal breakdown
  if (signals && Object.keys(signals).length) {
    html += `<div class="pred-popup-title" style="border-top:1px solid var(--border)">SIGNALS</div>`;
    Object.entries(signals).forEach(([name, sig]) => {
      const sb = sig.bias ?? 0;
      const sc = sb > 0.05 ? "var(--green)" : sb < -0.05 ? "var(--red)" : "var(--text3)";
      const bPct = (sb >= 0 ? "+" : "") + (sb * 100).toFixed(0) + "%";
      html += `<div class="pred-popup-row">
        <span class="pred-popup-key" style="min-width:72px">${name}</span>
        <span class="pred-popup-val" style="color:${sc};font-size:8px;flex:1">${sig.label}</span>
        <span style="font-size:7px;color:${sc};opacity:.7;flex-shrink:0;padding-left:4px">${bPct}</span>
      </div>`;
    });
  }

  // 14-day table
  html += `<div class="pred-popup-title" style="border-top:1px solid var(--border)">14-DAY OUTLOOK</div>`;
  fc.forEach((r, i) => {
    const d = r.date ? r.date.slice(5) : `+${i + 1}`;
    const dayDir = r.yhat >= last_close ? "up" : "dn";
    html += `<div class="pred-popup-row"><span class="pred-popup-key">${d}</span><span class="pred-popup-val pred-popup-${dayDir}">${fmt(r.yhat)}</span></div>`;
  });

  return html;
}

// ── HOVER WIRING ──────────────────────────────────────────────────────────────
function _wireHover(wrapId, getPopupEl, isActive, buildContent) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  wrap.addEventListener("mouseenter", () => {
    if (!isActive()) return;
    const popup = getPopupEl();
    _showPopup(popup, wrap, buildContent());
  });
  wrap.addEventListener("mouseleave", () => {
    const popup = getPopupEl();
    _hidePopup(popup);
  });
}

// ── APPLY PROPHET TO PANELS ───────────────────────────────────────────────────
function _applyProphetToPanels(dataByTF) {
  // dataByTF: { "1h": {...}, "30m": {...} } — or null to clear all
  App.panels.forEach(p => {
    p.prophetData = dataByTF ? (dataByTF[p.tf] || null) : null;
    if (p.prophetData) { p._xOffset = 0; p._panLocked = false; p._yMin = null; p._yMax = null; }
    if (p.candleData) drawMainChart(p, p.candleData);
    if (p.candleData) drawUtility(p, p.candleData._liveCandles);
  });
}

// ── TF-SWITCH REFRESH (called by chart.js via registerProphetRefresh) ─────────
async function _onPanelTFChange(p, gen) {
  if (!_prophetCache || p.tf === "1m") { p.prophetData = null; return; }
  try {
    const r = await fetch(API + `/api/prophet/${p.ticker}?interval=${p.tf}`);
    if (!r.ok || p._gen !== gen) return;
    const d = await r.json();
    if (d.error || p._gen !== gen) return;
    p.prophetData = d;
    p._yMin = null; p._yMax = null;
    if (p.candleData) { drawMainChart(p, p.candleData); drawUtility(p, p.candleData._liveCandles); }
  } catch (e) {}
}

// ── PUBLIC TOGGLES ────────────────────────────────────────────────────────────
export function togglePredARIMA() {
  const next = !indicators.arima;
  window.setIndicator("arima", next);
  _syncARIMAButton();
}

export async function togglePredProphet() {
  const activeP = App.panels[App.activeIdx];
  if (!activeP) return;
  const ticker = activeP.ticker;

  // Toggle off if already live
  if (_prophetCache && _prophetCache.ticker === ticker) {
    _prophetCache = null;
    _applyProphetToPanels(null);
    _syncProphetButton();
    return;
  }

  if (_prophetLoading) return;
  _prophetLoading = true;
  _prophetCache = null;
  _syncProphetButton(true);

  // Fetch fresh (nocache=1) for every unique TF across all open panels in parallel
  // 1m excluded — ETS flatlines at 1-minute resolution
  const tfs = [...new Set(App.panels.map(p => p.tf).filter(tf => tf !== "1m"))];
  const byTF = {};
  await Promise.all(tfs.map(async (tf) => {
    try {
      const r = await fetch(API + `/api/prophet/${ticker}?interval=${tf}&nocache=1`);
      if (!r.ok) return;
      const d = await r.json();
      if (!d.error) byTF[tf] = d;
    } catch (e) {}
  }));

  if (Object.keys(byTF).length) {
    _prophetCache = byTF[activeP.tf] || Object.values(byTF)[0];
    _applyProphetToPanels(byTF);
  } else {
    _prophetCache = null;
  }

  _prophetLoading = false;
  _syncProphetButton(false);
}

// ── HEURISTIC TOGGLES ─────────────────────────────────────────────────────────
export function toggleArimaHeuristic(val) {
  indicators.arimaHeuristic = val;
  saveIndicators();
  App.panels.forEach(p => {
    if (!p.forecastAll) return;
    p.forecastData = (val && p.forecastAll.forecast_biased?.length)
      ? p.forecastAll.forecast_biased : p.forecastAll.forecast;
    if (p.mainChart) p.mainChart.update("none");
  });
}

export function toggleProphetHeuristic(val) {
  indicators.prophetHeuristic = val;
  saveIndicators();
  App.panels.forEach(p => { if (p.mainChart && p.prophetData) p.mainChart.update("none"); });
}

// ── INIT ──────────────────────────────────────────────────────────────────────
export function initPredictions() {
  registerProphetRefresh(_onPanelTFChange);
  _syncARIMAButton();
  _syncProphetButton(false);

  _arimaPopupEl  = _getOrCreatePopup("pred-arima-popup-el");
  _prophetPopupEl = _getOrCreatePopup("pred-prophet-popup-el");

  _wireHover(
    "pred-arima-wrap",
    () => _arimaPopupEl,
    () => !!indicators.arima,
    _buildARIMAContent
  );
  _wireHover(
    "pred-prophet-wrap",
    () => _prophetPopupEl,
    () => _prophetCache !== null,
    _buildProphetContent
  );

  // Gear icon → body-appended popup
  const gearBtn = document.getElementById("pred-gear-btn");
  if (gearBtn) {
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_heuristicPopupEl && _heuristicPopupEl.style.display !== "none") {
        _closeHeuristicPopup();
      } else {
        _openHeuristicPopup(gearBtn);
      }
    });
  }
}

// ── HEURISTIC POPUP ───────────────────────────────────────────────────────────
function _bsFmt(bs) {
  return bs !== null && bs !== undefined
    ? " (" + (bs >= 0 ? "+" : "") + (bs * 100).toFixed(0) + "%)"
    : "";
}

function _openHeuristicPopup(gearBtn) {
  if (!_heuristicPopupEl) {
    _heuristicPopupEl = document.createElement("div");
    _heuristicPopupEl.id = "pred-heuristic-popup";
    _heuristicPopupEl.className = "pred-popup";
    _heuristicPopupEl.style.pointerEvents = "all";
    _heuristicPopupEl.style.width = "200px";
    document.body.appendChild(_heuristicPopupEl);
  }

  const p = App.panels[App.activeIdx];
  const aLabel = p?.forecastAll?.bias_label ?? "—";
  const aScore = p?.forecastAll?.bias_score ?? null;
  const prLabel = _prophetCache?.bias_label ?? "—";
  const prScore = _prophetCache?.bias_score ?? null;
  const aColor  = aScore > 0.05 ? "var(--green)" : aScore < -0.05 ? "var(--red)" : "var(--text3)";
  const pColor  = prScore > 0.05 ? "var(--green)" : prScore < -0.05 ? "var(--red)" : "var(--text3)";

  _heuristicPopupEl.innerHTML =
    `<div class="pred-popup-title">HEURISTIC BIAS</div>` +
    `<div class="pred-popup-row" style="gap:4px">` +
      `<span class="pred-popup-key">ARIMA</span>` +
      `<label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-left:auto">` +
        `<input type="checkbox" id="arima-heuristic-cb" style="cursor:pointer;accent-color:var(--green)">` +
        `<span style="font-size:8px;color:${aColor}">${aLabel}${_bsFmt(aScore)}</span>` +
      `</label>` +
    `</div>` +
    `<div class="pred-popup-row" style="gap:4px">` +
      `<span class="pred-popup-key">PROPHET</span>` +
      `<label style="display:flex;align-items:center;gap:5px;cursor:pointer;margin-left:auto">` +
        `<input type="checkbox" id="prophet-heuristic-cb" style="cursor:pointer;accent-color:var(--green)">` +
        `<span style="font-size:8px;color:${pColor}">${prLabel}${_bsFmt(prScore)}</span>` +
      `</label>` +
    `</div>` +
    `<div class="pred-popup-note" style="font-size:7px;opacity:.6">Bias shifts forecast trajectory</div>`;

  const arimaC = _heuristicPopupEl.querySelector("#arima-heuristic-cb");
  const propC  = _heuristicPopupEl.querySelector("#prophet-heuristic-cb");
  if (arimaC) {
    arimaC.checked = indicators.arimaHeuristic !== false;
    arimaC.addEventListener("change", () => toggleArimaHeuristic(arimaC.checked));
  }
  if (propC) {
    propC.checked = indicators.prophetHeuristic !== false;
    propC.addEventListener("change", () => toggleProphetHeuristic(propC.checked));
  }

  _heuristicPopupEl.style.display = "block";
  _positionPopup(_heuristicPopupEl, gearBtn);
  setTimeout(() => document.addEventListener("click", _heuristicDocClick), 0);
}

function _closeHeuristicPopup() {
  if (_heuristicPopupEl) _heuristicPopupEl.style.display = "none";
  document.removeEventListener("click", _heuristicDocClick);
}

function _heuristicDocClick(e) {
  if (_heuristicPopupEl && _heuristicPopupEl.contains(e.target)) {
    // clicked inside — keep open
    return;
  }
  _closeHeuristicPopup();
}

// Expose for inline HTML handlers
window.togglePredARIMA       = togglePredARIMA;
window.togglePredProphet     = togglePredProphet;
window.toggleArimaHeuristic  = toggleArimaHeuristic;
window.toggleProphetHeuristic = toggleProphetHeuristic;
