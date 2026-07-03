// =============================================================================
// InventoryProcessor.gs — Inventory Control Tower
// Core calculation engine. All business logic lives here.
//
// Key rules (v2):
//   - Only mapped+active facilities processed (unmapped = excluded)
//   - COGS master = Active SKU list. Not in COGS = Discontinued
//   - Good Inventory = Saleable + Not Damaged + Not Expired + Not Near Expiry
//   - Bad Inventory  = Expired + Near Expiry + Damaged + Non-Saleable
//   - Good + Bad     = Total Inventory Value (always)
//   - SKU counts     = DISTINCT SKU codes only
//   - Brand names    = auto-normalised (trim + lowercase key)
//   - DOI            = SOH / DRR at SKU level only
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

function runInventoryEngine() {
  Logger.log('--- InventoryProcessor v2: Starting ---');
  const runDate = new Date();
  const today   = getToday();

  // 1. Reference data
  Logger.log('Loading reference data...');
  const cogsMap     = _loadCogsMap();          // Map: skuCode → { COGS, Brand, ... }
  const facilityMap = _loadFacilityMap();      // Map: facilityCode → { type, name }
  const mappedCodes = new Set(facilityMap.keys());
  const salesNodes  = _getSalesNodeCodes(facilityMap);
  const motherCodes = _getMotherWarehouseCodes(facilityMap);
  const activeSKUs  = new Set(cogsMap.keys()); // COGS = Active SKU master

  Logger.log(`COGS SKUs (active): ${activeSKUs.size}`);
  Logger.log(`Mapped facilities: ${mappedCodes.size}`);
  Logger.log(`Mother WHs: ${motherCodes.join(', ')}`);
  Logger.log(`Sales Nodes: ${salesNodes.join(', ')}`);

  // 2. Load raw data
  Logger.log('Loading FG raw...');
  const fgRows = _loadFgRaw();
  Logger.log(`FG rows: ${fgRows.length}`);
  if (fgRows.length === 0) { Logger.log('No FG data. Aborting.'); return; }

  Logger.log('Loading Shelf raw...');
  const shelfRows = _loadShelfRaw();
  Logger.log(`Shelf rows: ${shelfRows.length}`);

  const thresholds = _loadThresholds();

  // 3. Build shelf aggregates (only mapped facilities)
  const shelfAgg = _aggregateShelfData(shelfRows, today, mappedCodes, thresholds);

  // 4. Combined sales from all mapped sales nodes (for Mother WH DOI)
  const combinedSales = _computeCombinedSales(fgRows, new Set(salesNodes));

  // 5. Build SKU summary — only mapped facilities, flag discontinued
  Logger.log('Building SKU summary...');
  const { skuRows, discontinuedRows, excludedFacilities } =
    _buildSkuSummary(fgRows, shelfAgg, cogsMap, facilityMap, mappedCodes,
                     new Set(motherCodes), new Set(salesNodes), combinedSales,
                     activeSKUs, runDate, today, thresholds);

  Logger.log(`SKU summary rows: ${skuRows.length}`);
  Logger.log(`Discontinued rows: ${discontinuedRows.length}`);
  Logger.log(`Excluded facility codes: ${[...excludedFacilities].join(', ')}`);

  // 6. SKU-level aggregates (1 row per SKU — used for management KPIs)
  Logger.log('Computing SKU aggregates...');
  const skuAggRows = _computeSkuAggregates(skuRows, discontinuedRows,
                                            combinedSales, thresholds, runDate);
  Logger.log(`SKU agg rows: ${skuAggRows.length}`);

  // 7. Health buckets (from SKU aggregates, not per-facility rows)
  const healthRows = _computeHealthBuckets(skuAggRows, runDate);

  // 8. Expiry summary (mapped facilities only)
  Logger.log('Computing expiry...');
  const expiryRows = _computeExpirySummary(shelfRows, cogsMap, fgRows,
                                            runDate, today, thresholds, mappedCodes, facilityMap);
  Logger.log(`Expiry rows: ${expiryRows.length}`);

  // 9. Bin utilization
  Logger.log('Computing utilization...');
  const utilData = _computeBinUtilization(shelfRows, runDate);

  // 10. Bad inventory summary (facility-wise, excludes DS)
  Logger.log('Computing bad inventory...');
  const badInvRows = _computeBadInventorySummary(shelfRows, cogsMap, facilityMap,
                                                  mappedCodes, runDate);
  Logger.log(`Bad inventory rows: ${badInvRows.length}`);

  // 11. Write outputs
  Logger.log('Writing outputs...');
  _writeSkuSummary(skuRows);
  _writeDiscontinued(discontinuedRows);
  _writeSkuAgg(skuAggRows);
  _writeHealthSummary(healthRows);
  _writeExpirySummary(expiryRows);
  _writeBadInventory(badInvRows);
  _writeUtilization(utilData);
  _writeDashboardSummary(skuAggRows, discontinuedRows, healthRows, utilData,
                          excludedFacilities, activeSKUs, runDate);

  Logger.log('--- InventoryProcessor v2: Done ---');
}

// ---------------------------------------------------------------------------
// REFERENCE DATA LOADERS
// ---------------------------------------------------------------------------

function _loadCogsMap() {
  const rows = readSheetAsObjects(SHEETS.COGS_MASTER);
  const map  = new Map();
  rows.forEach(row => {
    // Support both 'SKU Code' (with space — actual sheet header) and 'SkuCode' (legacy)
    const sku = String(row['SKU Code'] || row['SkuCode'] || '').trim();
    if (sku && sku !== 'EXAMPLE.SKU.001') map.set(sku, row);
  });
  return map;
}

