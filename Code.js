// =============================================================================
// Code.gs — Inventory Control Tower
// Main entry point. Run setupSpreadsheet() once after deployment to create
// all sheets, headers, seed data, and triggers.
// =============================================================================

// ---------------------------------------------------------------------------
// ENTRY POINT — Run this once after deploying to a new spreadsheet.
// ---------------------------------------------------------------------------
/**
 * Master setup function.
 * Creates all sheets, writes headers, seeds reference data, installs triggers.
 * Safe to re-run: will not overwrite existing data.
 */
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('=== Inventory Control Tower — Setup Started ===');

  try {
    _createAllSheets(ss);
    _writeSeedData(ss);
    _autoSaveSpreadsheetId(ss);
    _installTriggers();
    Logger.log('=== Setup Complete ===');
    SpreadsheetApp.getUi().alert(
      '✅ Setup Complete!\n\n' +
      'All sheets created.\n' +
      'Seed data written.\n' +
      'Daily trigger installed at 09:30 AM IST.\n\n' +
      'Next Steps:\n' +
      '1. Open tbl_settings and fill in email recipients, OAuth Client ID, dashboard URL.\n' +
      '2. Upload tbl_bin_master CSV.\n' +
      '3. Deploy Apps Script as a Web App (Execute as: Me, Access: Anyone with Google Account).\n' +
      '4. Add the Web App URL to Config.gs → dashboard_api_base.'
    );
  } catch (e) {
    Logger.log('Setup error: ' + e.message);
    SpreadsheetApp.getUi().alert('❌ Setup failed: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// SHEET CREATION
// ---------------------------------------------------------------------------
/**
 * Creates all required sheets if they don't exist.
 * Writes column headers to row 1.
 */
function _createAllSheets(ss) {
  const sheetDefs = [
    { name: SHEETS.FG_INVENTORY_RAW,      columns: FG_COLUMNS },
    { name: SHEETS.SHELF_INVENTORY_RAW,   columns: SHELF_COLUMNS },
    { name: SHEETS.BIN_MASTER,            columns: BIN_COLUMNS },
    { name: SHEETS.COGS_MASTER,           columns: COGS_COLUMNS },
    { name: SHEETS.FACILITY_MAPPING,      columns: FACILITY_MAPPING_COLUMNS },
    { name: SHEETS.SKU_SUMMARY,           columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.SKU_AGG,              columns: SKU_AGG_COLUMNS },
    { name: SHEETS.DISCONTINUED,         columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.INVENTORY_HEALTH,      columns: INVENTORY_HEALTH_COLUMNS },
    { name: SHEETS.EXPIRY_SUMMARY,        columns: EXPIRY_SUMMARY_COLUMNS },
    { name: SHEETS.WAREHOUSE_UTILIZATION, columns: WAREHOUSE_UTILIZATION_COLUMNS },
    { name: SHEETS.DASHBOARD_SUMMARY,     columns: DASHBOARD_SUMMARY_COLUMNS },
    { name: SHEETS.EMAIL_SUMMARY,         columns: EMAIL_SUMMARY_COLUMNS },
    { name: SHEETS.SETTINGS,             columns: SETTINGS_COLUMNS },
  ];

  sheetDefs.forEach(def => {
    let sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      Logger.log(`Created sheet: ${def.name}`);
    } else {
      Logger.log(`Sheet exists, skipping creation: ${def.name}`);
    }
    _ensureHeader(sheet, def.columns);
    _formatHeaderRow(sheet);
  });

  // Remove default "Sheet1" if it still exists and is empty
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() <= 1) {
    ss.deleteSheet(defaultSheet);
    Logger.log('Removed default Sheet1');
  }
}

/**
 * Writes column headers to row 1 only if row 1 is currently blank.
 */
function _ensureHeader(sheet, columns) {
  const firstCell = sheet.getRange(1, 1).getValue();
  if (!firstCell || String(firstCell).trim() === '') {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    Logger.log(`  Headers written to ${sheet.getName()}`);
  }
}

/**
 * Applies consistent enterprise header formatting.
 */
function _formatHeaderRow(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const headerRange = sheet.getRange(1, 1, 1, lastCol);
  headerRange
    .setBackground('#1a1a2e')   // Dark navy
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setFontSize(10)
    .setFontFamily('Google Sans, Arial, sans-serif')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);
}

// ---------------------------------------------------------------------------
// SEED DATA
// ---------------------------------------------------------------------------
/**
 * Seeds reference tables on first run.
 * Never overwrites rows that already exist.
 */
