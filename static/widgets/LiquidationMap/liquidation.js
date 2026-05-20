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
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.padding = "0";
  canvasWrap.innerHTML = `
    <div class="liq-header">
      <div class="liq-legend">
        <div class="liq-leg-item"><div class="liq-leg-dot" style="background:#f03e3e88"></div>LONG LIQ</div>
        <div class="liq-leg-item"><div class="liq-leg-dot" style="background:#00d47e88"></div>SHORT LIQ</div>
      </div>
      <span class="liq-count" id="liq-count-${p.idx}">waiting for data…</span>
    </div>
    <div class="liq-wrap" id="liq-wrap-${p.idx}">
      <canvas class="liq-canvas-main" id="liq-main-${p.idx}"></canvas>
      <canvas class="liq-canvas-hist" id="liq-hist-${p.idx}"></canvas>
    </div>
  `;
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
  // Seed price history from existing candle data
  if (p.candleData?._liveCandles) {
    p.candleData._liveCandles.slice(-200).forEach(c => {
      p._liqPriceHistory.push({ t: c.t, price: c.c });
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
        p._liqPriceHistory.push({ t: o.T, price });
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
        p._liqPriceHistory.push({ t: Date.now(), price: last.c });
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

function _drawLiqMain(p) {
  const canvas = document.getElementById("liq-main-" + p.idx);
  const wrap   = document.getElementById("liq-wrap-" + p.idx);
  if (!canvas || !wrap) return;
  const W = wrap.clientWidth - 80, H = wrap.clientHeight;
  if (W <= 0 || H <= 0) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  // Price axis range
  const cur = p._liqCurrentPrice;
  const history = p._liqPriceHistory;
  if (!cur || !history.length) { _drawNoData(ctx, W, H, "Waiting for liquidations…"); return; }

  const prices = history.map(h => h.price);
  const rawMin = Math.min(...prices), rawMax = Math.max(...prices);
  const pad = (rawMax - rawMin) * 0.1 || cur * 0.02;
  const minP = rawMin - pad, maxP = rawMax + pad;
  const priceRange = maxP - minP;

  const toY = price => H - ((price - minP) / priceRange) * H;
  const toX = (idx, total) => (idx / Math.max(total - 1, 1)) * W;

  // Background grid
  ctx.strokeStyle = "#1e253022"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * H;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    const price = maxP - (i / 4) * priceRange;
    ctx.fillStyle = "#3d5066"; ctx.font = "9px 'JetBrains Mono'";
    ctx.textAlign = "left"; ctx.fillText(fmt(price), 4, y - 2);
  }

  // Liquidation events as vertical bars at their price level (using bins mapped to time)
  // Show liquidation "rain" — bars at bottom proportional to volume
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
      // Green-red gradient
      const r = Math.round(240 * (1 - longFrac)), g = Math.round(211 * longFrac);
      ctx.fillStyle = `rgba(${r},${g},62,0.5)`;
      ctx.fillRect(0, y - barH / 2, W, barH);
    });
  }

  // Price line
  if (history.length > 1) {
    ctx.beginPath(); ctx.strokeStyle = "#c8d8e8"; ctx.lineWidth = 1.5;
    history.forEach((h, i) => {
      const x = toX(i, history.length), y = toY(h.price);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // Current price label
  const priceY = toY(cur);
  ctx.fillStyle = "#0a0c0f"; ctx.fillRect(W - 62, priceY - 8, 62, 16);
  ctx.fillStyle = "#c8d8e8"; ctx.font = "bold 10px 'JetBrains Mono'";
  ctx.textAlign = "center"; ctx.fillText(fmt(cur), W - 31, priceY + 3);
}

function _drawLiqHist(p) {
  const canvas = document.getElementById("liq-hist-" + p.idx);
  const wrap   = document.getElementById("liq-wrap-" + p.idx);
  if (!canvas || !wrap) return;
  const W = 79, H = wrap.clientHeight;
  if (H <= 0) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const cur = p._liqCurrentPrice;
  const history = p._liqPriceHistory;
  if (!cur || !history.length || p._liqMinPrice === null) return;

  const prices = history.map(h => h.price);
  const minP = Math.min(...prices) * 0.999, maxP = Math.max(...prices) * 1.001;
  const priceRange = maxP - minP;
  const toY = price => H - ((price - minP) / priceRange) * H;

  const binRange = p._liqMaxPrice - p._liqMinPrice;
  const maxVol = Math.max(...p._liqBins.map(b => b.longVol + b.shortVol), 1);

  p._liqBins.forEach((bin, i) => {
    const total = bin.longVol + bin.shortVol; if (total === 0) return;
    const binPrice = p._liqMinPrice + (i + 0.5) / BINS * binRange;
    if (binPrice < minP || binPrice > maxP) return;
    const y = toY(binPrice);
    const barW = Math.max(2, (total / maxVol) * (W - 20));
    const longFrac = bin.longVol / total;

    // Split bar: long portion red, short portion green
    const longW = barW * longFrac, shortW = barW * (1 - longFrac);
    ctx.fillStyle = "#f03e3e99"; ctx.fillRect(0, y - 1.5, longW, 3);
    ctx.fillStyle = "#00d47e99"; ctx.fillRect(longW, y - 1.5, shortW, 3);
  });

  // Current price tick
  const curY = toY(cur);
  ctx.strokeStyle = "#c8d8e8"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, curY); ctx.lineTo(W, curY); ctx.stroke();
}

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
