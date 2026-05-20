import { App } from '../../core/state.js';
import { fmt } from '../../core/utils.js';

const SCAN_MS   = 9_000;
const LOG_MAX   = 400;
const COOLDOWN  = 300_000; // 5-min per signal key
const _cache    = new Map(); // ticker_tf → { ts, data }
const _outlined = new Map(); // panelIdx → { color, ts, clearTimer }

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
  p._conLive      = false;
  p._conCooldowns = new Map();
  _emit(p, '#6a8099', 'SYS', `monitoring ${p.ticker} · scanning 15m 30m 1h 1d`);
  _runScan(p);
  p._conTimer = setInterval(() => _runScan(p), SCAN_MS);
}

export function stopConsole(p) {
  p._conActive = false;
  if (p._conTimer) { clearInterval(p._conTimer); p._conTimer = null; }
}

// ── SIGNAL GUIDE (for tooltip) ────────────────────────────────────────────────
const _GUIDE = [
  { badge: '▼ DROP  [TF]',          color: '#f03e3e', desc: 'Last closed candle body ≥ 2.5× the 20-bar average. Strong momentum or news-driven move.' },
  { badge: '▲ PUMP  [TF]',          color: '#00d47e', desc: 'Same as DROP but bullish. Unusually large green body relative to recent average.' },
  { badge: '⬡ MACD BOT  [TF]',      color: '#4dabf7', desc: 'MACD histogram below zero but turning up two bars in a row. Early bearish-momentum fade — possible reversal.' },
  { badge: '⬡ MACD CROSS  [TF]',    color: '#74c0fc', desc: 'MACD histogram just crossed above zero. Bullish momentum confirmed on this timeframe.' },
  { badge: '⬡ MACD TOP  [TF]',      color: '#ff9500', desc: 'MACD histogram positive but turning down. Bullish momentum fading — tighten stops.' },
  { badge: '◆ RSI ENTRY  [TF]',     color: '#a9e34b', desc: 'RSI < 35 AND MACD histogram turning up simultaneously. Two-factor oversold confluence — highest-quality long setup.' },
  { badge: '◇ RSI OVERSOLD  [TF]',  color: '#b2f2bb', desc: 'RSI below 30. Statistically stretched downside — not a standalone entry, wait for confirmation.' },
  { badge: '◇ RSI OBOUGHT  [TF]',   color: '#ffb300', desc: 'RSI above 72. Price extended to the upside — consider reducing longs.' },
  { badge: '◉ BULL ENGULF  [TF]',   color: '#00d47e', desc: 'Green candle fully engulfs prior red candle and undercuts its low. Classic reversal signal.' },
  { badge: '◉ BEAR ENGULF  [TF]',   color: '#f03e3e', desc: 'Red candle fully engulfs prior green candle and exceeds its high. Bearish reversal pattern.' },
  { badge: '● VOL SPIKE  [TF]',     color: '#cc5de8', desc: 'Volume exceeded 3.5× the 20-bar average. Unusual participation — often precedes sustained move.' },
  { badge: '⊘ EMA50 BREAK  [TF]',   color: '#f03e3e', desc: 'Close slipped below 50-period EMA. Key trend-filter sell signal used by institutional algos.' },
  { badge: '⊘ EMA50 RECLAIM  [TF]', color: '#00d47e', desc: 'Close reclaimed 50-period EMA after being below. Trend-filter buy confirmation.' },
  { badge: '▲ ICEBERG ASK',           color: '#ff9500', desc: 'Top ask ≥ 4× avg of next 5 levels. Hidden sell wall absorbing buys. Requires Level 2 panel.' },
  { badge: '▲ ICEBERG BID',           color: '#00d47e', desc: 'Top bid ≥ 4× avg of next 5 levels. Hidden buy wall absorbing sells. Requires Level 2 panel.' },
  { badge: '★ GOLDEN CROSS [TF]',     color: '#ffd43b', desc: 'EMA50 crossed above EMA200. Major trend flip to bullish — strong swing long confirmation.' },
  { badge: '☠ DEATH CROSS [TF]',      color: '#f03e3e', desc: 'EMA50 crossed below EMA200. Major trend flip to bearish — serious warning for open longs.' },
  { badge: '◈ BB SQUEEZE [TF]',       color: '#ffd43b', desc: 'Bollinger Bands compressed to < 50% of recent average width. Price is coiling — expect an explosive move soon.' },
  { badge: '◈ BB BREAKOUT [TF]',      color: '#00d47e', desc: 'Price broke above upper Bollinger Band after a squeeze. Momentum expanding to the upside.' },
  { badge: '◈ BB BREAKDOWN [TF]',     color: '#f03e3e', desc: 'Price broke below lower Bollinger Band after a squeeze. Momentum expanding to the downside.' },
  { badge: '⊕ STOCH CROSS [TF]',      color: '#a9e34b', desc: 'Stochastic %K crossed above %D while below 25 (oversold). Classic swing entry signal.' },
  { badge: '⬢ MA50 BOUNCE [TF]',      color: '#00d47e', desc: 'Price dipped to EMA50 and reclaimed it. High-value buy-the-dip signal in an existing uptrend.' },
  { badge: '⬢ MA200 BOUNCE [TF]',     color: '#ffd43b', desc: 'Price bounced off EMA200. Major long-term support reclaim — one of the highest-quality swing long setups.' },
];