function _writeSeedData(ss) {
  _seedFacilityMapping(ss);
  _seedSettings(ss);
  _seedCogsPlaceholder(ss);
}

function _seedFacilityMapping(ss) {
  const sheet = ss.getSheetByName(SHEETS.FACILITY_MAPPING);
  if (!sheet || sheet.getLastRow() > 1) return; // Already has data

  const rows = DEFAULT_FACILITY_MAPPING.map(row => row);
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Seeded facility mapping with ' + rows.length + ' facilities.');
}

function _seedSettings(ss) {
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() > 1) return; // Already has data

  const now  = new Date();
  const rows = DEFAULT_SETTINGS.map(row => [row[0], row[1], row[2], now]);
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('Seeded ' + rows.length + ' settings.');
}

function _seedCogsPlaceholder(ss) {
  const sheet = ss.getSheetByName(SHEETS.COGS_MASTER);
  if (!sheet || sheet.getLastRow() > 1) return; // Already has data

  // Write one example row so admin knows the format
  sheet.getRange(2, 1, 1, 4).setValues([
    ['EXAMPLE.SKU.001', 'Example Product Name', 'Example Brand', 100.00]
  ]);
  sheet.getRange(2, 1, 1, 4).setFontColor('#999999').setFontStyle('italic');
  Logger.log('Seeded COGS master with example placeholder.');
}

// ---------------------------------------------------------------------------
// SPREADSHEET ID — Save to settings for reference/visibility only.
// The hardcoded SPREADSHEET_ID constant is the authoritative source.
// ---------------------------------------------------------------------------
function _autoSaveSpreadsheetId(ss) {
  const settingsSheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!settingsSheet) return;
  const data = settingsSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'spreadsheet_id') {
      settingsSheet.getRange(i + 1, 2).setValue(ss.getId());
      settingsSheet.getRange(i + 1, 4).setValue(new Date());
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// TRIGGER MANAGEMENT
// ---------------------------------------------------------------------------
/**
 * Installs a daily time-based trigger at the hour/minute defined in settings.
 * Clears any existing daily triggers first to avoid duplicates.
 */
function _installTriggers() {
  // Remove existing daily triggers for runDailyProcessing
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'runDailyProcessing') {
      ScriptApp.deleteTrigger(trigger);
      Logger.log('Removed existing daily trigger.');
    }
  });

  const hour   = parseInt(getSetting('trigger_hour'), 10)   || 9;
  const minute = parseInt(getSetting('trigger_minute'), 10) || 30;

  ScriptApp.newTrigger('runDailyProcessing')
    .timeBased()
    .everyDays(1)
    .atHour(hour)
    .nearMinute(minute)
    .inTimezone(getSetting('timezone') || 'Asia/Kolkata')
    .create();

  Logger.log(`Daily trigger installed: ${hour}:${String(minute).padStart(2, '0')} IST`);
}

/**
 * Reinstall trigger (call from Settings page when schedule changes).
 */
function reinstallTrigger() {
  clearSettingsCache();
  _installTriggers();
  return { success: true, message: 'Trigger reinstalled.' };
}

// ---------------------------------------------------------------------------
// DAILY PROCESSING ORCHESTRATOR
// Called by the time-based trigger every day at 09:30 AM IST.
// ---------------------------------------------------------------------------
/**
 * Master daily run. Calls each module in sequence.
 * All errors are caught and logged — a failure in one step does not
 * prevent subsequent steps from running.
 */
function runDailyProcessing() {
  const runDate = new Date();
  const runLog  = [];

  Logger.log('=== Daily Processing Started: ' + runDate.toISOString() + ' ===');
  clearSettingsCache();

  // Write a placeholder row so _logRunStatus always updates THIS run's row,
  // not the previous run's row (which was the bug when runInventoryEngine fails
  // before _writeDashboardSummary appends its own row).
  try {
    const placeholderRow = new Array(DASHBOARD_SUMMARY_COLUMNS.length).fill('');
    placeholderRow[DASHBOARD_SUMMARY_COLUMNS.indexOf('Run Date')]      = runDate;
    placeholderRow[DASHBOARD_SUMMARY_COLUMNS.indexOf('Run Timestamp')] = new Date();
    placeholderRow[DASHBOARD_SUMMARY_COLUMNS.indexOf('Status')]        = 'RUNNING';
    appendRows(SHEETS.DASHBOARD_SUMMARY, [placeholderRow]);
  } catch (e) {
    Logger.log('Could not write run placeholder: ' + e.message);
  }

  const steps = [
    { name: 'Gmail Processing',  fn: processGmailReports  },
    { name: 'Inventory Engine',  fn: runInventoryEngine   },
    { name: 'Email Report',      fn: sendDailyEmailReport },
  ];
  // Note: Dashboard Summary is written inside runInventoryEngine automatically.

  let overallStatus = 'SUCCESS';

  steps.forEach(step => {
    try {
      Logger.log(`--- Starting: ${step.name} ---`);
      step.fn();
      runLog.push({ step: step.name, status: 'OK' });
      Logger.log(`--- Completed: ${step.name} ---`);
    } catch (e) {
      Logger.log(`ERROR in ${step.name}: ${e.message}\n${e.stack}`);
      runLog.push({ step: step.name, status: 'ERROR', error: e.message });
      overallStatus = 'PARTIAL';
    }
  });

  Logger.log('=== Daily Processing Finished. Status: ' + overallStatus + ' ===');

  // Write run summary to dashboard
  _logRunStatus(runDate, overallStatus, runLog);
}

