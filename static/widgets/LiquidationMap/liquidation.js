import { App } from '../../core/state.js';
import { fmt, toBinanceSymbol, LIVE_MAX } from '../../core/utils.js';

// Bins for the liquidation histogram
const BINS = 120;

// ── START / STOP ──────────────────────────────────────────────────────────────
export function startLiquidationMap(p) {
  _buildLiqDOM(p);
  _initLiqState(p);
  _startLiqStream(p);
  _renderLoop(p);
}

export function stopLiquidationMap(p) {
  if (p._liqWS) { p._liqWS.close(); p._liqWS = null; }
  if (p._liqRaf) { cancelAnimationFrame(p._liqRaf); p._liqRaf = null; }
  if (p._liqTimer) { clearInterval(p._liqTimer); p._liqTimer = null; }
}

// ── DOM ───────────────────────────────────────────────────────────────────────
function _buildLiqDOM(p) {
  const canvasWrap = document.getElementById("canvas-wrap-" + p.idx);
  if (!canvasWrap) return;
  if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
  canvasWrap.style.display = "flex";
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.padding = "0";
  canvasWrap.innerHTML = `
    <div class="liq-header">
      <div class="liq-legend">
        <div class="liq-leg-item"><div class="liq-leg-dot" style="background:#f03e3e"></div>LONG LIQ</div>
        <div class="liq-leg-item"><div class="liq-leg-dot" style="background:#00d47e"></div>SHORT LIQ</div>
      </div>
      <span class="liq-count" id="liq-count-${p.idx}">waiting for data…</span>
    </div>
    <div class="liq-wrap" id="liq-wrap-${p.idx}">
      <canvas class="liq-canvas-main" id="liq-main-${p.idx}"></canvas>
    </div>
  `;

  // Scroll wheel adjusts the rolling window size
  const wrap = document.getElementById("liq-wrap-" + p.idx);
  if (wrap) {
    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 20 : -20;
      p._liqZoom = Math.max(50, Math.min(LIQ_DISPLAY, (p._liqZoom || 150) + delta));
    }, { passive: false });
  }
}

// ── STATE ─────────────────────────────────────────────────────────────────────
function _initLiqState(p) {
  // bins[i] = { price, longVol, shortVol } for BINS evenly spaced price levels
  p._liqBins   = new Array(BINS).fill(null).map(() => ({ longVol: 0, shortVol: 0 }));
  p._liqPriceHistory = []; // { t, price } for mini price line
  p._liqTotalLong  = 0;
  p._liqTotalShort = 0;
  p._liqMinPrice   = null;
  p._liqMaxPrice   = null;
  p._liqCurrentPrice = null;
  p._liqZoom = 150; // rolling window — adjustable via scroll wheel
  // Seed price history from existing candle data (no liquidation color)
  if (p.candleData?._liveCandles) {
    p.candleData._liveCandles.slice(-200).forEach(c => {
      p._liqPriceHistory.push({ t: c.t, price: c.c, color: null });
    });
    const last = p.candleData._liveCandles[p.candleData._liveCandles.length - 1];
    if (last) p._liqCurrentPrice = last.c;
  }
}

