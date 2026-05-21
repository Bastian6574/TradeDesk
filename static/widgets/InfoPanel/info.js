import { App, indicators, saveIndicators, API, getContextTicker, isCrypto, setContextOverride } from '../../core/state.js';
import { N_FC, fmtVol } from '../../core/utils.js';
import { PINE_SCRIPTS, pineActive } from '../MainChart/pine.js';
import { loadForecast } from '../MainChart/chart.js';

// ── NEWS TOOLTIP ──────────────────────────────────────────────────────────────
export function initNewsTooltip() {
  const widget = document.getElementById("rp-news");
  const tooltip = document.getElementById("news-tooltip");
  widget.addEventListener("mouseenter", () => {
    if (!App.newsHeadlines.length) return;
    tooltip.innerHTML = App.newsHeadlines.map(h => {
      const sig = h.signal === "sell" ? "▼SELL" : h.signal === "buy" ? "▲BUY" : "— NEU";
      return `<div class="nt-line"><span class="nt-sig ${h.signal}">${sig}</span><span class="nt-title">${h.title}</span></div>`;
    }).join("");
    tooltip.classList.add("visible");
  });
  widget.addEventListener("mousemove", (e) => {
    const pad = 10; let left = e.clientX - tooltip.offsetWidth - pad;
    if (left < pad) left = e.clientX + pad;
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.min(e.clientY - 10, window.innerHeight - tooltip.offsetHeight - pad) + "px";
  });
  widget.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
}

// ── SOCIAL TOOLTIP ────────────────────────────────────────────────────────────
export function initSocialTooltip() {
  const widget  = document.getElementById("rp-social");
  const tooltip = document.getElementById("social-tooltip");
  widget.addEventListener("mouseenter", () => {
    const d = App._socialData;
    if (!d) return;
    const dir = d.label === "BULLISH" ? "bull" : d.label === "BEARISH" ? "bear" : "";
    let html = "";
    if (d.summary) html += `<div class="st-summary">${d.summary}</div>`;
    const themes = d.themes || [];
    if (themes.length) {
      html += `<div class="st-themes">${themes.map(t => `<span class="rp-theme-tag${dir ? " " + dir : ""}">${t}</span>`).join("")}</div>`;
    }
    const bulls = d.bull_signals || [], bears = d.bear_signals || [];
    if (bulls.length) html += `<div class="st-sigs bull">${bulls.map(s => `<div>▲ ${s}</div>`).join("")}</div>`;
    if (bears.length) html += `<div class="st-sigs bear">${bears.map(s => `<div>▼ ${s}</div>`).join("")}</div>`;
    if (!html) return;
    tooltip.innerHTML = html;
    tooltip.classList.add("visible");
  });
  widget.addEventListener("mousemove", (e) => {
    const pad = 10;
    let left = e.clientX - tooltip.offsetWidth - pad;
    if (left < pad) left = e.clientX + pad;
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.min(e.clientY - 10, window.innerHeight - tooltip.offsetHeight - pad) + "px";
  });
  widget.addEventListener("mouseleave", () => tooltip.classList.remove("visible"));
}

// ── CONTEXT ROW ───────────────────────────────────────────────────────────────
export function updateRpContextRow(ticker) {
  const t = ticker ?? getContextTicker();
  const el = document.getElementById("rp-ctx-ticker");
  if (el) el.textContent = t;
}

// ── SENTIMENT ─────────────────────────────────────────────────────────────────
function _sentimentNA(label = "N/A") {
  const na = { label, color: "text3", score: 0, breakdown: {}, last_update: null };
  updateSentimentPanel({
    tech: na,
    fng:  { ...na, value: null, classification: "" },
    news: { ...na, buy_count: 0, sell_count: 0, neutral_count: 0, noise_count: 0, total_count: 0, headlines: [] }
  });
}

export async function fetchSentiment(ticker) {
  const t = ticker || getContextTicker();
  try {
    let r = await fetch(API + `/api/sentiment/${encodeURIComponent(t)}`);
    if (!r.ok) {
      // New endpoint not available yet (server not restarted) — fall back to BTC engine
      r = await fetch(API + `/api/sentiment`);
    }
    if (!r.ok) { _sentimentNA("OFFLINE"); return; }
    const s = await r.json();
    if (s.error) { _sentimentNA("ERROR"); return; }
    updateSentimentPanel(s);
  } catch (e) { _sentimentNA("OFFLINE"); }
}