/**
 * Manual trigger for testing — runs full pipeline immediately.
 * Call from the Apps Script editor: manualRun()
 */
function manualRun() {
  runDailyProcessing();
}

// ---------------------------------------------------------------------------
// UTILITY FUNCTIONS
// Shared helpers used across all modules.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SPREADSHEET ID — Hardcoded for reliability across all execution contexts.
// Works in: spreadsheet UI, Web App (doGet/doPost), time-based triggers.
// ---------------------------------------------------------------------------
const SPREADSHEET_ID = '1c1dbK-jgpHWPNHlzpEB8Efy8grDF27O7Ejyp6suydlI';

/**
 * Returns the spreadsheet instance in ALL execution contexts.
 * Uses hardcoded ID so Web App and standalone triggers never fail.
 */
function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

/**
 * Returns a sheet by name, working in ALL execution contexts
 * (spreadsheet UI, Web App, time-based trigger, standalone script).
 * Throws a descriptive error if the sheet is not found.
 */
function getSheet(sheetName) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error(`Sheet not found: "${sheetName}". Run setupSpreadsheet() first.`);
  return sheet;
}

/**
 * Reads all data from a sheet as an array of objects (header row → keys).
 * Returns [] if sheet has only header or is empty.
 * @param {string} sheetName
 * @returns {Array<Object>}
 */
function readSheetAsObjects(sheetName) {
  const sheet = getSheet(sheetName);
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0].map(h => String(h).trim());
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Reads all data from a sheet as a 2D array (first row = headers).
 * @param {string} sheetName
 * @returns {Array<Array>}
 */
function readSheetRaw(sheetName) {
  const sheet = getSheet(sheetName);
  return sheet.getDataRange().getValues();
}

/**
 * Clears all data rows (keeps header) from a sheet.
 * Uses clearContents + deleteRows safely to avoid frozen-row errors.
 */
function clearSheetData(sheetName) {
  const sheet        = getSheet(sheetName);
  const lastRow      = sheet.getLastRow();
  const lastCol      = sheet.getLastColumn() || 1;
  const frozenRows   = sheet.getFrozenRows();
  const firstDataRow = Math.max(2, frozenRows + 1);

  if (lastRow < firstDataRow) return;

  const numRows = lastRow - firstDataRow + 1;
  if (numRows <= 0) return;

  // Clear content first (always safe)
  sheet.getRange(firstDataRow, 1, numRows, lastCol).clearContent();

  // Only delete rows if sheet has more rows than frozen+1 (avoids the "cannot delete all non-frozen" error)
  const maxRows = sheet.getMaxRows();
  if (maxRows > firstDataRow) {
    try {
      sheet.deleteRows(firstDataRow, numRows);
    } catch (e) {
      // Leave empty rows — content is already cleared, writes will still work
      Logger.log('Note: rows not deleted in ' + sheetName + ' (kept empty)');
    }
  }
}

/**
 * Appends rows to a sheet. rows is a 2D array.
 * Uses batch setValues for performance (handles 100k+ rows).
 */