function _loadFacilityMap() {
  const rows = readSheetAsObjects(SHEETS.FACILITY_MAPPING);
  const map  = new Map();
  rows.forEach(row => {
    const active = String(row['Is Active'] || 'true').toLowerCase();
    if (active === 'false' || active === '0' || active === 'no') return;
    // Key = Depot Name (matches both FG report 'Depot Name' and Shelf report 'Facility' column)
    const code = String(row['Depot Name'] || row['Facility Code'] || '').trim();
    if (code) map.set(code, row);
  });
  return map;
}

function _getSalesNodeCodes(facilityMap) {
  const codes = [];
  facilityMap.forEach((row, code) => {
    if (!_isMotherwh(row['Facility_Type'] || row['Facility Type'])) codes.push(code);
  });
  return codes;
}

function _getMotherWarehouseCodes(facilityMap) {
  const codes = [];
  facilityMap.forEach((row, code) => {
    if (_isMotherwh(row['Facility_Type'] || row['Facility Type'])) codes.push(code);
  });
  return codes;
}

function _loadThresholds() {
  return {
    doiCritical       : getSettingInt('doi_critical_threshold')   || 7,
    doiRiskMin        : getSettingInt('doi_risk_min')              || 8,
    doiRiskMax        : getSettingInt('doi_risk_max')              || 30,
    doiHealthyMin     : getSettingInt('doi_healthy_min')           || 31,
    doiHealthyMax     : getSettingInt('doi_healthy_max')           || 90,
    doiOverstock      : getSettingInt('doi_overstock_threshold')   || 90,
    nearExpiryDays    : getSettingInt('near_expiry_days')          || 60,
    criticalExpiryDays: getSettingInt('critical_expiry_days')      || 30,
  };
}

function _loadFgRaw()    { return readSheetAsObjects(SHEETS.FG_INVENTORY_RAW); }
function _loadShelfRaw() { return readSheetAsObjects(SHEETS.SHELF_INVENTORY_RAW); }

// ---------------------------------------------------------------------------
// BRAND NORMALISATION
// Auto-deduplicates: trim + collapse whitespace + title-case
// ---------------------------------------------------------------------------

// Brand override map — canonical names for known variants
const BRAND_OVERRIDE_MAP = {
  'bebodywise'   : 'Be Bodywise',
  'be bodywise'  : 'Be Bodywise',
  'bodywise'     : 'Be Bodywise',
  'manmatters'   : 'Man Matters',
  'man matters'  : 'Man Matters',
  'littlejoys'   : 'Little Joys',
  'little joys'  : 'Little Joys',
  'littlejoy'    : 'Little Joys',
  'rootlabs'     : 'Root Labs',
  'root labs'    : 'Root Labs',
  'root labs usa': 'Root Labs USA',
  'rootlabsusa'  : 'Root Labs USA',
  'stay steady'  : 'Stay Steady',
  'staysteady'   : 'Stay Steady',
};

const _brandCache = new Map();

function _normaliseBrand(raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
  const key     = cleaned.toLowerCase();
  if (_brandCache.has(key)) return _brandCache.get(key);
  const canonical = BRAND_OVERRIDE_MAP[key] ||
    cleaned.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  _brandCache.set(key, canonical);
  return canonical;
}

// ---------------------------------------------------------------------------
// SHELF DATA AGGREGATION
// Only processes mapped facilities.
// Good = Saleable + Not Damaged + Not Expired + Not Near Expiry
// Bad  = everything else (including Near Expiry)
// ---------------------------------------------------------------------------

function _aggregateShelfData(shelfRows, today, mappedCodes, thresholds) {
  const map = new Map();

  shelfRows.forEach(row => {
    // Match shelf rows using 'Facility' (full name) — same as Depot Name in facility mapping
    const facilityCode = String(row['Facility'] || row['Facility Code'] || '').trim();
    if (!mappedCodes.has(facilityCode)) return; // Skip unmapped

    const skuCode = String(row['Item Type SKU Code'] || '').trim();
    if (!skuCode) return;

    const key = `${facilityCode}|${skuCode}`;
    if (!map.has(key)) {
      map.set(key, {
        facilityCode,
        skuCode,
        goodQty          : 0,
        badQty           : 0,
        nearExpiryQty    : 0,
        criticalExpiryQty: 0,
        expiredQty       : 0,
        damagedQty       : 0,
        batches          : [],
      });
    }

    const agg          = map.get(key);
    const qty          = safeNum(row['Quantity']);
    const qtyDamaged   = safeNum(row['Quantity Damaged']);
    const qtyNotFound  = safeNum(row['Quantity Not Found']);
    const inventoryType= String(row['Inventory Type'] || '').trim().toUpperCase();
    const batchStatus  = String(row['Batch Status']   || '').trim();
    const expiryDate   = safeDate(row['Expiry']);

    // Expiry classification
    let isExpired     = false;
    let isNearExpiry  = false;
    let daysToExpiry  = null;

    if (expiryDate) {
      daysToExpiry = daysBetween(expiryDate, today);
      if (daysToExpiry < 0) {
        isExpired = true;
        agg.expiredQty += qty;
      } else if (daysToExpiry <= thresholds.criticalExpiryDays) {
        isNearExpiry = true;
        agg.criticalExpiryQty += qty;
        agg.nearExpiryQty     += qty;
      } else if (daysToExpiry <= thresholds.nearExpiryDays) {
        isNearExpiry = true;
        agg.nearExpiryQty += qty;
      }

      agg.batches.push({
        batchCode   : String(row['Batch Code'] || ''),
        expiryDate,
        daysToExpiry,
        qty,
        batchStatus,
        inventoryType,
      });
    }

    // Good vs Bad — classify purely by Inventory Type field from Unicommerce.
    // GOOD_INVENTORY = saleable. BAD_INVENTORY | QC_REJECTED = bad/non-saleable.
    if (inventoryType === 'GOOD_INVENTORY') {
      agg.goodQty += qty;
    } else {
      agg.badQty += qty;
    }

    agg.damagedQty += qtyDamaged;
  });

  return map;
}

