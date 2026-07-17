// =============================================================================
// EmailReport.gs — Inventory Control Tower
// Builds and sends the daily management summary email.
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

function sendDailyEmailReport() {
  Logger.log('--- EmailReport: Starting ---');

  const recipients = getSetting('email_recipients');
  if (!recipients || recipients.trim() === '') {
    Logger.log('WARNING: No email recipients configured. Skipping email.');
    return;
  }

  const payload = _buildEmailPayload();
  if (!payload) {
    Logger.log('ERROR: Could not build email payload — no dashboard data.');
    _logEmail(recipients, 'Inventory Control Tower — Daily Report', 'ERROR', 'No dashboard data found.');
    return;
  }

  const subject = `Inventory Control Tower — ${payload.runDateStr} | ${_kpiHeadline(payload.kpis)}`;
  const htmlBody = _buildEmailHtml(payload);

  try {
    GmailApp.sendEmail(recipients, subject, '', { htmlBody, name: 'Inventory Control Tower' });
    Logger.log(`Email sent to: ${recipients}`);
    _logEmail(recipients, subject, 'SENT', '');
  } catch (e) {
    Logger.log('Email send error: ' + e.message);
    _logEmail(recipients, subject, 'ERROR', e.message);
    throw e;
  }

  Logger.log('--- EmailReport: Done ---');
}

// ---------------------------------------------------------------------------
// DATA PAYLOAD BUILDER
// ---------------------------------------------------------------------------

function _buildEmailPayload() {
  const summaryRows = readSheetAsObjects(SHEETS.DASHBOARD_SUMMARY);
  if (summaryRows.length === 0) return null;
  const latest = summaryRows[summaryRows.length - 1];

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
    oosSkuCount            : safeNum(latest['OOS SKU Count']),
    criticalSkuCount       : safeNum(latest['Critical SKU Count']),
    riskSkuCount           : safeNum(latest['Risk SKU Count']),
    healthySkuCount        : safeNum(latest['Healthy SKU Count']),
    overstockSkuCount      : safeNum(latest['Overstock SKU Count']),
    cogsMissingSkuCount    : safeNum(latest['COGS Missing SKU Count']),
    occupiedBins           : safeNum(latest['Occupied Bins']),
    totalBins              : safeNum(latest['Total Bins']),
  };

  const runDate    = latest['Run Date'] ? new Date(latest['Run Date']) : new Date();
  const runDateStr = Utilities.formatDate(runDate, getSetting('timezone') || 'Asia/Kolkata', 'dd MMM yyyy');

  const skuRows = readSheetAsObjects(SHEETS.SKU_SUMMARY);

  // Aggregate totals by facility type
  function _facType(r) {
    return String(r['Facility Type'] || r['Facility_Type'] || '');
  }
  function _aggByType(typeValue) {
    const rows = skuRows.filter(r => _facType(r) === typeValue);
    const agg  = { inventoryValue: 0, goodValue: 0, badValue: 0, valueAtRisk: 0,
                   soh: 0, oosSkus: 0, criticalSkus: 0, healthySkus: 0, overstockSkus: 0 };
    rows.forEach(r => {
      agg.inventoryValue += safeNum(r['Inventory Value']      || r['Inv Value']  || 0);
      agg.goodValue      += safeNum(r['Good Inventory Value'] || r['Good Value'] || 0);
      agg.badValue       += safeNum(r['Bad Inventory Value']  || r['Bad Value']  || 0);
      agg.valueAtRisk    += safeNum(r['Value At Risk']        || r['Risk Value'] || 0);
      agg.soh            += safeNum(r['SOH'] || 0);
      const b = r['Health Bucket'];
      if (b === HEALTH_BUCKET.OOS)       agg.oosSkus++;
      if (b === HEALTH_BUCKET.CRITICAL)  agg.criticalSkus++;
      if (b === HEALTH_BUCKET.HEALTHY)   agg.healthySkus++;
      if (b === HEALTH_BUCKET.OVERSTOCK) agg.overstockSkus++;
    });
    return agg;
  }

  const facilityGroups = {
    motherHub   : _aggByType('MW-Self'),
    darkstore   : _aggByType('DS'),
    warehouse3pl: _aggByType('MW-3PL'),
  };

  // Per-facility breakdown for Mother Hub sub-facilities
  const motherFacMap = new Map();
  skuRows.filter(r => _isMotherwh(_facType(r))).forEach(r => {
    const code = String(r['Facility Code'] || r['Depot Code'] || r['Depot Name'] || '');
    const name = String(r['Facility Name'] || r['Display_Name'] || code);
    if (!code) return;
    if (!motherFacMap.has(code)) {
      motherFacMap.set(code, {
        code, name,
        inventoryValue: 0, goodValue: 0, badValue: 0, valueAtRisk: 0,
        soh: 0, oosSkus: 0, criticalSkus: 0, healthySkus: 0, overstockSkus: 0,
      });
    }
    const a = motherFacMap.get(code);
    a.inventoryValue += safeNum(r['Inventory Value']);
    a.goodValue      += safeNum(r['Good Inventory Value']);
    a.badValue       += safeNum(r['Bad Inventory Value']);
    a.valueAtRisk    += safeNum(r['Value At Risk']);
    a.soh            += safeNum(r['SOH']);
    const b = r['Health Bucket'];
    if (b === HEALTH_BUCKET.OOS)       a.oosSkus++;
    if (b === HEALTH_BUCKET.CRITICAL)  a.criticalSkus++;
    if (b === HEALTH_BUCKET.HEALTHY)   a.healthySkus++;
    if (b === HEALTH_BUCKET.OVERSTOCK) a.overstockSkus++;
  });
  const motherSubFacilities = Array.from(motherFacMap.values())
    .sort((a, b) => b.inventoryValue - a.inventoryValue);

  const expiryRows      = readSheetAsObjects(SHEETS.EXPIRY_SUMMARY);
  const top20NearExpiry = _getTopExpiry(expiryRows, 20);

  const dashboardUrl = getSetting('dashboard_url') || '#';

  return { kpis, runDateStr, dashboardUrl, facilityGroups, motherSubFacilities, top20NearExpiry };
}