// ── DOM ───────────────────────────────────────────────────────────────────────
function _buildDOM(p) {
  const wrap = document.getElementById('canvas-wrap-' + p.idx);
  if (!wrap) return;
  wrap.style.display = 'flex'; wrap.style.flexDirection = 'column'; wrap.style.padding = '0';

  const ttRows = _GUIDE.map(s =>
    `<div class="con-tt-row"><span class="con-tt-badge" style="color:${s.color}">${_esc(s.badge)}</span>` +
    `<span class="con-tt-desc">${_esc(s.desc)}</span></div>`
  ).join('');

  wrap.innerHTML = `
    <div class="con-header">
      <span class="con-title">BRAIN v1.0</span>
      <span class="con-ticker">${p.ticker}</span>
      <span class="con-status" id="con-status-${p.idx}">initialising…</span>
      <button class="con-live-btn" id="con-live-btn-${p.idx}"
        onclick="window._conToggleLive(${p.idx})">LIVE ○</button>
      <div class="con-info-wrap">
        <button class="con-info-btn">?</button>
        <div class="con-tooltip">
          <div class="con-tt-title">SIGNAL GUIDE</div>${ttRows}
        </div>
      </div>
      <button class="con-clr-btn"
        onclick="(function(){var l=document.getElementById('con-log-${p.idx}');if(l)l.innerHTML='';})()">CLR</button>
    </div>
    <div class="con-log" id="con-log-${p.idx}"></div>
    <div class="con-cmd-wrap">
      <span class="con-cmd-prompt">&gt;</span>
      <textarea class="con-cmd-input" id="con-cmd-${p.idx}" rows="2"
        placeholder="command / query…"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._conRunCmd(${p.idx});}"></textarea>
      <button class="con-cmd-send" onclick="window._conRunCmd(${p.idx})">▶</button>
    </div>
  `;
}