// ---------------------------------------------------------------------------
// COMBINED SALES COMPUTATION (for Mother WH DOI)
// ---------------------------------------------------------------------------

function _computeCombinedSales(fgRows, salesNodeSet) {
  const map = new Map();
  fgRows.forEach(row => {
    const depotCode = String(row['Depot Name'] || '').trim();
    const skuCode   = String(row['SKU Code'] || row['SkuCode'] || '').trim();
    if (!salesNodeSet.has(depotCode) || !skuCode) return;
    if (!map.has(skuCode)) map.set(skuCode, { sales30: 0, sales7: 0 });
    const e = map.get(skuCode);
    e.sales30 += safeNum(row['Last 30 days Sales']);
    e.sales7  += safeNum(row['Last 7 days Sales']);
  });
  return map;
}

// ---------------------------------------------------------------------------
// SKU SUMMARY BUILDER
// ---------------------------------------------------------------------------

function _buildSkuSummary(fgRows, shelfAgg, cogsMap, facilityMap, mappedCodes,
                           motherSet, salesNodeSet, combinedSales,
                           activeSKUs, runDate, today, thresholds) {
  const skuRows        = [];
  const discontinuedRows = [];
  const excludedFacilities = new Set();

  fgRows.forEach(fg => {
    // Match using Depot Name (full name) — this is what tbl_facility_mapping uses as key
    const depotCode = String(fg['Depot Name'] || '').trim();
    const skuCode   = String(fg['SKU Code'] || fg['SkuCode'] || '').trim();
    if (!depotCode || !skuCode) return;

    // Unmapped facility → track and skip
    if (!mappedCodes.has(depotCode)) {
      excludedFacilities.add(depotCode);
      return;
    }

    const facilityInfo = facilityMap.get(depotCode);
    const facilityType = String(facilityInfo['Facility_Type'] || facilityInfo['Facility Type'] || '').trim();
    const facilityName = String(facilityInfo['Display_Name']  || facilityInfo['Facility Name'] || depotCode).trim();

    // Discontinued SKU check
    const isDiscontinued = !activeSKUs.has(skuCode);

    // Core FG fields
    const soh       = safeNum(fg['Stock on Hand']);
    const sit       = safeNum(fg['Stock In Transfer']);
    const damaged   = safeNum(fg['Damaged Stock']);
    const openPO    = safeNum(fg['Open Purchase']);
    const costPrice = safeNum(fg['Cost Price']);

    // Sales: Mother WH uses combined sales node sales
    let sales30, sales7;
    if (_isMotherwh(facilityType)) {
      const c = combinedSales.get(skuCode) || { sales30: 0, sales7: 0 };
      sales30 = c.sales30; sales7 = c.sales7;
    } else {
      sales30 = safeNum(fg['Last 30 days Sales']);
      sales7  = safeNum(fg['Last 7 days Sales']);
    }

    // COGS resolution
    let cogs, cogsSource;
    const cogsRow = cogsMap.get(skuCode);
    if (cogsRow && safeNum(cogsRow['COGS']) > 0) {
      cogs = safeNum(cogsRow['COGS']); cogsSource = COGS_SOURCE.MASTER;
    } else {
      cogs = costPrice > 0 ? costPrice : 10; cogsSource = COGS_SOURCE.FALLBACK;
    }

    // Brand normalisation
    const rawBrand = String(fg['Brand'] || cogsRow?.['Brand'] || '').trim();
    const brand    = _normaliseBrand(rawBrand);

    // Shelf aggregates
    const shelfKey  = `${depotCode}|${skuCode}`;
    const shelf     = shelfAgg.get(shelfKey) || {
      goodQty: 0, badQty: 0,
      nearExpiryQty: 0, criticalExpiryQty: 0, expiredQty: 0, damagedQty: 0,
    };

    // Inventory valuation — ALWAYS use COGS
    // Good/Bad qty comes directly from shelf Inventory Type classification.
    // If shelf data exists: use it. If not (no shelf rows for this SKU+facility):
    //   treat all SOH as Good (best estimate — no shelf data to say otherwise).
    // Final cap: Good + Bad capped at SOH to prevent shelf/FG timing mismatches.
    const inventoryValue = soh * cogs;

    const shelfTotal = shelf.goodQty + shelf.badQty;
    let effectiveGoodQty, effectiveBadQty;
    let scaledNearQty, scaledCritQty, scaledExpQty;

    if (shelfTotal > 0) {
      // Scale shelf good/bad proportionally to match SOH (handles timing mismatches)
      const scale     = soh / shelfTotal;
      effectiveBadQty  = Math.min(Math.round(shelf.badQty * scale), soh);
      effectiveGoodQty = soh - effectiveBadQty;

      // Scale sub-breakdowns within Bad so they sum correctly to effectiveBadQty
      const badScale  = shelf.badQty > 0 ? effectiveBadQty / shelf.badQty : 0;
      scaledExpQty    = Math.round(shelf.expiredQty        * badScale);
      scaledCritQty   = Math.round(shelf.criticalExpiryQty * badScale);
      scaledNearQty   = Math.round(shelf.nearExpiryQty     * badScale);

      // Clamp so scaled sub-totals don't exceed effectiveBadQty due to rounding
      const subTotal  = scaledExpQty + scaledCritQty + scaledNearQty;
      if (subTotal > effectiveBadQty) {
        scaledNearQty = Math.max(0, scaledNearQty - (subTotal - effectiveBadQty));
      }
    } else {
      // No shelf data — treat all as good
      effectiveGoodQty = soh;
      effectiveBadQty  = 0;
      scaledNearQty    = 0;
      scaledCritQty    = 0;
      scaledExpQty     = 0;
    }

    const goodValue           = effectiveGoodQty * cogs;
    const badValue            = effectiveBadQty  * cogs;
    const nearExpiryValue     = scaledNearQty    * cogs;
    const criticalExpiryValue = scaledCritQty    * cogs;
    const expiredValue        = scaledExpQty     * cogs;
    const valueAtRisk         = badValue;

    // DOI (SKU level only, SOH only)
    const drr30 = sales30 > 0 ? sales30 / 30 : 0;
    const drr7  = sales7  > 0 ? sales7  / 7  : 0;
    const doi30 = drr30 > 0 ? soh / drr30 : (soh > 0 ? 9999 : 0);
    const doi7  = drr7  > 0 ? soh / drr7  : (soh > 0 ? 9999 : 0);

    // Health bucket (only for active SKUs)
    const bucket = isDiscontinued ? 'Discontinued'
                 : _assignHealthBucket(soh, doi30, thresholds);

    const outputRow = [
      runDate, skuCode,
      String(fg['Product Name'] || ''),
      brand,
      String(fg['Category'] || ''),
      depotCode, facilityName, facilityType,
      soh, sit, damaged, openPO,
      sales30, sales7,
      cogs, cogsSource,
      inventoryValue, goodValue, badValue,
      effectiveGoodQty, effectiveBadQty,
      scaledNearQty, scaledCritQty, scaledExpQty,
      nearExpiryValue, criticalExpiryValue, expiredValue,
      valueAtRisk,
      drr30, drr7, doi30, doi7,
      bucket, isDiscontinued ? 'Yes' : 'No',
    ];

    if (isDiscontinued) {
      discontinuedRows.push(outputRow);
    } else {
      skuRows.push(outputRow);
    }
  });

  return { skuRows, discontinuedRows, excludedFacilities };
}

