// =============================================================================
// inventoryHealth.js — Module 2: Inventory Health
// Bucket summary cards, filterable SKU detail table, pagination, export.
// =============================================================================

let _healthState = {
  data           : null,
  page           : 1,
  pageSize       : 200,
  filters        : {},
  sortData       : [],
  allFacilities  : [],   // full list loaded once for type-based filtering
  facilityType   : '',   // '', 'MW-Self', 'MW-3PL', 'DS'
};

async function loadInventoryHealth(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">Inventory Health</div>
        <div class="page-subtitle">DOI-based health classification across all SKUs</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary btn-sm" onclick="exportHealthCSV()">⬇ Export CSV</button>
        <button class="btn btn-secondary btn-sm" onclick="refreshHealth()">🔄 Refresh</button>
      </div>
    </div>

    <!-- Bucket Cards (clickable filters) -->
    <div class="bucket-grid" id="health-buckets">
      ${['OOS','Critical','Risk','Healthy','Overstock'].map(b => `
        <div class="bucket-card b-${b.toLowerCase()}" data-bucket="${b}" onclick="filterByBucket('${b}')">
          <div class="bucket-name">${b}</div>
          <div class="bucket-count" id="bc-${b}">—</div>
          <div class="bucket-value" id="bv-${b}">—</div>
        </div>`).join('')}
    </div>

    <!-- Facility Type Toggle -->
    <div class="filter-bar" id="health-type-bar" style="margin-bottom:6px;gap:8px;flex-wrap:wrap;">
      <span class="filter-label">Facility Type</span>
      ${[
        ['', 'All Facilities'],
        ['MW-Self', 'Mother Hub'],
        ['MW-3PL', '3PL / Ambient'],
        ['DS', 'Darkstore'],
      ].map(([val, lbl]) => `
        <button class="btn btn-sm ${val === '' ? 'btn-primary' : 'btn-secondary'}"
                id="hft-${val || 'all'}"
                onclick="setHealthFacilityType('${val}')">${lbl}</button>`).join('')}
    </div>

    <!-- Filters -->
    <div class="filter-bar" id="health-filter-bar">
      <div class="filter-group">
        <span class="filter-label">Search</span>
        <input class="filter-input" id="hf-sku" placeholder="SKU or product name..." oninput="debounceHealthFilter()">
      </div>
      <div class="filter-group">
        <span class="filter-label">Facility</span>
        <select class="filter-select" id="hf-facility" onchange="applyHealthFilters()">
          <option value="">All</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Brand</span>
        <input class="filter-input" id="hf-brand" placeholder="Brand..." style="min-width:120px" oninput="debounceHealthFilter()">
      </div>
      <div class="filter-group">
        <span class="filter-label">Bucket</span>
        <select class="filter-select" id="hf-bucket" onchange="applyHealthFilters()">
          <option value="">All Buckets</option>
          <option>OOS</option><option>Critical</option><option>Risk</option>
          <option>Healthy</option><option>Overstock</option>
        </select>
      </div>
      <div class="filter-spacer"></div>
      <button class="btn btn-ghost btn-sm" onclick="clearHealthFilters()">✕ Clear</button>
    </div>

    <!-- Table -->
    <div class="table-wrap" id="health-table-wrap">
      <div class="table-header">
        <span class="table-title">SKU Detail <span class="table-count" id="health-count"></span></span>
      </div>
      <div class="table-scroll">
        <table id="health-table">
          <thead><tr>
            <th>SKU Code</th><th>Product Name</th><th>Facility</th>
            <th class="td-right">SOH</th><th class="td-right">SIT</th>
            <th class="td-right">Sales 30D</th><th class="td-right">Sales 7D</th>
            <th class="td-right">DOI 30</th><th class="td-right">DOI 7</th>
            <th class="td-right">Inv. Value</th><th>Bucket</th>
          </tr></thead>
          <tbody id="health-tbody">
            <tr><td colspan="11"><div class="loading-state"><div class="loading-spinner"></div><span class="loading-text">Loading...</span></div></td></tr>
          </tbody>
        </table>
      </div>
      <div id="health-pagination"></div>
    </div>`;

  _populateFacilityDropdown('hf-facility');
  await _fetchHealth();
}

async function _fetchHealth() {
  _healthState.page = _healthState.page || 1;
  const f = _healthState.filters;

  try {
    const data = await API.getInventoryHealth(f, _healthState.page, _healthState.pageSize);
    _healthState.data = data;
    _renderBuckets(data.bucketSummary);
    _renderHealthTable(data.skuDetail);
    _renderHealthPagination(data.pagination);
    document.getElementById('health-count').textContent = formatNum(data.pagination.totalCount);
  } catch (e) {
    document.getElementById('health-tbody').innerHTML =
      `<tr><td colspan="11"><div class="empty-state"><p style="color:var(--red)">${e.message}</p></div></td></tr>`;
  }
}

// Bucket cards
function _renderBuckets(summary) {
  summary.forEach(b => {
    const countEl = document.getElementById(`bc-${b.bucket}`);
    const valEl   = document.getElementById(`bv-${b.bucket}`);
    if (countEl) countEl.textContent = formatNum(b.skuCount);
    if (valEl)   valEl.textContent   = formatINR(b.inventoryValue);
  });
}

// SKU table
function _renderHealthTable(rows) {
  const tbody = document.getElementById('health-tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty-state"><p>No SKUs match current filters.</p></div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="td-mono">${r.skuCode}</td>
      <td style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${r.productName}">${r.productName}</td>
      <td>${facilityBadge(r.facilityCode, r.facilityType)}</td>
      <td class="td-right fw-600">${formatNum(r.soh)}</td>
      <td class="td-right text-muted">${formatNum(r.sit)}</td>
      <td class="td-right">${formatNum(r.sales30)}</td>
      <td class="td-right">${formatNum(r.sales7)}</td>
      <td class="td-right ${_doiColor(r.doi30, r.bucket)}">${formatDOI(r.doi30)}</td>
      <td class="td-right ${_doiColor(r.doi7, r.bucket)}">${formatDOI(r.doi7)}</td>
      <td class="td-right fw-600">${formatINR(r.inventoryValue)}</td>
      <td>${bucketBadge(r.bucket)}</td>
    </tr>`).join('');
}

