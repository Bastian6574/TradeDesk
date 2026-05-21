import { App } from '../../core/state.js';
import { fmt } from '../../core/utils.js';

const SCAN_MS   = 9_000;
const LOG_MAX   = 300;
const COOLDOWN  = 300_000; // 5-min per signal key
const _cache    = new Map(); // ticker_tf → { ts, data }
const _outlined = new Map(); // panelIdx → { color, ts, clearTimer }

let _swingData  = null;   // last fetched swing scan result
let _swingFetch = 0;      // timestamp of last fetch

const TFS = [
  { tf: '15m', period: '5d',  interval: '15m', ttl:  60_000, section: 'st' },
  { tf: '30m', period: '10d', interval: '30m', ttl: 120_000, section: 'st' },
  { tf:  '1h', period: '1mo', interval:  '1h', ttl: 300_000, section: 'lt' },
  { tf:  '1d', period: '1y',  interval:  '1d', ttl: 600_000, section: 'lt' },
];

// Added only when Live mode is on AND market state is VIOLENT
const LIVE_TFS = [
  { tf: '1m', period: '1d', interval: '1m', ttl: 15_000, section: 'st', liveOnly: true },
  { tf: '5m', period: '5d', interval: '5m', ttl: 30_000, section: 'st', liveOnly: true },
];

// ── START / STOP ──────────────────────────────────────────────────────────────
export function startConsole(p) {
  if (p._conTimer) { clearInterval(p._conTimer); p._conTimer = null; }
  _buildDOM(p);
  p._conActive         = true;
  p._conLive           = false;
  p._conCooldowns      = new Map();
  p._scanCount         = 0;
  p._conPrevStState    = null;
  p._conPrevLtState    = null;
  p._conPrevSocialLabel = null;
  _emit(p, '#6a8099', 'SYS', `monitoring ${p.ticker} · scanning 15m 30m 1h 1d`, null, null, 'st');
  setTimeout(() => _checkSwingEntries(p), 2000); // defer so Brain initialises first
  _runScan(p);
  p._conTimer = setInterval(() => _runScan(p), SCAN_MS);
}

export function stopConsole(p) {
  p._conActive = false;
  if (p._conTimer) { clearInterval(p._conTimer); p._conTimer = null; }
}

