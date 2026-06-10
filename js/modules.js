// =============================================================================
// expiry.js — Module 3: Expiry Management
// =============================================================================

async function loadExpiry(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Expiry Management</div>
        <div class="page-subtitle">Batch-level expiry risk across all facilities</div></div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="exportExpiryCSV()">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" onclick="refreshExpiry()">🔄 Refresh</button>
      </div>
    </div>

    <!-- Aging Buckets -->
    <div class="aging-grid" id="expiry-aging">
      ${['0-30','31-60','61-90','90+'].map(r => `
        <div class="aging-card">
          <div class="aging-range">${r} Days</div>
          <div class="aging-qty" id="ea-qty-${r.replace('+','p')}">—</div>
          <div class="aging-value" id="ea-val-${r.replace('+','p')}">—</div>
        </div>`).join('')}
    </div>

    <!-- Expiry bucket summary -->
    <div class="section-card" style="margin-bottom:16px;">
      <div class="section-card-header">
        <span class="section-card-title">Summary by Expiry Bucket</span>
      </div>
      <div class="table-scroll">
        <table><thead><tr>
          <th>Bucket</th><th class="td-right">SKUs</th><th class="td-right">Batches</th>
          <th class="td-right">Qty</th><th class="td-right">Inventory Value</th>
        </tr></thead>
        <tbody id="expiry-bucket-tbody"></tbody></table>
      </div>
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <div class="filter-group">
        <span class="filter-label">Bucket</span>
        <select class="filter-select" id="ef-bucket" onchange="applyExpiryFilters()">
          <option value="">All Buckets</option>
          <option>Expired</option><option>Critical Expiry</option><option>Near Expiry</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Facility</span>
        <select class="filter-select" id="ef-facility" onchange="applyExpiryFilters()">
          <option value="">All Facilities</option>
        </select>
      </div>
      <div class="filter-spacer"></div>
      <button class="btn btn-ghost btn-sm" onclick="clearExpiryFilters()">✕ Clear</button>
    </div>

    <!-- Detail Table -->
    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Expiry Detail <span class="table-count" id="expiry-count"></span></span>
      </div>
      <div class="table-scroll">
        <table><thead><tr>
          <th>SKU Code</th><th>Product Name</th><th>Facility</th><th>Batch</th>
          <th>Expiry Date</th><th class="td-right">Days Left</th>
          <th class="td-right">Qty</th><th class="td-right">Value</th><th>Bucket</th>
        </tr></thead>
        <tbody id="expiry-tbody">
          <tr><td colspan="9"><div class="loading-state"><div class="loading-spinner"></div></div></td></tr>
        </tbody></table>
      </div>
      <div id="expiry-pagination"></div>
    </div>`;

  _populateFacilityDropdown('ef-facility');
  await _fetchExpiry(1);
}

let _expiryPage = 1;
let _expiryFilters = {};

async function _fetchExpiry(page) {
  _expiryPage = page;
  try {
    const data = await API.getExpiry(_expiryFilters, page, 200);
    _renderAgingCards(data.aging);
    _renderExpiryBuckets(data.bucketSummary);
    _renderExpiryTable(data.detail);
    document.getElementById('expiry-count').textContent = formatNum(data.pagination.totalCount);
    renderPagination(document.getElementById('expiry-pagination'), data.pagination, p => _fetchExpiry(p));
  } catch (e) {
    document.getElementById('expiry-tbody').innerHTML =
      `<tr><td colspan="9" style="color:var(--red);padding:20px;">${e.message}</td></tr>`;
  }
}

function _renderAgingCards(aging) {
  if (!aging) return;
  aging.forEach(a => {
    const key = a.range.replace('+','p');
    const qEl = document.getElementById(`ea-qty-${key}`);
    const vEl = document.getElementById(`ea-val-${key}`);
    if (qEl) qEl.textContent = formatNum(a.qty);
    if (vEl) vEl.textContent = formatINR(a.value);
  });
}

function _renderExpiryBuckets(summary) {
  const tbody = document.getElementById('expiry-bucket-tbody');
  if (!tbody) return;
  tbody.innerHTML = summary.map(b => `
    <tr>
      <td>${expiryBadge(b.bucket)}</td>
      <td class="td-right">${formatNum(b.skuCount)}</td>
      <td class="td-right">${formatNum(b.batchCount)}</td>
      <td class="td-right">${formatNum(b.qty)}</td>
      <td class="td-right fw-600">${formatINR(b.value)}</td>
    </tr>`).join('');
}

function _renderExpiryTable(rows) {
  const tbody = document.getElementById('expiry-tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><p>No expiry concerns. 🎉</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const daysColor = r.daysToExpiry < 0 ? 'text-red' : r.daysToExpiry <= 30 ? 'text-amber' : 'text-muted';
    const daysText  = r.daysToExpiry < 0 ? `Expired ${Math.abs(r.daysToExpiry)}d` : `${r.daysToExpiry}d`;
    return `<tr>
      <td class="td-mono">${r.skuCode}</td>
      <td>${r.productName}</td>
      <td><span class="badge badge-node">${r.facilityCode}</span></td>
      <td class="td-mono" style="font-size:10px;">${r.batchCode}</td>
      <td>${r.expiryDate}</td>
      <td class="td-right fw-600 ${daysColor}">${daysText}</td>
      <td class="td-right">${formatNum(r.qty)}</td>
      <td class="td-right fw-600">${formatINR(r.inventoryValue)}</td>
      <td>${expiryBadge(r.expiryBucket)}</td>
    </tr>`;
  }).join('');
}

window.applyExpiryFilters = function() {
  _expiryFilters = {
    bucket  : document.getElementById('ef-bucket')?.value   || '',
    facility: document.getElementById('ef-facility')?.value || '',
  };
  _fetchExpiry(1);
};
window.clearExpiryFilters = function() {
  ['ef-bucket','ef-facility'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  _expiryFilters = {};
  _fetchExpiry(1);
};
window.refreshExpiry = function() { clearCacheFor('expiry'); _fetchExpiry(1); };
window.exportExpiryCSV = async function() {
  try {
    showToast('Exporting…', 'info');
    const data = await API.getExpiry(_expiryFilters, 1, 10000);
    const headers = ['SKU Code','Product Name','Facility','Batch Code','Expiry Date','Days To Expiry','Qty','Value','Bucket'];
    const rows = [headers, ...data.detail.map(r => [
      r.skuCode, r.productName, r.facilityCode, r.batchCode,
      r.expiryDate, r.daysToExpiry, r.qty, r.inventoryValue, r.expiryBucket,
    ])];
    exportCSV(rows, 'expiry_report_' + new Date().toISOString().slice(0,10));
  } catch(e) { showToast('Export failed: ' + e.message, 'error'); }
};

// =============================================================================
// utilization.js — Module 4: Warehouse Utilization (SL_MH)
// =============================================================================

let _utilChart = null;

async function loadUtilization(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Warehouse Utilization</div>
        <div class="page-subtitle">SL_MH bin utilization · Real-time occupancy heatmap</div></div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="refreshUtilization()">🔄 Refresh</button>
      </div>
    </div>

    <!-- KPI Row -->
    <div class="kpi-grid" id="util-kpis" style="grid-template-columns:repeat(4,1fr);">
      ${['Total Bins','Occupied Bins','Empty Bins','Utilization %'].map(l => `
        <div class="kpi-card accent-purple">
          <div class="kpi-label">${l}</div>
          <div class="kpi-value" id="uk-${l.replace(/[^a-z]/gi,'').toLowerCase()}">—</div>
        </div>`).join('')}
    </div>

    <!-- Utilization Bar + Chart -->
    <div class="section-card" style="margin-bottom:16px;">
      <div class="section-card-header"><span class="section-card-title">Utilization Overview</span></div>
      <div class="section-card-body">
        <div style="height:14px;background:var(--bg-elevated);border-radius:7px;overflow:hidden;margin-bottom:8px;">
          <div id="util-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--green),var(--amber));transition:width 1s ease;border-radius:7px;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-secondary);">
          <span id="util-occupied-label">Occupied: —</span>
          <span id="util-pct-label">—%</span>
          <span id="util-total-label">Total: —</span>
        </div>
      </div>
    </div>

    <!-- Heatmaps -->
    <div class="heatmap-grid" id="util-heatmaps">
      <div class="heatmap-card"><div class="heatmap-title">By Row</div><div id="hm-row"></div></div>
      <div class="heatmap-card"><div class="heatmap-title">By Column</div><div id="hm-col"></div></div>
      <div class="heatmap-card"><div class="heatmap-title">By Level</div><div id="hm-level"></div></div>
    </div>`;

  await _fetchUtilization();
}