function _doiColor(doi, bucket) {
  if (bucket === 'OOS')       return 'text-red';
  if (bucket === 'Critical')  return 'text-amber';
  if (bucket === 'Overstock') return 'text-blue';
  return '';
}

function _renderHealthPagination(pagination) {
  const el = document.getElementById('health-pagination');
  renderPagination(el, pagination, (page) => {
    _healthState.page = page;
    _fetchHealth();
  });
}

// Filters
let _healthDebounce;
window.debounceHealthFilter = function() {
  clearTimeout(_healthDebounce);
  _healthDebounce = setTimeout(applyHealthFilters, 400);
};

window.applyHealthFilters = function() {
  _healthState.page = 1;
  _healthState.filters = {
    sku          : document.getElementById('hf-sku')?.value      || '',
    facility     : document.getElementById('hf-facility')?.value || '',
    brand        : document.getElementById('hf-brand')?.value    || '',
    bucket       : document.getElementById('hf-bucket')?.value   || '',
    facilityType : _healthState.facilityType || '',
  };
  _fetchHealth();
};

window.filterByBucket = function(bucket) {
  const sel = document.getElementById('hf-bucket');
  const existing = _healthState.filters.bucket;
  if (sel) sel.value = existing === bucket ? '' : bucket;
  document.querySelectorAll('.bucket-card').forEach(c => c.classList.remove('selected'));
  if (existing !== bucket) document.querySelector(`.bucket-card[data-bucket="${bucket}"]`)?.classList.add('selected');
  applyHealthFilters();
};

window.clearHealthFilters = function() {
  ['hf-sku','hf-facility','hf-brand','hf-bucket'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.querySelectorAll('.bucket-card').forEach(c => c.classList.remove('selected'));
  // Reset facility type toggle to "All"
  _healthState.facilityType = '';
  _rebuildFacilityDropdown('hf-facility', '');
  ['', 'MW-Self', 'MW-3PL', 'DS'].forEach(v => {
    const btn = document.getElementById('hft-' + (v || 'all'));
    if (!btn) return;
    btn.className = btn.className.replace(/btn-primary|btn-secondary/g, '').trim();
    btn.className += ' ' + (v === '' ? 'btn-primary' : 'btn-secondary');
  });
  _healthState.filters = {};
  _healthState.page    = 1;
  _fetchHealth();
};

window.refreshHealth = function() {
  clearCacheFor('inventory-health');
  _fetchHealth();
};

// Export
window.exportHealthCSV = async function() {
  try {
    showToast('Exporting all pages…', 'info');
    const data = await API.getInventoryHealth(_healthState.filters, 1, 10000);
    const headers = ['SKU Code','Product Name','Brand','Category','Facility','Type','SOH','SIT','Sales 30D','Sales 7D','DOI 30','DOI 7','Inv Value','Good Qty','Bad Qty','At Risk Value','Bucket'];
    const rows = [headers, ...data.skuDetail.map(r => [
      r.skuCode, r.productName, r.brand, r.category, r.facilityCode, r.facilityType,
      r.soh, r.sit, r.sales30, r.sales7, r.doi30, r.doi7,
      r.inventoryValue, r.goodQty, r.badQty, r.valueAtRisk, r.bucket,
    ])];
    exportCSV(rows, 'inventory_health_' + new Date().toISOString().slice(0,10));
  } catch(e) { showToast('Export failed: ' + e.message, 'error'); }
};

async function _populateFacilityDropdown(elId) {
  try {
    const facilities = await API.getFacilities();
    _healthState.allFacilities = facilities;
    _rebuildFacilityDropdown(elId, '');
  } catch (e) { /* non-critical */ }
}

function _rebuildFacilityDropdown(elId, typeFilter) {
  const sel = document.getElementById(elId);
  if (!sel) return;
  const list = typeFilter
    ? _healthState.allFacilities.filter(f => f.type === typeFilter)
    : _healthState.allFacilities;
  // Keep selected value if still in filtered list
  const prev = sel.value;
  sel.innerHTML = '<option value="">All</option>';
  list.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.code; opt.textContent = `${f.code} — ${f.name}`;
    sel.appendChild(opt);
  });
  if (list.some(f => f.code === prev)) sel.value = prev;
}

window.setHealthFacilityType = function(typeVal) {
  _healthState.facilityType = typeVal;
  // Update toggle button styles
  ['', 'MW-Self', 'MW-3PL', 'DS'].forEach(v => {
    const btn = document.getElementById('hft-' + (v || 'all'));
    if (!btn) return;
    btn.className = btn.className.replace(/btn-primary|btn-secondary/g, '').trim();
    btn.className += ' ' + (v === typeVal ? 'btn-primary' : 'btn-secondary');
  });
  // Reset facility dropdown to match selected type
  const sel = document.getElementById('hf-facility');
  if (sel) sel.value = '';
  _rebuildFacilityDropdown('hf-facility', typeVal);
  // Re-fetch with type filter (facility filter reset)
  _healthState.filters.facilityType = typeVal;
  _healthState.filters.facility = '';
  _healthState.page = 1;
  _fetchHealth();
};