// ---------------------------------------------------------------------------
// SKU-LEVEL AGGREGATE — One row per SKU across all facilities.
// Used for management KPIs (OOS count, Critical count, etc.).
// Health bucket is assigned here at the SKU level using combined SOH + sales.
// ---------------------------------------------------------------------------

function _computeSkuAggregates(skuRows, discontinuedRows, combinedSales, thresholds, runDate) {
  // Column indices for reading per-facility rows (SKU_SUMMARY_COLUMNS order)
  const iSku     = SKU_SUMMARY_COLUMNS.indexOf('SKU Code');
  const iName    = SKU_SUMMARY_COLUMNS.indexOf('Product Name');
  const iBrand   = SKU_SUMMARY_COLUMNS.indexOf('Brand');
  const iCat     = SKU_SUMMARY_COLUMNS.indexOf('Category');
  const iSoh     = SKU_SUMMARY_COLUMNS.indexOf('SOH');
  const iSit     = SKU_SUMMARY_COLUMNS.indexOf('SIT');
  const iDmg     = SKU_SUMMARY_COLUMNS.indexOf('Damaged Stock');
  const iPo      = SKU_SUMMARY_COLUMNS.indexOf('Open Purchase');
  const iCogs    = SKU_SUMMARY_COLUMNS.indexOf('COGS');
  const iCogsS   = SKU_SUMMARY_COLUMNS.indexOf('COGS Source');
  const iInvV    = SKU_SUMMARY_COLUMNS.indexOf('Inventory Value');
  const iGoodV   = SKU_SUMMARY_COLUMNS.indexOf('Good Inventory Value');
  const iBadV    = SKU_SUMMARY_COLUMNS.indexOf('Bad Inventory Value');
  const iGoodQ   = SKU_SUMMARY_COLUMNS.indexOf('Good Qty');
  const iBadQ    = SKU_SUMMARY_COLUMNS.indexOf('Bad Qty');
  const iNearQ   = SKU_SUMMARY_COLUMNS.indexOf('Near Expiry Qty');
  const iCritQ   = SKU_SUMMARY_COLUMNS.indexOf('Critical Expiry Qty');
  const iExpQ    = SKU_SUMMARY_COLUMNS.indexOf('Expired Qty');
  const iNearV   = SKU_SUMMARY_COLUMNS.indexOf('Near Expiry Value');
  const iCritV   = SKU_SUMMARY_COLUMNS.indexOf('Critical Expiry Value');
  const iExpV    = SKU_SUMMARY_COLUMNS.indexOf('Expired Value');
  const iRisk    = SKU_SUMMARY_COLUMNS.indexOf('Value At Risk');
  const iFac     = SKU_SUMMARY_COLUMNS.indexOf('Facility Code');
  const iFacType = SKU_SUMMARY_COLUMNS.indexOf('Facility Type');
  const iDisc    = SKU_SUMMARY_COLUMNS.indexOf('Is Discontinued');

  const skuMap = new Map();

  const addRow = (row) => {
    const sku = String(row[iSku] || '').trim();
    if (!sku) return;

    if (!skuMap.has(sku)) {
      skuMap.set(sku, {
        sku,
        name   : row[iName],
        brand  : row[iBrand],
        cat    : row[iCat],
        cogs   : row[iCogs],
        cogsS  : row[iCogsS],
        isDisc : row[iDisc],
        motherWhSoh: 0,           // SOH in Mother WHs only — drives DOI + health bucket
        networkSoh : 0,           // SOH in distribution facilities
        totalSit: 0, totalDmg: 0, totalPo: 0,
        totalInvV: 0, totalGoodV: 0, totalBadV: 0,
        totalGoodQ: 0, totalBadQ: 0,
        totalNearQ: 0, totalCritQ: 0, totalExpQ: 0,
        totalNearV: 0, totalCritV: 0, totalExpV: 0,
        totalRisk: 0,
        activeFacilities: [],
      });
    }

    const a   = skuMap.get(sku);
    const soh = safeNum(row[iSoh]);
    const facType = String(row[iFacType] || '').trim();

    // Separate Mother WH stock from distribution/network stock
    if (_isMotherwh(facType)) {
      a.motherWhSoh += soh;
    } else {
      a.networkSoh  += soh;
    }

    a.totalSit   += safeNum(row[iSit]);
    a.totalDmg   += safeNum(row[iDmg]);
    a.totalPo    += safeNum(row[iPo]);
    a.totalInvV  += safeNum(row[iInvV]);
    a.totalGoodV += safeNum(row[iGoodV]);
    a.totalBadV  += safeNum(row[iBadV]);
    a.totalGoodQ += safeNum(row[iGoodQ]);
    a.totalBadQ  += safeNum(row[iBadQ]);
    a.totalNearQ += safeNum(row[iNearQ]);
    a.totalCritQ += safeNum(row[iCritQ]);
    a.totalExpQ  += safeNum(row[iExpQ]);
    a.totalNearV += safeNum(row[iNearV]);
    a.totalCritV += safeNum(row[iCritV]);
    a.totalExpV  += safeNum(row[iExpV]);
    a.totalRisk  += safeNum(row[iRisk]);
    if (soh > 0) a.activeFacilities.push(String(row[iFac] || ''));
  };

  skuRows.forEach(addRow);
  discontinuedRows.forEach(addRow);

  const aggRows = [];

  skuMap.forEach(a => {
    // DOI uses Mother WH SOH only (how many days of stock left at the warehouse)
    // DRR comes from combined sales across all sales/distribution channels
    const sales = combinedSales.get(a.sku) || { sales30: 0, sales7: 0 };
    const drr30 = sales.sales30 > 0 ? sales.sales30 / 30 : 0;
    const drr7  = sales.sales7  > 0 ? sales.sales7  / 7  : 0;
    const doi30 = drr30 > 0 ? a.motherWhSoh / drr30 : (a.motherWhSoh > 0 ? 9999 : 0);
    const doi7  = drr7  > 0 ? a.motherWhSoh / drr7  : (a.motherWhSoh > 0 ? 9999 : 0);

    const isDisc = a.isDisc === 'Yes';
    // Health bucket based on Mother WH stock — OOS means no stock in any Mother WH
    const bucket = isDisc ? 'Discontinued'
                 : _assignHealthBucket(a.motherWhSoh, doi30, thresholds);

    aggRows.push([
      runDate,
      a.sku, a.name, a.brand, a.cat,
      a.motherWhSoh, a.networkSoh, a.motherWhSoh + a.networkSoh,
      a.totalSit, a.totalDmg, a.totalPo,
      sales.sales30, sales.sales7,
      drr30, drr7, doi30, doi7,
      a.cogs, a.cogsS,
      a.totalInvV, a.totalGoodV, a.totalBadV,
      a.totalGoodQ, a.totalBadQ,
      a.totalNearQ, a.totalCritQ, a.totalExpQ,
      a.totalNearV, a.totalCritV, a.totalExpV,
      a.totalRisk,
      bucket,
      a.isDisc,
      [...new Set(a.activeFacilities)].join(', '),
    ]);
  });

  return aggRows;
}