async function _fetchUtilization() {
  try {
    const data = await API.getUtilization();
    if (!data.kpis) { renderEmpty(document.getElementById('util-kpis'), 'No bin data. Upload Bin Master.', '🏭'); return; }
    const k = data.kpis;
    _setKpi('totalbins',       formatNum(k.totalBins));
    _setKpi('occupiedbins',    formatNum(k.occupiedBins));
    _setKpi('emptybins',       formatNum(k.emptyBins));
    _setKpi('utilization',     formatPct(k.utilizationPct));

    const pct = parseFloat(k.utilizationPct) || 0;
    document.getElementById('util-bar').style.width = pct + '%';
    document.getElementById('util-pct-label').textContent = formatPct(pct);
    document.getElementById('util-occupied-label').textContent = `Occupied: ${formatNum(k.occupiedBins)}`;
    document.getElementById('util-total-label').textContent    = `Total: ${formatNum(k.totalBins)}`;

    if (data.heatmap) {
      _renderHeatmap('hm-row',   data.heatmap.byRow,   'Row');
      _renderHeatmap('hm-col',   data.heatmap.byCol,   'Column');
      _renderHeatmap('hm-level', data.heatmap.byLevel, 'Level');
    }
  } catch(e) {
    showToast('Utilization load failed: ' + e.message, 'error');
  }
}

