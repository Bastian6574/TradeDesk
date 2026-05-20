import { App } from '../../core/state.js';
import { fmt, toBinanceSymbol } from '../../core/utils.js';

const DEPTH_LEVELS = 60;
const REFRESH_MS   = 1000;
const MAX_TAPE     = 120;
const ICE_THRESH   = 4;    // cluster count >= this → iceberg

const _DEF = {
  l2GradientOn:    true,
  l2GradientDepth: 65,
  l2ClusterOn:     true,
  l2ColorBySize:   true,
  l2HiddenOrders:  true,
  l2TapeFontSize:  8,
};
const _c   = (p, k) => p.widgetSettings?.[k] ?? _DEF[k];
const _set  = (p, k, v) => { if (!p.widgetSettings) p.widgetSettings = {}; p.widgetSettings[k] = v; };

// ── START / STOP ──────────────────────────────────────────────────────────────
export function startLevel2(p) {
  _buildL2DOM(p);
  p._l2Bids      = [];
  p._l2Asks      = [];
  p._l2Buys      = [];
  p._l2Sells     = [];
  p._l2TapeDirty = false;
  p._l2Timer     = setInterval(() => _fetchDepth(p), REFRESH_MS);
  _fetchDepth(p);
  _startTradeStream(p);
  _renderLoop(p);
  _applyGradient(p);
  _applyFontSize(p);
  _wireSettings(p);
}

export function stopLevel2(p) {
  if (p._l2Timer)   { clearInterval(p._l2Timer);      p._l2Timer   = null; }
  if (p._l2Raf)     { cancelAnimationFrame(p._l2Raf); p._l2Raf     = null; }
  if (p._l2TradeWS) { p._l2TradeWS.close();           p._l2TradeWS = null; }
}

// ── DOM ───────────────────────────────────────────────────────────────────────
function _buildL2DOM(p) {
  const canvasWrap = document.getElementById("canvas-wrap-" + p.idx);
  if (!canvasWrap) return;
  if (p.mainChart) { p.mainChart.destroy(); p.mainChart = null; }
  canvasWrap.style.flexDirection = "column";
  canvasWrap.style.padding = "0";
  canvasWrap.innerHTML = `
    <div class="l2-header">
      <span>DEPTH</span>
      <span class="l2-mid" id="l2-mid-${p.idx}">—</span>
      <span>SPREAD</span>
      <span class="l2-spread" id="l2-spread-${p.idx}">—</span>
      <div class="l2-bbo">
        <span class="l2-bbo-bid">BID <span id="l2-best-bid-${p.idx}">—</span></span>
        <span class="l2-bbo-ask">ASK <span id="l2-best-ask-${p.idx}">—</span></span>
      </div>
      <button class="l2-settings-btn" id="l2-settings-btn-${p.idx}" title="Tape settings">⚙</button>
    </div>
    <div class="l2-settings-panel" id="l2-settings-panel-${p.idx}">
      <div class="l2-sp-row">
        <span class="l2-sp-lbl">GRADIENT</span>
        <input class="l2-sp-check" type="checkbox" id="l2-sp-grad-${p.idx}" ${_c(p,'l2GradientOn') ? 'checked' : ''}>
        <input class="l2-sp-range" type="range" id="l2-sp-grad-depth-${p.idx}" min="20" max="90" value="${_c(p,'l2GradientDepth')}">
        <span class="l2-sp-val" id="l2-sp-grad-val-${p.idx}">${_c(p,'l2GradientDepth')}%</span>
      </div>
      <div class="l2-sp-row">
        <span class="l2-sp-lbl">CLUSTER ORDERS</span>
        <input class="l2-sp-check" type="checkbox" id="l2-sp-cluster-${p.idx}" ${_c(p,'l2ClusterOn') ? 'checked' : ''}>
      </div>
      <div class="l2-sp-row">
        <span class="l2-sp-lbl">COLOR INTENSITY</span>
        <input class="l2-sp-check" type="checkbox" id="l2-sp-color-${p.idx}" ${_c(p,'l2ColorBySize') ? 'checked' : ''}>
      </div>
      <div class="l2-sp-row">
        <span class="l2-sp-lbl">HIDDEN ORDERS</span>
        <input class="l2-sp-check" type="checkbox" id="l2-sp-ice-${p.idx}" ${_c(p,'l2HiddenOrders') ? 'checked' : ''}>
      </div>
      <div class="l2-sp-row">
        <span class="l2-sp-lbl">FONT SIZE</span>
        <input class="l2-sp-range" type="range" id="l2-sp-font-${p.idx}" min="6" max="13" value="${_c(p,'l2TapeFontSize')}">
        <span class="l2-sp-val" id="l2-sp-font-val-${p.idx}">${_c(p,'l2TapeFontSize')}px</span>
      </div>
    </div>
    <div class="l2-body" id="l2-body-${p.idx}">
      <div class="l2-depth-pane" id="l2-depth-pane-${p.idx}">
        <canvas class="l2-canvas" id="l2-canvas-${p.idx}"></canvas>
      </div>
      <div class="l2-tape-pane" id="l2-tape-pane-${p.idx}">
        <div class="l2-tape-bbo" id="l2-tape-bbo-${p.idx}">
          <span class="l2-tbbo-bid" id="l2-tbbo-bid-${p.idx}">—</span>
          <span class="l2-tbbo-spr" id="l2-tbbo-spr-${p.idx}">SPR —</span>
          <span class="l2-tbbo-ask" id="l2-tbbo-ask-${p.idx}">—</span>
        </div>
        <div class="l2-tape-hdr">
          <span class="l2-tape-hdr-buy">▲ BUYS</span>
          <span class="l2-tape-hdr-sell">SELLS ▼</span>
        </div>
        <div class="l2-tape-cols">
          <div class="l2-tape-col l2-tape-buy" id="l2-tape-buys-${p.idx}"></div>
          <div class="l2-tape-divider"></div>
          <div class="l2-tape-col l2-tape-sell" id="l2-tape-sells-${p.idx}"></div>
        </div>
      </div>
    </div>
  `;
}