// ── SIGNAL GUIDE ─────────────────────────────────────────────────────────────
const _GUIDE = [
  { badge: '▼ DROP  [TF]',          color: '#f03e3e', desc: 'Last closed candle body ≥ 2.5× the 20-bar average. Strong momentum or news-driven move.' },
  { badge: '▲ PUMP  [TF]',          color: '#00d47e', desc: 'Same as DROP but bullish. Unusually large green body relative to recent average.' },
  { badge: '⬡ MACD BOT  [TF]',      color: '#4dabf7', desc: 'MACD histogram below zero but turning up two bars in a row. Early bearish-momentum fade — possible reversal.' },
  { badge: '⬡ MACD CROSS  [TF]',    color: '#74c0fc', desc: 'MACD histogram just crossed above zero. Bullish momentum confirmed on this timeframe.' },
  { badge: '⬡ MACD TOP  [TF]',      color: '#ff9500', desc: 'MACD histogram positive but turning down. Bullish momentum fading — tighten stops.' },
  { badge: '◆ RSI ENTRY  [TF]',     color: '#a9e34b', desc: 'RSI < 35 AND MACD histogram turning up simultaneously. Two-factor oversold confluence.' },
  { badge: '◇ RSI OVERSOLD  [TF]',  color: '#b2f2bb', desc: 'RSI below 30. Statistically stretched downside — wait for confirmation.' },
  { badge: '◇ RSI OBOUGHT  [TF]',   color: '#ffb300', desc: 'RSI above 72. Price extended to the upside — consider reducing longs.' },
  { badge: '◉ BULL ENGULF  [TF]',   color: '#00d47e', desc: 'Green candle fully engulfs prior red candle and undercuts its low. Classic reversal signal.' },
  { badge: '◉ BEAR ENGULF  [TF]',   color: '#f03e3e', desc: 'Red candle fully engulfs prior green candle and exceeds its high. Bearish reversal.' },
  { badge: '● VOL SPIKE  [TF]',     color: '#cc5de8', desc: 'Volume exceeded 3.5× the 20-bar average. Unusual participation.' },
  { badge: '⊘ EMA50 BREAK  [TF]',   color: '#f03e3e', desc: 'Close slipped below 50-period EMA. Key trend-filter sell signal.' },
  { badge: '⊘ EMA50 RECLAIM  [TF]', color: '#00d47e', desc: 'Close reclaimed 50-period EMA after being below. Trend-filter buy confirmation.' },
  { badge: '▲ ICEBERG ASK',          color: '#ff9500', desc: 'Top ask ≥ 4× avg of next 5 levels. Hidden sell wall absorbing buys. Requires Level 2 panel.' },
  { badge: '▲ ICEBERG BID',          color: '#00d47e', desc: 'Top bid ≥ 4× avg of next 5 levels. Hidden buy wall absorbing sells. Requires Level 2 panel.' },
  { badge: '★ GOLDEN CROSS [TF]',    color: '#ffd43b', desc: 'EMA50 crossed above EMA200. Major trend flip to bullish.' },
  { badge: '☠ DEATH CROSS [TF]',     color: '#f03e3e', desc: 'EMA50 crossed below EMA200. Major trend flip to bearish.' },
  { badge: '◈ BB SQUEEZE [TF]',      color: '#ffd43b', desc: 'Bollinger Bands compressed to < 50% of recent avg width. Price is coiling.' },
  { badge: '◈ BB BREAKOUT [TF]',     color: '#00d47e', desc: 'Price broke above upper BB after a squeeze. Momentum expanding up.' },
  { badge: '◈ BB BREAKDOWN [TF]',    color: '#f03e3e', desc: 'Price broke below lower BB after a squeeze. Momentum expanding down.' },
  { badge: '⊕ STOCH CROSS [TF]',     color: '#a9e34b', desc: 'Stochastic %K crossed above %D while below 25 (oversold).' },
  { badge: '⬢ MA50 BOUNCE [TF]',       color: '#00d47e', desc: 'Price dipped to EMA50 and reclaimed it. Buy-the-dip in an uptrend.' },
  { badge: '⬢ MA200 BOUNCE [TF]',      color: '#ffd43b', desc: 'Price bounced off EMA200. Major long-term support reclaim.' },
  { badge: '◈ AVG WATCH [TICKER]',     color: '#ff9500', desc: 'Price within 1.5% of your set average — unclear direction. Watch for a breakout or breakdown.' },
  { badge: '⚠ SELL WARN [TICKER]',     color: '#f03e3e', desc: 'Price above your average with bearish momentum. Probability-weighted warning of breaking down through your cost basis.' },
  { badge: '⚠⚠ SELL WARN !! [TICKER]',color: '#ff3333', desc: 'Critical: price within 1% of your average with strong bearish momentum. Imminent break-down risk.' },
  { badge: '⚠⚠⚠ SELL BREAK [TICKER]', color: '#f03e3e', desc: 'Price just broke BELOW your set average. Key support level lost.' },
  { badge: '◆ AVG BREAK ↑ [TICKER]',   color: '#00d47e', desc: 'Price below your average with bullish momentum. Probability-weighted chance of reclaiming your cost basis.' },
  { badge: '◆◆ AVG RECLAIM [TICKER]',  color: '#00d47e', desc: 'Price just reclaimed your set average. Key resistance level recovered.' },
  { badge: '◆ [1H] TICKER RISKY ENTRY',   color: '#4dabf7', desc: '1-hour timeframe swing setup. RSI/MACD/volume confluence. High-risk, fast-moving entry — confirm before trading.' },
  { badge: '◆◆ [1D] TICKER GREAT ENTRY',  color: '#a9e34b', desc: 'Daily timeframe swing setup. Strong technical confluence. Good risk/reward entry point for medium-term swing.' },
  { badge: '◆◆◆ [1W] TICKER SUPERB ENTRY',color: '#ffd43b', desc: 'Weekly timeframe setup. Rare, high-conviction long-term entry. Best risk/reward — consider larger position.' },
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
        onclick="(function(){['con-log-lt-${p.idx}','con-log-st-${p.idx}'].forEach(id=>{var l=document.getElementById(id);if(l)l.innerHTML='';});})()">CLR</button>
    </div>

    <div class="con-section-hdr">
      <span class="con-section-title">LONGTERM TREND</span>
      <span class="con-section-dot">··</span>
      <span class="con-section-state" id="con-lt-state-${p.idx}">─</span>
      <span class="con-section-summary" id="con-lt-summary-${p.idx}"></span>
    </div>
    <div class="con-log con-log-lt" id="con-log-lt-${p.idx}"></div>

    <div class="con-section-hdr con-sw-hdr">
      <span class="con-section-title">SWING WATCH</span>
      <span class="con-section-dot">··</span>
      <span class="con-section-state" id="con-sw-state-${p.idx}">WATCHLIST</span>
      <button class="con-scan-btn" id="con-scan-btn-${p.idx}"
        onclick="window._conSwingScan(${p.idx})">⟳ SCAN</button>
    </div>
    <div class="con-log con-log-sw" id="con-log-sw-${p.idx}"></div>

    <div class="con-section-hdr">
      <span class="con-section-title">SHORTTERM TREND</span>
      <span class="con-section-dot">··</span>
      <span class="con-section-state" id="con-st-state-${p.idx}">─</span>
      <span class="con-section-summary" id="con-st-summary-${p.idx}"></span>
    </div>
    <div class="con-log con-log-st" id="con-log-st-${p.idx}"></div>

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
function _emit(p, color, badge, detail, weight, direction, section = 'st') {
  const logId = section === 'lt' ? `con-log-lt-${p.idx}` : section === 'sw' ? `con-log-sw-${p.idx}` : `con-log-st-${p.idx}`;
  const log = document.getElementById(logId);
  if (!log) return;
  const ts  = new Date().toTimeString().slice(0, 8);
  const row = document.createElement('div');
  row.className = 'con-row';

  let barHtml = '';
  if (weight != null) {
    const alpha = direction === 'bull' ? '18' : direction === 'bear' ? '18' : '10';
    barHtml = `<div class="con-bar" style="width:${weight}%;background:${color}${alpha}"></div>`;
  }
  const weightHtml = weight != null
    ? `<span class="con-weight" style="color:${color}80">${weight}%</span>` : '';
  const dirHtml = direction === 'bull' ? `<span class="con-dir bull">BULL</span>`
                : direction === 'bear' ? `<span class="con-dir bear">BEAR</span>` : '';

  row.innerHTML =
    barHtml +
    `<span class="con-ts">${ts}</span>` +
    `<span class="con-badge" style="color:${color}">${_esc(badge)}</span>` +
    `<span class="con-detail">${_esc(detail)}</span>` +
    weightHtml + dirHtml;

  log.appendChild(row);
  if (log.children.length > LOG_MAX) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── MARKET STATE ──────────────────────────────────────────────────────────────
function _marketState(candles) {
  if (!candles || candles.length < 28) return null;
  // ATR of last 14 bars vs prior 14 bars
  const atr = (slice) => slice.reduce((s, c, i) => {
    if (i === 0) return s + (c.h - c.l);
    return s + Math.max(c.h - c.l, Math.abs(c.h - slice[i-1].c), Math.abs(c.l - slice[i-1].c));
  }, 0) / slice.length;
  const recent = atr(candles.slice(-14));
  const prior  = atr(candles.slice(-28, -14));
  if (prior === 0) return null;
  const r = recent / prior;
  if (r < 0.75) return 'CALM';
  if (r < 1.7)  return 'ERRATIC';
  return 'VIOLENT';
}

const _STATE_COLOR = { CALM: '#4dabf7', ERRATIC: '#ff9500', VIOLENT: '#f03e3e' };

function _updateSectionState(idx, section, state) {
  const el = document.getElementById(`con-${section}-state-${idx}`);
  if (!el) return;
  if (!state) { el.textContent = '─'; el.style.color = '#3d5066'; return; }
  el.textContent = state;
  el.style.color = _STATE_COLOR[state] || '#6a8099';
  el.classList.toggle('con-state-violent', state === 'VIOLENT');
}

// ── BRAIN SUMMARY BADGE ───────────────────────────────────────────────────────
function _brainSummary(p, section) {
  const scores = [];

  // Tech breakdown (30%) — use timeframe-appropriate slices
  const tech = App._techData || App._sentimentData?.tech;
  if (tech?.breakdown) {
    const tfs = section === 'lt' ? ['1h', '4h', '1d'] : ['15m', '30m', '1h'];
    const vals = tfs.map(tf => tech.breakdown[tf]).filter(v => v != null);
    if (vals.length) scores.push({ s: vals.reduce((a, b) => a + b, 0) / vals.length, w: 0.30 });
  } else if (tech?.score != null) {
    scores.push({ s: Math.max(-1, Math.min(1, tech.score / 3)), w: 0.30 });
  }

  // F&G (10%, contrarian)
  const fng = App._sentimentData?.fng;
  if (fng?.value != null) {
    const fv = fng.value;
    const fb = fv < 25 ? 0.6 : fv < 40 ? 0.3 : fv < 60 ? 0 : fv < 75 ? -0.3 : -0.6;
    scores.push({ s: fb, w: 0.10 });
  }

  // News (15%)
  const news = App._sentimentData?.news;
  if (news) {
    const rel = (news.buy_count || 0) + (news.sell_count || 0);
    if (rel > 0) scores.push({ s: ((news.buy_count || 0) - (news.sell_count || 0)) / rel, w: 0.15 });
  }

  // Social (15%)
  const social = App._socialData;
  if (social?.score != null) {
    scores.push({ s: (social.score - 50) / 50, w: 0.15 });
  }

  // Recent signal directions from this section's log (30%)
  const logId = section === 'lt' ? `con-log-lt-${p.idx}` : `con-log-st-${p.idx}`;
  const log = document.getElementById(logId);
  if (log) {
    const dirs = Array.from(log.querySelectorAll('.con-dir')).slice(-20);
    const bulls = dirs.filter(r => r.classList.contains('bull')).length;
    const bears = dirs.filter(r => r.classList.contains('bear')).length;
    const total = bulls + bears;
    if (total > 0) scores.push({ s: (bulls - bears) / total, w: 0.30 });
  }

  if (!scores.length) return null;
  const tw = scores.reduce((a, b) => a + b.w, 0);
  const composite = scores.reduce((a, b) => a + b.s * b.w, 0) / tw;
  const pct = Math.round(Math.abs(composite) * 100);
  const label = composite > 0.08 ? 'BULL' : composite < -0.08 ? 'BEAR' : 'NEUT';
  const color = composite > 0.08 ? '#00d47e' : composite < -0.08 ? '#f03e3e' : '#ff9500';
  return { label, pct, color };
}

function _updateSectionSummary(idx, section, summary) {
  const el = document.getElementById(`con-${section}-summary-${idx}`);
  if (!el) return;
  if (!summary) { el.textContent = ''; return; }
  el.textContent = `${summary.label} ${summary.pct}%`;
  el.style.color = summary.color;
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

function _findChartPanel(excludeIdx, ticker) {
  const cands = App.panels.filter(q =>
    q.idx !== excludeIdx &&
    (q.widgetMode || 'candles') === 'candles' &&
    (!ticker || q.ticker === ticker)
  );
  if (!cands.length) return null;
  const free = cands.filter(q => !_outlined.has(q.idx));
  if (free.length) return free[0];
  return cands.sort((a, b) => (_outlined.get(a.idx)?.ts || 0) - (_outlined.get(b.idx)?.ts || 0))[0];
}

// ── AUTO-CONTROL ──────────────────────────────────────────────────────────────
function _autoControl(conPanel, sig) {
  if (!conPanel._conLive || !sig.autoAction) return;
  const act = sig.autoAction;
  if (act.type === 'level2') {
    const l2 = App.panels.find(q =>
      q.idx !== conPanel.idx && q.widgetMode === 'level2' && q.ticker === conPanel.ticker
    );
    if (l2) _outlinePanel(l2.idx, sig.color);
    return;
  }
  if (act.type === 'chart') {
    const target = _findChartPanel(conPanel.idx, conPanel.ticker);
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
    : 'auto-control OFF', null, null, 'st');
};

// ── COMMANDS ──────────────────────────────────────────────────────────────────
function _cmdHelp(p) {
  const cmds = [
    ['/analyze [TICKER]', 'full AI analysis: action, price targets, support/resistance, bull & bear case (defaults to current ticker)'],
    ['/scan',             'force-refresh the swing watchlist scan across all favorites'],
    ['/clear',            'clear all log sections'],
    ['/help',             'show this command list'],
  ];
  _emit(p, '#4dabf7', 'HELP', 'BRAIN v1.0 commands:', null, null, 'st');
  for (const [cmd, desc] of cmds)
    _emit(p, '#4dabf760', `  ${cmd}`, desc, null, null, 'st');
}

async function _cmdAnalyze(p, ticker) {
  _emit(p, '#ff9500', '◎ ANALYZE', `${ticker}  · gathering data, running AI…`, null, null, 'st');
  try {
    const res = await fetch(`/api/analyze/${encodeURIComponent(ticker)}`);
    if (!res.ok) { _emit(p, '#f03e3e', 'ERR', `HTTP ${res.status}`, null, null, 'st'); return; }
    const d = await res.json();
    if (d.error) { _emit(p, '#f03e3e', 'ERR', d.error, null, null, 'st'); return; }

    const aC = d.action === 'BUY' ? '#00d47e' : d.action === 'SELL' ? '#f03e3e' : d.action === 'WATCH' ? '#ffd43b' : '#6a8099';
    const aD = d.action === 'BUY' ? 'bull'    : d.action === 'SELL' ? 'bear'    : null;
    const cD = d.conviction === 'HIGH' ? '●●●' : d.conviction === 'MEDIUM' ? '●●○' : '●○○';
    _emit(p, aC,          `◎ ${d.action} ${ticker}`, `${cD} ${d.conviction} conviction  ·  $${d.price}`, 80, aD, 'st');
    if (d.summary)        _emit(p, '#c8d8e8',    '  ↳',      d.summary,    null, null, 'st');
    if (d.avg_price != null) {
      const pc = d.pnl_pct >= 0 ? '#00d47e' : '#f03e3e';
      _emit(p, pc, '  AVG', `cost $${d.avg_price}  P&L ${d.pnl_pct > 0 ? '+' : ''}${d.pnl_pct}%`, null, null, 'st');
    }
    if (d.price_target_1w != null)
      _emit(p, '#4dabf7', '  TARGETS', `1W $${d.price_target_1w}  ·  1M $${d.price_target_1m}  ·  stop $${d.stop_loss ?? '?'}`, null, null, 'st');
    if (d.support_1 != null)
      _emit(p, '#6a8099',  '  LEVELS',  `S1 $${d.support_1}  S2 $${d.support_2 ?? '?'}  ·  R1 $${d.resistance_1}  R2 $${d.resistance_2 ?? '?'}`, null, null, 'st');
    if (d.bull_case)      _emit(p, '#00d47e80', '  BULL ↑', d.bull_case,   null, null, 'st');
    if (d.bear_case)      _emit(p, '#f03e3e80', '  BEAR ↓', d.bear_case,   null, null, 'st');
    if (d.key_level)      _emit(p, '#ffd43b',   '  KEY',    d.key_level,   null, null, 'st');
    if (d.entry_zone && d.action !== 'SELL')
                          _emit(p, '#a9e34b',   '  ENTRY',  d.entry_zone,  null, null, 'st');
    _emit(p, '#2a3340', '  ·', `model: ${d.model ?? '?'}  ·  tf: ${d.timeframe_bias ?? '?'}  ·  ${new Date().toLocaleTimeString()}`, null, null, 'st');
  } catch (e) {
    _emit(p, '#f03e3e', 'ERR', String(e), null, null, 'st');
  }
}

window._conRunCmd = function(idx) {
  const input = document.getElementById('con-cmd-' + idx); if (!input) return;
  const raw = input.value.trim(); if (!raw) return;
  input.value = '';
  const p = App.panels.find(q => q.idx === idx); if (!p) return;
  _emit(p, '#3d5066', '>', raw, null, null, 'st');

  const parts = raw.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1);

  if      (cmd === '/help' || cmd === '/?')          _cmdHelp(p);
  else if (cmd === '/analyze' || cmd === '/a')        _cmdAnalyze(p, (args[0] || p.ticker).toUpperCase());
  else if (cmd === '/scan')                           window._conSwingScan(idx);
  else if (cmd === '/clear' || cmd === '/clr') {
    ['con-log-lt-', 'con-log-st-', 'con-log-sw-'].forEach(pfx => {
      const l = document.getElementById(pfx + idx); if (l) l.innerHTML = '';
    });
    _emit(p, '#3d5066', 'SYS', 'logs cleared', null, null, 'st');
  }
  else _emit(p, '#f03e3e', 'ERR', `unknown command "${_esc(raw)}" — type /help`, null, null, 'st');
};

window._conSwingScan = async function(idx) {
  const p = App.panels.find(q => q.idx === idx); if (!p) return;
  const btn = document.getElementById('con-scan-btn-' + idx);
  if (btn) { btn.textContent = '⟳ …'; btn.disabled = true; }
  await _checkSwingEntries(p, true);
  if (btn) { btn.textContent = '⟳ SCAN'; btn.disabled = false; }
};

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function _runScan(p) {
  if (!p._conActive) return;
  const ticker = p.ticker;
  const now    = Date.now();
  const sigs   = [];

  // Re-check swing entries every hour
  if (!p._swingLastCheck || Date.now() - p._swingLastCheck > 1_800_000) {
    p._swingLastCheck = Date.now();
    _checkSwingEntries(p).catch(() => {});
  }

  try { _detectIceberg(ticker).forEach(s => sigs.push(s)); } catch(_e) {}

  // Determine which TFs to scan (add 1m/5m when live + violent)
  let stCandles = null, ltCandles = null;
  const activeTFS = [...TFS];

  for (const cfg of activeTFS) {
    let candles;
    try { candles = await _fetchCandles(ticker, cfg); } catch(_e) { continue; }
    if (!candles?.length) continue;

    // Capture data for market state
    if (cfg.tf === '15m' && !stCandles) stCandles = candles;
    if (cfg.tf === '1d'  && !ltCandles) ltCandles = candles;

    try {
      const detectors = cfg.liveOnly
        ? [_detectLargeCandle, _detectMacd, _detectVolSpike, _detectEngulf]
        : [
            _detectLargeCandle, _detectMacd, _detectRSI, _detectEngulf,
            _detectVolSpike, _detectEMA50Break, _detectGoldenCross,
            _detectBBSqueeze, _detectStoch, _detectMABounce,
          ];
      detectors.flatMap(fn => fn(candles, cfg)).forEach(s => sigs.push(s));
    } catch(_e) {}
  }

  // Compute market states and detect transitions
  const stState = _marketState(stCandles);
  const ltState = _marketState(ltCandles);
  _updateSectionState(p.idx, 'st', stState);
  _updateSectionState(p.idx, 'lt', ltState);

  if (stState && p._conPrevStState && stState !== p._conPrevStState)
    _fetchAndEmitSocial(p, 'st', stState, p._conPrevStState);
  if (ltState && p._conPrevLtState && ltState !== p._conPrevLtState)
    _fetchAndEmitSocial(p, 'lt', ltState, p._conPrevLtState);
  if (stState) p._conPrevStState = stState;
  if (ltState) p._conPrevLtState = ltState;

  // Detect social sentiment label change
  const socialLabel = App._socialData?.label;
  if (socialLabel && p._conPrevSocialLabel !== null && socialLabel !== p._conPrevSocialLabel) {
    const dir   = socialLabel === 'BULLISH' ? 'bull' : socialLabel === 'BEARISH' ? 'bear' : null;
    const color = socialLabel === 'BULLISH' ? '#00d47e' : socialLabel === 'BEARISH' ? '#f03e3e' : '#ff9500';
    _emit(p, color, `◎ SOCIAL → ${socialLabel}`,
      `sentiment shifted: ${p._conPrevSocialLabel} → ${socialLabel}  score ${App._socialData?.score ?? '?'}/100`,
      App._socialData?.score ?? null, dir, 'st');
  }
  if (socialLabel) p._conPrevSocialLabel = socialLabel;

  // Update summary badges
  _updateSectionSummary(p.idx, 'st', _brainSummary(p, 'st'));
  _updateSectionSummary(p.idx, 'lt', _brainSummary(p, 'lt'));

  // Scan all user averages for break signals
  try { await _scanAverageBreaks(p); } catch (_e) {}

  // If live + short-term market is violent, re-scan with 1m/5m
  if (p._conLive && stState === 'VIOLENT') {
    for (const cfg of LIVE_TFS) {
      let candles;
      try { candles = await _fetchCandles(ticker, cfg); } catch(_e) { continue; }
      if (!candles?.length) continue;
      try {
        [_detectLargeCandle, _detectMacd, _detectVolSpike, _detectEngulf]
          .flatMap(fn => fn(candles, cfg)).forEach(s => sigs.push(s));
      } catch(_e) {}
    }
  }

  let emitted = 0;
  sigs.forEach(sig => {
    const ck = `${ticker}_${sig.key}`;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + COOLDOWN);
    _emit(p, sig.color, sig.badge, `${ticker}  ${sig.detail}`, sig.weight, sig.direction, sig.section || 'st');
    _autoControl(p, sig);
    emitted++;
  });

  p._scanCount = (p._scanCount || 0) + 1;
  if (p._scanCount % 33 === 0) {
    _emit(p, '#2a3340', 'SYS', `${ticker} · no new signals · ${new Date().toTimeString().slice(0,8)}`, null, null, 'st');
  }

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
  const sec    = cfg.section || 'st';
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
    direction:'bear', weight, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  return          [{ key:`pump_${lbl}`, color:'#00d47e', badge:`▲ PUMP ${lbl}`, detail:`${ratio.toFixed(1)}x avg body${vTag}`,
    direction:'bull', weight, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectMacd(candles, cfg) {
  const lbl  = cfg.tf.toUpperCase();
  const sec  = cfg.section || 'st';
  const hist = _macdHist(candles.map(c => c.c));
  if (!hist || hist.length < 3) return [];
  const n = hist.length;
  const [h2, h1, h0] = [hist[n-3], hist[n-2], hist[n-1]];
  const out = [];
  if (h2 < h1 && h1 <= h0 && h0 < 0)
    out.push({ key:`macd_bot_${lbl}`, color:'#4dabf7', badge:`⬡ MACD BOT ${lbl}`, detail:`hist ${h0.toFixed(2)} turning up`,
      direction:'bull', weight:58, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (h1 < 0 && h0 >= 0)
    out.push({ key:`macd_cross_${lbl}`, color:'#74c0fc', badge:`⬡ MACD CROSS ${lbl}`, detail:`histogram crossed zero`,
      direction:'bull', weight:78, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (h2 > h1 && h1 >= h0 && h0 > 0)
    out.push({ key:`macd_top_${lbl}`, color:'#ff9500', badge:`⬡ MACD TOP ${lbl}`, detail:`hist ${h0.toFixed(2)} turning down`,
      direction:'bear', weight:55, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectRSI(candles, cfg) {
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const closes = candles.map(c => c.c);
  const r = _rsi(closes, 14); if (r === null) return [];
  const hist  = _macdHist(closes);
  const hn    = hist?.length;
  const macdUp = hist && hn >= 2 && hist[hn-1] > hist[hn-2] && hist[hn-1] < 0;
  const out = [];
  if (r < 35 && macdUp)
    out.push({ key:`rsi_entry_${lbl}`, color:'#a9e34b', badge:`◆ RSI ENTRY ${lbl}`, detail:`RSI ${r.toFixed(1)} · MACD hist turning up`,
      direction:'bull', weight:85, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  else if (r < 30)
    out.push({ key:`rsi_os_${lbl}`, color:'#b2f2bb', badge:`◇ RSI OVERSOLD ${lbl}`, detail:`RSI ${r.toFixed(1)}`,
      direction:'bull', weight:38, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  if (r > 72)
    out.push({ key:`rsi_ob_${lbl}`, color:'#ffb300', badge:`◇ RSI OBOUGHT ${lbl}`, detail:`RSI ${r.toFixed(1)}`,
      direction:'bear', weight:38, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  return out;
}

function _detectEngulf(candles, cfg) {
  if (candles.length < 3) return [];
  const lbl = cfg.tf.toUpperCase();
  const sec = cfg.section || 'st';
  const p   = candles[candles.length - 3], c = candles[candles.length - 2];
  const pb  = c.c - c.o, qb = p.c - p.o;
  const out = [];
  if (qb < 0 && pb > 0 && pb > Math.abs(qb) * 1.05 && c.l <= p.l)
    out.push({ key:`bull_engulf_${lbl}`, color:'#00d47e', badge:`◉ BULL ENGULF ${lbl}`, detail:`${(pb/Math.abs(qb)).toFixed(1)}x prev body`,
      direction:'bull', weight:62, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (qb > 0 && pb < 0 && Math.abs(pb) > qb * 1.05 && c.h >= p.h)
    out.push({ key:`bear_engulf_${lbl}`, color:'#f03e3e', badge:`◉ BEAR ENGULF ${lbl}`, detail:`${(Math.abs(pb)/qb).toFixed(1)}x prev body`,
      direction:'bear', weight:62, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectVolSpike(candles, cfg) {
  if (candles.length < 22) return [];
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const last20 = candles.slice(-21, -1);
  const avg    = last20.reduce((s, c) => s + (c.v || 0), 0) / last20.length;
  const c      = last20[last20.length - 1];
  if (avg <= 0 || (c.v || 0) <= 3.5 * avg) return [];
  const ratio = (c.v||0) / avg;
  const dir   = c.c >= c.o ? 'bull' : 'bear';
  return [{ key:`vol_${lbl}`, color:'#cc5de8', badge:`● VOL SPIKE ${lbl}`, detail:`${ratio.toFixed(1)}x avg volume`,
    direction: dir, weight: Math.round(Math.min(85, 45 + ratio * 7)), section: sec,
    autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectEMA50Break(candles, cfg) {
  if (candles.length < 55) return [];
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const closes = candles.map(c => c.c);
  const ema    = _emaArr(closes, 50);
  const n      = ema.length;
  const out    = [];
  if (closes[n-2] > ema[n-2] && closes[n-1] < ema[n-1])
    out.push({ key:`ema50_dn_${lbl}`, color:'#f03e3e', badge:`⊘ EMA50 BREAK ${lbl}`, detail:`closed below EMA50`,
      direction:'bear', weight:70, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (closes[n-2] < ema[n-2] && closes[n-1] > ema[n-1])
    out.push({ key:`ema50_up_${lbl}`, color:'#00d47e', badge:`⊘ EMA50 RECLAIM ${lbl}`, detail:`closed above EMA50`,
      direction:'bull', weight:70, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectGoldenCross(candles, cfg) {
  if (candles.length < 202) return [];
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const closes = candles.map(c => c.c);
  const e50    = _emaArr(closes, 50);
  const e200   = _emaArr(closes, 200);
  const n = e50.length;
  const out = [];
  if (e50[n-2] < e200[n-2] && e50[n-1] > e200[n-1])
    out.push({ key:`golden_${lbl}`, color:'#ffd43b', badge:`★ GOLDEN CROSS ${lbl}`,
      detail:`EMA50 crossed above EMA200`, direction:'bull', weight:88, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (e50[n-2] > e200[n-2] && e50[n-1] < e200[n-1])
    out.push({ key:`death_${lbl}`, color:'#f03e3e', badge:`☠ DEATH CROSS ${lbl}`,
      detail:`EMA50 crossed below EMA200`, direction:'bear', weight:88, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  return out;
}

function _detectBBSqueeze(candles, cfg) {
  if (candles.length < 65) return [];
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const closes = candles.map(c => c.c);
  const n      = closes.length;
  function _bb(arr) {
    const mid = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((s, v) => s + (v - mid) ** 2, 0) / arr.length);
    return { mid, upper: mid + 2*std, lower: mid - 2*std, width: std > 0 ? 4*std/mid : 0 };
  }
  const curBB    = _bb(closes.slice(-20));
  const avgWidth = Array.from({ length: 20 }, (_, i) =>
    _bb(closes.slice(n - 40 + i, n - 20 + i)).width
  ).reduce((a, b) => a + b, 0) / 20;
  if (avgWidth === 0 || curBB.width > avgWidth * 0.55) return [];
  const price = closes[n-1];
  if (price > curBB.upper)
    return [{ key:`bb_up_${lbl}`, color:'#00d47e', badge:`◈ BB BREAKOUT ${lbl}`,
      detail:`broke above upper band after squeeze`, direction:'bull', weight:76, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  if (price < curBB.lower)
    return [{ key:`bb_dn_${lbl}`, color:'#f03e3e', badge:`◈ BB BREAKDOWN ${lbl}`,
      detail:`broke below lower band after squeeze`, direction:'bear', weight:76, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
  return [{ key:`bb_sq_${lbl}`, color:'#ffd43b', badge:`◈ BB SQUEEZE ${lbl}`,
    detail:`bands at ${(curBB.width*100).toFixed(1)}% vs ${(avgWidth*100).toFixed(1)}% avg — coiling`,
    direction:'neutral', weight:52, section: sec, autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } }];
}

function _detectStoch(candles, cfg) {
  if (candles.length < 20) return [];
  const lbl = cfg.tf.toUpperCase();
  const sec = cfg.section || 'st';
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
      detail:`%K ${kNow.toFixed(1)} crossed above %D in oversold`, direction:'bull', weight:72, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  if (kNow > 75 && kPrev > dPrev && kNow < d)
    out.push({ key:`stoch_ob_${lbl}`, color:'#ff9500', badge:`⊕ STOCH CROSS ${lbl}`,
      detail:`%K ${kNow.toFixed(1)} crossed below %D in overbought`, direction:'bear', weight:65, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'rsi' } });
  return out;
}

function _detectMABounce(candles, cfg) {
  if (candles.length < 55) return [];
  const lbl    = cfg.tf.toUpperCase();
  const sec    = cfg.section || 'st';
  const closes = candles.map(c => c.c);
  const n      = closes.length;
  const e50    = _emaArr(closes, 50);
  const price  = closes[n-1], prev = closes[n-2];
  const out    = [];
  if (prev <= e50[n-2] * 1.003 && price > e50[n-1])
    out.push({ key:`ma50_bounce_${lbl}`, color:'#00d47e', badge:`⬢ MA50 BOUNCE ${lbl}`,
      detail:`price reclaimed EMA50 after touching it`, direction:'bull', weight:68, section: sec,
      autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  if (closes.length >= 205) {
    const e200  = _emaArr(closes, 200);
    if (prev <= e200[n-2] * 1.003 && price > e200[n-1])
      out.push({ key:`ma200_bounce_${lbl}`, color:'#ffd43b', badge:`⬢ MA200 BOUNCE ${lbl}`,
        detail:`price reclaimed EMA200 — major long-term support`, direction:'bull', weight:82, section: sec,
        autoAction:{ type:'chart', tf:cfg.tf, utility:'macd' } });
  }
  return out;
}

// ── SWING ENTRY SCANNER ───────────────────────────────────────────────────────
async function _checkSwingEntries(p, force = false) {
  const now = Date.now();
  if (!force && _swingData && (now - _swingFetch) < 1_800_000) {
    _renderSwingEntries(p, _swingData);
    return;
  }
  try {
    const res = await fetch(`/api/swing_scan${force ? '?force=1' : ''}`);
    if (!res.ok) return;
    _swingData = await res.json();
    _swingFetch = Date.now();
    _renderSwingEntries(p, _swingData);
  } catch (_e) {}
}

function _renderSwingEntries(p, data) {
  const log = document.getElementById('con-log-sw-' + p.idx);
  if (!log) return;
  log.innerHTML = '';

  const entries = data?.entries || {};
  const date    = data?.scan_date || '—';
  const wl      = (data?.watchlist || []).join(' · ');

  _emitRaw(log, '#2a3340', `SCAN ${date}`, wl || 'no tickers');

  const all = [];
  for (const [ticker, tfs] of Object.entries(entries)) {
    for (const [tf, info] of Object.entries(tfs)) {
      all.push({ ticker, ...info });
    }
  }
  all.sort((a, b) => b.score - a.score);

  if (!all.length) {
    _emitRaw(log, '#3d5066', 'NO SETUPS', 'no watchlist tickers meet entry threshold');
    return;
  }

  for (const e of all) {
    const color  = e.tier === 'superb' ? '#ffd43b' : e.tier === 'great' ? '#a9e34b' : '#4dabf7';
    const stars  = e.tier === 'superb' ? '◆◆◆' : e.tier === 'great' ? '◆◆' : '◆';
    const ai     = e.ai;
    const conv   = ai?.conviction  ? ` · AI:${ai.conviction}` : '';
    const ew     = ai?.entry_window ? ` · ${ai.entry_window}` : '';
    const detail = `${e.signals.slice(0,3).join(' · ')}${conv}${ew}`;
    const score  = e.score;

    const row = document.createElement('div');
    row.className = 'con-row';
    row.innerHTML =
      `<span class="con-ts">—</span>` +
      `<span class="con-badge" style="color:${color}">${_esc(stars)} [${_esc(e.label)}] ${_esc(e.ticker)}</span>` +
      `<span class="con-detail">${_esc(detail)}</span>` +
      `<span class="con-weight" style="color:${color}80">${score}%</span>`;
    log.appendChild(row);
    if (log.children.length > LOG_MAX) log.removeChild(log.firstChild);

    if (score >= 68) {
      const ck  = `swing_${e.ticker}_${e.tf}`;
      const now = Date.now();
      if ((p._conCooldowns.get(ck) || 0) <= now) {
        p._conCooldowns.set(ck, now + 14_400_000); // 4h cooldown
        const sec = e.section || (e.tf === '1h' ? 'st' : 'lt');
        const riskLabel = e.tier === 'superb' ? 'SUPERB ENTRY' : e.tier === 'great' ? 'GREAT ENTRY' : 'RISKY ENTRY';
        _emit(p, color, `${stars} [${e.label}] ${e.ticker}`,
          `${riskLabel} · ${e.signals.slice(0,2).join(' · ')}${conv}`,
          score, 'bull', sec);
        if (ai?.setup_quality) {
          _emit(p, `${color}80`, '  ↳ AI', ai.setup_quality +
            (ai.entry_window ? `  ·  entry ${ai.entry_window}` : '') +
            (ai.confirm_level ? `  ·  confirm: ${ai.confirm_level}` : ''),
            null, null, sec);
        }
      }
    }
  }
}

function _emitRaw(log, color, badge, detail) {
  const row = document.createElement('div');
  row.className = 'con-row';
  row.innerHTML =
    `<span class="con-ts">—</span>` +
    `<span class="con-badge" style="color:${color}">${_esc(badge)}</span>` +
    `<span class="con-detail">${_esc(detail)}</span>`;
  log.appendChild(row);
}

// ── AVERAGE BREAK FORECAST ────────────────────────────────────────────────────
const _AVG_CFGS = [
  { tf: '1h', period: '1mo', interval: '1h', ttl: 300_000, section: 'st' },
  { tf: '1d', period: '1y',  interval: '1d', ttl: 600_000, section: 'lt' },
];

async function _scanAverageBreaks(p) {
  const avgs = App.state?.averages;
  if (!avgs || !Object.keys(avgs).length) return;
  for (const [ticker, avgPrice] of Object.entries(avgs)) {
    if (!avgPrice || avgPrice <= 0) continue;
    for (const cfg of _AVG_CFGS) {
      try { await _analyzeAvgTF(p, ticker, Number(avgPrice), cfg); } catch (_e) {}
    }
  }
}

async function _analyzeAvgTF(p, ticker, avgPrice, cfg) {
  const section = cfg.section;
  const candles = await _fetchCandles(ticker, cfg);
  if (!candles || candles.length < 30) return;

  const closes = candles.map(c => c.c);
  const n      = closes.length;
  const price  = closes[n - 1];
  const prev   = closes[n - 2];

  const above          = price > avgPrice;
  const distPct        = Math.abs(price - avgPrice) / avgPrice * 100;
  const distAbs        = Math.abs(price - avgPrice);
  const justCrossedDn  = prev > avgPrice && price <= avgPrice;
  const justCrossedUp  = prev < avgPrice && price >= avgPrice;

  // ── Indicators ──────────────────────────────────────────────────────────────
  const rsiVal = _rsi(closes, 14);
  const hist   = _macdHist(closes);
  const ema20  = _emaArr(closes, 20);
  const ema50  = closes.length >= 52 ? _emaArr(closes, 50) : null;

  // ATR-14 for time estimation
  const atr14 = candles.slice(-15).reduce((s, c, i, arr) => {
    if (i === 0) return s + (c.h - c.l);
    return s + Math.max(c.h - c.l, Math.abs(c.h - arr[i-1].c), Math.abs(c.l - arr[i-1].c));
  }, 0) / 14;

  // Velocity: avg price change per bar over last 10 bars
  const velocity   = n >= 11 ? (closes[n-1] - closes[n-11]) / 10 : 0;
  const movingToward = above ? velocity < 0 : velocity > 0;
  const barsEst    = movingToward && Math.abs(velocity) > 0
    ? Math.abs(distAbs / velocity) : null;
  const mins       = cfg.tf === '1h' ? 60 : 1440;
  const timeStr    = barsEst != null && barsEst < 120
    ? (barsEst * mins < 60   ? `~${Math.round(barsEst * mins)}m`
      : barsEst * mins < 1440 ? `~${Math.round(barsEst * mins / 60)}h`
      :                         `~${Math.round(barsEst * mins / 1440)}d`)
    : null;

  // ── Momentum scoring ────────────────────────────────────────────────────────
  let bearScore = 0, bullScore = 0;
  const reasons = [];

  if (rsiVal !== null) {
    if      (rsiVal > 68) { bearScore += 30; reasons.push(`RSI ${rsiVal.toFixed(0)}`); }
    else if (rsiVal > 55)   bearScore += 12;
    else if (rsiVal < 32) { bullScore += 30; reasons.push(`RSI ${rsiVal.toFixed(0)}`); }
    else if (rsiVal < 45)   bullScore += 12;
  }

  if (hist && hist.length >= 3) {
    const hn = hist.length;
    const [h2, h1, h0] = [hist[hn-3], hist[hn-2], hist[hn-1]];
    if      (h0 < 0 && h0 < h1)  { bearScore += 25; reasons.push('MACD bear'); }
    else if (h0 > 0 && h0 < h1)  { bearScore += 15; reasons.push('MACD fading'); }
    if      (h0 > 0 && h0 > h1)  { bullScore += 25; reasons.push('MACD bull'); }
    else if (h0 < 0 && h0 > h1)  { bullScore += 15; reasons.push('MACD turning'); }
  }

  if (ema20.length > 5) {
    const slope = (ema20[n-1] - ema20[Math.max(0, n-6)]) / ema20[n-1] * 100;
    if      (slope < -0.5) { bearScore += 15; reasons.push('EMA20↓'); }
    else if (slope >  0.5) { bullScore += 15; reasons.push('EMA20↑'); }
    if (ema50) {
      if (price < ema20[n-1] && price < ema50[n-1]) bearScore += 10;
      if (price > ema20[n-1] && price > ema50[n-1]) bullScore += 10;
    }
  }

  // Declining highs (last 5 bars)
  if (n >= 6) {
    const highSlope = (candles[n-1].h - candles[n-6].h) / candles[n-1].h * 100;
    if (highSlope < -1.5) { bearScore += 10; reasons.push('lower highs'); }
    if (highSlope >  1.5) { bullScore += 10; reasons.push('higher highs'); }
  }

  const netScore = bullScore - bearScore;

  // Probability: distance factor + momentum
  const distFactor = Math.max(0, 1 - distPct / 15);
  const prob = Math.min(93, Math.max(25, Math.round(distFactor * 55 + Math.abs(netScore) * 0.35)));

  const now    = Date.now();
  const avgStr = fmt(avgPrice);
  const tDesc  = timeStr ? `  est ${timeStr}` : '';
  const rsn    = reasons.slice(0, 3).join(' · ');
  const prefix = 'avgbrk_';

  // ── Just crossed DOWN ───────────────────────────────────────────────────────
  if (justCrossedDn) {
    const ck = `${prefix}broke_dn_${ticker}_${cfg.tf}`;
    if ((p._conCooldowns.get(ck) || 0) <= now) {
      p._conCooldowns.set(ck, now + COOLDOWN);
      _emit(p, '#f03e3e', `⚠⚠⚠ SELL BREAK ${ticker}`,
        `${cfg.tf.toUpperCase()} · broke BELOW avg@${avgStr}  ${rsn}`, 85, 'bear', section);
    }
    return;
  }

  // ── Just crossed UP ─────────────────────────────────────────────────────────
  if (justCrossedUp) {
    const ck = `${prefix}broke_up_${ticker}_${cfg.tf}`;
    if ((p._conCooldowns.get(ck) || 0) <= now) {
      p._conCooldowns.set(ck, now + COOLDOWN);
      _emit(p, '#00d47e', `◆◆ AVG RECLAIM ${ticker}`,
        `${cfg.tf.toUpperCase()} · reclaimed avg@${avgStr}  ${rsn}`, 80, 'bull', section);
    }
    return;
  }

  // Only emit directional warnings within threshold distance
  const thresh = section === 'lt' ? 8 : 5;
  if (distPct > thresh) return;

  // ── Price ABOVE avg, bearish momentum ───────────────────────────────────────
  if (above && netScore < -25) {
    const crit   = distPct < 1.0;
    const badge  = crit ? `⚠⚠ SELL WARN !! ${ticker}` : `⚠ SELL WARN ${ticker}`;
    const color  = crit ? '#ff4444' : '#f03e3e';
    const ck     = `${prefix}warn_dn_${ticker}_${cfg.tf}${crit ? '_c' : ''}`;
    const cd     = crit ? Math.floor(COOLDOWN / 2.5) : COOLDOWN;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + cd);
    _emit(p, color, badge,
      `${cfg.tf.toUpperCase()} · avg@${avgStr}  ${distPct.toFixed(1)}% above${tDesc}  ${rsn}`,
      prob, 'bear', section);
    _emit(p, '#f03e3e80', '  ↳',
      `${prob}% probability break ↓ avg${timeStr ? '  ' + timeStr : '  momentum-based'}`,
      null, null, section);
    return;
  }

  // ── Price BELOW avg, bullish momentum ───────────────────────────────────────
  if (!above && netScore > 25) {
    const ck = `${prefix}warn_up_${ticker}_${cfg.tf}`;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + COOLDOWN);
    _emit(p, '#00d47e', `◆ AVG BREAK ↑ ${ticker}`,
      `${cfg.tf.toUpperCase()} · avg@${avgStr}  ${distPct.toFixed(1)}% below${tDesc}  ${rsn}`,
      prob, 'bull', section);
    _emit(p, '#00d47e80', '  ↳',
      `${prob}% probability reclaim avg${timeStr ? '  ' + timeStr : '  momentum-based'}`,
      null, null, section);
    return;
  }

  // ── Very close, unclear direction ───────────────────────────────────────────
  if (distPct < 1.5) {
    const ck = `${prefix}watch_${ticker}_${cfg.tf}`;
    if ((p._conCooldowns.get(ck) || 0) > now) return;
    p._conCooldowns.set(ck, now + Math.floor(COOLDOWN / 2));
    _emit(p, '#ff9500', `◈ AVG WATCH ${ticker}`,
      `${cfg.tf.toUpperCase()} · within 1.5% of avg@${avgStr}  direction unclear`,
      null, null, section);
  }
}

// ── SOCIAL SENTIMENT ON STATE TRANSITION ─────────────────────────────────────
async function _fetchAndEmitSocial(p, section, newState, prevState) {
  const stateColor = _STATE_COLOR[newState] || '#6a8099';
  _emit(p, stateColor, `◎ STATE → ${newState}`,
    `${prevState} → ${newState} · querying social sentiment…`, null, null, section);
  try {
    const r = await fetch(`/api/social/${encodeURIComponent(p.ticker)}`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.error || !d.label) return;
    const dir   = d.label === 'BULLISH' ? 'bull' : d.label === 'BEARISH' ? 'bear' : null;
    const color = d.label === 'BULLISH' ? '#00d47e' : d.label === 'BEARISH' ? '#f03e3e' : '#ff9500';
    const themes = (d.themes || []).slice(0, 3).join(' · ');
    _emit(p, color, `◎ SOCIAL ${d.label}`,
      `${d.score}/100  ▲${d.bull_count || 0}/▼${d.bear_count || 0}  ${themes}`,
      d.score, dir, section);
    if (d.summary) {
      _emit(p, '#6a8099', '  ↳', d.summary, null, null, section);
    }
    const signals = [...(d.bull_signals || []), ...(d.bear_signals || [])].slice(0, 3);
    signals.forEach(sig => {
      const isBull = (d.bull_signals || []).includes(sig);
      _emit(p, isBull ? '#00d47e80' : '#f03e3e80', '    ·', sig, null, null, section);
    });
  } catch (_) {}
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
        direction, weight:65, section: 'st', autoAction:{ type:'level2' } });
  };
  chk('ask', panel._l2Asks, '▲ ICEBERG ASK', '#ff9500', 'bear');
  chk('bid', panel._l2Bids, '▲ ICEBERG BID', '#00d47e', 'bull');
  return out;
}