function _writeSkuAgg(rows) {
  clearSheetData(SHEETS.SKU_AGG);
  if (rows.length > 0) _batchWriteRows(SHEETS.SKU_AGG, rows);
  Logger.log(`SKU Agg: ${rows.length} rows`);
}

// ---------------------------------------------------------------------------
// HEALTH BUCKET
// ---------------------------------------------------------------------------

function _assignHealthBucket(soh, doi30, t) {
  if (soh === 0)                return HEALTH_BUCKET.OOS;
  if (doi30 < t.doiCritical)   return HEALTH_BUCKET.CRITICAL;
  if (doi30 < t.doiRiskMin)    return HEALTH_BUCKET.CRITICAL; // fill gap between doiCritical and doiRiskMin
  if (doi30 <= t.doiRiskMax)   return HEALTH_BUCKET.RISK;
  if (doi30 <= t.doiHealthyMax) return HEALTH_BUCKET.HEALTHY;
  return HEALTH_BUCKET.OVERSTOCK;
}

// ---------------------------------------------------------------------------
// HEALTH BUCKET SUMMARY
// ---------------------------------------------------------------------------

function _computeHealthBuckets(skuAggRows, runDate) {
  // SKU_AGG_COLUMNS indices — one row per SKU, so no Set deduplication needed
  const iSOH    = SKU_AGG_COLUMNS.indexOf('Mother WH SOH'); // health is based on Mother WH stock
  const iValue  = SKU_AGG_COLUMNS.indexOf('Total Inventory Value');
  const iBucket = SKU_AGG_COLUMNS.indexOf('Health Bucket');

  const buckets = {};
  Object.values(HEALTH_BUCKET).forEach(b => {
    buckets[b] = { skuCount: 0, totalQty: 0, totalValue: 0 };
  });

  skuAggRows.forEach(row => {
    const bucket = row[iBucket];
    if (!buckets[bucket]) return;
    buckets[bucket].skuCount++;
    buckets[bucket].totalQty   += safeNum(row[iSOH]);
    buckets[bucket].totalValue += safeNum(row[iValue]);
  });

  return Object.entries(buckets).map(([bucket, d]) => [
    runDate, bucket, d.skuCount, d.totalQty, d.totalValue,
  ]);
}

