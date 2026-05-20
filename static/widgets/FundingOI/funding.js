import { App, API } from '../../core/state.js';
import { fmt } from '../../core/utils.js';

let _timer      = null;
let _countdown  = null;
let _lastData   = null;

// ── INIT ──────────────────────────────────────────────────────────────────────
export function initFunding() {
  _fetchForActive();
  _timer     = setInterval(_fetchForActive, 30000);
  _countdown = setInterval(_tick, 1000);
  const infoBtn = document.getElementById("fund-info-btn");
  const infoPopup = document.getElementById("fund-info-popup");
  if (infoBtn && infoPopup) {
    infoBtn.addEventListener("mouseenter", () => infoPopup.classList.remove("hidden"));
    infoBtn.addEventListener("mouseleave", () => infoPopup.classList.add("hidden"));
    infoPopup.addEventListener("mouseenter", () => infoPopup.classList.remove("hidden"));
    infoPopup.addEventListener("mouseleave", () => infoPopup.classList.add("hidden"));
  }
}

// ── PUBLIC FETCH (called by setActivePanel on ticker switch) ──────────────────
export async function fetchFunding(ticker) {
  try {
    const r = await fetch(API + `/api/funding/${ticker}`);
    if (!r.ok) { console.warn("[funding] HTTP", r.status, "for", ticker); _setNoData(ticker); return; }
    const d = await r.json();
    if (d.error) { console.warn("[funding] error:", d.error); _setNoData(ticker); return; }
    console.log("[funding] ok:", d.symbol, d.last_funding_rate);
    _lastData = d;
    _updateUI(d);
  } catch (e) { console.error("[funding] exception:", e); _setNoData(ticker); }
}

function _fetchForActive() {
  const t = App.panels[App.activeIdx]?.ticker;
  if (t) fetchFunding(t);
}

// ── UI UPDATE ─────────────────────────────────────────────────────────────────
function _updateUI(d) {
  const rate = d.last_funding_rate;  // already %, e.g. 0.0100 = 0.01%
  const rColor = rate > 0.005 ? "var(--amber)"
               : rate < -0.005 ? "#5598e0"
               : "var(--text2)";
  const sign = rate >= 0 ? "+" : "";
  const lbl  = rate > 0.005  ? "LONGS PAYING"
             : rate < -0.005 ? "SHORTS PAYING"
             : "NEUTRAL";

  const oiUsd = d.oi_usd || 0;
  const oiFmt = oiUsd >= 1e9 ? (oiUsd / 1e9).toFixed(2) + "B"
              : oiUsd >= 1e6 ? (oiUsd / 1e6).toFixed(1) + "M"
              : oiUsd >= 1e3 ? (oiUsd / 1e3).toFixed(0) + "K"
              : oiUsd.toFixed(0);

  const s = (id, txt, col) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = txt;
    if (col !== undefined) el.style.color = col;
  };

  s("fund-sym",       d.symbol || "");
  s("fund-rate-val",  sign + rate.toFixed(4) + "%", rColor);
  s("fund-rate-lbl",  lbl,                          rColor);
  s("fund-mark-val",  fmt(d.mark_price));
  s("fund-oi-val",    "$" + oiFmt);
  const levRow = document.getElementById("fund-lev-row");
  if (d.max_leverage && levRow) {
    levRow.style.display = "";
    s("fund-lev-val", d.max_leverage + "×");
  }

  _tick();
  _drawSparkline(d.history || []);
}

// ── COUNTDOWN ─────────────────────────────────────────────────────────────────
function _tick() {
  const el = document.getElementById("fund-next-val");
  if (!el) return;
  if (!_lastData) { el.textContent = "—"; return; }
  const ms = _lastData.next_funding_ts - Date.now();
  if (ms <= 0) { el.textContent = "NOW"; return; }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  el.textContent = h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── SPARKLINE ─────────────────────────────────────────────────────────────────
function _drawSparkline(history) {
  const canvas = document.getElementById("fund-sparkline");
  if (!canvas || !history.length) return;
  const W = canvas.offsetWidth || 190, H = 32;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const rates  = history.map(h => h.rate);
  const maxAbs = Math.max(...rates.map(r => Math.abs(r)), 0.001);
  const midY   = H / 2;

  // zero line
  ctx.strokeStyle = "#2a334088"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();

  const step = W / rates.length;
  const bW   = Math.max(3, step - 2);
  rates.forEach((r, i) => {
    const x = i * step + (step - bW) / 2;
    const h = Math.abs(r) / maxAbs * (midY - 3);
    ctx.fillStyle = r >= 0 ? "#f5a62399" : "#5598e099";
    ctx.fillRect(x, r >= 0 ? midY - h : midY, bW, h || 1);
  });
}

// ── NO DATA ───────────────────────────────────────────────────────────────────
function _setNoData(ticker) {
  _lastData = null;
  const s = (id, txt, col) => {
    const el = document.getElementById(id); if (!el) return;
    el.textContent = txt;
    if (col !== undefined) el.style.color = col;
  };
  s("fund-sym",      ticker || "");
  s("fund-rate-val", "—",        "var(--text3)");
  s("fund-rate-lbl", "NO FUTURES DATA", "var(--text3)");
  s("fund-mark-val", "—");
  s("fund-oi-val",   "—");
  s("fund-next-val", "—");
  const levRow = document.getElementById("fund-lev-row");
  if (levRow) levRow.style.display = "none";
  const canvas = document.getElementById("fund-sparkline");
  if (canvas) { const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}
