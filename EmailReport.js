// =============================================================================
// EmailReport.gs — Inventory Control Tower
// Builds and sends the daily management summary email.
//
// Called by: runDailyProcessing() in Code.gs
// Public entry: sendDailyEmailReport()
//
// Email includes:
//   - KPI summary cards
//   - Top 20 OOS / Critical / Near Expiry / Overstock SKUs
//   - Warehouse utilization
//   - Dashboard link
//   - COGS data quality flag
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * Builds and sends the daily management email.
 * Recipients are read from tbl_settings → email_recipients.
 * Logs send result to tbl_email_summary.
 */
function sendDailyEmailReport() {
  Logger.log('--- EmailReport: Starting ---');

  const recipients = getSetting('email_recipients');
  if (!recipients || recipients.trim() === '') {
    Logger.log('WARNING: No email recipients configured. Skipping email.');
    return;
  }

  // Gather all data needed for the email
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
  // Latest dashboard KPIs
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

  // SKU summary for top tables
  const skuRows = readSheetAsObjects(SHEETS.SKU_SUMMARY);

  // Filter to Mother WH facilities only (SL Ambient + SL Mother Hub = MW-Self)
  const motherWhRows = skuRows.filter(r => _isMotherwh(r['Facility Type']));

  const top20OOS = _getTopSkus(motherWhRows, HEALTH_BUCKET.OOS, 20);
  const top20Critical = _getTopSkus(motherWhRows, HEALTH_BUCKET.CRITICAL, 20);
  const top20Overstock = _getTopSkus(motherWhRows, HEALTH_BUCKET.OVERSTOCK, 20);

  // Near expiry from expiry summary — all facilities (Mother WH + others, per user requirement)
  const expiryRows = readSheetAsObjects(SHEETS.EXPIRY_SUMMARY);
  const top20NearExpiry = _getTopExpiry(expiryRows, 20);

  const dashboardUrl = getSetting('dashboard_url') || '#';

  return {
    kpis, runDateStr, dashboardUrl,
    top20OOS, top20Critical, top20Overstock, top20NearExpiry,
  };
}

/**
 * Returns top N SKUs for a given health bucket, sorted by inventory value desc.
 */
function _getTopSkus(skuRows, bucket, n) {
  return skuRows
    .filter(r => r['Health Bucket'] === bucket)
    .sort((a, b) => safeNum(b['Inventory Value']) - safeNum(a['Inventory Value']))
    .slice(0, n)
    .map(r => ({
      skuCode  : r['SKU Code'],
      name     : r['Product Name'],
      facility : r['Facility Code'],
      soh      : safeNum(r['SOH']),
      doi30    : _emailDoi(safeNum(r['DOI30'])),
      value    : safeNum(r['Inventory Value']),
      sales30  : safeNum(r['Last 30 Days Sales']),
    }));
}