// ---------------------------------------------------------------------------
// EXPIRY SUMMARY (mapped facilities only)
// ---------------------------------------------------------------------------

function _computeExpirySummary(shelfRows, cogsMap, fgRows, runDate, today, thresholds, mappedCodes, facilityMap) {
  // Build SKU → Product Name lookup (using Depot Name as key)
  const skuNameMap = new Map();
  fgRows.forEach(row => {
    const sku  = String(row['SKU Code'] || row['SkuCode'] || '').trim();
    const name = String(row['Product Name'] || '').trim();
    if (sku && name && !skuNameMap.has(sku)) skuNameMap.set(sku, name);
  });

  const outputRows = [];
  const near = thresholds.nearExpiryDays;
  const crit = thresholds.criticalExpiryDays;

  shelfRows.forEach(row => {
    // Match using Facility (full name) — same as Depot Name in facility mapping
    const facilityCode = String(row['Facility'] || row['Facility Code'] || '').trim();
    if (!mappedCodes.has(facilityCode)) return;

    const skuCode    = String(row['Item Type SKU Code'] || '').trim();
    const expiryDate = safeDate(row['Expiry']);
    if (!skuCode || !expiryDate) return;

    const daysToExpiry = daysBetween(expiryDate, today);
    if (daysToExpiry > near) return;

    const qty = safeNum(row['Quantity']);
    if (qty <= 0) return;

    let expiryBucket;
    if (daysToExpiry < 0)        expiryBucket = EXPIRY_BUCKET.EXPIRED;
    else if (daysToExpiry <= crit) expiryBucket = EXPIRY_BUCKET.CRITICAL;
    else                          expiryBucket = EXPIRY_BUCKET.NEAR;

    const cogsRow = cogsMap.get(skuCode);
    const cogs    = cogsRow && safeNum(cogsRow['COGS']) > 0 ? safeNum(cogsRow['COGS']) : 10;
    const facInfo = facilityMap ? facilityMap.get(facilityCode) : null;
    const facType = facInfo ? String(facInfo['Facility_Type'] || facInfo['Facility Type'] || '') : '';
    const facDisplay = facInfo ? String(facInfo['Display_Name'] || facInfo['Facility Name'] || facilityCode) : facilityCode;

    outputRows.push([
      runDate, skuCode,
      skuNameMap.get(skuCode) || String(row['Item Type Name'] || ''),
      facilityCode, facDisplay, facType,
      String(row['Batch Code']   || ''),
      expiryDate, daysToExpiry, qty, cogs, qty * cogs,
      expiryBucket,
    ]);
  });

  outputRows.sort((a, b) => safeNum(a[6]) - safeNum(b[6]));
  return outputRows;
}

// ---------------------------------------------------------------------------
// BIN UTILIZATION (SL_MH only)
// ---------------------------------------------------------------------------

function _computeBinUtilization(shelfRows, runDate) {
  const binRows = readSheetAsObjects(SHEETS.BIN_MASTER);
  if (binRows.length === 0) {
    Logger.log('WARNING: Bin Master empty. Skipping utilization.');
    return { summary: [], binDetail: [] };
  }

  const occupiedBins = new Set();
  shelfRows.forEach(row => {
    if (String(row['Facility'] || '').trim() !== BIN_UTILIZATION_FACILITY) return;
    const shelf = String(row['Shelf'] || '').trim();
    if (shelf && safeNum(row['Quantity']) > 0) occupiedBins.add(shelf.toUpperCase());
  });

  const rowAgg = new Map(), colAgg = new Map(), levelAgg = new Map();
  const binDetailRows = [];
  let totalBins = 0, occupiedCount = 0;

  binRows.forEach(bin => {
    const binId = String(bin['Bin ID'] || '').trim();
    if (!binId) return;
    totalBins++;
    const isOccupied = occupiedBins.has(binId.toUpperCase());
    if (isOccupied) occupiedCount++;
    _incAgg(rowAgg,   String(bin['Row']       || ''), isOccupied);
    _incAgg(colAgg,   String(bin['Column No'] || ''), isOccupied);
    _incAgg(levelAgg, String(bin['Level']     || ''), isOccupied);
    binDetailRows.push([runDate, binId, bin['Row'], bin['Column No'], bin['Level'], isOccupied]);
  });

  const utilPct = totalBins > 0 ? occupiedCount / totalBins * 100 : 0;
  Logger.log(`Bin Utilization: ${occupiedCount}/${totalBins} = ${utilPct.toFixed(1)}%`);

  return {
    summary   : [[runDate, totalBins, occupiedCount, totalBins - occupiedCount, utilPct]],
    binDetail : binDetailRows,
    heatmap   : { byRow: rowAgg, byCol: colAgg, byLevel: levelAgg },
  };
}