function appendRows(sheetName, rows) {
  if (!rows || rows.length === 0) return;
  const sheet    = getSheet(sheetName);
  const lastRow  = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Builds a lookup Map from a sheet using a specified column as key.
 * Useful for O(1) lookups (e.g., COGS by SKU Code).
 * @param {string} sheetName
 * @param {string} keyColumn   Column name to use as Map key
 * @returns {Map<string, Object>}
 */
function buildLookupMap(sheetName, keyColumn) {
  const rows = readSheetAsObjects(sheetName);
  const map  = new Map();
  rows.forEach(row => {
    const key = String(row[keyColumn] || '').trim();
    if (key) map.set(key, row);
  });
  return map;
}

/**
 * Returns today's date at midnight in the configured timezone.
 */
function getToday() {
  const tz = getSetting('timezone') || 'Asia/Kolkata';
  const formatted = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  return new Date(formatted + 'T00:00:00');
}

/**
 * Formats a number as Indian Rupees (₹).
 * @param {number} value
 * @returns {string}
 */
function formatINR(value) {
  const num = parseFloat(value) || 0;
  return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

/**
 * Safe number parser. Returns 0 for blank/null/NaN.
 */
function safeNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

/**
 * Safe date parser. Returns null for blank/invalid.
 */
function safeDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Returns days between two dates (positive = future).
 */
function daysBetween(dateA, dateB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((dateA - dateB) / msPerDay);
}

/**
 * Chunks a large array into smaller arrays of size n.
 * Used for batch API writes.
 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// RUN STATUS LOGGING
// ---------------------------------------------------------------------------
function _logRunStatus(runDate, status, runLog) {
  try {
    const notes  = runLog.map(r => `${r.step}: ${r.status}${r.error ? ' (' + r.error + ')' : ''}`).join(' | ');
    const sheet  = getSheet(SHEETS.DASHBOARD_SUMMARY);
    const last   = sheet.getLastRow();
    if (last > 1) {
      // Update Status and Notes columns in the most recent row
      const statusColIdx = DASHBOARD_SUMMARY_COLUMNS.indexOf('Status') + 1;
      const notesColIdx  = DASHBOARD_SUMMARY_COLUMNS.indexOf('Notes') + 1;
      if (statusColIdx > 0) sheet.getRange(last, statusColIdx).setValue(status);
      if (notesColIdx > 0)  sheet.getRange(last, notesColIdx).setValue(notes);
    }
  } catch (e) {
    Logger.log('Could not write run status: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// MENU — Adds a custom menu to the spreadsheet for manual operations.
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏭 Inventory Tower')
    .addItem('⚙️  First-time Setup', 'setupSpreadsheet')
    .addSeparator()
    .addItem('▶️  Run Daily Processing Now', 'manualRun')
    .addItem('📧 Send Email Report Now',   'sendDailyEmailReport')
    .addSeparator()
    .addItem('🔄 Reinstall Trigger',       'reinstallTrigger')
    .addItem('🗑️  Clear Raw Tables',        'clearRawTables')
    .addSeparator()
    .addItem('📊 Verify Sheet Structure',  'verifySheetStructure')
    .addToUi();
}

// ---------------------------------------------------------------------------
// ADMIN UTILITIES
// ---------------------------------------------------------------------------

/**
 * Clears FG and Shelf raw tables (keeps headers).
 * Use before re-importing a day's data manually.
 */
function clearRawTables() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Clear Raw Tables?',
    'This will delete all rows in tbl_fg_inventory_raw and tbl_shelf_inventory_raw.\nThis cannot be undone.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (response === ui.Button.YES) {
    clearSheetData(SHEETS.FG_INVENTORY_RAW);
    clearSheetData(SHEETS.SHELF_INVENTORY_RAW);
    ui.alert('✅ Raw tables cleared.');
  }
}

/**
 * Verifies all required sheets exist and have correct headers.
 * Reports any missing sheets or column mismatches.
 */
function verifySheetStructure() {
  const ss      = getSpreadsheet();
  const results = [];
  const sheetDefs = [
    { name: SHEETS.FG_INVENTORY_RAW,      columns: FG_COLUMNS },
    { name: SHEETS.SHELF_INVENTORY_RAW,   columns: SHELF_COLUMNS },
    { name: SHEETS.BIN_MASTER,            columns: BIN_COLUMNS },
    { name: SHEETS.COGS_MASTER,           columns: COGS_COLUMNS },
    { name: SHEETS.FACILITY_MAPPING,      columns: FACILITY_MAPPING_COLUMNS },
    { name: SHEETS.SKU_SUMMARY,           columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.SKU_AGG,              columns: SKU_AGG_COLUMNS },
    { name: SHEETS.DISCONTINUED,         columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.INVENTORY_HEALTH,      columns: INVENTORY_HEALTH_COLUMNS },
    { name: SHEETS.EXPIRY_SUMMARY,        columns: EXPIRY_SUMMARY_COLUMNS },
    { name: SHEETS.WAREHOUSE_UTILIZATION, columns: WAREHOUSE_UTILIZATION_COLUMNS },
    { name: SHEETS.DASHBOARD_SUMMARY,     columns: DASHBOARD_SUMMARY_COLUMNS },
    { name: SHEETS.EMAIL_SUMMARY,         columns: EMAIL_SUMMARY_COLUMNS },
    { name: SHEETS.SETTINGS,             columns: SETTINGS_COLUMNS },
  ];

  sheetDefs.forEach(def => {
    const sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      results.push(`❌ MISSING: ${def.name}`);
      return;
    }
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const missing = def.columns.filter(col => !headers.includes(col));
    if (missing.length > 0) {
      results.push(`⚠️  ${def.name}: Missing columns: ${missing.join(', ')}`);
    } else {
      results.push(`✅ ${def.name}`);
    }
  });

  SpreadsheetApp.getUi().alert('Sheet Structure Verification\n\n' + results.join('\n'));
}