/**
 * Returns top N near-expiry batches sorted by days-to-expiry ascending.
 */
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
  const { kpis, runDateStr, dashboardUrl, top20OOS, top20Critical, top20Overstock, top20NearExpiry } = p;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #1a1a2e; }
  .wrapper { max-width: 900px; margin: 0 auto; background: #f0f2f5; padding: 24px 16px; }

  /* Header */
  .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%);
            border-radius: 12px; padding: 32px; margin-bottom: 20px; text-align: center; }
  .header h1 { color: #fff; font-size: 22px; font-weight: 700; letter-spacing: 0.5px; }
  .header p  { color: #94a3b8; font-size: 13px; margin-top: 6px; }
  .header .date { color: #e2e8f0; font-size: 15px; margin-top: 4px; font-weight: 600; }

  /* KPI Grid */
  .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  .kpi-card { background: #fff; border-radius: 10px; padding: 18px 16px;
              border-left: 4px solid #e2e8f0; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .kpi-card.blue   { border-left-color: #3b82f6; }
  .kpi-card.green  { border-left-color: #10b981; }
  .kpi-card.red    { border-left-color: #ef4444; }
  .kpi-card.orange { border-left-color: #f59e0b; }
  .kpi-card.purple { border-left-color: #8b5cf6; }
  .kpi-card.grey   { border-left-color: #6b7280; }
  .kpi-label { font-size: 11px; color: #6b7280; text-transform: uppercase;
               letter-spacing: 0.6px; font-weight: 600; }
  .kpi-value { font-size: 22px; font-weight: 700; color: #1a1a2e; margin-top: 4px; }
  .kpi-sub   { font-size: 11px; color: #94a3b8; margin-top: 2px; }

  /* Section */
  .section { background: #fff; border-radius: 10px; margin-bottom: 20px;
             box-shadow: 0 1px 4px rgba(0,0,0,0.06); overflow: hidden; }
  .section-header { padding: 14px 20px; font-size: 13px; font-weight: 700;
                    letter-spacing: 0.4px; text-transform: uppercase; }
  .section-header.oos      { background: #fef2f2; color: #dc2626; border-bottom: 1px solid #fee2e2; }
  .section-header.critical { background: #fff7ed; color: #d97706; border-bottom: 1px solid #fed7aa; }
  .section-header.expiry   { background: #faf5ff; color: #7c3aed; border-bottom: 1px solid #e9d5ff; }
  .section-header.overstock{ background: #f0fdf4; color: #16a34a; border-bottom: 1px solid #bbf7d0; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f8fafc; padding: 10px 12px; text-align: left;
       font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0;
       font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
  td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; color: #334155; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f8fafc; }
  .mono { font-family: 'Courier New', monospace; font-size: 11px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px;
           font-size: 10px; font-weight: 600; letter-spacing: 0.3px; }
  .badge-red    { background: #fef2f2; color: #dc2626; }
  .badge-orange { background: #fff7ed; color: #d97706; }
  .badge-purple { background: #faf5ff; color: #7c3aed; }
  .badge-green  { background: #f0fdf4; color: #16a34a; }

  /* Alert box */
  .alert { border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;
           font-size: 12px; display: flex; align-items: flex-start; gap: 10px; }
  .alert.warning { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
  .alert.danger  { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }

  /* CTA Button */
  .cta-wrap { text-align: center; margin: 24px 0 8px; }
  .cta-btn  { display: inline-block; background: linear-gradient(135deg, #3b82f6, #1d4ed8);
              color: #fff; text-decoration: none; padding: 14px 40px; border-radius: 8px;
              font-weight: 700; font-size: 14px; letter-spacing: 0.3px; }

  /* Footer */
  .footer { text-align: center; color: #94a3b8; font-size: 11px; margin-top: 20px;
            padding: 16px; }
  .empty-note { text-align: center; padding: 20px; color: #94a3b8; font-size: 12px; font-style: italic; }
</style>
</head>
<body>
<div class="wrapper">

  <!-- HEADER -->
  <div class="header">
    <h1>Inventory Control Tower</h1>
    <p class="date">${runDateStr} — Daily Management Summary</p>
    <p>Auto-generated · Do not reply</p>
  </div>

  <!-- ALERTS -->
  ${kpis.cogsMissingSkuCount > 0 ? `
  <div class="alert warning">
    <span><strong>WARNING:</strong> ${kpis.cogsMissingSkuCount} SKU(s) are missing from COGS Master and are valued using Cost Price fallback. Please update <strong>tbl_cogs_master</strong> for accurate valuation.</span>
  </div>` : ''}
  ${kpis.valueAtRisk > 0 ? `
  <div class="alert danger">
    <span><strong>ACTION REQUIRED:</strong> <strong>${_inr(kpis.valueAtRisk)}</strong> of inventory is at risk (bad stock + near expiry + expired). Immediate review recommended.</span>
  </div>` : ''}

  <!-- KPI CARDS ROW 1 — Inventory Value -->
  <div class="kpi-grid">
    <div class="kpi-card blue">
      <div class="kpi-label">Total Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.totalInventoryValue)}</div>
      <div class="kpi-sub">All facilities</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-label">Good Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.goodInventoryValue)}</div>
      <div class="kpi-sub">${_pct(kpis.goodInventoryValue, kpis.totalInventoryValue)} of total</div>
    </div>
    <div class="kpi-card red">
      <div class="kpi-label">Bad Inventory Value</div>
      <div class="kpi-value">${_inr(kpis.badInventoryValue)}</div>
      <div class="kpi-sub">${_pct(kpis.badInventoryValue, kpis.totalInventoryValue)} of total</div>
    </div>
  </div>

  <!-- KPI CARDS ROW 2 — Risk & Expiry -->
  <div class="kpi-grid">
    <div class="kpi-card red">
      <div class="kpi-label">Value At Risk</div>
      <div class="kpi-value">${_inr(kpis.valueAtRisk)}</div>
      <div class="kpi-sub">Bad + Near Expiry + Expired</div>
    </div>
    <div class="kpi-card orange">
      <div class="kpi-label">Near Expiry Value</div>
      <div class="kpi-value">${_inr(kpis.nearExpiryValue)}</div>
      <div class="kpi-sub">Expiring within 60 days</div>
    </div>
    <div class="kpi-card orange">
      <div class="kpi-label">Expired Value</div>
      <div class="kpi-value">${_inr(kpis.expiredValue)}</div>
      <div class="kpi-sub">Requires immediate action</div>
    </div>
  </div>

  <!-- KPI CARDS ROW 3 — Health Buckets -->
  <div class="kpi-grid">
    <div class="kpi-card red">
      <div class="kpi-label">OOS SKUs</div>
      <div class="kpi-value">${kpis.oosSkuCount}</div>
      <div class="kpi-sub">Zero stock on hand</div>
    </div>
    <div class="kpi-card orange">
      <div class="kpi-label">Critical SKUs</div>
      <div class="kpi-value">${kpis.criticalSkuCount}</div>
      <div class="kpi-sub">DOI &lt; 7 days</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-label">Overstock SKUs</div>
      <div class="kpi-value">${kpis.overstockSkuCount}</div>
      <div class="kpi-sub">DOI &gt; 90 days</div>
    </div>
  </div>

  <!-- KPI CARDS ROW 4 — Operations -->
  <div class="kpi-grid">
    <div class="kpi-card purple">
      <div class="kpi-label">Warehouse Utilization</div>
      <div class="kpi-value">${kpis.warehouseUtilizationPct.toFixed(1)}%</div>
      <div class="kpi-sub">${kpis.occupiedBins} / ${kpis.totalBins} bins (SL_MH)</div>
    </div>
    <div class="kpi-card grey">
      <div class="kpi-label">Risk SKUs</div>
      <div class="kpi-value">${kpis.riskSkuCount}</div>
      <div class="kpi-sub">DOI 8–30 days</div>
    </div>
    <div class="kpi-card green">
      <div class="kpi-label">Healthy SKUs</div>
      <div class="kpi-value">${kpis.healthySkuCount}</div>
      <div class="kpi-sub">DOI 31–90 days</div>
    </div>
  </div>

  <!-- TOP 20 OOS -->
  <div class="section">
    <div class="section-header oos">Top 20 Out-of-Stock SKUs &mdash; SL Ambient &amp; SL Mother Hub</div>
    ${_skuTable(top20OOS, 'oos')}
  </div>

  <!-- TOP 20 CRITICAL -->
  <div class="section">
    <div class="section-header critical">Top 20 Critical SKUs (DOI &lt; 7 Days) &mdash; SL Ambient &amp; SL Mother Hub</div>
    ${_skuTable(top20Critical, 'critical')}
  </div>

  <!-- TOP 20 NEAR EXPIRY -->
  <div class="section">
    <div class="section-header expiry">Top 20 Near Expiry Batches</div>
    ${_expiryTable(top20NearExpiry)}
  </div>

  <!-- TOP 20 OVERSTOCK -->
  <div class="section">
    <div class="section-header overstock">Top 20 Overstock SKUs (DOI &gt; 90 Days) &mdash; SL Ambient &amp; SL Mother Hub</div>
    ${_skuTable(top20Overstock, 'overstock')}
  </div>

  <!-- CTA -->
  <div class="cta-wrap">
    <a href="${dashboardUrl}" class="cta-btn">Open Full Dashboard</a>
  </div>

  <!-- FOOTER -->
  <div class="footer">
    Inventory Control Tower · Auto-generated on ${runDateStr}<br>
    This email is system-generated. For queries contact your Supply Chain team.
  </div>

</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// TABLE BUILDERS
// ---------------------------------------------------------------------------

function _skuTable(skus, type) {
  if (!skus || skus.length === 0) {
    return '<div class="empty-note">No SKUs in this category today.</div>';
  }

  const rows = skus.map((s, i) => {
    const badgeClass = type === 'oos' ? 'badge-red' : type === 'critical' ? 'badge-orange' : 'badge-green';
    const doiDisplay = type === 'oos' ? '—' : s.doi30;
    return `<tr>
      <td style="color:#94a3b8;font-size:11px;">${i + 1}</td>
      <td class="mono">${_esc(s.skuCode)}</td>
      <td>${_esc(s.name)}</td>
      <td><span class="badge ${badgeClass}">${_esc(s.facility)}</span></td>
      <td style="text-align:right;">${_num(s.soh)}</td>
      <td style="text-align:right;">${doiDisplay}</td>
      <td style="text-align:right;">${_num(s.sales30)}</td>
      <td style="text-align:right;font-weight:600;">${_inr(s.value)}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>SKU Code</th>
        <th>Product Name</th>
        <th>Facility</th>
        <th style="text-align:right;">SOH</th>
        <th style="text-align:right;">DOI30</th>
        <th style="text-align:right;">Sales 30D</th>
        <th style="text-align:right;">Value</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function _expiryTable(items) {
  if (!items || items.length === 0) {
    return '<div class="empty-note">No near-expiry batches today.</div>';
  }

  const rows = items.map((r, i) => {
    const badgeClass = r.bucket === 'Expired' ? 'badge-red'
                     : r.bucket === 'Critical Expiry' ? 'badge-orange'
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
      <td style="text-align:right;">${_num(r.qty)}</td>
      <td style="text-align:right;font-weight:600;">${_inr(r.value)}</td>
    </tr>`;
  }).join('');

  return `<table>
    <thead>
      <tr>
        <th>#</th>
        <th>SKU Code</th>
        <th>Product Name</th>
        <th>Facility</th>
        <th>Batch</th>
        <th>Expiry Date</th>
        <th>Days Left</th>
        <th style="text-align:right;">Qty</th>
        <th style="text-align:right;">Value</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// EMAIL LOG
// ---------------------------------------------------------------------------

function _logEmail(recipients, subject, status, notes) {
  try {
    appendRows(SHEETS.EMAIL_SUMMARY, [[
      new Date(), recipients, subject, status, notes
    ]]);
  } catch (e) {
    Logger.log('Could not log email: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// FORMAT HELPERS (private to this file)
// ---------------------------------------------------------------------------

/** Indian Rupee format */
function _inr(val) {
  const n = parseFloat(val) || 0;
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/** Percentage of total */
function _pct(part, total) {
  if (!total) return '0%';
  return (part / total * 100).toFixed(1) + '%';
}

/** Number with thousand separators */
function _num(val) {
  return (parseFloat(val) || 0).toLocaleString('en-IN');
}

/** HTML escape */
function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}