function _incAgg(map, key, isOccupied) {
  if (!key) return;
  if (!map.has(key)) map.set(key, { total: 0, occupied: 0 });
  const d = map.get(key); d.total++;
  if (isOccupied) d.occupied++;
}

// ---------------------------------------------------------------------------
// BAD INVENTORY SUMMARY — Facility-wise BAD_INVENTORY + QC_REJECTED
// Excludes facilities where F_Type = 'DS' (Darkstores).
// ---------------------------------------------------------------------------

function _computeBadInventorySummary(shelfRows, cogsMap, facilityMap, mappedCodes, runDate) {
  const map = new Map();

  shelfRows.forEach(row => {
    const facilityName = String(row['Facility'] || row['Facility Code'] || '').trim();
    if (!mappedCodes.has(facilityName)) return;

    const invType = String(row['Inventory Type'] || '').trim().toUpperCase();
    if (invType !== 'BAD_INVENTORY' && invType !== 'QC_REJECTED') return;

    const facInfo = facilityMap.get(facilityName);
    if (!facInfo) return;

    // Exclude Darkstore facilities
    const fType = String(facInfo['F_Type'] || '').trim();
    if (fType === 'DS') return;

    const skuCode = String(row['Item Type SKU Code'] || '').trim();
    if (!skuCode) return;

    const qty = safeNum(row['Quantity']);
    if (qty <= 0) return;

    const key = `${facilityName}|${skuCode}`;
    if (!map.has(key)) {
      const cogsRow  = cogsMap.get(skuCode);
      const cogs     = cogsRow && safeNum(cogsRow['COGS']) > 0 ? safeNum(cogsRow['COGS']) : 10;
      const brand    = cogsRow ? String(cogsRow['Brand'] || '') : '';
      map.set(key, {
        facilityName,
        facDisplay : String(facInfo['Display_Name'] || facilityName),
        facType    : String(facInfo['Facility_Type'] || ''),
        fType,
        skuCode,
        name  : String(row['Item Type Name'] || ''),
        brand,
        cogs,
        badQty : 0,
        qcQty  : 0,
      });
    }

    const e = map.get(key);
    if (invType === 'BAD_INVENTORY') e.badQty += qty;
    else                             e.qcQty  += qty;
  });

  const rows = [];
  map.forEach(e => {
    const totalBad = e.badQty + e.qcQty;
    if (totalBad <= 0) return;
    rows.push([
      runDate,
      e.skuCode, e.name, e.brand,
      e.facilityName, e.facDisplay, e.facType, e.fType,
      e.badQty, e.qcQty, totalBad,
      e.cogs, totalBad * e.cogs,
    ]);
  });

  rows.sort((a, b) => b[12] - a[12]); // Sort by bad value descending
  return rows;
}

function _writeBadInventory(rows) {
  clearSheetData(SHEETS.BAD_INVENTORY);
  if (rows.length > 0) _batchWriteRows(SHEETS.BAD_INVENTORY, rows);
  Logger.log(`Bad Inventory: ${rows.length} rows`);
}

// ---------------------------------------------------------------------------
// OUTPUT WRITERS
// ---------------------------------------------------------------------------

function _writeSkuSummary(rows) {
  clearSheetData(SHEETS.SKU_SUMMARY);
  if (rows.length > 0) _batchWriteRows(SHEETS.SKU_SUMMARY, rows);
  Logger.log(`SKU Summary: ${rows.length} rows`);
}

function _writeDiscontinued(rows) {
  const ss    = getSpreadsheet();
  let sheet   = ss.getSheetByName(SHEETS.DISCONTINUED);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.DISCONTINUED);
    sheet.getRange(1, 1, 1, SKU_SUMMARY_COLUMNS.length).setValues([SKU_SUMMARY_COLUMNS]);
    _formatHeaderRow(sheet);
  }
  clearSheetData(SHEETS.DISCONTINUED);
  if (rows.length > 0) _batchWriteRows(SHEETS.DISCONTINUED, rows);
  Logger.log(`Discontinued: ${rows.length} rows`);
}

function _writeHealthSummary(rows) {
  clearSheetData(SHEETS.INVENTORY_HEALTH);
  if (rows.length > 0) appendRows(SHEETS.INVENTORY_HEALTH, rows);
  Logger.log(`Health buckets: ${rows.length}`);
}

function _writeExpirySummary(rows) {
  clearSheetData(SHEETS.EXPIRY_SUMMARY);
  if (rows.length > 0) _batchWriteRows(SHEETS.EXPIRY_SUMMARY, rows);
  Logger.log(`Expiry: ${rows.length} rows`);
}

function _writeUtilization(data) {
  clearSheetData(SHEETS.WAREHOUSE_UTILIZATION);
  if (data.summary.length > 0) appendRows(SHEETS.WAREHOUSE_UTILIZATION, data.summary);

  if (data.binDetail.length > 0) {
    const sheet      = getSheet(SHEETS.WAREHOUSE_UTILIZATION);
    const detailStart = sheet.getLastRow() + 2;
    sheet.getRange(detailStart, 1, 1, BIN_DETAIL_COLUMNS.length).setValues([BIN_DETAIL_COLUMNS]);
    _batchWriteRows(SHEETS.WAREHOUSE_UTILIZATION, data.binDetail);
  }
  Logger.log(`Utilization: summary=${data.summary.length} bins=${data.binDetail.length}`);
}