// ── SETTINGS WIRING ───────────────────────────────────────────────────────────
function _wireSettings(p) {
  const btnEl   = document.getElementById("l2-settings-btn-"   + p.idx);
  const panelEl = document.getElementById("l2-settings-panel-" + p.idx);
  if (!btnEl || !panelEl) return;

  btnEl.addEventListener("click", () => {
    const open = panelEl.classList.toggle("open");
    btnEl.classList.toggle("active", open);
  });

  const bind = (id, key, isRange) => {
    const el = document.getElementById(id);
    if (!el) return;
    const apply = () => {
      const v = isRange ? Number(el.value) : el.checked;
      _set(p, key, v);
      _onSettingChange(p, key);
    };
    el.addEventListener("change", apply);
    if (isRange) el.addEventListener("input", apply);
  };

  bind("l2-sp-grad-"       + p.idx, "l2GradientOn",    false);
  bind("l2-sp-grad-depth-" + p.idx, "l2GradientDepth", true);
  bind("l2-sp-cluster-"    + p.idx, "l2ClusterOn",     false);
  bind("l2-sp-color-"      + p.idx, "l2ColorBySize",   false);
  bind("l2-sp-ice-"        + p.idx, "l2HiddenOrders",  false);
  bind("l2-sp-font-"       + p.idx, "l2TapeFontSize",  true);
}

function _onSettingChange(p, key) {
  if (key === "l2GradientOn" || key === "l2GradientDepth") {
    _applyGradient(p);
    const valEl = document.getElementById("l2-sp-grad-val-" + p.idx);
    const rng   = document.getElementById("l2-sp-grad-depth-" + p.idx);
    if (valEl && rng) valEl.textContent = rng.value + "%";
  }
  if (key === "l2TapeFontSize") {
    _applyFontSize(p);
    const valEl = document.getElementById("l2-sp-font-val-" + p.idx);
    const rng   = document.getElementById("l2-sp-font-" + p.idx);
    if (valEl && rng) valEl.textContent = rng.value + "px";
  }
  p._l2TapeDirty = true;
}

