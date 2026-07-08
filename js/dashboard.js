// =============================================================================
// dashboard.js — Module 1: Inventory Overview
// KPI cards, 4 Chart.js charts, 30-day trend, refresh button.
// =============================================================================

let _overviewCharts = {};

// Destroy all existing chart instances before re-rendering
function _destroyAllCharts() {
  Object.values(_overviewCharts).forEach(c => { try { c.destroy(); } catch(e) {} });
  _overviewCharts = {};
  // Destroy any remaining Chart.js instances still tracked globally
  Object.keys(Chart.instances || {}).forEach(id => {
    try { Chart.instances[id].destroy(); } catch(e) {}
  });
}

// Safe canvas helper — destroys any existing Chart on the element before use
function _getCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
  return canvas;
}

async function loadOverview(container) {
  _destroyAllCharts();
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Inventory Overview</div>
        <div class="page-subtitle" id="overview-subtitle">Loading latest snapshot...</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="refreshOverview()">🔄 Refresh</button>
        <button class="btn btn-secondary btn-sm" onclick="exportOverviewCSV()">⬇ Export</button>
      </div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid" id="overview-kpis">
      ${_skeletonKpis(12)}
    </div>

    <!-- Charts -->
    <div class="chart-grid" id="overview-charts">
      ${[
        ['Mother Hub — Good vs Bad Value', 'chart-mother-hub'],
        ['Value by Brand (Top 15)',        'chart-brand'],
        ['Inventory by Health Bucket',     'chart-bucket'],
        ['Mother Hub Facility Comparison', 'chart-mother-compare'],
      ].map(([t, id]) => `
        <div class="chart-card">
          <div class="chart-card-title">${t}</div>
          <canvas id="${id}"></canvas>
        </div>`).join('')}
    </div>

    <!-- 30-day Trend -->
    <div class="section-card">
      <div class="section-card-header">
        <span class="section-card-title">📈 30-Day Trend</span>
      </div>
      <div class="section-card-body">
        <canvas id="trend-chart" style="max-height:180px;"></canvas>
      </div>
    </div>`;

  await _fetchAndRenderOverview();
}

async function _fetchAndRenderOverview() {
  try {
    applyChartDefaults();
    const data = await API.getSummary();
    if (!data || !data.kpis) {
      document.getElementById('overview-kpis').innerHTML =
        '<div class="empty-state"><p>No data yet. Run the daily processing first.</p></div>';
      return;
    }

    _renderKpis(data.kpis);
    _renderCharts(data.charts);
    _renderTrend(data.trend);

    const sub = document.getElementById('overview-subtitle');
    if (sub) sub.textContent = `As of ${formatDate(data.kpis.runDate)} · Last updated ${_timeAgo(data.lastUpdated)}`;

    // Update nav badges
    _updateNavBadges(data.kpis);

  } catch (e) {
    document.getElementById('overview-kpis').innerHTML =
      `<div class="empty-state"><div class="empty-icon">⚠️</div><p style="color:var(--red)">${e.message}</p></div>`;
  }
}

window.refreshOverview = function() {
  clearApiCache();
  _destroyAllCharts();
  _fetchAndRenderOverview();
};

// ---------------------------------------------------------------------------
// KPI CARDS
// ---------------------------------------------------------------------------

function _renderKpis(k) {
  const cards = [
    { label: 'Total Inventory Value',  value: formatINR(k.totalInventoryValue),    sub: 'All facilities',           accent: 'blue',   icon: '💰' },
    { label: 'Good Inventory Value',   value: formatINR(k.goodInventoryValue),     sub: _pct(k.goodInventoryValue, k.totalInventoryValue) + ' of total', accent: 'green', icon: '✅' },
    { label: 'Bad Inventory Value',    value: formatINR(k.badInventoryValue),      sub: _pct(k.badInventoryValue, k.totalInventoryValue) + ' of total',  accent: 'red',   icon: '❌' },
    { label: 'Value At Risk',          value: formatINR(k.valueAtRisk),            sub: 'Bad + Near Expiry + Expired', accent: 'red',   icon: '🚨' },
    { label: 'Near Expiry Value',      value: formatINR(k.nearExpiryValue),        sub: 'Expiring ≤ 60 days',       accent: 'amber',  icon: '⏳' },
    { label: 'Expired Value',          value: formatINR(k.expiredValue),           sub: 'Action required',          accent: 'amber',  icon: '🗑️' },
    { label: 'Warehouse Utilization',  value: formatPct(k.warehouseUtilizationPct), sub: `${formatNum(k.occupiedBins)} / ${formatNum(k.totalBins)} bins`, accent: 'purple', icon: '🏭' },
    { label: 'Total SKUs',             value: formatNum(k.totalSkuCount),          sub: 'Across all facilities',    accent: 'blue',   icon: '📦' },
    { label: 'OOS SKUs',               value: formatNum(k.oosSkuCount),            sub: 'Zero stock on hand',       accent: 'red',    icon: '🔴' },
    { label: 'Critical SKUs',          value: formatNum(k.criticalSkuCount),       sub: 'DOI < 7 days',             accent: 'amber',  icon: '🟠' },
    { label: 'Healthy SKUs',           value: formatNum(k.healthySkuCount),        sub: 'DOI 31–90 days',           accent: 'green',  icon: '🟢' },
    { label: 'Overstock SKUs',         value: formatNum(k.overstockSkuCount),      sub: 'DOI > 90 days',            accent: 'yellow', icon: '🔵' },
  ];

  document.getElementById('overview-kpis').innerHTML = cards.map((c, i) => `
    <div class="kpi-card accent-${c.accent}" style="animation-delay:${i * 40}ms">
      <div class="kpi-label">${c.icon} ${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-sub">${c.sub}</div>
    </div>`).join('');
}

// ---------------------------------------------------------------------------
// CHARTS
// ---------------------------------------------------------------------------

function _renderCharts(charts) {
  if (!charts) return;

  const motherData = charts.byMotherHub || charts.byMotherWarehouse || [];

  // Chart 1: Inventory by Mother Hub (horizontal stacked bar — good/bad split)
  const c1 = _getCanvas('chart-mother-hub');
  if (c1) {
    _overviewCharts.motherHub = new Chart(c1, {
      type: 'bar',
      data: {
        labels  : motherData.map(f => f.facility),
        datasets: [
          { label: 'Good', data: motherData.map(f => f.goodValue || 0), backgroundColor: CHART_COLORS.green, borderRadius: 3 },
          { label: 'Bad',  data: motherData.map(f => f.badValue  || 0), backgroundColor: CHART_COLORS.red,   borderRadius: 3 },
        ],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
        scales: {
          x: { stacked: true, ticks: { callback: v => formatINR(v) } },
          y: { stacked: true },
        },
      },
    });
  }

  // Chart 2: By Brand (doughnut)
  const c2 = _getCanvas('chart-brand');
  if (!c2) return;
  _overviewCharts.brand = new Chart(c2, {
    type: 'doughnut',
    data: {
      labels  : charts.byBrand.map(b => b.brand),
      datasets: [{ data: charts.byBrand.map(b => b.value), backgroundColor: CHART_PALETTE, borderWidth: 2, borderColor: 'var(--bg-surface)' }],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: {
        legend: { position: 'right', labels: { boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${formatINR(ctx.raw)}` } },
      },
    },
  });

  // Chart 3: By Bucket (bar)
  const bucketColors = {
    'OOS': CHART_COLORS.red, 'Critical': CHART_COLORS.amber,
    'Risk': CHART_COLORS.yellow, 'Healthy': CHART_COLORS.green, 'Overstock': CHART_COLORS.blue,
  };
  const c3 = _getCanvas('chart-bucket');
  if (c3) {
    _overviewCharts.bucket = new Chart(c3, {
      type: 'bar',
      data: {
        labels  : charts.byBucket.map(b => b.bucket),
        datasets: [
          { label: 'SKU Count', data: charts.byBucket.map(b => b.skuCount),
            backgroundColor: charts.byBucket.map(b => bucketColors[b.bucket] || CHART_COLORS.blue),
            borderRadius: 4, yAxisID: 'y' },
          { label: 'Value', data: charts.byBucket.map(b => b.value),
            type: 'line', borderColor: CHART_COLORS.amber, backgroundColor: 'transparent',
            pointRadius: 4, tension: 0.3, yAxisID: 'y2' },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } },
        scales: {
          y  : { position: 'left',  title: { display: true, text: 'SKUs' } },
          y2 : { position: 'right', title: { display: true, text: 'Value' },
                 ticks: { callback: v => formatINR(v) }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  // Chart 4: Mother Warehouse total value comparison (bar)
  const c4 = _getCanvas('chart-mother-compare');
  if (c4) {
    _overviewCharts.mother = new Chart(c4, {
      type: 'bar',
      data: {
        labels  : motherData.map(m => m.facility),
        datasets: [{ label: 'Inventory Value', data: motherData.map(m => m.value),
          backgroundColor: [CHART_COLORS.blue, CHART_COLORS.purple, CHART_COLORS.teal, CHART_COLORS.green, CHART_COLORS.amber],
          borderRadius: 5 }],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: v => formatINR(v) } } },
      },
    });
  }
}

function _renderTrend(trend) {
  if (!trend || trend.length === 0) return;
  const canvas = _getCanvas('trend-chart');
  if (!canvas) return;

  _overviewCharts.trend = new Chart(canvas, {
    type: 'line',
    data: {
      labels  : trend.map(t => t.date),
      datasets: [
        { label: 'Total Value',   data: trend.map(t => t.totalValue),  borderColor: CHART_COLORS.blue,
          backgroundColor: 'rgba(88,166,255,0.08)', fill: true, tension: 0.3, pointRadius: 2 },
        { label: 'Value At Risk', data: trend.map(t => t.valueAtRisk), borderColor: CHART_COLORS.red,
          backgroundColor: 'rgba(248,81,73,0.08)',  fill: true, tension: 0.3, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { position: 'top', labels: { boxWidth: 10 } } },
      scales: { y: { ticks: { callback: v => formatINR(v) } } },
    },
  });
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

window.exportOverviewCSV = async function() {
  try {
    const data = await API.getSummary();
    const k    = data.kpis;
    const rows = [
      ['KPI', 'Value'],
      ['Total Inventory Value', k.totalInventoryValue],
      ['Good Inventory Value',  k.goodInventoryValue],
      ['Bad Inventory Value',   k.badInventoryValue],
      ['Value At Risk',         k.valueAtRisk],
      ['Near Expiry Value',     k.nearExpiryValue],
      ['Expired Value',         k.expiredValue],
      ['Warehouse Utilization %', k.warehouseUtilizationPct],
      ['Total SKUs',            k.totalSkuCount],
      ['OOS SKUs',              k.oosSkuCount],
      ['Critical SKUs',         k.criticalSkuCount],
      ['Risk SKUs',             k.riskSkuCount],
      ['Healthy SKUs',          k.healthySkuCount],
      ['Overstock SKUs',        k.overstockSkuCount],
    ];
    exportCSV(rows, 'inventory_overview_' + _today());
  } catch (e) { showToast('Export failed: ' + e.message, 'error'); }
};

// ---------------------------------------------------------------------------
// NAV BADGE UPDATE
// ---------------------------------------------------------------------------

function _updateNavBadges(kpis) {
  _setNavBadge('health',  kpis.oosSkuCount + kpis.criticalSkuCount, 'red');
  _setNavBadge('expiry',  '', '');
  _setNavBadge('mother-warehouse', '', '');
}

function _setNavBadge(module, count, type) {
  const el = document.querySelector(`.nav-item[data-module="${module}"] .nav-badge`);
  if (!el) return;
  if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.className = `nav-badge ${type}`; el.style.display = ''; }
  else el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function _skeletonKpis(n) {
  return Array(n).fill(0).map(() => `
    <div class="kpi-card" style="animation:none;">
      <div style="height:10px;width:60%;background:var(--border);border-radius:4px;margin-bottom:12px;"></div>
      <div style="height:26px;width:80%;background:var(--bg-elevated);border-radius:4px;margin-bottom:6px;"></div>
      <div style="height:8px;width:50%;background:var(--border);border-radius:4px;"></div>
    </div>`).join('');
}

function _pct(part, total) {
  if (!total) return '0%';
  return (part / total * 100).toFixed(1) + '%';
}

function _timeAgo(iso) {
  if (!iso) return '';
  const secs = Math.round((Date.now() - new Date(iso)) / 1000);
  if (secs < 60)   return 'just now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  return Math.floor(secs / 3600) + 'h ago';
}

function _today() {
  return new Date().toISOString().slice(0, 10);
}
