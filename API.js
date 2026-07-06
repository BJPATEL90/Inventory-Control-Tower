// =============================================================================
// API.gs — Inventory Control Tower
// Web App entry point. All GitHub Pages dashboard API calls land here.
//
// Deploy as: Execute as → Me | Access → Anyone with Google Account
//
// Endpoints (all GET, param: action=<name>):
//   ?action=summary
//   ?action=inventory-health
//   ?action=expiry
//   ?action=utilization
//   ?action=sku&skuCode=<code>
//   ?action=mother-warehouse
//   ?action=settings          (admin only — requires token)
//
// All responses: Content-Type application/json, CORS headers included.
// All data is pre-aggregated in Sheets — browser never sees raw inventory.
// =============================================================================

// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Handles all GET requests from the GitHub Pages dashboard.
 * Routes to the correct handler based on ?action= parameter.
 */
function doGet(e) {
  const params = e.parameter || {};
  const action = (params.action || '').toLowerCase().trim();

  Logger.log(`API doGet: action="${action}" params=${JSON.stringify(params)}`);

  // Session verification — log-only mode (not blocking yet).
  // Switch to _errorResponse(401, ...) once frontend tokens are confirmed working.
  if (action !== 'auth' && action !== 'ping') {
    const sessionCheck = verifySession(params.sessionToken || '');
    if (!sessionCheck.valid) {
      Logger.log(`AUTH WARNING [${action}]: ${sessionCheck.reason} (log-only mode — not blocking)`);
    }
  }

  try {
    let data;

    switch (action) {
      case 'summary':
        data = apiGetSummary();
        break;
      case 'inventory-health':
        data = apiGetInventoryHealth(params);
        break;
      case 'expiry':
        data = apiGetExpiry(params);
        break;
      case 'utilization':
        data = apiGetUtilization();
        break;
      case 'sku':
        data = apiGetSku(params);
        break;
      case 'mother-warehouse':
        data = apiGetMotherWarehouse();
        break;
      case 'settings':
        data = apiGetSettings(params);
        break;
      case 'auth':
        data = apiAuth(params);
        break;
      case 'facilities':
        data = apiGetFacilities();
        break;
      case 'facilities-detail':
        data = apiGetFacilitiesDetail(params);
        break;
      case 'ping':
        data = { status: 'ok', timestamp: new Date().toISOString() };
        break;
      default:
        return _errorResponse(400, `Unknown action: "${action}". Valid actions: summary, inventory-health, expiry, utilization, sku, mother-warehouse, settings, ping`);
    }

    return _jsonResponse(data);

  } catch (err) {
    Logger.log(`API Error [${action}]: ${err.message}\n${err.stack}`);
    return _errorResponse(500, err.message);
  }
}

// ---------------------------------------------------------------------------
// ENDPOINT: /summary
// Returns the latest dashboard KPI snapshot.
// Used by: Module 1 — Inventory Overview
// ---------------------------------------------------------------------------

/**
 * Returns the most recent dashboard summary row plus
 * facility-level and brand-level breakdowns for charts.
 */
function apiGetSummary() {
  // ── Latest KPI row ───────────────────────────────────────────────────────
  const summaryRows = readSheetAsObjects(SHEETS.DASHBOARD_SUMMARY);
  if (summaryRows.length === 0) {
    return { kpis: null, charts: {}, lastUpdated: null };
  }

  const latest  = summaryRows[summaryRows.length - 1];

  // Load SKU aggregate (one row per SKU) for accurate distinct counts
  const skuAggRows = readSheetAsObjects(SHEETS.SKU_AGG);

  // Count distinct SKUs per bucket from tbl_sku_agg (already 1 row per SKU)
  const bucketCounts = { OOS: 0, Critical: 0, Risk: 0, Healthy: 0, Overstock: 0 };
  skuAggRows.forEach(row => {
    if (String(row['Is Discontinued'] || '') === 'Yes') return;
    const bucket = String(row['Health Bucket'] || '');
    if (bucketCounts[bucket] !== undefined) bucketCounts[bucket]++;
  });

  const kpis = {
    totalInventoryValue    : safeNum(latest['Total Inventory Value']),
    goodInventoryValue     : safeNum(latest['Good Inventory Value']),
    badInventoryValue      : safeNum(latest['Bad Inventory Value']),
    nearExpiryValue        : safeNum(latest['Near Expiry Value']),
    criticalExpiryValue    : safeNum(latest['Critical Expiry Value']),
    expiredValue           : safeNum(latest['Expired Value']),
    valueAtRisk            : safeNum(latest['Value At Risk']),
    warehouseUtilizationPct: safeNum(latest['Warehouse Utilization Pct']),
    totalSkuCount          : safeNum(latest['Total SKU Count']),
    oosSkuCount            : bucketCounts.OOS,
    criticalSkuCount       : bucketCounts.Critical,
    riskSkuCount           : bucketCounts.Risk,
    healthySkuCount        : bucketCounts.Healthy,
    overstockSkuCount      : bucketCounts.Overstock,
    totalBins              : safeNum(latest['Total Bins']),
    occupiedBins           : safeNum(latest['Occupied Bins']),
    emptyBins              : safeNum(latest['Empty Bins']),
    cogsMissingSkuCount    : safeNum(latest['COGS Missing SKU Count']),
    discontinuedSkuCount   : safeNum(latest['Discontinued SKU Count']),
    discontinuedValue      : safeNum(latest['Discontinued Inventory Value']),
    runDate                : latest['Run Date'],
    runTimestamp           : latest['Run Timestamp'],
    status                 : latest['Status'],
  };

  // Charts: per-facility data from SKU summary; brand/bucket from SKU agg
  const skuRows = readSheetAsObjects(SHEETS.SKU_SUMMARY);
  const charts  = _buildSummaryCharts(skuAggRows, skuRows);

  // ── Trend data (last 30 days of dashboard summary) ────────────────────────
  const trend = _buildTrendData(summaryRows);

  return { kpis, charts, trend, lastUpdated: new Date().toISOString() };
}