function colorClass(c) { return c === "green" ? "green" : c === "red" ? "red" : c === "amber" ? "amber" : ""; }

function updateSentimentPanel(s) {
  const upd = (dot, badge, ts, data) => {
    if (!dot) return;
    dot.className = "rp-dot " + colorClass(data.color);
    badge.className = "rp-badge " + colorClass(data.color);
    badge.textContent = data.label;
    ts.textContent = data.last_update ? "@" + data.last_update : "";
  };
  upd(document.getElementById("rp-tech-dot"), document.getElementById("rp-tech-label"), document.getElementById("rp-tech-ts"), s.tech);
  const bd = Object.entries(s.tech.breakdown || {}).map(([tf, v]) => `${tf}:${v >= 0 ? "+" : ""}${v.toFixed(2)}`).join("  ");
  document.getElementById("rp-tech-detail").textContent = `score:${s.tech.score >= 0 ? "+" : ""}${(s.tech.score || 0).toFixed(2)}  ${bd}`;
  upd(document.getElementById("rp-fng-dot"), document.getElementById("rp-fng-label"), document.getElementById("rp-fng-ts"), s.fng);
  document.getElementById("rp-fng-detail").textContent = s.fng.value !== null ? `${s.fng.value}/100 — ${s.fng.classification || ""}` : "scanning...";
  App.newsHeadlines = s.news.headlines || [];
  upd(document.getElementById("rp-news-dot"), document.getElementById("rp-news-label"), document.getElementById("rp-news-ts"), s.news);
  const rel = (s.news.buy_count || 0) + (s.news.sell_count || 0);
  document.getElementById("rp-news-detail").textContent = `▲${s.news.buy_count || 0}/▼${s.news.sell_count || 0}/∅${s.news.noise_count || 0}  ${rel}/${s.news.total_count || 0} relevant`;
}

export function scheduleSentiment() {
  fetchSentiment();
  setInterval(() => fetchSentiment(), 60000);
}

// ── SOCIAL SENTIMENT ──────────────────────────────────────────────────────────
export async function fetchSocial(ticker) {
  const t = ticker || getContextTicker();
  try {
    const r = await fetch(API + `/api/social/${encodeURIComponent(t)}`);
    if (!r.ok) { _socialNA(); return; }
    const d = await r.json();
    if (d.error) { _socialNA(); return; }
    updateSocialPanel(d);
  } catch (_) { _socialNA(); }
}

export function scheduleSocial() {
  fetchSocial();
  setInterval(() => fetchSocial(), 300000); // refresh every 5 min
}

function _socialNA() {
  const dot = document.getElementById("rp-social-dot");
  const lbl = document.getElementById("rp-social-label");
  const det = document.getElementById("rp-social-detail");
  if (dot) dot.className = "rp-dot";
  if (lbl) { lbl.className = "rp-badge"; lbl.textContent = "OFFLINE"; }
  if (det) det.textContent = "unavailable";
}

function updateSocialPanel(d) {
  const dot = document.getElementById("rp-social-dot");
  const lbl = document.getElementById("rp-social-label");
  const ts  = document.getElementById("rp-social-ts");
  const det = document.getElementById("rp-social-detail");
  if (!dot) return;

  const color = d.color === "green" ? "green" : d.color === "red" ? "red" : "amber";
  dot.className = "rp-dot " + color;
  lbl.className = "rp-badge " + color;
  lbl.textContent = d.label || "NEUTRAL";
  if (ts) ts.textContent = d.last_update ? "@" + d.last_update : "";

  const score = d.score ?? 50;
  const bc = d.bull_count ?? 0, br = d.bear_count ?? 0, pc = d.post_count ?? 0;
  if (det) det.textContent = `${score}/100  ▲${bc}/▼${br}  ${pc} posts`;

  App._socialData = d;
}

// ── DETAILS ───────────────────────────────────────────────────────────────────
export async function fetchDetails(ticker) {
  try {
    const t = ticker || getContextTicker();
    const r = await fetch(API + `/api/details/${t}`);
    if (!r.ok) return; const d = await r.json(); if (d.error) return;
    const buyEl = document.getElementById("det-buy-vol");
    const sellEl = document.getElementById("det-sell-vol");
    const avgEl = document.getElementById("det-avg-vol");
    const buyLbl = document.getElementById("det-buy-label");
    const sellLbl = document.getElementById("det-sell-label");
    if (d.is_crypto) {
      buyLbl.textContent = "▲ BUY"; sellLbl.textContent = "▼ SELL";
      buyEl.textContent = fmtVol(d.buy_vol); sellEl.textContent = fmtVol(d.sell_vol);
      buyEl.style.color = "var(--green)"; sellEl.style.color = "var(--red)";
    } else {
      buyLbl.textContent = "TODAY"; sellLbl.textContent = "SPLIT";
      buyEl.textContent = fmtVol(d.total_vol); sellEl.textContent = "N/A";
      buyEl.style.color = "var(--text2)"; sellEl.style.color = "var(--text3)";
    }
    if (avgEl) avgEl.textContent = fmtVol(d.avg_daily_vol);
  } catch (e) {}
}