function _setKpi(key, val) {
  const el = document.getElementById('uk-' + key);
  if (el) el.textContent = val;
}

function _renderHeatmap(containerId, rows, label) {
  const el = document.getElementById(containerId);
  if (!el || !rows) return;
  el.innerHTML = rows.slice(0, 30).map(r => {
    const pct      = r.utilizationPct;
    const barClass = pct > 80 ? 'high' : '';
    return `
      <div class="heatmap-row">
        <span class="heatmap-label">${r.key}</span>
        <div class="heatmap-bar-wrap">
          <div class="heatmap-bar ${barClass}" style="width:${pct}%"></div>
        </div>
        <span class="heatmap-pct">${pct}%</span>
      </div>`;
  }).join('');
}

window.refreshUtilization = function() { clearCacheFor('utilization'); _fetchUtilization(); };

// =============================================================================
// skuDeepDive.js — Module 5: SKU Deep Dive
// =============================================================================

async function loadSkuDeepDive(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">SKU Deep Dive</div>
        <div class="page-subtitle">Complete inventory profile for any SKU across all facilities</div></div>
    </div>

    <div class="sku-search-bar">
      <input class="sku-search-input" id="sku-search-input"
             placeholder="Enter SKU code and press Enter or click Search..."
             onkeydown="if(event.key==='Enter') searchSku()">
      <button class="btn btn-primary" onclick="searchSku()">🔍 Search</button>
    </div>

    <div id="sku-result-area">
      <div class="empty-state"><div class="empty-icon">🔍</div><p>Search for a SKU to see its full profile.</p></div>
    </div>`;
}

window.searchSku = async function() {
  const code = document.getElementById('sku-search-input')?.value.trim();
  if (!code) { showToast('Enter a SKU code to search.', 'warning'); return; }

  const area = document.getElementById('sku-result-area');
  renderLoading(area, 'Loading SKU profile...');

  try {
    const data = await API.getSku(code);
    if (!data.found) {
      renderEmpty(area, `SKU "${code}" not found in today's inventory.`, '📭');
      return;
    }
    _renderSkuResult(area, data);
  } catch(e) {
    renderError(area, e.message);
  }
};