function _applyGradient(p) {
  const on    = _c(p, "l2GradientOn");
  const depth = _c(p, "l2GradientDepth");
  const mask  = on ? `linear-gradient(to bottom, black ${depth}%, transparent 100%)` : "";
  ["l2-tape-buys-" + p.idx, "l2-tape-sells-" + p.idx].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
  });
}

function _applyFontSize(p) {
  const fs = _c(p, "l2TapeFontSize");
  ["l2-tape-buys-" + p.idx, "l2-tape-sells-" + p.idx].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.fontSize = fs + "px";
  });
  const paneEl = document.getElementById("l2-tape-pane-" + p.idx);
  if (paneEl) paneEl.style.flex = `0 0 ${Math.round(fs * 26)}px`;
}

// ── TRADE STREAM ──────────────────────────────────────────────────────────────
function _startTradeStream(p) {
  const binSym = toBinanceSymbol(p.ticker);
  if (!binSym) return;
  const myGen = p._gen;

  function connect() {
    if (p._gen !== myGen) return;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${binSym}@trade`);
    p._l2TradeWS = ws;

    ws.onmessage = (evt) => {
      if (p._gen !== myGen) return;
      try {
        const d = JSON.parse(evt.data);
        // m=true: buyer is market maker → seller was aggressor → sell print
        const isBuy = !d.m;
        const trade = { t: d.T, qty: parseFloat(d.q), price: parseFloat(d.p) };
        if (isBuy) {
          p._l2Buys.unshift(trade);
          if (p._l2Buys.length > MAX_TAPE) p._l2Buys.length = MAX_TAPE;
        } else {
          p._l2Sells.unshift(trade);
          if (p._l2Sells.length > MAX_TAPE) p._l2Sells.length = MAX_TAPE;
        }
        p._l2TapeDirty = true;
      } catch (e) {}
    };

    ws.onerror = ws.onclose = () => { if (p._gen === myGen) setTimeout(connect, 3000); };
  }
  connect();
}

// ── DEPTH FETCH ───────────────────────────────────────────────────────────────
async function _fetchDepth(p) {
  const myGen = p._gen;
  try {
    const binSym = toBinanceSymbol(p.ticker);
    if (!binSym) {
      _drawPlaceholder(p, p.ticker + " — L2 only available for crypto");
      return;
    }
    const r = await fetch(`https://api.binance.com/api/v3/depth?symbol=${binSym.toUpperCase()}&limit=100`);
    if (!r.ok || p._gen !== myGen) return;
    const d = await r.json();
    if (p._gen !== myGen) return;

    p._l2Bids = d.bids.slice(0, DEPTH_LEVELS).map(([pr, qt]) => ({ price: parseFloat(pr), qty: parseFloat(qt) }));
    p._l2Asks = d.asks.slice(0, DEPTH_LEVELS).map(([pr, qt]) => ({ price: parseFloat(pr), qty: parseFloat(qt) }));

    if (p._l2Bids.length && p._l2Asks.length) {
      const bestBid = p._l2Bids[0].price, bestAsk = p._l2Asks[0].price;
      const mid = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;
      const spreadPct = (spread / mid * 100).toFixed(3);
      const el = id => document.getElementById(id);
      if (el("l2-mid-"      + p.idx)) el("l2-mid-"      + p.idx).textContent = fmt(mid);
      if (el("l2-spread-"   + p.idx)) el("l2-spread-"   + p.idx).textContent = fmt(spread) + " (" + spreadPct + "%)";
      if (el("l2-best-bid-" + p.idx)) el("l2-best-bid-" + p.idx).textContent = fmt(bestBid);
      if (el("l2-best-ask-" + p.idx)) el("l2-best-ask-" + p.idx).textContent = fmt(bestAsk);
      // tape pane BBO strip
      if (el("l2-tbbo-bid-" + p.idx)) el("l2-tbbo-bid-" + p.idx).textContent = fmt(bestBid);
      if (el("l2-tbbo-ask-" + p.idx)) el("l2-tbbo-ask-" + p.idx).textContent = fmt(bestAsk);
      if (el("l2-tbbo-spr-" + p.idx)) el("l2-tbbo-spr-" + p.idx).textContent = "Δ " + _fmtPrice(spread);
    }
  } catch (e) {}
}

