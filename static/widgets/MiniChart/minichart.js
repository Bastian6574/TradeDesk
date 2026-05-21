const _charts = {};

export function renderMiniChart(canvasId, candles, changePct) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !candles?.length) return;
  if (_charts[canvasId]) { _charts[canvasId].destroy(); }
  const color = (changePct ?? 0) >= 0 ? "#00d47e" : "#f03e3e";
  _charts[canvasId] = new Chart(canvas, {
    type: "line",
    data: {
      labels: candles.map(() => ""),
      datasets: [{ data: candles.map(c => c.c), borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: color + "18", tension: 0.2 }]
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } }
    }
  });
}

export function destroyMiniChart(canvasId) {
  if (_charts[canvasId]) { _charts[canvasId].destroy(); delete _charts[canvasId]; }
}

export function destroyAllByPrefix(prefix) {
  Object.keys(_charts).filter(id => id.startsWith(prefix))
    .forEach(id => { _charts[id].destroy(); delete _charts[id]; });
}