// ── BINANCE LIQUIDATION STREAM ────────────────────────────────────────────────
function _startLiqStream(p) {
  const binSym = toBinanceSymbol(p.ticker);
  if (!binSym) { _showLiqOffline(p, "No futures data for " + p.ticker); return; }
  const wsUrl = `wss://fstream.binance.com/ws/${binSym}@forceOrder`;
  const myGen = p._gen;

  function connect() {
    if (p._gen !== myGen) return;
    const ws = new WebSocket(wsUrl);
    p._liqWS = ws;

    ws.onopen = () => {
      if (p._gen !== myGen) { ws.close(); return; }
      const ct = document.getElementById("liq-count-" + p.idx);
      if (ct) ct.textContent = "live — 0 events";
    };

    ws.onmessage = (evt) => {
      if (p._gen !== myGen) return;
      try {
        const d = JSON.parse(evt.data);
        const o = d.o;
        if (!o) return;
        const price = parseFloat(o.p || o.ap);
        const qty   = parseFloat(o.q);
        const usdVal = price * qty;
        const isLong = o.S === "SELL"; // SELL side liquidation = long position got liquidated

        p._liqCurrentPrice = price;
        p._liqPriceHistory.push({ t: o.T, price, color: isLong ? 'long' : 'short' });
        if (p._liqPriceHistory.length > LIVE_MAX) p._liqPriceHistory.shift();

        if (isLong) p._liqTotalLong += usdVal;
        else        p._liqTotalShort += usdVal;

        _addLiqToBin(p, price, usdVal, isLong);

        const total = p._liqTotalLong + p._liqTotalShort;
        const ct = document.getElementById("liq-count-" + p.idx);
        if (ct) ct.textContent = `live — ${_fmtVol(total)} total · ${_fmtVol(p._liqTotalLong)} longs · ${_fmtVol(p._liqTotalShort)} shorts`;
      } catch (e) {}
    };

    ws.onerror = () => { if (p._gen === myGen) setTimeout(connect, 3000); };
    ws.onclose = () => { if (p._gen === myGen) setTimeout(connect, 3000); };
  }
  connect();

  // Also update price history from the main price feed (fallback for price line)
  p._liqTimer = setInterval(() => {
    if (p._gen !== myGen) return;
    const active = App.panels.find(q => q.ticker === p.ticker && q.tf !== "1s" && q.candleData?._liveCandles);
    if (active) {
      const last = active.candleData._liveCandles[active.candleData._liveCandles.length - 1];
      if (last) {
        p._liqCurrentPrice = last.c;
        p._liqPriceHistory.push({ t: Date.now(), price: last.c, color: null });
        if (p._liqPriceHistory.length > LIVE_MAX) p._liqPriceHistory.shift();
      }
    }
  }, 2000);
}

function _addLiqToBin(p, price, usdVal, isLong) {
  if (!p._liqBins) return;
  // Dynamic price range: expand if needed
  if (p._liqMinPrice === null) { p._liqMinPrice = price * 0.97; p._liqMaxPrice = price * 1.03; }
  if (price < p._liqMinPrice) p._liqMinPrice = price * 0.998;
  if (price > p._liqMaxPrice) p._liqMaxPrice = price * 1.002;

  const range = p._liqMaxPrice - p._liqMinPrice;
  if (range <= 0) return;
  const bin = Math.min(BINS - 1, Math.floor(((price - p._liqMinPrice) / range) * BINS));
  if (isLong) p._liqBins[bin].longVol  += usdVal;
  else        p._liqBins[bin].shortVol += usdVal;
}

// ── RENDER LOOP ───────────────────────────────────────────────────────────────
function _renderLoop(p) {
  const myGen = p._gen;
  let lastDraw = 0;
  function frame(now) {
    if (p._gen !== myGen) return;
    p._liqRaf = requestAnimationFrame(frame);
    if (now - lastDraw < 250) return; // ~4 fps is plenty
    lastDraw = now;
    _drawLiqMain(p);
    _drawLiqHist(p);
  }
  p._liqRaf = requestAnimationFrame(frame);
}

const LIQ_DISPLAY = 400; // max rolling window
const RMARGIN    = 62;   // price scale column on the right (ticks + label)