// ── EMIT ──────────────────────────────────────────────────────────────────────
function _emit(p, color, badge, detail, weight, direction) {
  const log = document.getElementById('con-log-' + p.idx);
  if (!log) return;
  const ts  = new Date().toTimeString().slice(0, 8);
  const row = document.createElement('div');
  row.className = 'con-row';

  // Backdrop bar (weight% wide, colored at ~10% opacity)
  let barHtml = '';
  if (weight != null) {
    const alpha = direction === 'bull' ? '18' : direction === 'bear' ? '18' : '10';
    barHtml = `<div class="con-bar" style="width:${weight}%;background:${color}${alpha}"></div>`;
  }

  const weightHtml = weight != null
    ? `<span class="con-weight" style="color:${color}80">${weight}%</span>` : '';

  const dirHtml = direction === 'bull' ? `<span class="con-dir bull">BULL</span>`
                : direction === 'bear' ? `<span class="con-dir bear">BEAR</span>`
                : '';

  row.innerHTML =
    barHtml +
    `<span class="con-ts">${ts}</span>` +
    `<span class="con-badge" style="color:${color}">${_esc(badge)}</span>` +
    `<span class="con-detail">${_esc(detail)}</span>` +
    weightHtml +
    dirHtml;

  log.appendChild(row);
  if (log.children.length > LOG_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── PANEL OUTLINE SYSTEM ──────────────────────────────────────────────────────
function _outlinePanel(idx, color) {
  const el = document.getElementById('chart-panel-' + idx);
  if (!el) return;
  const prev = _outlined.get(idx);
  if (prev?.clearTimer) clearTimeout(prev.clearTimer);
  el.style.outline       = `2px solid ${color}`;
  el.style.outlineOffset = '-2px';
  const t = setTimeout(() => {
    const cur = document.getElementById('chart-panel-' + idx);
    if (cur) { cur.style.outline = ''; cur.style.outlineOffset = ''; }
    _outlined.delete(idx);
  }, 45_000);
  _outlined.set(idx, { color, ts: Date.now(), clearTimer: t });
}

function _findChartPanel(excludeIdx) {
  const cands = App.panels.filter(q =>
    q.idx !== excludeIdx && (q.widgetMode || 'candles') === 'candles'
  );
  if (!cands.length) return null;
  const free = cands.filter(q => !_outlined.has(q.idx));
  if (free.length) return free[0];
  // All outlined — override the one outlined longest ago
  return cands.sort((a, b) => (_outlined.get(a.idx)?.ts || 0) - (_outlined.get(b.idx)?.ts || 0))[0];
}

// ── AUTO-CONTROL ──────────────────────────────────────────────────────────────
function _autoControl(conPanel, sig) {
  if (!conPanel._conLive || !sig.autoAction) return;
  const act = sig.autoAction;

  if (act.type === 'level2') {
    const l2 = App.panels.find(q =>
      q.idx !== conPanel.idx && q.widgetMode === 'level2'
    );
    if (l2) _outlinePanel(l2.idx, sig.color);
    return;
  }

  if (act.type === 'chart') {
    const target = _findChartPanel(conPanel.idx);
    if (!target) return;
    if (act.tf && target.tf !== act.tf) window.setPanelTF?.(target.idx, act.tf);
    if (act.utility) window.setUtilityMode?.(target.idx, act.utility);
    _outlinePanel(target.idx, sig.color);
  }
}

// ── WINDOW HANDLERS ───────────────────────────────────────────────────────────
window._conToggleLive = function(idx) {
  const p = App.panels.find(q => q.idx === idx); if (!p) return;
  p._conLive = !p._conLive;
  const btn = document.getElementById('con-live-btn-' + idx);
  if (btn) { btn.textContent = p._conLive ? 'LIVE ●' : 'LIVE ○'; btn.classList.toggle('active', p._conLive); }
  _emit(p, '#6a8099', 'SYS', p._conLive
    ? 'auto-control ON — signals will redirect panels'
    : 'auto-control OFF');
};

window._conRunCmd = function(idx) {
  const input = document.getElementById('con-cmd-' + idx); if (!input) return;
  const cmd = input.value.trim(); if (!cmd) return;
  input.value = '';
  const p = App.panels.find(q => q.idx === idx); if (!p) return;
  _emit(p, '#3d5066', '>', cmd);
  // Future: route to AI / bot dispatcher
  _emit(p, '#4dabf7', 'SYS', 'command input active — AI integration coming soon');
};

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function _runScan(p) {
  if (!p._conActive) return;
  const ticker = p.ticker;
  const now    = Date.now();
  const sigs   = [];

  _detectIceberg(ticker).forEach(s => sigs.push(s));

  for (const cfg of TFS) {
    let candles;
    try { candles = await _fetchCandles(ticker, cfg); } catch(_e) { continue; }
    if (!candles?.length) continue;
    [
      ..._detectLargeCandle(candles, cfg),
      ..._detectMacd(candles, cfg),
      ..._detectRSI(candles, cfg),
      ..._detectEngulf(candles, cfg),
      ..._detectVolSpike(candles, cfg),
      ..._detectEMA50Break(candles, cfg),
      ..._detectGoldenCross(candles, cfg),
      ..._detectBBSqueeze(candles, cfg),
      ..._detectStoch(candles, cfg),
      ..._detectMABounce(candles, cfg),
    ].forEach(s => sigs.push(s));
  }

  sigs.forEach(sig => {
    const ck = `${ticker}_${sig.key}`;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + COOLDOWN);
    _emit(p, sig.color, sig.badge, `${ticker}  ${sig.detail}`, sig.weight, sig.direction);
    _autoControl(p, sig);
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

// ── MATH ──────────────────────────────────────────────────────────────────────
function _emaArr(data, n) {
  const k = 2 / (n + 1), out = [data[0]];
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
    g = (g*(n-1) + Math.max(ch[i], 0)) / n;
    l = (l*(n-1) + Math.max(-ch[i], 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function _macdHist(closes) {
  if (closes.length < 36) return null;
  const e12  = _emaArr(closes, 12), e26 = _emaArr(closes, 26);
  const line = e12.map((v, i) => v - e26[i]).slice(25);
  if (line.length < 10) return null;
  const sig  = _emaArr(line, 9);
  return line.map((v, i) => v - sig[i]);
}

// ── SIGNAL DETECTORS ──────────────────────────────────────────────────────────
function _detectLargeCandle(candles, cfg) {
  if (candles.length < 22) return [];
  const lbl    = cfg.tf.toUpperCase();
  const last20 = candles.slice(-21, -1);
  const avgBody = last20.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / last20.length;
  const avgVol  = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const c       = last20[last20.length - 1];
  const body    = c.c - c.o;
  const ratio   = avgBody > 0 ? Math.abs(body) / avgBody : 0;
  if (ratio < 2.5) return [];
  const weight = Math.round(Math.min(95, 50 + (ratio - 2.5) * 14));
  const vTag   = avgVol > 0 ? `  vol ${((c.v||0)/avgVol).toFixed(1)}x` : '';
  if (body < 0) return [{ key:`drop_${lbl}`, color:'#f03e3e', badge:`▼ DROP ${lbl}`, detail:`${ratio.toFixed(1)}x avg body${vTag}`,
    direction:'bear', weight, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  return          [{ key:`pump_${lbl}`, color:'#00d47e', badge:`▲ PUMP ${lbl}`, detail:`${ratio.toFixed(1)}x avg body${vTag}`,
    direction:'bull', weight, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectMacd(candles, cfg) {
  const lbl  = cfg.tf.toUpperCase();
  const hist = _macdHist(candles.map(c => c.c));
  if (!hist || hist.length < 3) return [];
  const n = hist.length;
  const [h2, h1, h0] = [hist[n-3], hist[n-2], hist[n-1]];
  const out = [];
  if (h2 < h1 && h1 <= h0 && h0 < 0)
    out.push({ key:`macd_bot_${lbl}`, color:'#4dabf7', badge:`⬡ MACD BOT ${lbl}`, detail:`hist ${h0.toFixed(2)} turning up`,
      direction:'bull', weight:58, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (h1 < 0 && h0 >= 0)
    out.push({ key:`macd_cross_${lbl}`, color:'#74c0fc', badge:`⬡ MACD CROSS ${lbl}`, detail:`histogram crossed zero`,
      direction:'bull', weight:78, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (h2 > h1 && h1 >= h0 && h0 > 0)
    out.push({ key:`macd_top_${lbl}`, color:'#ff9500', badge:`⬡ MACD TOP ${lbl}`, detail:`hist ${h0.toFixed(2)} turning down`,
      direction:'bear', weight:55, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectRSI(candles, cfg) {
  const lbl    = cfg.tf.toUpperCase();
  const closes = candles.map(c => c.c);
  const r = _rsi(closes, 14); if (r === null) return [];
  const hist  = _macdHist(closes);
  const hn    = hist?.length;
  const macdUp = hist && hn >= 2 && hist[hn-1] > hist[hn-2] && hist[hn-1] < 0;
  const out = [];
  if (r < 35 && macdUp)
    out.push({ key:`rsi_entry_${lbl}`, color:'#a9e34b', badge:`◆ RSI ENTRY ${lbl}`, detail:`RSI ${r.toFixed(1)} · MACD hist turning up`,
      direction:'bull', weight:85, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  else if (r < 30)
    out.push({ key:`rsi_os_${lbl}`, color:'#b2f2bb', badge:`◇ RSI OVERSOLD ${lbl}`, detail:`RSI ${r.toFixed(1)}`,
      direction:'bull', weight:38, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  if (r > 72)
    out.push({ key:`rsi_ob_${lbl}`, color:'#ffb300', badge:`◇ RSI OBOUGHT ${lbl}`, detail:`RSI ${r.toFixed(1)}`,
      direction:'bear', weight:38, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  return out;
}

function _detectEngulf(candles, cfg) {
  if (candles.length < 3) return [];
  const lbl = cfg.tf.toUpperCase();
  const p   = candles[candles.length - 3], c = candles[candles.length - 2];
  const pb  = c.c - c.o, qb = p.c - p.o;
  const out = [];
  if (qb < 0 && pb > 0 && pb > Math.abs(qb) * 1.05 && c.l <= p.l)
    out.push({ key:`bull_engulf_${lbl}`, color:'#00d47e', badge:`◉ BULL ENGULF ${lbl}`, detail:`${(pb/Math.abs(qb)).toFixed(1)}x prev body`,
      direction:'bull', weight:62, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (qb > 0 && pb < 0 && Math.abs(pb) > qb * 1.05 && c.h >= p.h)
    out.push({ key:`bear_engulf_${lbl}`, color:'#f03e3e', badge:`◉ BEAR ENGULF ${lbl}`, detail:`${(Math.abs(pb)/qb).toFixed(1)}x prev body`,
      direction:'bear', weight:62, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectVolSpike(candles, cfg) {
  if (candles.length < 22) return [];
  const lbl    = cfg.tf.toUpperCase();
  const last20 = candles.slice(-21, -1);
  const avg    = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const c      = last20[last20.length - 1];
  if (avg <= 0 || (c.v || 0) <= 3.5 * avg) return [];
  const ratio = (c.v||0) / avg;
  const dir   = c.c >= c.o ? 'bull' : 'bear';
  return [{ key:`vol_${lbl}`, color:'#cc5de8', badge:`● VOL SPIKE ${lbl}`, detail:`${ratio.toFixed(1)}x avg volume`,
    direction: dir, weight: Math.round(Math.min(85, 45 + ratio * 7)),
    autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectEMA50Break(candles, cfg) {
  if (candles.length < 55) return [];
  const lbl    = cfg.tf.toUpperCase();
  const closes = candles.map(c => c.c);
  const ema    = _emaArr(closes, 50);
  const n      = ema.length;
  const out    = [];
  if (closes[n-2] > ema[n-2] && closes[n-1] < ema[n-1])
    out.push({ key:`ema50_dn_${lbl}`, color:'#f03e3e', badge:`⊘ EMA50 BREAK ${lbl}`, detail:`closed below EMA50`,
      direction:'bear', weight:70, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (closes[n-2] < ema[n-2] && closes[n-1] > ema[n-1])
    out.push({ key:`ema50_up_${lbl}`, color:'#00d47e', badge:`⊘ EMA50 RECLAIM ${lbl}`, detail:`closed above EMA50`,
      direction:'bull', weight:70, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

// ── SWING DETECTORS ───────────────────────────────────────────────────────────

function _detectGoldenCross(candles, cfg) {
  if (candles.length < 202) return [];
  const lbl    = cfg.tf.toUpperCase();
  const closes = candles.map(c => c.c);
  const e50    = _emaArr(closes, 50);
  const e200   = _emaArr(closes, 200);
  const n = e50.length;
  const out = [];
  if (e50[n-2] < e200[n-2] && e50[n-1] > e200[n-1])
    out.push({ key:`golden_${lbl}`, color:'#ffd43b', badge:`★ GOLDEN CROSS ${lbl}`,
      detail:`EMA50 crossed above EMA200`,
      direction:'bull', weight:88, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (e50[n-2] > e200[n-2] && e50[n-1] < e200[n-1])
    out.push({ key:`death_${lbl}`, color:'#f03e3e', badge:`☠ DEATH CROSS ${lbl}`,
      detail:`EMA50 crossed below EMA200`,
      direction:'bear', weight:88, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectBBSqueeze(candles, cfg) {
  if (candles.length < 65) return [];
  const lbl    = cfg.tf.toUpperCase();
  const closes = candles.map(c => c.c);
  const n      = closes.length;

  function _bb(arr) {
    const mid = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((s, v) => s + (v - mid) ** 2, 0) / arr.length);
    return { mid, upper: mid + 2*std, lower: mid - 2*std, width: std > 0 ? 4*std/mid : 0 };
  }

  const curBB   = _bb(closes.slice(-20));
  const avgWidth = Array.from({ length: 20 }, (_, i) =>
    _bb(closes.slice(n - 40 + i, n - 20 + i)).width
  ).reduce((a, b) => a + b, 0) / 20;

  if (avgWidth === 0 || curBB.width > avgWidth * 0.55) return [];

  const price = closes[n-1];
  if (price > curBB.upper)
    return [{ key:`bb_up_${lbl}`, color:'#00d47e', badge:`◈ BB BREAKOUT ${lbl}`,
      detail:`broke above upper band after squeeze`,
      direction:'bull', weight:76, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  if (price < curBB.lower)
    return [{ key:`bb_dn_${lbl}`, color:'#f03e3e', badge:`◈ BB BREAKDOWN ${lbl}`,
      detail:`broke below lower band after squeeze`,
      direction:'bear', weight:76, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  return [{ key:`bb_sq_${lbl}`, color:'#ffd43b', badge:`◈ BB SQUEEZE ${lbl}`,
    detail:`bands at ${(curBB.width*100).toFixed(1)}% vs ${(avgWidth*100).toFixed(1)}% avg — coiling`,
    direction:'neutral', weight:52, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectStoch(candles, cfg) {
  if (candles.length < 20) return [];
  const lbl = cfg.tf.toUpperCase();
  const N   = 14;
  const ks  = [];
  for (let i = N - 1; i < candles.length; i++) {
    const sl = candles.slice(i - N + 1, i + 1);
    const lo = Math.min(...sl.map(c => c.l));
    const hi = Math.max(...sl.map(c => c.h));
    ks.push(hi === lo ? 50 : (candles[i].c - lo) / (hi - lo) * 100);
  }
  if (ks.length < 4) return [];
  const kNow  = ks[ks.length - 1];
  const kPrev = ks[ks.length - 2];
  const d     = (ks[ks.length-1] + ks[ks.length-2] + ks[ks.length-3]) / 3;
  const dPrev = (ks[ks.length-2] + ks[ks.length-3] + ks[ks.length-4]) / 3;
  const out = [];
  if (kNow < 25 && kPrev < d    && kNow > d)
    out.push({ key:`stoch_os_${lbl}`, color:'#a9e34b', badge:`⊕ STOCH CROSS ${lbl}`,
      detail:`%K ${kNow.toFixed(1)} crossed above %D in oversold`,
      direction:'bull', weight:72, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  if (kNow > 75 && kPrev > dPrev && kNow < d)
    out.push({ key:`stoch_ob_${lbl}`, color:'#ff9500', badge:`⊕ STOCH CROSS ${lbl}`,
      detail:`%K ${kNow.toFixed(1)} crossed below %D in overbought`,
      direction:'bear', weight:65, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  return out;
}

function _detectMABounce(candles, cfg) {
  if (candles.length < 55) return [];
  const lbl    = cfg.tf.toUpperCase();
  const closes = candles.map(c => c.c);
  const n      = closes.length;
  const e50    = _emaArr(closes, 50);
  const price  = closes[n-1], prev = closes[n-2];
  const out    = [];

  if (prev <= e50[n-2] * 1.003 && price > e50[n-1])
    out.push({ key:`ma50_bounce_${lbl}`, color:'#00d47e', badge:`⬢ MA50 BOUNCE ${lbl}`,
      detail:`price reclaimed EMA50 after touching it`,
      direction:'bull', weight:68, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });

  if (closes.length >= 205) {
    const e200  = _emaArr(closes, 200);
    if (prev <= e200[n-2] * 1.003 && price > e200[n-1])
      out.push({ key:`ma200_bounce_${lbl}`, color:'#ffd43b', badge:`⬢ MA200 BOUNCE ${lbl}`,
        detail:`price reclaimed EMA200 — major long-term support`,
        direction:'bull', weight:82, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  }
  return out;
}

function _detectIceberg(ticker) {
  const panel = App.panels.find(q =>
    q.ticker === ticker && q.widgetMode === 'level2' && q._l2Asks?.length > 5 && q._l2Bids?.length > 5
  );
  if (!panel) return [];
  const out = [];
  const chk = (side, arr, badge, color, direction) => {
    const avg5 = arr.slice(1, 6).reduce((s, x) => s + x.qty, 0) / 5;
    if (avg5 > 0 && arr[0].qty > 4 * avg5)
      out.push({ key:`ice_${side}`, color, badge, detail:`${arr[0].qty.toFixed(2)} @ ${fmt(arr[0].price)}  (${(arr[0].qty/avg5).toFixed(1)}x top-5 avg)`,
        direction, weight:65, autoAction:{ type:'level2' } });
  };
  chk('ask', panel._l2Asks, '▲ ICEBERG ASK', '#ff9500', 'bear');
  chk('bid', panel._l2Bids, '▲ ICEBERG BID', '#00d47e', 'bull');
  return out;
}