/**
 * Shared batch writer — writes rows to a sheet in chunks of 5000.
 * Used by both GmailProcessor and InventoryProcessor.
 * @param {string} sheetName
 * @param {Array[]} rows
 */
function _batchWriteRows(sheetName, rows) {
  if (!rows || rows.length === 0) return;
  const BATCH  = 5000;
  const sheet  = getSheet(sheetName);
  let startRow = sheet.getLastRow() + 1;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    sheet.getRange(startRow, 1, chunk.length, chunk[0].length).setValues(chunk);
    startRow += chunk.length;
    SpreadsheetApp.flush();
  }
}

/**
 * Diagnostic: prints the first row (headers) of tbl_fg_inventory_raw.
 * Run this to see exactly what column names were written during import.
 */
function diagnoseFgHeaders() {
  const sheet = getSheet(SHEETS.FG_INVENTORY_RAW);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const sample  = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0]
    : [];
  const lines = ['tbl_fg_inventory_raw headers:\n'];
  headers.forEach((h, i) => {
    lines.push(`Col ${i+1}: "${h}" → sample: "${sample[i] || ''}"`);
  });
  Logger.log(lines.join('\n'));
}

/**
 * Fixes tbl_fg_inventory_raw header row to match FG_COLUMNS exactly.
 * Run this once if headers are wrong from old setup.
 */
function fixFgHeaders() {
  const sheet = getSheet(SHEETS.FG_INVENTORY_RAW);
  sheet.getRange(1, 1, 1, FG_COLUMNS.length).setValues([FG_COLUMNS]);
  Logger.log('✅ FG headers fixed. Now run manualRunEngine().');
}

/**
 * Fixes header rows on all computed summary sheets to match current column definitions.
 * Run this once after any column definition change.
 */
function fixAllHeaders() {
  const sheetDefs = [
    { name: SHEETS.FG_INVENTORY_RAW,      columns: FG_COLUMNS },
    { name: SHEETS.SHELF_INVENTORY_RAW,   columns: SHELF_COLUMNS },
    { name: SHEETS.SKU_SUMMARY,           columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.SKU_AGG,             columns: SKU_AGG_COLUMNS },
    { name: SHEETS.DISCONTINUED,        columns: SKU_SUMMARY_COLUMNS },
    { name: SHEETS.INVENTORY_HEALTH,      columns: INVENTORY_HEALTH_COLUMNS },
    { name: SHEETS.EXPIRY_SUMMARY,        columns: EXPIRY_SUMMARY_COLUMNS },
    { name: SHEETS.WAREHOUSE_UTILIZATION, columns: WAREHOUSE_UTILIZATION_COLUMNS },
    { name: SHEETS.DASHBOARD_SUMMARY,     columns: DASHBOARD_SUMMARY_COLUMNS },
    { name: SHEETS.EMAIL_SUMMARY,         columns: EMAIL_SUMMARY_COLUMNS },
  ];

  const ss = getSpreadsheet();
  const results = [];

  sheetDefs.forEach(def => {
    try {
      const sheet = ss.getSheetByName(def.name);
      if (!sheet) { results.push('MISSING: ' + def.name); return; }
      sheet.getRange(1, 1, 1, def.columns.length).setValues([def.columns]);
      _formatHeaderRow(sheet);
      results.push('✅ ' + def.name);
    } catch(e) {
      results.push('❌ ' + def.name + ': ' + e.message);
    }
  });

  Logger.log('Headers fixed: ' + results.join(' | '));
  // Run from spreadsheet menu for alert popup, or check Apps Script logs.
}