function _renderSkuResult(area, d) {
  const t = d.totals;
  area.innerHTML = `
    <!-- SKU Header -->
    <div class="section-card" style="margin-bottom:16px;">
      <div class="section-card-header" style="justify-content:space-between;">
        <div>
          <div style="font-size:16px;font-weight:700;">${d.productName}</div>
          <div class="td-mono" style="color:var(--text-secondary);margin-top:2px;">${d.skuCode}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:11px;color:var(--text-secondary);">Brand: ${d.brand} · Category: ${d.category}</div>
          <div style="font-size:12px;margin-top:4px;">COGS: <strong>${formatINR(d.cogs)}</strong>
            ${d.cogsSource === 'FG Fallback' ? '<span class="badge badge-yellow" style="margin-left:6px;">FG Fallback</span>' : ''}</div>
        </div>
      </div>
    </div>

    <!-- Totals KPI Strip -->
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">
      ${[
        {l:'Total SOH',   v:formatNum(t.soh),            a:'blue'},
        {l:'Total Value', v:formatINR(t.inventoryValue),  a:'blue'},
        {l:'Good Qty',    v:formatNum(t.goodQty),         a:'green'},
        {l:'Bad Qty',     v:formatNum(t.badQty),          a:'red'},
        {l:'Near Expiry', v:formatNum(t.nearExpiryQty),   a:'amber'},
        {l:'Expired Qty', v:formatNum(t.expiredQty),      a:'red'},
        {l:'Value At Risk',v:formatINR(t.valueAtRisk),    a:'red'},
        {l:'SIT',         v:formatNum(t.sit),             a:'purple'},
      ].map(c=>`<div class="kpi-card accent-${c.a}"><div class="kpi-label">${c.l}</div><div class="kpi-value">${c.v}</div></div>`).join('')}
    </div>

    <div class="sku-result">
      <!-- Facility Breakdown -->
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Facility Breakdown</span></div>
        <div class="table-scroll"><table>
          <thead><tr>
            <th>Facility</th><th>Type</th><th class="td-right">SOH</th><th class="td-right">SIT</th>
            <th class="td-right">Sales 30D</th><th class="td-right">DOI 30</th>
            <th class="td-right">Good</th><th class="td-right">Bad</th>
            <th class="td-right">Value</th><th>Bucket</th>
          </tr></thead>
          <tbody>
            ${d.facilityBreakdown.map(f => `<tr>
              <td>${facilityBadge(f.facilityCode, f.facilityType)}</td>
              <td style="font-size:11px;color:var(--text-secondary);">${f.facilityType}</td>
              <td class="td-right fw-600">${formatNum(f.soh)}</td>
              <td class="td-right text-muted">${formatNum(f.sit)}</td>
              <td class="td-right">${formatNum(f.sales30)}</td>
              <td class="td-right">${formatDOI(f.doi30)}</td>
              <td class="td-right text-green">${formatNum(f.goodQty)}</td>
              <td class="td-right text-red">${formatNum(f.badQty)}</td>
              <td class="td-right fw-600">${formatINR(f.inventoryValue)}</td>
              <td>${bucketBadge(f.bucket)}</td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>

      <!-- Expiry Detail -->
      <div class="table-wrap">
        <div class="table-header"><span class="table-title">Expiry / Batch Detail</span></div>
        <div class="table-scroll"><table>
          <thead><tr>
            <th>Facility</th><th>Batch</th><th>Expiry</th>
            <th class="td-right">Days</th><th class="td-right">Qty</th>
            <th class="td-right">Value</th><th>Status</th>
          </tr></thead>
          <tbody>
            ${d.expiryDetail.length === 0
              ? `<tr><td colspan="7"><div class="empty-state"><p>No expiry concerns.</p></div></td></tr>`
              : d.expiryDetail.map(b => {
                  const dColor = b.daysToExpiry < 0 ? 'text-red' : b.daysToExpiry <= 30 ? 'text-amber' : '';
                  return `<tr>
                    <td><span class="badge badge-node">${b.facilityCode}</span></td>
                    <td class="td-mono" style="font-size:10px;">${b.batchCode}</td>
                    <td>${b.expiryDate}</td>
                    <td class="td-right fw-600 ${dColor}">${b.daysToExpiry < 0 ? 'Exp' : b.daysToExpiry + 'd'}</td>
                    <td class="td-right">${formatNum(b.qty)}</td>
                    <td class="td-right">${formatINR(b.inventoryValue)}</td>
                    <td>${expiryBadge(b.expiryBucket)}</td>
                  </tr>`;
                }).join('')}
          </tbody>
        </table></div>
      </div>
    </div>`;
}

// =============================================================================
// motherWarehouse.js — Module 6: Mother Warehouse Control Tower
// =============================================================================

async function loadMotherWarehouse(container) {
  container.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Mother Warehouse Control Tower</div>
        <div class="page-subtitle">Live status and KPIs for all mother warehouses</div></div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="refreshMotherWarehouse()">🔄 Refresh</button>
      </div>
    </div>
    <div class="mw-grid" id="mw-cards">
      <div class="loading-state"><div class="loading-spinner"></div></div>
    </div>

    <!-- Full comparison table -->
    <div class="table-wrap">
      <div class="table-header"><span class="table-title">Comparison Table</span></div>
      <div class="table-scroll"><table>
        <thead><tr>
          <th>Facility</th><th class="td-right">SOH</th><th class="td-right">SIT</th>
          <th class="td-right">Inv. Value</th><th class="td-right">Good Value</th>
          <th class="td-right">Bad Value</th><th class="td-right">Sales 30D</th>
          <th class="td-right">DOI 30</th><th class="td-right">DOI 7</th>
          <th class="td-right">OOS SKUs</th><th class="td-right">Critical SKUs</th><th>Status</th>
        </tr></thead>
        <tbody id="mw-tbody">
          <tr><td colspan="12"><div class="loading-state"><div class="loading-spinner"></div></div></td></tr>
        </tbody>
      </table></div>
    </div>`;

  await _fetchMotherWarehouse();
}