// Brand normalisation reuses _normaliseBrand() from InventoryProcessor.js
// (all Apps Script files share the same scope — no duplication needed)
function _canonicalBrand(raw) {
  return _normaliseBrand(raw) || 'Unknown';
}

/**
 * Builds chart payloads.
 * skuAggRows  = tbl_sku_agg (one row per SKU) — used for brand and bucket charts
 * skuRows     = tbl_sku_summary (per-facility rows) — used for facility and mother-WH charts
 */
function _buildSummaryCharts(skuAggRows, skuRows) {
  const byFacility = new Map();
  const byBrand    = new Map();
  const byBucket   = new Map();
  const byMother   = new Map();

  // Brand and bucket charts from SKU-level aggregates (one row per SKU = no inflation)
  skuAggRows.forEach(row => {
    if (String(row['Is Discontinued'] || '') === 'Yes') return;
    const rawBrand = String(row['Brand'] || 'Unknown');
    const brand    = _canonicalBrand(rawBrand);
    const bucket   = String(row['Health Bucket'] || '');
    const value    = safeNum(row['Total Inventory Value']);
    const soh      = safeNum(row['Total SOH']);

    if (!byBrand.has(brand)) byBrand.set(brand, 0);
    byBrand.set(brand, byBrand.get(brand) + value);

    if (!byBucket.has(bucket)) byBucket.set(bucket, { skuCount: 0, qty: 0, value: 0 });
    const bAgg = byBucket.get(bucket);
    bAgg.skuCount++;
    bAgg.qty   += soh;
    bAgg.value += value;
  });

  // Facility and mother-WH charts from per-facility rows
  skuRows.forEach(row => {
    const facility     = String(row['Facility Code']        || '');
    const facilityType = String(row['Facility Type']        || '');
    const value        = safeNum(row['Inventory Value']);
    const goodVal      = safeNum(row['Good Inventory Value']);
    const badVal       = safeNum(row['Bad Inventory Value']);

    if (value > 0) {
      if (!byFacility.has(facility)) byFacility.set(facility, { value: 0, goodValue: 0, badValue: 0 });
      const fAgg = byFacility.get(facility);
      fAgg.value     += value;
      fAgg.goodValue += goodVal;
      fAgg.badValue  += badVal;
    }

    if (_isMotherwh(facilityType) && value > 0) {
      if (!byMother.has(facility)) byMother.set(facility, 0);
      byMother.set(facility, byMother.get(facility) + value);
    }
  });

  const brandsSorted = Array.from(byBrand.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  const bucketOrder = [
    HEALTH_BUCKET.OOS, HEALTH_BUCKET.CRITICAL,
    HEALTH_BUCKET.RISK, HEALTH_BUCKET.HEALTHY, HEALTH_BUCKET.OVERSTOCK,
  ];

  return {
    byFacility: Array.from(byFacility.entries())
      .map(([code, d]) => ({ facility: code, value: d.value, goodValue: d.goodValue, badValue: d.badValue }))
      .sort((a, b) => b.value - a.value),
    byBrand: brandsSorted.map(([brand, value]) => ({ brand, value })),
    byBucket: bucketOrder.map(b => {
      const d = byBucket.get(b) || { skuCount: 0, qty: 0, value: 0 };
      return { bucket: b, skuCount: d.skuCount, qty: d.qty, value: d.value };
    }),
    byMotherWarehouse: Array.from(byMother.entries())
      .map(([facility, value]) => ({ facility, value }))
      .sort((a, b) => b.value - a.value),
  };
}

/**
 * Builds 30-day trend data from dashboard summary history.
 */
function _buildTrendData(summaryRows) {
  const last30 = summaryRows.slice(-30);
  return last30.map(row => ({
    date              : _formatDate(row['Run Date']),
    totalValue        : safeNum(row['Total Inventory Value']),
    valueAtRisk       : safeNum(row['Value At Risk']),
    oosCount          : safeNum(row['OOS SKU Count']),
    utilizationPct    : safeNum(row['Warehouse Utilization Pct']),
  }));
}

// ---------------------------------------------------------------------------
// ENDPOINT: /inventory-health
// Returns bucket summary + filtered SKU detail table.
// Used by: Module 2 — Inventory Health
// ---------------------------------------------------------------------------

/**
 * Params:
 *   facility  (optional) filter by facility code
 *   brand     (optional) filter by brand
 *   bucket    (optional) filter by health bucket
 *   sku       (optional) filter by SKU code (partial match)
 *   page      (optional, default 1)
 *   pageSize  (optional, default 200)
 */
/**
 * Two-level inventory health view:
 *   Default (no ?facility): SKU-level aggregate from tbl_sku_agg — one row per SKU.
 *   With ?facility=CODE: Facility drill-down from tbl_sku_summary — rows for that facility only.
 *
 * Bucket summary always comes from tbl_sku_agg (distinct SKU counts, not inflated).
 */
function apiGetInventoryHealth(params) {
  const facilityFilter = (params.facility || '').trim().toUpperCase();
  const brandFilter    = (params.brand    || '').trim().toLowerCase();
  const bucketFilter   = (params.bucket   || '').trim();
  const skuFilter      = (params.sku      || '').trim().toLowerCase();
  const page           = Math.max(1, parseInt(params.page     || '1',    10));
  const pageSize       = Math.min(500, parseInt(params.pageSize || '200', 10));

  // Bucket summary always from tbl_sku_agg (1 row per SKU = correct distinct counts)
  const skuAggRows = readSheetAsObjects(SHEETS.SKU_AGG);
  const bucketTotals = {};
  Object.values(HEALTH_BUCKET).forEach(b => { bucketTotals[b] = { skuCount: 0, totalQty: 0, inventoryValue: 0 }; });
  skuAggRows.forEach(row => {
    if (String(row['Is Discontinued'] || '') === 'Yes') return;
    const b = String(row['Health Bucket'] || '');
    if (!bucketTotals[b]) return;
    bucketTotals[b].skuCount++;
    bucketTotals[b].totalQty      += safeNum(row['Total SOH']);
    bucketTotals[b].inventoryValue += safeNum(row['Total Inventory Value']);
  });
  const bucketSummary = Object.entries(bucketTotals).map(([bucket, d]) => ({ bucket, ...d }));

  const viewMode = facilityFilter ? 'facility' : 'sku';

  let rows, detail;

  if (viewMode === 'facility') {
    // Facility drill-down: read tbl_sku_summary filtered to the selected facility
    rows = readSheetAsObjects(SHEETS.SKU_SUMMARY)
      .filter(r => String(r['Facility Code'] || '').toUpperCase() === facilityFilter);

    if (brandFilter)  rows = rows.filter(r => String(r['Brand']        || '').toLowerCase().includes(brandFilter));
    if (bucketFilter) rows = rows.filter(r => String(r['Health Bucket']|| '') === bucketFilter);
    if (skuFilter)    rows = rows.filter(r =>
      String(r['SKU Code']     || '').toLowerCase().includes(skuFilter) ||
      String(r['Product Name'] || '').toLowerCase().includes(skuFilter)
    );

    rows.sort((a, b) => {
      const pri = { OOS: 0, Critical: 1, Risk: 2, Healthy: 3, Overstock: 4 };
      const pa  = pri[a['Health Bucket']] ?? 9;
      const pb  = pri[b['Health Bucket']] ?? 9;
      if (pa !== pb) return pa - pb;
      return safeNum(b['Inventory Value']) - safeNum(a['Inventory Value']);
    });

    const paged = rows.slice((page - 1) * pageSize, page * pageSize);
    detail = paged.map(row => ({
      skuCode       : row['SKU Code'],
      productName   : row['Product Name'],
      brand         : row['Brand'],
      category      : row['Category'],
      facilityCode  : row['Facility Code'],
      facilityName  : row['Facility Name'],
      facilityType  : row['Facility Type'],
      soh           : safeNum(row['SOH']),
      sit           : safeNum(row['SIT']),
      damaged       : safeNum(row['Damaged Stock']),
      sales30       : safeNum(row['Last 30 Days Sales']),
      sales7        : safeNum(row['Last 7 Days Sales']),
      doi30         : _roundDoi(safeNum(row['DOI30'])),
      doi7          : _roundDoi(safeNum(row['DOI7'])),
      inventoryValue: safeNum(row['Inventory Value']),
      goodQty       : safeNum(row['Good Qty']),
      badQty        : safeNum(row['Bad Qty']),
      nearExpiryQty : safeNum(row['Near Expiry Qty']),
      critExpiryQty : safeNum(row['Critical Expiry Qty']),
      expiredQty    : safeNum(row['Expired Qty']),
      goodValue     : safeNum(row['Good Inventory Value']),
      badValue      : safeNum(row['Bad Inventory Value']),
      valueAtRisk   : safeNum(row['Value At Risk']),
      bucket        : row['Health Bucket'],
      cogsSource    : row['COGS Source'],
    }));

  } else {
    // SKU-level view: read tbl_sku_agg — one row per SKU, aggregate across all facilities
    rows = skuAggRows.filter(r => String(r['Is Discontinued'] || '') !== 'Yes');

    if (brandFilter)  rows = rows.filter(r => String(r['Brand']        || '').toLowerCase().includes(brandFilter));
    if (bucketFilter) rows = rows.filter(r => String(r['Health Bucket']|| '') === bucketFilter);
    if (skuFilter)    rows = rows.filter(r =>
      String(r['SKU Code']     || '').toLowerCase().includes(skuFilter) ||
      String(r['Product Name'] || '').toLowerCase().includes(skuFilter)
    );

    rows.sort((a, b) => {
      const pri = { OOS: 0, Critical: 1, Risk: 2, Healthy: 3, Overstock: 4 };
      const pa  = pri[a['Health Bucket']] ?? 9;
      const pb  = pri[b['Health Bucket']] ?? 9;
      if (pa !== pb) return pa - pb;
      return safeNum(b['Total Inventory Value']) - safeNum(a['Total Inventory Value']);
    });

    const paged = rows.slice((page - 1) * pageSize, page * pageSize);
    detail = paged.map(row => ({
      skuCode       : row['SKU Code'],
      productName   : row['Product Name'],
      brand         : row['Brand'],
      category      : row['Category'],
      facilityCode  : row['Active Facilities'] || 'All Facilities',
      facilityType  : '',
      facilityName  : 'All Facilities',
      soh           : safeNum(row['Total SOH']),
      sit           : safeNum(row['Total SIT']),
      damaged       : safeNum(row['Total Damaged']),
      sales30       : safeNum(row['Sales 30D']),
      sales7        : safeNum(row['Sales 7D']),
      doi30         : _roundDoi(safeNum(row['DOI30'])),
      doi7          : _roundDoi(safeNum(row['DOI7'])),
      inventoryValue: safeNum(row['Total Inventory Value']),
      goodQty       : safeNum(row['Total Good Qty']),
      badQty        : safeNum(row['Total Bad Qty']),
      nearExpiryQty : safeNum(row['Near Expiry Qty']),
      critExpiryQty : safeNum(row['Critical Expiry Qty']),
      expiredQty    : safeNum(row['Expired Qty']),
      goodValue     : safeNum(row['Total Good Value']),
      badValue      : safeNum(row['Total Bad Value']),
      valueAtRisk   : safeNum(row['Value At Risk']),
      bucket        : row['Health Bucket'],
      cogsSource    : row['COGS Source'],
    }));
  }

  return {
    viewMode,
    bucketSummary,
    skuDetail : detail,
    pagination: { page, pageSize, totalCount: rows.length, totalPages: Math.ceil(rows.length / pageSize) },
    filters   : { facilityFilter, brandFilter, bucketFilter, skuFilter },
  };
}

// ---------------------------------------------------------------------------
// ENDPOINT: /expiry
// Returns expiry risk rows grouped by bucket.
// Used by: Module 3 — Expiry Management
// ---------------------------------------------------------------------------

/**
 * Params:
 *   facility  (optional)
 *   bucket    (optional) 'Expired' | 'Critical Expiry' | 'Near Expiry'
 *   page      (optional, default 1)
 *   pageSize  (optional, default 200)
 */
function apiGetExpiry(params) {
  const facilityFilter = (params.facility || '').trim().toUpperCase();
  const bucketFilter   = (params.bucket   || '').trim();
  const page           = Math.max(1, parseInt(params.page     || '1',    10));
  const pageSize       = Math.min(500, parseInt(params.pageSize || '200', 10));

  let rows = readSheetAsObjects(SHEETS.EXPIRY_SUMMARY);

  if (facilityFilter) {
    rows = rows.filter(r => String(r['Facility Code'] || '').toUpperCase() === facilityFilter);
  }
  if (bucketFilter) {
    rows = rows.filter(r => String(r['Expiry Bucket'] || '') === bucketFilter);
  }

  // Already sorted by days-to-expiry ascending from processor
  // Build bucket summary
  const bucketTotals = {};
  Object.values(EXPIRY_BUCKET).forEach(b => {
    bucketTotals[b] = { qty: 0, value: 0, skuCount: 0, batchCount: 0 };
  });

  // Count before pagination for summary
  rows.forEach(row => {
    const b = String(row['Expiry Bucket'] || '');
    if (!bucketTotals[b]) return;
    bucketTotals[b].qty       += safeNum(row['Qty']);
    bucketTotals[b].value     += safeNum(row['Inventory Value']);
    bucketTotals[b].batchCount++;
  });

  // Count unique SKUs per bucket
  const skuSets = {};
  Object.values(EXPIRY_BUCKET).forEach(b => { skuSets[b] = new Set(); });
  rows.forEach(row => {
    const b = String(row['Expiry Bucket'] || '');
    if (skuSets[b]) skuSets[b].add(row['SKU Code']);
  });
  Object.values(EXPIRY_BUCKET).forEach(b => {
    if (bucketTotals[b]) bucketTotals[b].skuCount = skuSets[b].size;
  });

  const totalCount = rows.length;
  const totalPages = Math.ceil(totalCount / pageSize);
  const pagedRows  = rows.slice((page - 1) * pageSize, page * pageSize);

  const detail = pagedRows.map(row => ({
    skuCode       : row['SKU Code'],
    productName   : row['Product Name'],
    facilityCode  : row['Facility Code'],
    batchCode     : row['Batch Code'],
    expiryDate    : _formatDate(row['Expiry Date']),
    daysToExpiry  : safeNum(row['Days To Expiry']),
    qty           : safeNum(row['Qty']),
    inventoryValue: safeNum(row['Inventory Value']),
    expiryBucket  : row['Expiry Bucket'],
  }));

  // Aging buckets (0-30, 31-60, 61-90, 90+) across all expiry rows
  const aging = _buildExpiryAging(rows);

  return {
    bucketSummary: Object.entries(bucketTotals).map(([bucket, d]) => ({ bucket, ...d })),
    aging,
    detail,
    pagination: { page, pageSize, totalCount, totalPages },
  };
}

/**
 * Groups expiry rows into aging buckets: 0-30, 31-60, 61-90, 90+.
 */
function _buildExpiryAging(rows) {
  const aging = {
    'Expired': { qty: 0, value: 0 },
    '0-30'   : { qty: 0, value: 0 },
    '31-60'  : { qty: 0, value: 0 },
    '61-90'  : { qty: 0, value: 0 },
    '90+'    : { qty: 0, value: 0 },
  };

  rows.forEach(row => {
    const days  = safeNum(row['Days To Expiry']);
    const qty   = safeNum(row['Qty']);
    const value = safeNum(row['Inventory Value']);

    let bucket;
    if (days < 0)         bucket = 'Expired'; // already past expiry date
    else if (days <= 30)  bucket = '0-30';
    else if (days <= 60)  bucket = '31-60';
    else if (days <= 90)  bucket = '61-90';
    else                  bucket = '90+';

    aging[bucket].qty   += qty;
    aging[bucket].value += value;
  });

  return Object.entries(aging).map(([range, d]) => ({ range, qty: d.qty, value: d.value }));
}

// ---------------------------------------------------------------------------
// ENDPOINT: /utilization
// Returns SL_MH bin utilization KPIs and heatmap data.
// Used by: Module 4 — Warehouse Utilization
// ---------------------------------------------------------------------------

function apiGetUtilization() {
  const sheet   = getSheet(SHEETS.WAREHOUSE_UTILIZATION);
  const allData = sheet.getDataRange().getValues();

  if (allData.length <= 1) {
    return { kpis: null, heatmap: {}, binDetail: [] };
  }

  // The sheet has two sections:
  // Section 1: Summary row (columns match WAREHOUSE_UTILIZATION_COLUMNS)
  // Section 2: Bin detail rows (starts after a blank row, columns match BIN_DETAIL_COLUMNS)
  // We parse them separately.

  const summaryHeaders = allData[0];
  const summaryRow     = allData[1] || [];

  const kpis = {
    totalBins      : _getCellVal(summaryRow, summaryHeaders, 'Total Bins'),
    occupiedBins   : _getCellVal(summaryRow, summaryHeaders, 'Occupied Bins'),
    emptyBins      : _getCellVal(summaryRow, summaryHeaders, 'Empty Bins'),
    utilizationPct : _getCellVal(summaryRow, summaryHeaders, 'Utilization Pct'),
    runDate        : _formatDate(_getCellVal(summaryRow, summaryHeaders, 'Run Date')),
  };

  // Find bin detail section (look for BIN_DETAIL_COLUMNS header row)
  let detailHeaderIdx = -1;
  for (let i = 2; i < allData.length; i++) {
    if (String(allData[i][0] || '').trim() === 'Run Date' &&
        String(allData[i][1] || '').trim() === 'Bin ID') {
      detailHeaderIdx = i;
      break;
    }
  }

  let binRows = [];
  if (detailHeaderIdx !== -1) {
    const detailHeaders = allData[detailHeaderIdx];
    for (let i = detailHeaderIdx + 1; i < allData.length; i++) {
      const row = allData[i];
      if (!row[1]) continue; // Skip blank rows
      binRows.push({
        binId     : String(row[_hIdx(detailHeaders, 'Bin ID')]     || ''),
        row       : String(row[_hIdx(detailHeaders, 'Row')]        || ''),
        col       : String(row[_hIdx(detailHeaders, 'Column No')]  || ''),
        level     : String(row[_hIdx(detailHeaders, 'Level')]      || ''),
        isOccupied: row[_hIdx(detailHeaders, 'Is Occupied')] === true,
      });
    }
  }

  // Build heatmap aggregations
  const heatmap = _buildHeatmap(binRows);

  return { kpis, heatmap, binDetail: binRows };
}

function _buildHeatmap(binRows) {
  const byRow   = new Map();
  const byCol   = new Map();
  const byLevel = new Map();

  binRows.forEach(bin => {
    _heatmapIncrement(byRow,   bin.row,   bin.isOccupied);
    _heatmapIncrement(byCol,   bin.col,   bin.isOccupied);
    _heatmapIncrement(byLevel, bin.level, bin.isOccupied);
  });

  const toArr = (map) => Array.from(map.entries())
    .map(([key, d]) => ({
      key,
      total       : d.total,
      occupied    : d.occupied,
      empty       : d.total - d.occupied,
      utilizationPct: d.total > 0 ? +(d.occupied / d.total * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));

  return {
    byRow  : toArr(byRow),
    byCol  : toArr(byCol),
    byLevel: toArr(byLevel),
  };
}

function _heatmapIncrement(map, key, isOccupied) {
  if (!key) return;
  if (!map.has(key)) map.set(key, { total: 0, occupied: 0 });
  const d = map.get(key);
  d.total++;
  if (isOccupied) d.occupied++;
}

// ---------------------------------------------------------------------------
// ENDPOINT: /sku
// Returns full SKU deep-dive for a single SKU across all facilities.
// Used by: Module 5 — SKU Deep Dive
// ---------------------------------------------------------------------------

/**
 * Params:
 *   skuCode (required)
 */
function apiGetSku(params) {
  const skuCode = (params.skuCode || '').trim();
  if (!skuCode) return _apiError('skuCode parameter is required.');

  // SKU summary rows for this SKU (all facilities)
  const allSkuRows = readSheetAsObjects(SHEETS.SKU_SUMMARY);
  const skuRows    = allSkuRows.filter(r =>
    String(r['SKU Code'] || '').trim().toLowerCase() === skuCode.toLowerCase()
  );

  if (skuRows.length === 0) {
    return { found: false, skuCode };
  }

  const firstRow = skuRows[0];

  // Facility-wise breakdown
  const facilityBreakdown = skuRows.map(row => ({
    facilityCode   : row['Facility Code'],
    facilityType   : row['Facility Type'],
    soh            : safeNum(row['SOH']),
    sit            : safeNum(row['SIT']),
    sales30        : safeNum(row['Last 30 Days Sales']),
    sales7         : safeNum(row['Last 7 Days Sales']),
    doi30          : _roundDoi(safeNum(row['DOI30'])),
    doi7           : _roundDoi(safeNum(row['DOI7'])),
    inventoryValue : safeNum(row['Inventory Value']),
    goodQty        : safeNum(row['Good Qty']),
    badQty         : safeNum(row['Bad Qty']),
    goodValue      : safeNum(row['Good Inventory Value']),
    badValue       : safeNum(row['Bad Inventory Value']),
    nearExpiryQty  : safeNum(row['Near Expiry Qty']),
    expiredQty     : safeNum(row['Expired Qty']),
    valueAtRisk    : safeNum(row['Value At Risk']),
    bucket         : row['Health Bucket'],
    cogsSource     : row['COGS Source'],
  }));

  // Totals across all facilities
  const totals = facilityBreakdown.reduce((acc, r) => {
    acc.soh            += r.soh;
    acc.sit            += r.sit;
    acc.inventoryValue += r.inventoryValue;
    acc.goodQty        += r.goodQty;
    acc.badQty         += r.badQty;
    acc.nearExpiryQty  += r.nearExpiryQty;
    acc.expiredQty     += r.expiredQty;
    acc.valueAtRisk    += r.valueAtRisk;
    return acc;
  }, { soh: 0, sit: 0, inventoryValue: 0, goodQty: 0, badQty: 0, nearExpiryQty: 0, expiredQty: 0, valueAtRisk: 0 });

  // Expiry / batch details from expiry summary
  const allExpiryRows = readSheetAsObjects(SHEETS.EXPIRY_SUMMARY);
  const expiryRows    = allExpiryRows
    .filter(r => String(r['SKU Code'] || '').trim().toLowerCase() === skuCode.toLowerCase())
    .map(row => ({
      facilityCode  : row['Facility Code'],
      batchCode     : row['Batch Code'],
      expiryDate    : _formatDate(row['Expiry Date']),
      daysToExpiry  : safeNum(row['Days To Expiry']),
      qty           : safeNum(row['Qty']),
      inventoryValue: safeNum(row['Inventory Value']),
      expiryBucket  : row['Expiry Bucket'],
    }));

  return {
    found          : true,
    skuCode        : String(firstRow['SKU Code']     || ''),
    productName    : String(firstRow['Product Name'] || ''),
    brand          : String(firstRow['Brand']        || ''),
    category       : String(firstRow['Category']     || ''),
    cogs           : safeNum(firstRow['COGS']),
    cogsSource     : String(firstRow['COGS Source']  || ''),
    totals,
    facilityBreakdown,
    expiryDetail   : expiryRows,
  };
}

// ---------------------------------------------------------------------------
// ENDPOINT: /mother-warehouse
// Returns mother warehouse control tower view.
// Used by: Module 6 — Mother Warehouse Control Tower
// ---------------------------------------------------------------------------

function apiGetMotherWarehouse() {
  const facilityMap = _loadFacilityMap();
  const skuRows     = readSheetAsObjects(SHEETS.SKU_SUMMARY);

  // Aggregate per mother warehouse facility
  const motherAgg = new Map(); // facilityCode → aggregated KPIs

  facilityMap.forEach((info, code) => {
    if (!_isMotherwh(info['Facility_Type'] || info['Facility Type'])) return;
    motherAgg.set(code, {
      facilityCode    : code,
      facilityName    : String(info['Display_Name'] || info['Facility Name'] || code),
      soh             : 0,
      sit             : 0,
      inventoryValue  : 0,
      goodValue       : 0,
      badValue        : 0,
      valueAtRisk     : 0,
      sales30         : 0,
      sales7          : 0,
      totalSkus       : 0,
      oosSkus         : 0,
      criticalSkus    : 0,
      healthySkus     : 0,
      overstockSkus   : 0,
    });
  });

  skuRows.forEach(row => {
    const code = String(row['Facility Code'] || '');
    if (!motherAgg.has(code)) return;

    const agg = motherAgg.get(code);
    agg.soh            += safeNum(row['SOH']);
    agg.sit            += safeNum(row['SIT']);
    agg.inventoryValue += safeNum(row['Inventory Value']);
    agg.goodValue      += safeNum(row['Good Inventory Value']);
    agg.badValue       += safeNum(row['Bad Inventory Value']);
    agg.valueAtRisk    += safeNum(row['Value At Risk']);
    agg.sales30        += safeNum(row['Last 30 Days Sales']);
    agg.sales7         += safeNum(row['Last 7 Days Sales']);
    agg.totalSkus++;

    const bucket = row['Health Bucket'];
    if (bucket === HEALTH_BUCKET.OOS)       agg.oosSkus++;
    if (bucket === HEALTH_BUCKET.CRITICAL)  agg.criticalSkus++;
    if (bucket === HEALTH_BUCKET.HEALTHY)   agg.healthySkus++;
    if (bucket === HEALTH_BUCKET.OVERSTOCK) agg.overstockSkus++;
  });

  const facilities = Array.from(motherAgg.values()).map(agg => {
    // Compute aggregate DOI
    const drr30 = agg.sales30 > 0 ? agg.sales30 / 30 : 0;
    const drr7  = agg.sales7  > 0 ? agg.sales7  / 7  : 0;
    const doi30 = drr30 > 0 ? _roundDoi(agg.soh / drr30) : (agg.soh > 0 ? 9999 : 0);
    const doi7  = drr7  > 0 ? _roundDoi(agg.soh / drr7)  : (agg.soh > 0 ? 9999 : 0);

    // Traffic light status
    const status = _motherWarehouseStatus(agg.oosSkus, agg.criticalSkus, agg.totalSkus);

    return { ...agg, doi30, doi7, status };
  });

  return { facilities, lastUpdated: new Date().toISOString() };
}

/**
 * Assigns a traffic-light status to a mother warehouse.
 * Red: >5% OOS or >10% Critical
 * Yellow: >2% OOS or >5% Critical
 * Green: otherwise
 */
function _motherWarehouseStatus(oosSkus, criticalSkus, totalSkus) {
  if (totalSkus === 0) return 'Grey';
  const oosPct      = oosSkus      / totalSkus;
  const criticalPct = criticalSkus / totalSkus;
  if (oosPct > 0.05 || criticalPct > 0.10) return 'Red';
  if (oosPct > 0.02 || criticalPct > 0.05) return 'Yellow';
  return 'Green';
}

// ---------------------------------------------------------------------------
// ENDPOINT: /settings
// Returns non-sensitive settings for the dashboard Settings page.
// Admin-only: requires ?token= matching a setting stored in the sheet.
// ---------------------------------------------------------------------------

function apiGetSettings(params) {
  // Simple token check — admin sets 'admin_token' in tbl_settings
  const token        = (params.token || '').trim();
  const storedToken  = getSetting('admin_token');

  if (!storedToken || token !== storedToken) {
    return _apiError('Unauthorized. Provide valid ?token= parameter.');
  }

  // Return only non-sensitive settings (exclude token itself)
  const sensitiveKeys = ['admin_token', 'oauth_client_id', 'spreadsheet_id'];
  const allSettings   = readSheetAsObjects(SHEETS.SETTINGS);

  const settings = allSettings
    .filter(row => !sensitiveKeys.includes(row['Setting Key']))
    .map(row => ({
      key        : row['Setting Key'],
      value      : row['Setting Value'],
      description: row['Description'],
      lastUpdated: _formatDate(row['Last Updated']),
    }));

  return { settings };
}

// ---------------------------------------------------------------------------
// FACILITIES LIST (helper used by frontend filter dropdowns)
// ---------------------------------------------------------------------------

function apiGetFacilities() {
  const rows = readSheetAsObjects(SHEETS.FACILITY_MAPPING);
  return rows
    .filter(r => {
      const a = String(r['Is Active'] || 'true').toLowerCase();
      return a !== 'false' && a !== '0' && a !== 'no';
    })
    .map(r => ({
      code    : r['Depot Name'],
      name    : r['Display_Name'] || r['Depot Name'],
      type    : r['Facility_Type'],
      fType   : r['F_Type'] || '',
    }));
}

// ---------------------------------------------------------------------------
// ENDPOINT: /facilities-detail
// Returns per-facility inventory breakdown grouped by facility.
// Used by: Facility drill-down panel (point 2 — facility-level view).
// Params:
//   sku (optional) — filter to a specific SKU across all facilities
// ---------------------------------------------------------------------------

function apiGetFacilitiesDetail(params) {
  const skuFilter = (params.sku || '').trim().toLowerCase();

  let skuRows = readSheetAsObjects(SHEETS.SKU_SUMMARY);
  if (skuFilter) {
    skuRows = skuRows.filter(r =>
      String(r['SKU Code']     || '').toLowerCase().includes(skuFilter) ||
      String(r['Product Name'] || '').toLowerCase().includes(skuFilter)
    );
  }

  const facilityMap = readSheetAsObjects(SHEETS.FACILITY_MAPPING);
  const facilityInfo = {};
  facilityMap.forEach(r => {
    const code = String(r['Depot Name'] || '').trim();
    if (code) facilityInfo[code] = {
      name : r['Display_Name'] || code,
      type : r['Facility_Type'] || '',
      fType: r['F_Type'] || '',
    };
  });

  // Group by facility
  const byFacility = new Map();

  skuRows.forEach(row => {
    const code = String(row['Facility Code'] || '').trim();
    if (!code) return;

    if (!byFacility.has(code)) {
      const info = facilityInfo[code] || { name: code, type: '', fType: '' };
      byFacility.set(code, {
        facilityCode    : code,
        facilityName    : info.name,
        facilityType    : info.type,
        fType           : info.fType,
        totalSoh        : 0,
        totalValue      : 0,
        goodValue       : 0,
        badValue        : 0,
        goodQty         : 0,
        badQty          : 0,
        nearExpiryQty   : 0,
        critExpiryQty   : 0,
        expiredQty      : 0,
        nearExpiryValue : 0,
        critExpiryValue : 0,
        expiredValue    : 0,
        valueAtRisk     : 0,
        skuCount        : 0,
        oosSkuCount     : 0,
      });
    }

    const agg = byFacility.get(code);
    agg.totalSoh        += safeNum(row['SOH']);
    agg.totalValue      += safeNum(row['Inventory Value']);
    agg.goodValue       += safeNum(row['Good Inventory Value']);
    agg.badValue        += safeNum(row['Bad Inventory Value']);
    agg.goodQty         += safeNum(row['Good Qty']);
    agg.badQty          += safeNum(row['Bad Qty']);
    agg.nearExpiryQty   += safeNum(row['Near Expiry Qty']);
    agg.critExpiryQty   += safeNum(row['Critical Expiry Qty']);
    agg.expiredQty      += safeNum(row['Expired Qty']);
    agg.nearExpiryValue += safeNum(row['Near Expiry Value']);
    agg.critExpiryValue += safeNum(row['Critical Expiry Value']);
    agg.expiredValue    += safeNum(row['Expired Value']);
    agg.valueAtRisk     += safeNum(row['Value At Risk']);
    agg.skuCount++;
    if (safeNum(row['SOH']) === 0) agg.oosSkuCount++;
  });

  const facilities = Array.from(byFacility.values())
    .sort((a, b) => b.totalValue - a.totalValue);

  return { facilities, lastUpdated: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// RESPONSE HELPERS
// ---------------------------------------------------------------------------

/**
 * Wraps data in a standard success envelope and returns a JSON ContentService response.
 */
function _jsonResponse(data) {
  const payload = JSON.stringify({
    success  : true,
    data     : data,
    timestamp: new Date().toISOString(),
  });

  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns a JSON error response.
 */
function _errorResponse(code, message) {
  const payload = JSON.stringify({
    success: false,
    error  : { code, message },
    timestamp: new Date().toISOString(),
  });

  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Returns a structured API error object (used inside handlers, not as HTTP response).
 */
function _apiError(message) {
  return { error: true, message };
}

// ---------------------------------------------------------------------------
// UTILITY HELPERS (private to API.gs)
// ---------------------------------------------------------------------------

/**
 * Gets a cell value from a row using header name lookup.
 */
function _getCellVal(row, headers, colName) {
  const idx = headers.indexOf(colName);
  return idx === -1 ? null : row[idx];
}

/**
 * Returns the 0-based index of a header name in an array.
 */
function _hIdx(headers, name) {
  return headers.indexOf(name);
}

/**
 * Formats a Date object to YYYY-MM-DD string. Returns '' for invalid dates.
 */
function _formatDate(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return Utilities.formatDate(d, getSetting('timezone') || 'Asia/Kolkata', 'yyyy-MM-dd');
}

/**
 * Rounds DOI to 1 decimal. Caps 9999 (infinite) display at 9999.
 */
function _roundDoi(doi) {
  if (doi >= 9999) return 9999;
  return Math.round(doi * 10) / 10;
}