function _getTopExpiry(expiryRows, n) {
  return expiryRows
    .filter(r => safeNum(r['Qty']) > 0)
    .sort((a, b) => safeNum(a['Days To Expiry']) - safeNum(b['Days To Expiry']))
    .slice(0, n)
    .map(r => ({
      skuCode     : r['SKU Code'],
      name        : r['Product Name'],
      facility    : r['Facility Code'],
      batchCode   : r['Batch Code'],
      expiryDate  : r['Expiry Date'] ? Utilities.formatDate(new Date(r['Expiry Date']), getSetting('timezone') || 'Asia/Kolkata', 'dd MMM yyyy') : '',
      daysToExpiry: safeNum(r['Days To Expiry']),
      qty         : safeNum(r['Qty']),
      value       : safeNum(r['Inventory Value']),
      bucket      : r['Expiry Bucket'],
    }));
}

function _kpiHeadline(kpis) {
  return `OOS: ${kpis.oosSkuCount} | Critical: ${kpis.criticalSkuCount} | At Risk: ${_inr(kpis.valueAtRisk)}`;
}

function _emailDoi(doi) {
  return doi >= 9999 ? '∞' : doi.toFixed(1);
}

// ---------------------------------------------------------------------------
// HTML EMAIL BUILDER
// ---------------------------------------------------------------------------

