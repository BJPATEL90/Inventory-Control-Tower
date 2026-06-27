// =============================================================================
// GmailProcessor.gs — Inventory Control Tower
// Reads Gmail for daily inventory report emails, extracts CloudFront CSV URLs
// from the email body, downloads the CSVs via UrlFetchApp, and imports to
// raw tables.
//
// Email format (Unicommerce):
//   Subject : "Export Job Complete - FG INVENTORY REPORT"
//   Body    : "Export File Path: https://xxx.cloudfront.net/path/FILE.csv"
//
//   Subject : "Export Job Complete - All facility Shelfwise Inventory"
//   Body    : "Export File Path: https://xxx.cloudfront.net/path/FILE.csv"
//
// Called by: runDailyProcessing() in Code.gs
// Public entry: processGmailReports()
// =============================================================================

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

function processGmailReports() {
  Logger.log('--- GmailProcessor: Starting ---');

  const result = {
    fgImported   : 0,
    shelfImported: 0,
    fgSkipped    : false,
    shelfSkipped : false,
    errors       : [],
    warnings     : [],
  };

  const lookbackDays = Math.ceil((getSettingInt('lookback_hours') || 24) / 24);
  const sender       = getSetting('email_sender_filter') || 'noreply@e.unicommerce.com';
  const fgSubject    = getSetting('fg_subject_filter')    || 'Export Job Complete - FG INVENTORY REPORT';
  const shelfSubject = getSetting('shelf_subject_filter') || 'Export Job Complete - All facility Shelfwise Inventory';

  // ── 1. Find and download FG CSV ─────────────────────────────────────────
  try {
    const fgUrl = _extractCsvUrl(sender, fgSubject, lookbackDays);
    if (!fgUrl) {
      result.warnings.push('FG Inventory email not found. Subject: ' + fgSubject);
      result.fgSkipped = true;
      Logger.log('WARNING: FG email not found.');
    } else {
      Logger.log('FG CSV URL: ' + fgUrl);
      const rows    = _downloadAndParseCsv(fgUrl, 'FG Inventory');
      const cleaned = _validateAndCleanFgRows(rows, result);
      _importToSheet(SHEETS.FG_INVENTORY_RAW, cleaned);
      result.fgImported = cleaned.length;
      Logger.log('FG Inventory imported: ' + cleaned.length + ' rows');
    }
  } catch (e) {
    Logger.log('ERROR importing FG Inventory: ' + e.message);
    result.errors.push('FG Import: ' + e.message);
    result.fgSkipped = true;
  }

  // ── 2. Find and download Shelf CSV ──────────────────────────────────────
  try {
    const shelfUrl = _extractCsvUrl(sender, shelfSubject, lookbackDays);
    if (!shelfUrl) {
      result.warnings.push('Shelf Inventory email not found. Subject: ' + shelfSubject);
      result.shelfSkipped = true;
      Logger.log('WARNING: Shelf email not found.');
    } else {
      Logger.log('Shelf CSV URL: ' + shelfUrl);
      const rows    = _downloadAndParseCsv(shelfUrl, 'Shelf Inventory');
      const cleaned = _validateAndCleanShelfRows(rows, result);
      _importToSheet(SHEETS.SHELF_INVENTORY_RAW, cleaned);
      result.shelfImported = cleaned.length;
      Logger.log('Shelf Inventory imported: ' + cleaned.length + ' rows');
    }
  } catch (e) {
    Logger.log('ERROR importing Shelf Inventory: ' + e.message);
    result.errors.push('Shelf Import: ' + e.message);
    result.shelfSkipped = true;
  }

  Logger.log('--- GmailProcessor: Done. FG=' + result.fgImported + ' Shelf=' + result.shelfImported + ' ---');
  return result;
}

// ---------------------------------------------------------------------------
// STEP 1 — FIND EMAIL AND EXTRACT CSV URL FROM BODY
// ---------------------------------------------------------------------------