// ── RENDER LOOP ───────────────────────────────────────────────────────────────
function _renderLoop(p) {
  const myGen = p._gen;
  let lastDepthDraw = 0;
  function frame(now) {
    if (p._gen !== myGen) return;
    p._l2Raf = requestAnimationFrame(frame);
    if (now - lastDepthDraw >= REFRESH_MS) {
      lastDepthDraw = now;
      _drawDepthChart(p);
    }
    if (p._l2TapeDirty) {
      p._l2TapeDirty = false;
      _renderTape(p);
    }
  }
  p._l2Raf = requestAnimationFrame(frame);
}

// ── CLUSTERING ────────────────────────────────────────────────────────────────
function _cluster(trades) {
  const out = [];
  for (const t of trades) {
    const last = out[out.length - 1];
    // group consecutive same-size orders within 8% tolerance
    if (last && last.qty > 0 && Math.abs(t.qty - last.qty) / last.qty < 0.08) {
      last.count++;
      last.totalQty += t.qty;
    } else {
      out.push({ ...t, count: 1, totalQty: t.qty });
    }
  }
  // count >= ICE_THRESH → iceberg pattern (repeated same-size hidden order)
  for (const c of out) c.isIceberg = c.count >= ICE_THRESH;
  return out;
}

// ── TAPE RENDER ───────────────────────────────────────────────────────────────
function _renderTape(p) {
  const buysEl  = document.getElementById("l2-tape-buys-"  + p.idx);
  const sellsEl = document.getElementById("l2-tape-sells-" + p.idx);
  if (!buysEl || !sellsEl) return;

  const clusterOn = _c(p, "l2ClusterOn");
  const colorOn   = _c(p, "l2ColorBySize");
  const iceOn     = _c(p, "l2HiddenOrders");

  const buys  = clusterOn ? _cluster(p._l2Buys)  : p._l2Buys.map(t  => ({ ...t, count: 1, totalQty: t.qty, isIceberg: false }));
  const sells = clusterOn ? _cluster(p._l2Sells) : p._l2Sells.map(t => ({ ...t, count: 1, totalQty: t.qty, isIceberg: false }));

  // max qty across both sides for relative intensity
  const allQtys = [...buys, ...sells].map(t => t.qty);
  const maxQty  = allQtys.length ? Math.max(...allQtys) : 1;

  buysEl.innerHTML  = buys.slice(0, 60).map(t  => _rowHTML(t, "buy",  maxQty, colorOn, iceOn)).join("");
  sellsEl.innerHTML = sells.slice(0, 60).map(t => _rowHTML(t, "sell", maxQty, colorOn, iceOn)).join("");
}

function _rowHTML(t, side, maxQty, colorOn, iceOn) {
  const qty   = _fmtQt(t.qty);
  const cnt   = t.count > 1 ? `<span class="l2-cnt">×${t.count}</span>` : "";
  const price = _fmtPrice(t.price);

  const intensity = colorOn ? (0.15 + Math.min(t.qty / maxQty, 1) * 0.85) : 1.0;
  const isIce = iceOn && t.isIceberg;

  let style = "";
  if (isIce) {
    style = side === "buy"
      ? `style="background:rgba(0,50,25,0.9);color:rgba(20,255,140,1)"`
      : `style="background:rgba(50,0,0,0.9);color:rgba(255,90,90,1)"`;
  } else if (colorOn) {
    style = side === "buy"
      ? `style="color:rgba(0,212,126,${intensity.toFixed(2)})"`
      : `style="color:rgba(240,62,62,${intensity.toFixed(2)})"`;
  }

  return `<div class="l2-row${isIce ? " l2-ice" : ""}" ${style}><span class="l2-col-qty">${qty}${cnt}</span><span class="l2-col-price">${price}</span></div>`;
}