export function scheduleDetails() {
  fetchDetails();
  setInterval(() => { updateRpContextRow(); fetchDetails(getContextTicker()); }, 5000);
}

// ── INDICATORS UI ─────────────────────────────────────────────────────────────
export function initIndicatorUI() {
  // Restore active pine oscillator label in utility panels
  const activePineOsc = PINE_SCRIPTS.find(s => !s.overlay && pineActive[s.id]);
  if (activePineOsc) {
    App.panels.forEach(p => {
      const l = document.getElementById("utility-pine-lbl-" + p.idx);
      if (l) { l.textContent = activePineOsc.name; l.style.display = ""; }
    });
  }
}

export function setIndicator(key, val) {
  indicators[key] = val; saveIndicators();
  App.panels.forEach(p => applyIndicatorToPanel(p, key, val));
}

function applyIndicatorToPanel(p, key, val) {
  switch (key) {
    case "arima": {
      const n = p.candleData?._liveCandles?.length ?? p.chartZoom;
      const zoom = Math.min(p.chartZoom, n);
      const prophetExtra = p.prophetData ? (p.prophetData.n_fc || 14) : 0;
      if (val) {
        p._xOffset = 0; p._panLocked = false;
        if (p.mainChart) { p.mainChart.options.scales.x.min = n - zoom - 0.3; p.mainChart.options.scales.x.max = n - 0.7 + N_FC + prophetExtra; p.mainChart.update("none"); }
        loadForecast(p);
      } else {
        p.forecastData = []; p.forecastOffset = 0;
        if (p.mainChart) { p.mainChart.options.scales.x.min = n - zoom - 0.3; p.mainChart.options.scales.x.max = n - 0.7 + prophetExtra; p.mainChart.update("none"); }
      }
      break;
    }
    case "volume": if (p.mainChart) p.mainChart.update("none"); break;
  }
}

let _arimaReloading = false;
export async function reloadArima(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  if (_arimaReloading) return;
  _arimaReloading = true;
  document.querySelectorAll("#arima-reload").forEach(el => el.classList.add("spinning"));
  const p = App.panels[App.activeIdx];
  if (p) {
    const period = { "1s": null, "1m": "1d", "5m": "2d", "15m": "5d", "30m": "5d", "1h": "1mo", "1d": "3mo" }[p.tf] || "5d";
    const offset = p.candleData?._liveCandles?.length ?? p.chartZoom;
    try {
      const r = await fetch(API + `/api/forecast/${p.ticker}?interval=${p.tf}&period=${period}&n=20&nocache=1`);
      if (r.ok) {
        const d = await r.json();
        if (!d.error && d.forecast?.length) {
          p.forecastOffset = offset; p.forecastData = d.forecast;
          if (p.mainChart) { p.mainChart.update("none"); }
        }
      }
    } catch (_e) {}
  }
  _arimaReloading = false;
  document.querySelectorAll("#arima-reload").forEach(el => el.classList.remove("spinning"));
}

window.rpRecalc = function() {
  const t = App.panels[App.activeIdx]?.ticker ?? "BTC";
  setContextOverride(t);
  const el = document.getElementById("rp-ctx-ticker");
  if (el) el.textContent = t;
  fetchSentiment(t);
  fetchSocial(t);
  fetchDetails(t);
  import('../FundingOI/funding.js').then(m => m.fetchFunding(t));
  // Restart any Brain panels on this monitor so they scan the recalc'd ticker
  App.panels.forEach(p => {
    if ((p.widgetMode || "candles") === "console" && p.ticker !== t) {
      p.ticker = t;
      import('../Console/console.js').then(c => c.startConsole(p));
    }
  });
  import('../MainChart/chart.js').then(m => m.saveMonitorPreset());
};

// Expose for inline HTML handlers
window.setIndicator = setIndicator;
window.reloadArima = reloadArima;
