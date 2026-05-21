import { API } from '../../core/state.js';

let _timer = null;

export function initBot() {
  _refresh();
  _timer = setInterval(_refresh, 30_000);
}

async function _refresh() {
  try {
    const r = await fetch(API + '/api/bot/status');
    if (!r.ok) return;
    _render(await r.json());
  } catch (e) {}
}

function _fmt(n) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _render(d) {
  const up    = d.pnl_usd >= 0;
  const sign  = up ? '+' : '−';
  const color = up ? 'var(--green)' : 'var(--red)';
  const set   = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const col   = (id, c) => { const e = document.getElementById(id); if (e) e.style.color  = c; };

  set('bot-capital',   _fmt(d.portfolio_value));
  col('bot-capital',   color);
  set('bot-arrow',     up ? '▲' : '▼');
  col('bot-arrow',     color);
  set('bot-pnl',       `${sign}${_fmt(Math.abs(d.pnl_usd))}  ${sign}${Math.abs(d.pnl_pct).toFixed(2)}%`);
  col('bot-pnl',       color);
  set('bot-pos-count', d.positions);

  const btn = document.getElementById('bot-toggle-btn');
  if (btn) {
    btn.textContent = d.active ? '⏸ PAUSE' : '▶ START';
    btn.classList.toggle('active', !!d.active);
  }
}

window._botToggle = async function () {
  await fetch(API + '/api/bot/toggle', { method: 'POST' });
  await _refresh();
};
