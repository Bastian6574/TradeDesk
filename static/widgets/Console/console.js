import { App } from '../../core/state.js';
import { fmt } from '../../core/utils.js';

const SCAN_MS  = 9_000;   // full scan every 9s
const LOG_MAX  = 400;     // max rows kept in DOM
const COOLDOWN = 300_000; // 5-min silence per signal key
const _cache   = new Map(); // ticker_tf → { ts, data }

const TFS = [
  { tf: '15m', period: '5d',  interval: '15m', ttl:  60_000 },
  { tf: '30m', period: '10d', interval: '30m', ttl: 120_000 },
  { tf:  '1h', period: '1mo', interval:  '1h', ttl: 300_000 },
  { tf:  '1d', period: '1y',  interval:  '1d', ttl: 600_000 },
];

// ── START / STOP ──────────────────────────────────────────────────────────────
export function startConsole(p) {
  _buildDOM(p);
  p._conActive    = true;
  p._conCooldowns = new Map();
  _emit(p, '#6a8099', 'SYS', `console active — monitoring ${p.ticker} · scanning 15m 30m 1h 1d`);
  _runScan(p);
  p._conTimer = setInterval(() => _runScan(p), SCAN_MS);
}

export function stopConsole(p) {
  p._conActive = false;
  if (p._conTimer) { clearInterval(p._conTimer); p._conTimer = null; }
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const _SIGNAL_GUIDE = [
  { badge: '▼ DROP  [TF]',         color: '#f03e3e', desc: 'Last closed candle body ≥ 2.5× the 20-candle average. Strong directional momentum or news event.' },
  { badge: '▲ PUMP  [TF]',         color: '#00d47e', desc: 'Same as DROP but bullish. Unusually large green candle relative to recent average.' },
  { badge: '⬡ MACD BOT  [TF]',     color: '#4dabf7', desc: 'MACD histogram is below zero but turning upward for two consecutive bars. Early sign bearish momentum is fading — possible reversal.' },
  { badge: '⬡ MACD CROSS  [TF]',   color: '#74c0fc', desc: 'MACD histogram just crossed above zero. Bullish momentum confirmed on this timeframe.' },
  { badge: '⬡ MACD TOP  [TF]',     color: '#ff9500', desc: 'MACD histogram is positive but turning down two bars in a row. Bullish momentum fading — consider tightening stops.' },
  { badge: '◆ RSI ENTRY  [TF]',    color: '#a9e34b', desc: 'RSI < 35 AND MACD histogram turning up simultaneously. Two-factor oversold confluence — highest-quality long setup.' },
  { badge: '◇ RSI OVERSOLD  [TF]', color: '#b2f2bb', desc: 'RSI fell below 30. Price statistically stretched to the downside. Not a standalone entry — wait for confirmation.' },
  { badge: '◇ RSI OBOUGHT  [TF]',  color: '#ffb300', desc: 'RSI exceeded 72. Price may be extended to the upside. Consider reducing longs or watching for reversal patterns.' },
  { badge: '◉ BULL ENGULF  [TF]',  color: '#00d47e', desc: 'Green candle body fully engulfs the prior red candle and undercuts its low. Classic candlestick reversal signal.' },
  { badge: '◉ BEAR ENGULF  [TF]',  color: '#f03e3e', desc: 'Red candle body fully engulfs the prior green candle and exceeds its high. Bearish reversal candlestick pattern.' },
  { badge: '● VOL SPIKE  [TF]',    color: '#cc5de8', desc: 'Candle volume exceeded 3.5× the 20-bar average. Unusual participation — often precedes a sustained directional move.' },
  { badge: '⊘ EMA50 BREAK  [TF]',  color: '#f03e3e', desc: 'Price closed below the 50-period EMA after being above it. Key trend-filter sell signal used by institutional algos.' },
  { badge: '⊘ EMA50 RECLAIM  [TF]',color: '#00d47e', desc: 'Price closed above the 50-period EMA after being below it. Trend-filter buy signal — confirms recovery.' },
  { badge: '▲ ICEBERG ASK',         color: '#ff9500', desc: 'Top ask is ≥ 4× larger than the average of the next 5 ask levels. A large hidden sell wall absorbing market buys. Requires Level 2 panel open on same ticker.' },
  { badge: '▲ ICEBERG BID',         color: '#00d47e', desc: 'Top bid is ≥ 4× larger than the average of the next 5 bid levels. A large hidden buy wall absorbing market sells. Requires Level 2 panel open on same ticker.' },
];

function _buildDOM(p) {
  const wrap = document.getElementById('canvas-wrap-' + p.idx);
  if (!wrap) return;
  wrap.style.display       = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.padding       = '0';

  const ttRows = _SIGNAL_GUIDE.map(s =>
    `<div class="con-tt-row">` +
    `<span class="con-tt-badge" style="color:${s.color}">${_esc(s.badge)}</span>` +
    `<span class="con-tt-desc">${_esc(s.desc)}</span>` +
    `</div>`
  ).join('');

  wrap.innerHTML = `
    <div class="con-header">
      <span class="con-title">CONSOLE</span>
      <span class="con-ticker">${p.ticker}</span>
      <span class="con-status" id="con-status-${p.idx}">initialising…</span>
      <div class="con-info-wrap" style="margin-left:auto">
        <button class="con-info-btn">?</button>
        <div class="con-tooltip">
          <div class="con-tt-title">SIGNAL GUIDE</div>
          ${ttRows}
        </div>
      </div>
      <button class="con-clr-btn" onclick="(function(){
        const l=document.getElementById('con-log-${p.idx}');
        if(l)l.innerHTML='';
      })()">CLR</button>
    </div>
    <div class="con-log" id="con-log-${p.idx}"></div>
  `;
}

// ── EMIT ──────────────────────────────────────────────────────────────────────
function _emit(p, color, badge, detail) {
  const log = document.getElementById('con-log-' + p.idx);
  if (!log) return;
  const ts  = new Date().toTimeString().slice(0, 8);
  const row = document.createElement('div');
  row.className = 'con-row';
  row.innerHTML =
    `<span class="con-ts">${ts}</span>` +
    `<span class="con-badge" style="color:${color}">${badge}</span>` +
    `<span class="con-detail">${_esc(detail)}</span>`;
  log.appendChild(row);
  if (log.children.length > LOG_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function _runScan(p) {
  if (!p._conActive) return;
  const ticker = p.ticker;
  const now    = Date.now();
  const sigs   = [];

  // Live data checks (no API call needed)
  _detectIceberg(ticker).forEach(s => sigs.push(s));

  // Multi-TF candle checks
  for (const cfg of TFS) {
    let candles;
    try { candles = await _fetchCandles(ticker, cfg); } catch { continue; }
    if (!candles?.length) continue;
    const lbl = cfg.tf.toUpperCase();
    [
      ..._detectLargeCandle(candles, lbl),
      ..._detectMacd(candles, lbl),
      ..._detectRSI(candles, lbl),
      ..._detectEngulf(candles, lbl),
      ..._detectVolSpike(candles, lbl),
      ..._detectEMA50Break(candles, lbl),
    ].forEach(s => sigs.push(s));
  }

  // Emit with cooldown
  sigs.forEach(sig => {
    const ck = `${ticker}_${sig.key}`;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + COOLDOWN);
    _emit(p, sig.color, sig.badge, `${ticker}  ${sig.detail}`);
  });

  const el = document.getElementById('con-status-' + p.idx);
  if (el) el.textContent = `scanned ${new Date().toTimeString().slice(0, 8)}`;
}

// ── DATA FETCH ────────────────────────────────────────────────────────────────
async function _fetchCandles(ticker, cfg) {
  const key = `${ticker}_${cfg.tf}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < cfg.ttl) return hit.data;
  const res = await fetch(`/api/chart/${encodeURIComponent(ticker)}?period=${cfg.period}&interval=${cfg.interval}`);
  if (!res.ok) return null;
  const json = await res.json();
  const data = json.candles || json;
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

// ── MATH HELPERS ─────────────────────────────────────────────────────────────
function _emaArr(data, n) {
  const k = 2 / (n + 1);
  const out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i-1] * (1 - k));
  return out;
}

function _rsi(closes, n = 14) {
  if (closes.length < n + 2) return null;
  const ch = closes.slice(1).map((c, i) => c - closes[i]);
  let g = 0, l = 0;
  for (let i = 0; i < n; i++) { if (ch[i] > 0) g += ch[i]; else l -= ch[i]; }
  g /= n; l /= n;
  for (let i = n; i < ch.length; i++) {
    g = (g * (n-1) + Math.max(ch[i], 0)) / n;
    l = (l * (n-1) + Math.max(-ch[i], 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function _macdHist(closes) {
  if (closes.length < 36) return null;
  const e12  = _emaArr(closes, 12);
  const e26  = _emaArr(closes, 26);
  const line = e12.map((v, i) => v - e26[i]).slice(25);
  if (line.length < 10) return null;
  const sig  = _emaArr(line, 9);
  return line.map((v, i) => v - sig[i]);
}

// ── SIGNAL DETECTORS ─────────────────────────────────────────────────────────

function _detectLargeCandle(candles, lbl) {
  if (candles.length < 22) return [];
  const last20  = candles.slice(-21, -1);
  const avgBody = last20.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / last20.length;
  const avgVol  = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const c       = last20[last20.length - 1];
  const body    = c.c - c.o;
  const ratio   = avgBody > 0 ? Math.abs(body) / avgBody : 0;
  if (ratio < 2.5) return [];
  const vTag = avgVol > 0 ? `  vol ${((c.v||0)/avgVol).toFixed(1)}x` : '';
  if (body < 0) return [{ key: `drop_${lbl}`,  color: '#f03e3e', badge: `▼ DROP ${lbl}`,  detail: `${ratio.toFixed(1)}x avg body${vTag}` }];
  return            [{ key: `pump_${lbl}`,  color: '#00d47e', badge: `▲ PUMP ${lbl}`,  detail: `${ratio.toFixed(1)}x avg body${vTag}` }];
}

function _detectMacd(candles, lbl) {
  const hist = _macdHist(candles.map(c => c.c));
  if (!hist || hist.length < 3) return [];
  const n = hist.length;
  const [h2, h1, h0] = [hist[n-3], hist[n-2], hist[n-1]];
  const out = [];
  if (h2 < h1 && h1 <= h0 && h0 < 0)
    out.push({ key: `macd_bot_${lbl}`,   color: '#4dabf7', badge: `⬡ MACD BOT ${lbl}`,   detail: `histogram ${h0.toFixed(2)} turning up` });
  if (h1 < 0 && h0 >= 0)
    out.push({ key: `macd_cross_${lbl}`, color: '#74c0fc', badge: `⬡ MACD CROSS ${lbl}`, detail: `histogram crossed zero` });
  if (h2 > h1 && h1 >= h0 && h0 > 0)
    out.push({ key: `macd_top_${lbl}`,   color: '#ff9500', badge: `⬡ MACD TOP ${lbl}`,   detail: `histogram ${h0.toFixed(2)} turning down` });
  return out;
}

function _detectRSI(candles, lbl) {
  const closes = candles.map(c => c.c);
  const r = _rsi(closes, 14);
  if (r === null) return [];
  const hist = _macdHist(closes);
  const n    = hist?.length;
  const macdUp = hist && n >= 2 && hist[n-1] > hist[n-2] && hist[n-1] < 0;
  const out = [];
  if (r < 35 && macdUp)
    out.push({ key: `rsi_entry_${lbl}`, color: '#a9e34b', badge: `◆ RSI ENTRY ${lbl}`, detail: `RSI ${r.toFixed(1)} · MACD hist turning up` });
  else if (r < 30)
    out.push({ key: `rsi_os_${lbl}`,    color: '#b2f2bb', badge: `◇ RSI OVERSOLD ${lbl}`, detail: `RSI ${r.toFixed(1)}` });
  if (r > 72)
    out.push({ key: `rsi_ob_${lbl}`,    color: '#ffb300', badge: `◇ RSI OBOUGHT ${lbl}`,  detail: `RSI ${r.toFixed(1)}` });
  return out;
}

function _detectEngulf(candles, lbl) {
  if (candles.length < 3) return [];
  const p = candles[candles.length - 3];
  const c = candles[candles.length - 2];
  const pb = c.c - c.o, qb = p.c - p.o;
  const out = [];
  if (qb < 0 && pb > 0 && pb > Math.abs(qb) * 1.05 && c.l <= p.l)
    out.push({ key: `bull_engulf_${lbl}`, color: '#00d47e', badge: `◉ BULL ENGULF ${lbl}`, detail: `curr ${(pb/Math.abs(qb)).toFixed(1)}x prev body` });
  if (qb > 0 && pb < 0 && Math.abs(pb) > qb * 1.05 && c.h >= p.h)
    out.push({ key: `bear_engulf_${lbl}`, color: '#f03e3e', badge: `◉ BEAR ENGULF ${lbl}`, detail: `curr ${(Math.abs(pb)/qb).toFixed(1)}x prev body` });
  return out;
}

function _detectVolSpike(candles, lbl) {
  if (candles.length < 22) return [];
  const last20 = candles.slice(-21, -1);
  const avg    = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const c      = last20[last20.length - 1];
  if (avg > 0 && (c.v || 0) > 3.5 * avg)
    return [{ key: `vol_${lbl}`, color: '#cc5de8', badge: `● VOL SPIKE ${lbl}`, detail: `${((c.v||0)/avg).toFixed(1)}x avg volume` }];
  return [];
}

function _detectEMA50Break(candles, lbl) {
  if (candles.length < 55) return [];
  const closes = candles.map(c => c.c);
  const ema    = _emaArr(closes, 50);
  const n      = ema.length;
  const out    = [];
  if (closes[n-2] > ema[n-2] && closes[n-1] < ema[n-1])
    out.push({ key: `ema50_dn_${lbl}`, color: '#f03e3e', badge: `⊘ EMA50 BREAK ${lbl}`,   detail: `close slipped below EMA50` });
  if (closes[n-2] < ema[n-2] && closes[n-1] > ema[n-1])
    out.push({ key: `ema50_up_${lbl}`, color: '#00d47e', badge: `⊘ EMA50 RECLAIM ${lbl}`, detail: `close reclaimed EMA50` });
  return out;
}

function _detectIceberg(ticker) {
  const panel = App.panels.find(q =>
    q.ticker === ticker && q.widgetMode === 'level2' &&
    q._l2Asks?.length > 5 && q._l2Bids?.length > 5
  );
  if (!panel) return [];
  const out = [];
  const chk = (side, arr, label, color) => {
    const avg5 = arr.slice(1, 6).reduce((s, x) => s + x.qty, 0) / 5;
    if (avg5 > 0 && arr[0].qty > 4 * avg5)
      out.push({ key: `ice_${side}`, color, badge: `▲ ICEBERG ${label}`,
        detail: `${arr[0].qty.toFixed(2)} @ ${fmt(arr[0].price)}  (${(arr[0].qty/avg5).toFixed(1)}x top-5 avg)` });
  };
  chk('ask', panel._l2Asks, 'ASK', '#ff9500');
  chk('bid', panel._l2Bids, 'BID', '#00d47e');
  return out;
}
