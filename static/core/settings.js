import { App, syncState } from './state.js';
import { startPriceFeed, applyUtilityHeight } from '../widgets/MainChart/chart.js';
import { drawUtility } from '../widgets/UtilityPanel/utility.js';

let _settSaveTimer = null;

export function openSettings() {
  _syncSettingsUI();
  document.getElementById("settings-popup").classList.remove("hidden");
}

export function closeSettings() {
  document.getElementById("settings-popup").classList.add("hidden");
}

export function switchStab(tab) {
  document.querySelectorAll(".sett-tab").forEach(b => b.classList.toggle("active", b.id === "stab-" + tab));
  document.getElementById("stab-body-chart").classList.toggle("hidden", tab !== "chart");
  document.getElementById("stab-body-indicators").classList.toggle("hidden", tab !== "indicators");
}

function _syncSettingsUI() {
  const ms = App.updateIntervalMs;
  document.querySelectorAll("#sett-interval-presets .sett-preset").forEach(b => b.classList.toggle("active", parseInt(b.dataset.ms) === ms));
  const zoom = App.state.chart_zoom || 150;
  document.getElementById("sett-zoom-slider").value = zoom;
  document.getElementById("sett-zoom-val").textContent = zoom;
  const tf = App.state.default_tf || "30m";
  document.querySelectorAll("#sett-tf-presets .sett-preset").forEach(b => b.classList.toggle("active", b.dataset.tf === tf));
  const rsi = App.state.rsi_period || 14;
  document.getElementById("sett-rsi-slider").value = rsi;
  document.getElementById("sett-rsi-val").textContent = rsi;
  const h = App.state.utility_height || 90;
  document.getElementById("sett-height-slider").value = h;
  document.getElementById("sett-height-val").textContent = h + "px";
}

function _flashSaved() {
  const el = document.getElementById("sett-saved");
  el.classList.add("show");
  clearTimeout(window._settFlash);
  window._settFlash = setTimeout(() => el.classList.remove("show"), 1500);
}

function _schedSave() {
  clearTimeout(_settSaveTimer);
  _settSaveTimer = setTimeout(async () => { await syncState(); _flashSaved(); }, 400);
}

export function setUpdateInterval(ms) {
  App.updateIntervalMs = ms; App.state.update_interval = ms;
  App.priceFeedMs = 0; startPriceFeed();
  document.querySelectorAll("#sett-interval-presets .sett-preset").forEach(b => b.classList.toggle("active", parseInt(b.dataset.ms) === ms));
  _schedSave();
}

export function onZoomSlider(v) {
  const n = parseInt(v); App.state.chart_zoom = n;
  document.getElementById("sett-zoom-val").textContent = n;
  _schedSave();
}

export function setDefaultTF(tf) {
  App.state.default_tf = tf;
  document.querySelectorAll("#sett-tf-presets .sett-preset").forEach(b => b.classList.toggle("active", b.dataset.tf === tf));
  _schedSave();
}

export function onRSISlider(v) {
  const n = parseInt(v); App.state.rsi_period = n;
  document.getElementById("sett-rsi-val").textContent = n;
  App.panels.forEach(p => {
    p.rsiPeriod = n;
    if (p.candleData && p.utilityMode === "rsi") drawUtility(p, p.candleData._liveCandles || []);
    else if (p.tf === "1s" && p.liveCandles.length && p.utilityMode === "rsi") drawUtility(p, p.liveCandles.slice(-p.chartZoom));
  });
  _schedSave();
}

export function onHeightSlider(v) {
  const n = parseInt(v); App.state.utility_height = n;
  document.getElementById("sett-height-val").textContent = n + "px";
  applyUtilityHeight(n);
  _schedSave();
}

// Expose for inline HTML handlers
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.switchStab = switchStab;
window.setUpdateInterval = setUpdateInterval;
window.onZoomSlider = onZoomSlider;
window.setDefaultTF = setDefaultTF;
window.onRSISlider = onRSISlider;
window.onHeightSlider = onHeightSlider;