function _drawLiqMain(p) {
  const canvas = document.getElementById("liq-main-" + p.idx);
  const wrap   = document.getElementById("liq-wrap-" + p.idx);
  if (!canvas || !wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W <= 0 || H <= 0) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const cur     = p._liqCurrentPrice;
  const history = p._liqPriceHistory;
  if (!cur || !history.length) { _drawNoData(ctx, W, H, "Waiting for liquidations…"); return; }

  const zoom   = p._liqZoom || 150;
  const disp   = history.slice(-zoom);
  const n      = disp.length;
  const chartW = W - RMARGIN; // line area

  const prices     = disp.map(h => h.price);
  const rawMin     = Math.min(...prices, cur), rawMax = Math.max(...prices, cur);
  const pad        = (rawMax - rawMin) * 0.1 || cur * 0.02;
  const minP       = rawMin - pad, maxP = rawMax + pad;
  const priceRange = maxP - minP;

  const toY = price => H - ((price - minP) / priceRange) * H;
  const toX = idx   => (idx / Math.max(n - 1, 1)) * chartW;

  // Background grid lines (chart area only)
  ctx.strokeStyle = "#1e253022"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(chartW, y); ctx.stroke();
  }

  // Vertical separator between chart area and price scale
  ctx.strokeStyle = "#2a3545"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(chartW, 0); ctx.lineTo(chartW, H); ctx.stroke();

  // Liquidation bins as horizontal bands
  if (p._liqMinPrice !== null) {
    const binRange = p._liqMaxPrice - p._liqMinPrice;
    const maxVol = Math.max(...p._liqBins.map(b => b.longVol + b.shortVol), 1);
    p._liqBins.forEach((bin, i) => {
      const total = bin.longVol + bin.shortVol; if (total === 0) return;
      const binPrice = p._liqMinPrice + (i + 0.5) / BINS * binRange;
      if (binPrice < minP || binPrice > maxP) return;
      const y = toY(binPrice);
      const barH = Math.max(1, (total / maxVol) * 40);
      const longFrac = bin.longVol / total;
      const r = Math.round(240 * (1 - longFrac)), g = Math.round(211 * longFrac);
      ctx.fillStyle = `rgba(${r},${g},62,0.5)`;
      ctx.fillRect(0, y - barH / 2, chartW, barH);
    });
  }

  // Price line — color per segment by direction (green = up tick, red = down tick)
  if (n > 1) {
    for (let i = 1; i < n; i++) {
      const prev = disp[i - 1], cur = disp[i];
      const segColor = cur.price > prev.price ? '#00d47e'
                     : cur.price < prev.price ? '#f03e3e'
                     : '#6a8099';
      ctx.strokeStyle = segColor; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(toX(i - 1), toY(prev.price));
      ctx.lineTo(toX(i),     toY(cur.price));
      ctx.stroke();
    }
  }

  // Liquidation event dots on top of the line
  for (let i = 0; i < n; i++) {
    const h = disp[i];
    if (h.color !== 'long' && h.color !== 'short') continue;
    const dotColor = h.color === 'long' ? '#f03e3e' : '#00d47e';
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(toX(i), toY(h.price), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // Price scale tick labels in the right margin
  ctx.font = "9px 'JetBrains Mono'"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const price = minP + (i / 4) * priceRange;
    const y     = toY(price);
    ctx.strokeStyle = "#2a354560"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(chartW, y); ctx.lineTo(chartW + 5, y); ctx.stroke();
    ctx.fillStyle = "#8faabb";
    ctx.fillText(fmt(price), chartW + 7, y);
  }

  // Dashed connector from last point to price scale
  const curY    = Math.max(10, Math.min(H - 10, toY(cur)));
  const lineEndX = n > 0 ? toX(n - 1) : 0;
  ctx.save();
  ctx.strokeStyle = "#c8d8e870"; ctx.lineWidth = 0.8; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(lineEndX, curY); ctx.lineTo(chartW, curY); ctx.stroke();
  ctx.restore();

  // White tick across the scale column at current price
  ctx.strokeStyle = "#c8d8e8"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(chartW, curY); ctx.lineTo(W, curY); ctx.stroke();

  // Price label box
  const labelX = chartW + 2;
  const labelW = RMARGIN - 4;
  ctx.fillStyle = "#0f1923";
  ctx.fillRect(labelX, curY - 9, labelW, 18);
  ctx.strokeStyle = "#c8d8e8"; ctx.lineWidth = 1;
  ctx.strokeRect(labelX, curY - 9, labelW, 18);
  ctx.fillStyle = "#c8d8e8";
  ctx.font = "bold 9px 'JetBrains Mono'";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fmt(cur), labelX + labelW / 2, curY);
}

// Price scale is now drawn inside _drawLiqMain's right margin — no separate hist canvas needed
function _drawLiqHist(_p) {}

function _drawNoData(ctx, W, H, msg) {
  ctx.fillStyle = "#3d5066"; ctx.font = "10px 'JetBrains Mono'";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(msg, W / 2, H / 2);
}

function _showLiqOffline(p, msg) {
  const canvas = document.getElementById("liq-main-" + p.idx);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  _drawNoData(ctx, canvas.width || 400, canvas.height || 200, msg);
}

function _fmtVol(n) {
  if (!n) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}