function _buildEmailHtml(p) {
  const { kpis, runDateStr, dashboardUrl, facilityGroups, motherSubFacilities, top20NearExpiry } = p;
  const mh = (facilityGroups && facilityGroups.motherHub)    || {};
  const ds = (facilityGroups && facilityGroups.darkstore)    || {};
  const pl = (facilityGroups && facilityGroups.warehouse3pl) || {};

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Segoe UI',Arial,sans-serif; background:#e8eaf0; color:#111827; }

  /* ── KPI Cards ── */
  .kpi-card { background:#fff; border-radius:10px; padding:16px 18px;
              border-top:4px solid #e5e7eb; box-shadow:0 2px 8px rgba(0,0,0,0.08); }
  .kpi-card.blue   { border-top-color:#2563eb; }
  .kpi-card.green  { border-top-color:#059669; }
  .kpi-card.red    { border-top-color:#dc2626; }
  .kpi-card.orange { border-top-color:#d97706; }
  .kpi-card.purple { border-top-color:#7c3aed; }
  .kpi-card.grey   { border-top-color:#6b7280; }
  .kpi-label { font-size:10px; color:#6b7280; text-transform:uppercase; letter-spacing:0.8px; font-weight:700; }
  .kpi-value { font-size:22px; font-weight:800; color:#111827; margin-top:5px; }
  .kpi-sub   { font-size:11px; color:#9ca3af; margin-top:3px; }

  /* ── Section Blocks ── */
  .section { background:#fff; border-radius:10px; margin-bottom:20px;
             box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden; }
  .section-header { padding:14px 20px; font-size:13px; font-weight:800;
                    letter-spacing:0.5px; text-transform:uppercase; color:#fff; }
  .section-header.mh     { background:#1e40af; }
  .section-header.expiry { background:#7c3aed; }
  .section-header .sub   { font-size:10px; font-weight:500; opacity:0.85;
                            display:block; margin-top:2px; text-transform:none; letter-spacing:0; }

  /* ── Facility Group Panel ── */
  .fac-panel { background:#fff; border-radius:10px; margin-bottom:20px;
               box-shadow:0 2px 8px rgba(0,0,0,0.08); overflow:hidden; }
  .fac-panel-header { background:#1e293b; color:#fff; padding:12px 20px;
                      font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; }

  /* ── Tables ── */
  table.data { width:100%; border-collapse:collapse; font-size:12px; }
  table.data th { background:#1e293b; color:#e2e8f0; padding:10px 12px; text-align:left;
                  font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:0.4px; }
  table.data th.num { text-align:right; }
  table.data td { padding:9px 12px; border-bottom:1px solid #f3f4f6; color:#1f2937; vertical-align:middle; }
  table.data td.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.data td.val { text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
  table.data tr:nth-child(even) td { background:#f9fafb; }
  table.data tr:last-child td { border-bottom:none; }

  /* ── Alerts ── */
  .alert { border-radius:8px; padding:14px 18px; margin-bottom:16px; font-size:13px; }
  .alert.warning { background:#fef3c7; border-left:4px solid #f59e0b; color:#78350f; }
  .alert.danger  { background:#fee2e2; border-left:4px solid #ef4444; color:#7f1d1d; }

  /* ── Badges ── */
  .badge { display:inline-block; padding:3px 9px; border-radius:20px; font-size:10px; font-weight:700; }
  .badge-mh     { background:#dbeafe; color:#1d4ed8; }
  .badge-red    { background:#fee2e2; color:#b91c1c; }
  .badge-orange { background:#ffedd5; color:#c2410c; }
  .badge-purple { background:#ede9fe; color:#6d28d9; }
  .badge-green  { background:#d1fae5; color:#065f46; }
  .oos-num  { color:#dc2626; font-weight:800; }
  .crit-num { color:#d97706; font-weight:800; }
  .risk-num { color:#dc2626; font-weight:700; }
  .mono     { font-family:'Courier New',monospace; font-size:11px; }

  /* ── CTA ── */
  .cta-wrap { text-align:center; margin:24px 0 8px; }
  .cta-btn  { display:inline-block; background:linear-gradient(135deg,#2563eb,#1d4ed8);
              color:#fff; text-decoration:none; padding:14px 44px; border-radius:8px;
              font-weight:800; font-size:14px; }
  .empty-note { text-align:center; padding:20px; color:#9ca3af; font-size:12px; font-style:italic; }
</style>
</head>
<body>
<div style="max-width:900px;margin:0 auto;background:#e8eaf0;padding:24px 16px;font-family:'Segoe UI',Arial,sans-serif;color:#111827;">

  <!-- HEADER -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#1e40af 100%);border-radius:12px;padding:32px;margin-bottom:20px;text-align:center;">
    <h1 style="color:#fff;font-size:24px;font-weight:800;margin:0;">Inventory Control Tower</h1>
    <div style="color:#bfdbfe;font-size:15px;margin-top:8px;font-weight:600;">${runDateStr} &mdash; Daily Management Summary</div>
    <p style="color:#93c5fd;font-size:12px;margin-top:4px;">Auto-generated &middot; Do not reply</p>
  </div>

  <!-- ALERTS -->
  ${kpis.cogsMissingSkuCount > 0 ? `
  <div class="alert warning">
    <strong>WARNING:</strong> ${kpis.cogsMissingSkuCount} SKU(s) missing from COGS Master &mdash; valued using Cost Price fallback. Update <strong>tbl_cogs_master</strong>.
  </div>` : ''}
  ${kpis.valueAtRisk > 0 ? `
  <div class="alert danger">
    <strong>ACTION REQUIRED:</strong> <strong>${_inr(kpis.valueAtRisk)}</strong> of inventory is at risk (bad stock + near expiry + expired).
  </div>` : ''}

  <!-- KPI ROW 1 -->
  <table style="width:100%;border-collapse:separate;border-spacing:10px;margin-bottom:4px;"><tr>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card blue">
      <div class="kpi-label">Total Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.totalInventoryValue)}</div>
      <div class="kpi-sub">All facilities</div>
    </div></td>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card green">
      <div class="kpi-label">Good Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.goodInventoryValue)}</div>
      <div class="kpi-sub">${_pct(kpis.goodInventoryValue, kpis.totalInventoryValue)} of total</div>
    </div></td>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card red">
      <div class="kpi-label">Bad Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.badInventoryValue)}</div>
      <div class="kpi-sub">${_pct(kpis.badInventoryValue, kpis.totalInventoryValue)} of total</div>
    </div></td>
  </tr></table>

  <!-- KPI ROW 2 -->
  <table style="width:100%;border-collapse:separate;border-spacing:10px;margin-bottom:4px;"><tr>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card red">
      <div class="kpi-label">Value At Risk</div>
      <div class="kpi-value">${_inr(kpis.valueAtRisk)}</div>
      <div class="kpi-sub">Bad + Near Expiry + Expired</div>
    </div></td>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card orange">
      <div class="kpi-label">Near Expiry Value</div>
      <div class="kpi-value">${_inr(kpis.nearExpiryValue)}</div>
      <div class="kpi-sub">Expiring within 60 days</div>
    </div></td>
    <td style="width:33%;vertical-align:top;"><div class="kpi-card orange">
      <div class="kpi-label">Expired Value</div>
      <div class="kpi-value">${_inr(kpis.expiredValue)}</div>
      <div class="kpi-sub">Requires immediate action</div>
    </div></td>
  </tr></table>

  <!-- KPI ROW 3 -->
  <table style="width:100%;border-collapse:separate;border-spacing:10px;margin-bottom:20px;"><tr>
    <td style="width:25%;vertical-align:top;"><div class="kpi-card red">
      <div class="kpi-label">OOS SKUs</div>
      <div class="kpi-value">${kpis.oosSkuCount}</div>
      <div class="kpi-sub">Zero stock on hand</div>
    </div></td>
    <td style="width:25%;vertical-align:top;"><div class="kpi-card orange">
      <div class="kpi-label">Critical SKUs</div>
      <div class="kpi-value">${kpis.criticalSkuCount}</div>
      <div class="kpi-sub">DOI &lt; 7 days</div>
    </div></td>
    <td style="width:25%;vertical-align:top;"><div class="kpi-card green">
      <div class="kpi-label">Healthy SKUs</div>
      <div class="kpi-value">${kpis.healthySkuCount}</div>
      <div class="kpi-sub">DOI 31&ndash;90 days</div>
    </div></td>
    <td style="width:25%;vertical-align:top;"><div class="kpi-card grey">
      <div class="kpi-label">Overstock SKUs</div>
      <div class="kpi-value">${kpis.overstockSkuCount}</div>
      <div class="kpi-sub">DOI &gt; 90 days</div>
    </div></td>
  </tr></table>

  <!-- FACILITY GROUP SUMMARY -->
  <div class="fac-panel">
    <div class="fac-panel-header">Facility Group Summary</div>
    <table class="data">
      <thead><tr>
        <th>Facility Type</th>
        <th class="num">Inv. Value</th>
        <th class="num">Good Value</th>
        <th class="num">Bad Value</th>
        <th class="num">At Risk</th>
        <th class="num">SOH</th>
        <th class="num">OOS</th>
        <th class="num">Critical</th>
      </tr></thead>
      <tbody>
        <tr>
          <td><span class="badge badge-mh">Mother Hub</span></td>
          <td class="val">${_inr(mh.inventoryValue||0)}</td>
          <td class="num">${_inr(mh.goodValue||0)}</td>
          <td class="num">${_inr(mh.badValue||0)}</td>
          <td class="num risk-num">${_inr(mh.valueAtRisk||0)}</td>
          <td class="num">${_num(mh.soh||0)}</td>
          <td class="num oos-num">${mh.oosSkus||0}</td>
          <td class="num crit-num">${mh.criticalSkus||0}</td>
        </tr>
        <tr>
          <td><span class="badge badge-green">Darkstore (DS)</span></td>
          <td class="val">${_inr(ds.inventoryValue||0)}</td>
          <td class="num">${_inr(ds.goodValue||0)}</td>
          <td class="num">${_inr(ds.badValue||0)}</td>
          <td class="num risk-num">${_inr(ds.valueAtRisk||0)}</td>
          <td class="num">${_num(ds.soh||0)}</td>
          <td class="num oos-num">${ds.oosSkus||0}</td>
          <td class="num crit-num">${ds.criticalSkus||0}</td>
        </tr>
        <tr>
          <td><span class="badge badge-purple">3PL Warehouse</span></td>
          <td class="val">${_inr(pl.inventoryValue||0)}</td>
          <td class="num">${_inr(pl.goodValue||0)}</td>
          <td class="num">${_inr(pl.badValue||0)}</td>
          <td class="num risk-num">${_inr(pl.valueAtRisk||0)}</td>
          <td class="num">${_num(pl.soh||0)}</td>
          <td class="num oos-num">${pl.oosSkus||0}</td>
          <td class="num crit-num">${pl.criticalSkus||0}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- MOTHER HUB SUB-FACILITY BREAKDOWN -->
  <div class="section">
    <div class="section-header mh">
      Mother Hub &mdash; Sub-Facility Breakdown
      <span class="sub">SL Ambient &middot; SL Mother Hub &middot; SL Rx and others</span>
    </div>
    ${_motherSubTable(motherSubFacilities)}
  </div>

  <!-- TOP 20 NEAR EXPIRY -->
  <div class="section">
    <div class="section-header expiry">
      Top 20 Near Expiry Batches
      <span class="sub">All facilities</span>
    </div>
    ${_expiryTable(top20NearExpiry)}
  </div>

  <!-- CTA -->
  <div class="cta-wrap">
    <a href="${dashboardUrl}" class="cta-btn">Open Full Dashboard</a>
  </div>

  <!-- FOOTER -->
  <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:20px;padding:16px;">
    Inventory Control Tower &middot; Auto-generated on ${runDateStr}<br>
    This email is system-generated. For queries contact your Supply Chain team.
  </div>

</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// TABLE BUILDERS
// ---------------------------------------------------------------------------

function _motherSubTable(facilities) {
  if (!facilities || facilities.length === 0) {
    return '<div class="empty-note">No Mother Hub sub-facility data available.</div>';
  }
  const rows = facilities.map(f => `
    <tr>
      <td><strong>${_esc(f.name)}</strong><br><span class="mono">${_esc(f.code)}</span></td>
      <td class="val">${_inr(f.inventoryValue)}</td>
      <td class="num">${_inr(f.goodValue)}</td>
      <td class="num">${_inr(f.badValue)}</td>
      <td class="num risk-num">${_inr(f.valueAtRisk)}</td>
      <td class="num">${_num(f.soh)}</td>
      <td class="num oos-num">${f.oosSkus}</td>
      <td class="num crit-num">${f.criticalSkus}</td>
      <td class="num">${f.healthySkus}</td>
      <td class="num">${f.overstockSkus}</td>
    </tr>`).join('');
  return `<table class="data">
    <thead><tr>
      <th>Facility</th>
      <th class="num">Inv. Value</th>
      <th class="num">Good Value</th>
      <th class="num">Bad Value</th>
      <th class="num">At Risk</th>
      <th class="num">SOH</th>
      <th class="num">OOS</th>
      <th class="num">Critical</th>
      <th class="num">Healthy</th>
      <th class="num">Overstock</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function _expiryTable(items) {
  if (!items || items.length === 0) {
    return '<div class="empty-note">No near-expiry batches today.</div>';
  }
  const rows = items.map((r, i) => {
    const badgeClass = r.bucket === 'Expired'          ? 'badge-red'
                     : r.bucket === 'Critical Expiry'  ? 'badge-orange'
                     : 'badge-purple';
    const daysDisplay = r.daysToExpiry < 0
      ? `<span style="color:#dc2626;font-weight:700;">Expired ${Math.abs(r.daysToExpiry)}d ago</span>`
      : `<span style="color:${r.daysToExpiry <= 30 ? '#d97706' : '#7c3aed'};font-weight:600;">${r.daysToExpiry}d</span>`;
    return `<tr>
      <td style="color:#94a3b8;font-size:11px;">${i + 1}</td>
      <td class="mono">${_esc(r.skuCode)}</td>
      <td>${_esc(r.name)}</td>
      <td><span class="badge ${badgeClass}">${_esc(r.facility)}</span></td>
      <td class="mono" style="font-size:11px;">${_esc(r.batchCode)}</td>
      <td>${_esc(r.expiryDate)}</td>
      <td>${daysDisplay}</td>
      <td class="num">${_num(r.qty)}</td>
      <td class="val">${_inr(r.value)}</td>
    </tr>`;
  }).join('');
  return `<table class="data">
    <thead><tr>
      <th>#</th><th>SKU Code</th><th>Product Name</th><th>Facility</th>
      <th>Batch</th><th>Expiry Date</th><th>Days Left</th>
      <th class="num">Qty</th><th class="num">Value</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// EMAIL LOG
// ---------------------------------------------------------------------------

function _logEmail(recipients, subject, status, notes) {
  try {
    appendRows(SHEETS.EMAIL_SUMMARY, [[new Date(), recipients, subject, status, notes]]);
  } catch (e) {
    Logger.log('Could not log email: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// FORMAT HELPERS
// ---------------------------------------------------------------------------

function _inr(val) {
  const n = parseFloat(val) || 0;
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function _pct(part, total) {
  if (!total) return '0%';
  return (part / total * 100).toFixed(1) + '%';
}

function _num(val) {
  return (parseFloat(val) || 0).toLocaleString('en-IN');
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