/**
 * Searches Gmail for the report email and extracts the CloudFront CSV URL
 * from the email body.
 *
 * @param {string} sender       Sender email filter
 * @param {string} subject      Full subject line to match
 * @param {number} lookbackDays How many days back to search
 * @returns {string|null}       CSV download URL or null if not found
 */
function _extractCsvUrl(sender, subject, lookbackDays) {
  const query = [
    'from:' + sender,
    'subject:"' + subject + '"',
    'newer_than:' + lookbackDays + 'd',
  ].join(' ');

  Logger.log('Gmail search: ' + query);
  const threads = GmailApp.search(query, 0, 10);
  Logger.log('Threads found: ' + threads.length);

  if (threads.length === 0) return null;

  const found = [];

  for (const thread of threads) {
    for (const msg of thread.getMessages()) {
      const body = msg.getPlainBody() + ' ' + msg.getBody();

      // Match CloudFront or any HTTPS CSV URL
      const match = body.match(/https?:\/\/[a-zA-Z0-9\-\.]+(?:cloudfront\.net|amazonaws\.com|s3\.)[^\s"<>\r\n]+\.csv/i)
                 || body.match(/Export File Path:\s*(https?:\/\/[^\s"<>\r\n]+\.csv)/i)
                 || body.match(/(https?:\/\/[^\s"<>\r\n]+\.csv)/i);

      if (!match) {
        Logger.log('  No CSV URL found in message: ' + msg.getSubject());
        continue;
      }

      // Use capture group if present, otherwise full match
      const url = (match[1] || match[0]).trim();
      Logger.log('  Found URL: ' + url);
      found.push({ url, date: msg.getDate() });
    }
  }

  if (found.length === 0) return null;

  // Return the URL from the most recent email
  found.sort((a, b) => b.date - a.date);
  return found[0].url;
}

// ---------------------------------------------------------------------------
// STEP 2 — DOWNLOAD CSV VIA UrlFetchApp
// ---------------------------------------------------------------------------

/**
 * Downloads a CSV file from a URL and parses it into a 2D array.
 * Row 0 = headers.
 *
 * @param {string} url
 * @param {string} label  For logging
 * @returns {string[][]}
 */
function _downloadAndParseCsv(url, label) {
  Logger.log('Downloading ' + label + ' from: ' + url);

  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects   : true,
  });

  const code = response.getResponseCode();
  Logger.log('HTTP response: ' + code);

  if (code !== 200) {
    throw new Error(label + ' download failed: HTTP ' + code + '. URL may have expired.');
  }

  let content = response.getContentText('UTF-8');

  // Strip UTF-8 BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  // Normalise line endings
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  let rows;
  try {
    rows = Utilities.parseCsv(content);
  } catch (e) {
    throw new Error('CSV parse failed for ' + label + ': ' + e.message);
  }

  // Remove blank rows
  rows = rows.filter(r => r.some(c => String(c).trim() !== ''));

  Logger.log(label + ': ' + rows.length + ' rows parsed (including header)');

  if (rows.length < 2) {
    throw new Error(label + ' CSV has no data rows (only ' + rows.length + ' row(s)).');
  }

  return rows;
}

// ---------------------------------------------------------------------------
// FG INVENTORY — VALIDATE & CLEAN
// ---------------------------------------------------------------------------

function _validateAndCleanFgRows(rows, result) {
  const importDate = new Date();
  const csvHeaders = rows[0].map(h => String(h).trim());
  const colMap     = _buildColumnMap(csvHeaders);

  // Required columns
  ['SkuCode', 'Stock on Hand', 'Depot Code', 'Last 30 days Sales', 'Last 7 days Sales']
    .forEach(col => {
      if (colMap[col] === undefined) {
        const ci = _findColCI(csvHeaders, col);
        if (ci !== -1) { colMap[col] = ci; result.warnings.push('FG: "' + col + '" matched case-insensitively.'); }
        else throw new Error('FG CSV missing required column: "' + col + '". Found: ' + csvHeaders.join(', '));
      }
    });

  const cleaned = [];
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const row    = rows[i];
    const skuCode = String(_getVal(row, colMap, 'SkuCode') || '').trim();
    if (!skuCode) { skipped++; continue; }

    cleaned.push([
      _getVal(row, colMap, 'Category'),
      _getVal(row, colMap, 'Brand'),
      _getVal(row, colMap, 'Depot Code'),
      _getVal(row, colMap, 'Depot Name'),
      skuCode,
      _getVal(row, colMap, 'Product Name'),
      safeNum(_getVal(row, colMap, 'MRP')),
      safeNum(_getVal(row, colMap, 'Cost Price')),
      safeNum(_getVal(row, colMap, 'Inventory Value on CP')),
      safeNum(_getVal(row, colMap, 'Stock on Hand')),
      safeNum(_getVal(row, colMap, 'Damaged Stock')),
      safeNum(_getVal(row, colMap, 'Stock In Transfer')),
      safeNum(_getVal(row, colMap, 'Open Purchase')),
      safeNum(_getVal(row, colMap, 'Last 30 days Sales')),
      safeNum(_getVal(row, colMap, 'Last 7 days Sales')),
      safeNum(_getVal(row, colMap, 'Day Of Inventory')),
      importDate,
    ]);
  }

  if (skipped > 0) result.warnings.push('FG: Skipped ' + skipped + ' rows with blank SKU Code.');
  Logger.log('FG cleaned: ' + cleaned.length + ' rows (skipped ' + skipped + ')');
  return cleaned;
}

// ---------------------------------------------------------------------------
// SHELF INVENTORY — VALIDATE & CLEAN
// ---------------------------------------------------------------------------

function _validateAndCleanShelfRows(rows, result) {
  const importDate = new Date();
  const csvHeaders = rows[0].map(h => String(h).trim());
  const colMap     = _buildColumnMap(csvHeaders);

  ['Facility Code', 'Item Type SKU Code', 'Quantity', 'Expiry', 'Batch Status']
    .forEach(col => {
      if (colMap[col] === undefined) {
        const ci = _findColCI(csvHeaders, col);
        if (ci !== -1) { colMap[col] = ci; result.warnings.push('Shelf: "' + col + '" matched case-insensitively.'); }
        else throw new Error('Shelf CSV missing required column: "' + col + '". Found: ' + csvHeaders.join(', '));
      }
    });

  const cleaned = [];
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const row     = rows[i];
    const skuCode = String(_getVal(row, colMap, 'Item Type SKU Code') || '').trim();
    if (!skuCode) { skipped++; continue; }

    cleaned.push([
      _getVal(row, colMap, 'Facility'),
      _getVal(row, colMap, 'Facility Code'),
      skuCode,
      _getVal(row, colMap, 'Item Type Name'),
      _getVal(row, colMap, 'Inventory Type'),
      _getVal(row, colMap, 'Shelf'),
      _getVal(row, colMap, 'Inventory Allocation'),
      _getVal(row, colMap, 'Inventory Sync'),
      _getVal(row, colMap, 'Sku Mixing'),
      _getVal(row, colMap, 'Shelf On Hold'),
      safeNum(_getVal(row, colMap, 'Quantity')),
      safeNum(_getVal(row, colMap, 'Quantity Blocked')),
      safeNum(_getVal(row, colMap, 'Quantity Not Found')),
      safeNum(_getVal(row, colMap, 'Quantity Damaged')),
      _getVal(row, colMap, 'Priority'),
      _getVal(row, colMap, 'Section'),
      _getVal(row, colMap, 'Batch Code'),
      _parseDate(_getVal(row, colMap, 'Expiry')),
      safeNum(_getVal(row, colMap, 'MRP')),
      _parseDate(_getVal(row, colMap, 'Manufacturing Date')),
      _getVal(row, colMap, 'Vendor Batch Code'),
      _getVal(row, colMap, 'Batch Recall'),
      _getVal(row, colMap, 'Batch Status'),
      importDate,
    ]);
  }

  if (skipped > 0) result.warnings.push('Shelf: Skipped ' + skipped + ' rows with blank SKU Code.');
  Logger.log('Shelf cleaned: ' + cleaned.length + ' rows (skipped ' + skipped + ')');
  return cleaned;
}

// ---------------------------------------------------------------------------
// STEP 3 — WRITE TO SHEET
// ---------------------------------------------------------------------------

/**
 * Clears sheet data and writes rows in batches of 5000.
 */
function _importToSheet(sheetName, rows) {
  clearSheetData(sheetName);
  if (rows.length === 0) { Logger.log('No rows to write to ' + sheetName); return; }

  const BATCH = 5000;
  const sheet = getSheet(sheetName);
  let startRow = 2; // Row 1 = headers

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    sheet.getRange(startRow, 1, chunk.length, chunk[0].length).setValues(chunk);
    startRow += chunk.length;
    SpreadsheetApp.flush();
    Logger.log('  Written rows ' + (i + 1) + ' to ' + (i + chunk.length));
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function _buildColumnMap(headers) {
  const map = {};
  headers.forEach((h, i) => { if (h) map[String(h).trim()] = i; });
  return map;
}

function _findColCI(headers, target) {
  const t = target.toLowerCase();
  return headers.findIndex(h => String(h).trim().toLowerCase() === t);
}

function _getVal(row, colMap, name) {
  const idx = colMap[name];
  if (idx === undefined) return '';
  const v = row[idx];
  return (v === null || v === undefined) ? '' : v;
}

function _parseDate(raw) {
  if (!raw || String(raw).trim() === '') return '';
  if (raw instanceof Date) return isNaN(raw.getTime()) ? '' : raw;
  const s = String(raw).trim();

  // YYYY-MM-DD — parse as local date (not UTC midnight) to avoid ±1 day timezone issues
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const p = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
    if (!isNaN(p.getTime())) return p;
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const p = new Date(parseInt(dmy[3]), parseInt(dmy[2]) - 1, parseInt(dmy[1]));
    if (!isNaN(p.getTime())) return p;
  }

  // Last resort — let JS parse (may have timezone offset)
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d;
}

function _formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// ---------------------------------------------------------------------------
// MANUAL / DIAGNOSTIC FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Diagnose Gmail search — shows what emails and URLs are found.
 * Run this from the Apps Script editor to verify settings before a full run.
 */
function diagnoseGmailSearch() {
  const sender       = getSetting('email_sender_filter') || 'noreply@e.unicommerce.com';
  const fgSubject    = getSetting('fg_subject_filter')    || 'Export Job Complete - FG INVENTORY REPORT';
  const shelfSubject = getSetting('shelf_subject_filter') || 'Export Job Complete - All facility Shelfwise Inventory';
  const lookbackDays = Math.ceil((getSettingInt('lookback_hours') || 24) / 24);

  const lines = ['Gmail Diagnostic\n'];

  [[fgSubject, 'FG Inventory'], [shelfSubject, 'Shelf Inventory']].forEach(([subject, label]) => {
    lines.push('── ' + label + ' ──');
    lines.push('Subject: ' + subject);
    const url = _extractCsvUrl(sender, subject, lookbackDays);
    if (url) {
      lines.push('✅ URL found: ' + url.substring(0, 80) + '...');
    } else {
      lines.push('❌ No URL found.');
      lines.push('Tips: check sender (' + sender + '), subject exact match, lookback_hours setting.');
    }
    lines.push('');
  });

  Logger.log(lines.join('\n'));
}

/**
 * Manual import — runs full Gmail processing and shows result summary.
 */
function manualGmailImport() {
  const result = processGmailReports();
  const msg = [
    'Gmail Processing Result:',
    'FG rows imported : ' + result.fgImported,
    'Shelf imported   : ' + result.shelfImported,
    result.fgSkipped    ? '⚠ FG skipped'    : '',
    result.shelfSkipped ? '⚠ Shelf skipped' : '',
    result.warnings.length ? 'Warnings: ' + result.warnings.join('; ') : '',
    result.errors.length   ? 'Errors: '   + result.errors.join('; ')   : '',
  ].filter(Boolean).join('\n');
  Logger.log(msg);
}