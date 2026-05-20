import { App, indicators } from '../../core/state.js';
import { fmt, N_FC } from '../../core/utils.js';

// ── ORDER BLOCK DETECTION ─────────────────────────────────────────────────────
// A bullish OB  = last bearish (red) candle before a sustained upward impulse
// A bearish OB  = last bullish (green) candle before a sustained downward impulse
// An OB is "mitigated" when price fully retraces through it

const IMPULSE_BARS  = 3;    // how many consecutive bars define an impulse
const IMPULSE_PCT   = 0.4;  // each bar must move at least this % in same direction
const MAX_OBS       = 12;   // max order blocks to show per side

export function detectOrderBlocks(candles) {
  const bulls = [], bears = [];

  for (let i = 1; i < candles.length - IMPULSE_BARS; i++) {
    const c = candles[i];

    // Check for bullish impulse starting at i+1
    let bullOk = true;
    for (let k = 1; k <= IMPULSE_BARS; k++) {
      const nxt = candles[i + k];
      if (!nxt || (nxt.c - nxt.o) / nxt.o * 100 < IMPULSE_PCT) { bullOk = false; break; }
    }
    if (bullOk && c.c < c.o) { // current candle is bearish = potential bullish OB
      const hi = Math.max(c.o, c.h), lo = Math.min(c.c, c.l);
      const mitigated = candles.slice(i + 1).some(x => x.l <= lo);
      bulls.push({ idx: i, hi, lo, mid: (hi + lo) / 2, mitigated });
    }

    // Check for bearish impulse starting at i+1
    let bearOk = true;
    for (let k = 1; k <= IMPULSE_BARS; k++) {
      const nxt = candles[i + k];
      if (!nxt || (nxt.o - nxt.c) / nxt.o * 100 < IMPULSE_PCT) { bearOk = false; break; }
    }
    if (bearOk && c.c > c.o) { // current candle is bullish = potential bearish OB
      const hi = Math.max(c.c, c.h), lo = Math.min(c.o, c.l);
      const mitigated = candles.slice(i + 1).some(x => x.h >= hi);
      bears.push({ idx: i, hi, lo, mid: (hi + lo) / 2, mitigated });
    }
  }

  // Keep most recent OBs only
  return {
    bulls: bulls.slice(-MAX_OBS),
    bears: bears.slice(-MAX_OBS),
  };
}

// ── RENDER ────────────────────────────────────────────────────────────────────
export function drawOrderBlocks(p, data) {
  if (!data || !data._liveCandles?.length) return;
  const candles = data._liveCandles;
  const { bulls, bears } = detectOrderBlocks(data.candles || candles);

  const { makePanelCanvas, buildChartOptions, buildCandlePlugins, buildPriceLinePlugin, buildForecastPlugin } = _chartFns;
  if (!makePanelCanvas) return; // not yet registered by chart.js

  const avg = App.state.averages[p.ticker];
  const prices = candles.flatMap(c => [c.h, c.l]); if (avg) prices.push(avg);
  if (indicators.arima && p.forecastData?.length) p.forecastData.forEach(f => { prices.push(f.ci_lo, f.ci_hi); });
  const minP = Math.min(...prices) * 0.999, maxP = Math.max(...prices) * 1.001;

  const canvas = makePanelCanvas(p);
  if (!canvas) return;

  const obPlugin = {
    id: "orderBlocks",
    beforeDatasetsDraw(chart) {
      const { ctx, scales: { x, y }, chartArea: { left, right } } = chart;
      // Map candle index → x pixel; we need to find each OB's candle position in _liveCandles
      const liveStart = (data.candles || candles).length - candles.length;

      const drawZone = (ob, color, fillAlpha) => {
        const xStart = x.getPixelForValue(ob.idx - liveStart - 0.4);
        const xEnd   = right;
        const yHi    = y.getPixelForValue(ob.hi);
        const yLo    = y.getPixelForValue(ob.lo);
        if (xEnd < left || xStart > right) return;
        const alpha = ob.mitigated ? 0.07 : fillAlpha;
        ctx.save();
        ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0');
        ctx.fillRect(Math.max(xStart, left), yHi, xEnd - Math.max(xStart, left), yLo - yHi);
        ctx.strokeStyle = color + (ob.mitigated ? "44" : "99");
        ctx.lineWidth = 1;
        ctx.setLineDash(ob.mitigated ? [4, 4] : []);
        ctx.strokeRect(Math.max(xStart, left), yHi, xEnd - Math.max(xStart, left), yLo - yHi);
        ctx.setLineDash([]);
        // Label
        if (!ob.mitigated) {
          ctx.fillStyle = color + "cc";
          ctx.font = "bold 9px 'JetBrains Mono'";
          ctx.textAlign = "right";
          ctx.fillText(fmt(ob.mid), right - 4, (yHi + yLo) / 2 + 3);
        }
        ctx.restore();
      };

      bulls.forEach(ob => drawZone(ob, "#00d47e", 0.12));
      bears.forEach(ob => drawZone(ob, "#f03e3e", 0.12));
    }
  };

  p.forecastOffset = candles.length;
  p.mainChart = new Chart(canvas, {
    type: "scatter",
    data: { labels: candles.map((_, i) => i), datasets: [{ data: candles.map((c, i) => ({ x: i, y: c.c })), pointRadius: 0, showLine: false }] },
    options: buildChartOptions(p, candles, minP, maxP, false),
    plugins: [...buildCandlePlugins(candles, avg, false), buildForecastPlugin(p), buildPriceLinePlugin(p, candles), obPlugin]
  });
  if (indicators.arima) import('../MainChart/chart.js').then(m => m.loadForecast(p));
}

// Lazy reference populated by chart.js at init time to avoid circular static imports
const _chartFns = {};
export function _registerChartFns(fns) { Object.assign(_chartFns, fns); }