async function _fetchMotherWarehouse() {
  try {
    const data = await API.getMotherWarehouse();
    _renderMwCards(data.facilities);
    _renderMwTable(data.facilities);
  } catch(e) { showToast('Mother warehouse load failed: ' + e.message, 'error'); }
}

function _renderMwCards(facilities) {
  const grid = document.getElementById('mw-cards');
  if (!grid) return;
  grid.innerHTML = facilities.map(f => {
    const statusClass = `status-${f.status.toLowerCase()}`;
    const statusIcon  = f.status === 'Green' ? '🟢' : f.status === 'Yellow' ? '🟡' : '🔴';
    return `
      <div class="mw-card ${statusClass}">
        <div class="mw-card-header">
          <div class="mw-card-name">${f.facilityName}</div>
          <span class="badge badge-mother">${f.facilityCode}</span>
        </div>
        <div class="mw-card-body">
          ${[
            ['SOH',             formatNum(f.soh)],
            ['SIT',             formatNum(f.sit)],
            ['Inventory Value', formatINR(f.inventoryValue)],
            ['Good Value',      formatINR(f.goodValue)],
            ['Value At Risk',   formatINR(f.valueAtRisk)],
            ['Sales 30D',       formatNum(f.sales30)],
            ['DOI 30',          formatDOI(f.doi30)],
            ['DOI 7',           formatDOI(f.doi7)],
            ['OOS SKUs',        formatNum(f.oosSkus)],
            ['Critical SKUs',   formatNum(f.criticalSkus)],
          ].map(([l,v]) => `
            <div class="mw-stat-row">
              <span class="mw-stat-label">${l}</span>
              <span class="mw-stat-value">${v}</span>
            </div>`).join('')}
          <div class="mw-stat-row" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
            <span class="mw-stat-label">Status</span>
            <span>${statusIcon} ${f.status}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function _renderMwTable(facilities) {
  const tbody = document.getElementById('mw-tbody');
  if (!tbody) return;
  tbody.innerHTML = facilities.map(f => `
    <tr>
      <td><strong>${f.facilityName}</strong><br><span class="td-mono">${f.facilityCode}</span></td>
      <td class="td-right">${formatNum(f.soh)}</td>
      <td class="td-right text-muted">${formatNum(f.sit)}</td>
      <td class="td-right fw-600">${formatINR(f.inventoryValue)}</td>
      <td class="td-right text-green">${formatINR(f.goodValue)}</td>
      <td class="td-right text-red">${formatINR(f.badValue)}</td>
      <td class="td-right">${formatNum(f.sales30)}</td>
      <td class="td-right">${formatDOI(f.doi30)}</td>
      <td class="td-right">${formatDOI(f.doi7)}</td>
      <td class="td-right text-red">${formatNum(f.oosSkus)}</td>
      <td class="td-right text-amber">${formatNum(f.criticalSkus)}</td>
      <td><span class="badge badge-${f.status.toLowerCase() === 'green' ? 'green' : f.status.toLowerCase() === 'yellow' ? 'yellow' : 'red'}">${f.status}</span></td>
    </tr>`).join('');
}

window.refreshMotherWarehouse = function() { clearCacheFor('mother-warehouse'); _fetchMotherWarehouse(); };

// =============================================================================
// settings.js — Settings Page
// =============================================================================

async function loadSettings(container) {
  const session = getSession();
  container.innerHTML = `
    <div class="page-header">
      <div><div class="page-title">Settings</div>
        <div class="page-subtitle">System configuration · Signed in as ${session?.name || session?.email || 'Unknown'}</div></div>
    </div>

    <!-- Quick Reference -->
    <div class="section-card" style="margin-bottom:16px;">
      <div class="section-card-header"><span class="section-card-title">🔗 System Reference</span></div>
      <div class="section-card-body">
        <div class="mw-stat-row">
          <span class="mw-stat-label">Web App URL</span>
          <span class="td-mono" style="font-size:11px;word-break:break-all;">${API_BASE}</span>
        </div>
        <div class="mw-stat-row" style="margin-top:8px;">
          <span class="mw-stat-label">Session Expires</span>
          <span>${session ? new Date(session.exp).toLocaleString('en-IN') : '—'}</span>
        </div>
        <div class="mw-stat-row" style="margin-top:8px;">
          <span class="mw-stat-label">Theme</span>
          <span>
            <button class="btn btn-secondary btn-sm" onclick="toggleTheme()">Toggle Dark / Light</button>
          </span>
        </div>
        <div class="mw-stat-row" style="margin-top:8px;">
          <span class="mw-stat-label">Session</span>
          <span>
            <button class="btn btn-danger btn-sm" onclick="signOut()">Sign Out</button>
          </span>
        </div>
      </div>
    </div>

    <!-- Config instructions -->
    <div class="section-card">
      <div class="section-card-header"><span class="section-card-title">⚙️ Configuration</span></div>
      <div class="section-card-body">
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.7;">
          All system settings are managed directly in the Google Sheet:<br>
          <strong style="color:var(--text-primary);">tbl_settings</strong><br><br>
          Key settings to configure:
        </p>
        <table style="margin-top:12px;width:100%;font-size:12px;">
          <thead><tr><th>Setting Key</th><th>What it controls</th></tr></thead>
          <tbody>
            ${[
              ['email_recipients',       'Daily email recipients (comma-separated)'],
              ['email_sender_filter',    'Gmail: sender email filter to find reports'],
              ['email_subject_filter',   'Gmail: subject keyword to find reports'],
              ['fg_attachment_keyword',  'Filename keyword to identify FG Inventory CSV'],
              ['shelf_attachment_keyword','Filename keyword to identify Shelf CSV'],
              ['dashboard_url',          'This GitHub Pages URL (used in emails)'],
              ['allowed_domains',        'Google Workspace domains allowed to sign in'],
              ['oauth_client_id',        'Google OAuth 2.0 Client ID for sign-in'],
              ['near_expiry_days',       'Days threshold for Near Expiry (default: 60)'],
              ['critical_expiry_days',   'Days threshold for Critical Expiry (default: 30)'],
              ['doi_critical_threshold', 'DOI below this = Critical bucket (default: 7)'],
              ['doi_overstock_threshold','DOI above this = Overstock (default: 90)'],
              ['data_retention_days',    'Days of historical data to keep (default: 90)'],
              ['timezone',               'Timezone for all calculations (default: Asia/Kolkata)'],
            ].map(([k,d]) => `<tr>
              <td class="td-mono">${k}</td>
              <td style="color:var(--text-secondary);">${d}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div style="margin-top:16px;padding:12px;background:var(--amber-dim);border:1px solid var(--amber-border);border-radius:var(--radius-sm);">
          <p style="font-size:12px;color:var(--amber);">
            ⚠️ After changing settings, run <strong>🏭 Inventory Tower → 🔄 Reinstall Trigger</strong>
            from the Google Sheets menu to apply schedule changes.
          </p>
        </div>
      </div>
    </div>`;
}