// ── DEPTH CHART ───────────────────────────────────────────────────────────────
function _drawDepthChart(p) {
  const canvas = document.getElementById("l2-canvas-"     + p.idx);
  const pane   = document.getElementById("l2-depth-pane-" + p.idx);
  if (!canvas || !pane) return;
  const W = pane.clientWidth, H = pane.clientHeight;
  if (W <= 0 || H <= 0) return;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);

  const bids = p._l2Bids, asks = p._l2Asks;
  if (!bids?.length || !asks?.length) return;

  const cumBids = [], cumAsks = [];
  let bidCum = 0, askCum = 0;
  for (const b of bids) { bidCum += b.qty; cumBids.push({ price: b.price, cum: bidCum }); }
  for (const a of asks) { askCum += a.qty; cumAsks.push({ price: a.price, cum: askCum }); }

  const maxCum     = Math.max(bidCum, askCum);
  const minPrice   = bids[bids.length - 1]?.price ?? 0;
  const maxPrice   = asks[asks.length - 1]?.price ?? 0;
  const priceRange = maxPrice - minPrice || 1;
  const bestBid    = bids[0].price, bestAsk = asks[0].price;
  const mid        = (bestBid + bestAsk) / 2;

  const toX = price => ((price - minPrice) / priceRange) * W;
  const toY = cum   => H - (cum / maxCum) * H * 0.9;

  ctx.strokeStyle = "#1e253015"; ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = H - (i / 4) * H * 0.9;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = "#3d5066"; ctx.font = "8px 'JetBrains Mono'"; ctx.textAlign = "right";
    ctx.fillText(_fmtQt((i / 4) * maxCum), W - 4, y - 2);
  }

  ctx.beginPath();
  ctx.moveTo(toX(bestBid), H);
  cumBids.forEach(({ price, cum }) => ctx.lineTo(toX(price), toY(cum)));
  ctx.lineTo(toX(minPrice), H);
  ctx.closePath();
  ctx.fillStyle = "#00d47e22"; ctx.fill();
  ctx.strokeStyle = "#00d47e88"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  cumBids.forEach(({ price, cum }, i) => { i === 0 ? ctx.moveTo(toX(bestBid), H) : null; ctx.lineTo(toX(price), toY(cum)); });
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(toX(bestAsk), H);
  cumAsks.forEach(({ price, cum }) => ctx.lineTo(toX(price), toY(cum)));
  ctx.lineTo(toX(maxPrice), H);
  ctx.closePath();
  ctx.fillStyle = "#f03e3e22"; ctx.fill();
  ctx.strokeStyle = "#f03e3e88"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  cumAsks.forEach(({ price, cum }, i) => { i === 0 ? ctx.moveTo(toX(bestAsk), H) : null; ctx.lineTo(toX(price), toY(cum)); });
  ctx.stroke();

  const midX = toX(mid);
  ctx.strokeStyle = "#6a809966"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(midX, 0); ctx.lineTo(midX, H); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#6a8099"; ctx.font = "8px 'JetBrains Mono'"; ctx.textAlign = "center";
  [minPrice, bestBid, mid, bestAsk, maxPrice].forEach(pr => {
    const x = toX(pr);
    if (x < 20 || x > W - 20) return;
    ctx.fillText(fmt(pr), x, H - 4);
  });
}

function _drawPlaceholder(p, msg) {
  const canvas = document.getElementById("l2-canvas-" + p.idx);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#3d5066"; ctx.font = "10px 'JetBrains Mono'";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(msg, canvas.width / 2 || 200, canvas.height / 2 || 100);
}

// ── FORMATTERS ────────────────────────────────────────────────────────────────
function _fmtQt(n) {
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3)  return (n / 1e3).toFixed(2) + "K";
  if (n >= 1)    return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function _fmtPrice(pr) {
  if (pr >= 10000) return pr.toFixed(2);
  if (pr >= 1000)  return pr.toFixed(3);
  if (pr >= 1)     return pr.toFixed(4);
  if (pr >= 0.001) return pr.toFixed(6);
  return pr.toExponential(3);
}