function _writeDashboardSummary(skuAggRows, discontinuedRows, healthRows, utilData,
                                  excludedFacilities, activeSKUs, runDate) {
  // Aggregate from SKU-level rows (one row per SKU — correct distinct counts)
  const iMotherSoh = SKU_AGG_COLUMNS.indexOf('Mother WH SOH'); // eslint-disable-line no-unused-vars
  const iVal     = SKU_AGG_COLUMNS.indexOf('Total Inventory Value');
  const iGoodVal = SKU_AGG_COLUMNS.indexOf('Total Good Value');
  const iBadVal  = SKU_AGG_COLUMNS.indexOf('Total Bad Value');
  const iNearVal = SKU_AGG_COLUMNS.indexOf('Near Expiry Value');
  const iCritVal = SKU_AGG_COLUMNS.indexOf('Critical Expiry Value');
  const iExpVal  = SKU_AGG_COLUMNS.indexOf('Expired Value');
  const iRisk    = SKU_AGG_COLUMNS.indexOf('Value At Risk');
  const iBucket  = SKU_AGG_COLUMNS.indexOf('Health Bucket');
  const iCogsSrc = SKU_AGG_COLUMNS.indexOf('COGS Source');
  const iSku     = SKU_AGG_COLUMNS.indexOf('SKU Code');
  const iDisc    = SKU_AGG_COLUMNS.indexOf('Is Discontinued');

  let totalVal = 0, goodVal = 0, badVal = 0;
  let nearVal = 0, critVal = 0, expVal = 0, riskVal = 0;
  let cogsMissing = 0, activeSkuCount = 0;
  const bucketCounts = {};
  Object.values(HEALTH_BUCKET).forEach(b => { bucketCounts[b] = 0; });

  // Only active (non-discontinued) SKUs contribute to health buckets
  skuAggRows.forEach(row => {
    if (row[iDisc] === 'Yes') return;
    activeSkuCount++;
    totalVal += safeNum(row[iVal]);
    goodVal  += safeNum(row[iGoodVal]);
    badVal   += safeNum(row[iBadVal]);
    nearVal  += safeNum(row[iNearVal]);
    critVal  += safeNum(row[iCritVal]);
    expVal   += safeNum(row[iExpVal]);
    riskVal  += safeNum(row[iRisk]);
    if (row[iCogsSrc] === COGS_SOURCE.FALLBACK) cogsMissing++;
    const b = row[iBucket];
    if (bucketCounts[b] !== undefined) bucketCounts[b]++;
  });

  // Validation: Good + Bad must equal Total (floating point tolerance ₹1)
  const diff = Math.abs(totalVal - goodVal - badVal);
  if (diff > 1) {
    Logger.log(`WARNING: Good(${goodVal}) + Bad(${badVal}) ≠ Total(${totalVal}). Diff: ${diff}`);
  }

  const utilSummary = utilData.summary[0] || [];
  // Discontinued stats from the agg rows themselves
  let discValue = 0, discSkuCount = 0;
  skuAggRows.forEach(row => {
    if (row[iDisc] === 'Yes') { discValue += safeNum(row[iVal]); discSkuCount++; }
  });
  const discSkus = discSkuCount;

  const dashRow = [[
    runDate, new Date(),
    totalVal, goodVal, badVal,
    nearVal, critVal, expVal, riskVal,
    safeNum(utilSummary[4]),     // utilization pct
    activeSkuCount,              // DISTINCT active SKU count (from SKU agg, excludes discontinued)
    bucketCounts[HEALTH_BUCKET.OOS]       || 0,
    bucketCounts[HEALTH_BUCKET.CRITICAL]  || 0,
    bucketCounts[HEALTH_BUCKET.RISK]      || 0,
    bucketCounts[HEALTH_BUCKET.HEALTHY]   || 0,
    bucketCounts[HEALTH_BUCKET.OVERSTOCK] || 0,
    safeNum(utilSummary[1]),     // total bins
    safeNum(utilSummary[2]),     // occupied bins
    safeNum(utilSummary[3]),     // empty bins
    cogsMissing,
    discSkus,                    // discontinued SKU count (distinct)
    discValue,                   // discontinued inventory value
    [...excludedFacilities].join(', '),
    'SUCCESS', '',
  ]];

  appendRows(SHEETS.DASHBOARD_SUMMARY, dashRow);
  Logger.log('Dashboard summary written.');
  Logger.log(`Validation — Total: ${totalVal.toFixed(0)} | Good: ${goodVal.toFixed(0)} | Bad: ${badVal.toFixed(0)} | Diff: ${diff.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// MANUAL ENTRY POINTS
// ---------------------------------------------------------------------------

function manualRunEngine() {
  runInventoryEngine();
  Logger.log('✅ Inventory engine complete. Check tbl_sku_summary and tbl_dashboard_summary.');
}

function diagnoseSummaryTables() {
  const tables = [
    SHEETS.FG_INVENTORY_RAW, SHEETS.SHELF_INVENTORY_RAW,
    SHEETS.SKU_SUMMARY, SHEETS.SKU_AGG, SHEETS.DISCONTINUED,
    SHEETS.INVENTORY_HEALTH, SHEETS.EXPIRY_SUMMARY,
    SHEETS.WAREHOUSE_UTILIZATION, SHEETS.DASHBOARD_SUMMARY,
  ];
  const lines = tables.map(name => {
    try {
      const sheet = getSheet(name);
      return `${name}: ${Math.max(0, sheet.getLastRow() - 1)} rows`;
    } catch (e) { return `${name}: ERROR`; }
  });
  Logger.log('Table Row Counts: ' + lines.join(' | '));
}