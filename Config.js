// =============================================================================
// Config.gs — Inventory Control Tower
// Central configuration file for all constants, sheet names, and defaults.
// Edit this file to change system-wide behaviour without touching logic files.
// =============================================================================

// ---------------------------------------------------------------------------
// SHEET NAMES
// All table names in one place. Never hardcode sheet names elsewhere.
// ---------------------------------------------------------------------------
const SHEETS = {
  FG_INVENTORY_RAW      : 'tbl_fg_inventory_raw',
  SHELF_INVENTORY_RAW   : 'tbl_shelf_inventory_raw',
  BIN_MASTER            : 'tbl_bin_master',
  COGS_MASTER           : 'tbl_cogs_master',
  FACILITY_MAPPING      : 'tbl_facility_mapping',
  SKU_SUMMARY           : 'tbl_sku_summary',
  SKU_AGG               : 'tbl_sku_agg',
  DISCONTINUED          : 'tbl_discontinued',
  INVENTORY_HEALTH      : 'tbl_inventory_health',
  EXPIRY_SUMMARY        : 'tbl_expiry_summary',
  WAREHOUSE_UTILIZATION : 'tbl_warehouse_utilization',
  DASHBOARD_SUMMARY     : 'tbl_dashboard_summary',
  EMAIL_SUMMARY         : 'tbl_email_summary',
  SETTINGS              : 'tbl_settings',
};

// ---------------------------------------------------------------------------
// FG INVENTORY RAW — Column Headers (Source 1)
// Order must match the CSV attachment exactly.
// ---------------------------------------------------------------------------
const FG_COLUMNS = [
  'Category',
  'Brand',
  'Depot Code',
  'Depot Name',
  'SkuCode',
  'Product Name',
  'MRP',
  'Cost Price',           // Used as COGS fallback only
  'Inventory Value on CP',// Ignored — we always use COGS master
  'Stock on Hand',
  'Damaged Stock',
  'Stock In Transfer',
  'Open Purchase',
  'Last 30 days Sales',
  'Last 7 days Sales',
  'Day Of Inventory',
  // Appended by system during import
  'Import Date',
];

// ---------------------------------------------------------------------------
// SHELF INVENTORY RAW — Column Headers (Source 2)
// Order must match the CSV attachment exactly.
// ---------------------------------------------------------------------------
const SHELF_COLUMNS = [
  'Facility',
  'Facility Code',
  'Item Type SKU Code',
  'Item Type Name',
  'Inventory Type',
  'Shelf',
  'Inventory Allocation',
  'Inventory Sync',
  'Sku Mixing',
  'Shelf On Hold',
  'Quantity',
  'Quantity Blocked',
  'Quantity Not Found',
  'Quantity Damaged',
  'Priority',
  'Section',
  'Batch Code',
  'Expiry',
  'MRP',
  'Manufacturing Date',
  'Vendor Batch Code',
  'Batch Recall',
  'Batch Status',
  // Appended by system during import
  'Import Date',
];

// ---------------------------------------------------------------------------
// BIN MASTER — Column Headers (Source 3, manual upload)
// ---------------------------------------------------------------------------
const BIN_COLUMNS = [
  'Bin ID',
  'Row',
  'Column No',
  'Level',
];

// ---------------------------------------------------------------------------
// COGS MASTER — Column Headers (Source 4, manually maintained)
// ---------------------------------------------------------------------------
const COGS_COLUMNS = [
  'SkuCode',
  'Product Name',
  'Brand',
  'COGS',
];

// ---------------------------------------------------------------------------
// FACILITY MAPPING — Column Headers
// Configurable via Settings page. Never hardcode facility types.
// ---------------------------------------------------------------------------
const FACILITY_MAPPING_COLUMNS = [
  'Depot Name',         // Matches Depot Name column in FG report and Facility column in Shelf report
  'Display_Name',       // Human-readable label shown in the dashboard
  'Facility_Type',      // MW-3PL | MW-Self = Mother Warehouse; Darkstore | Self-B2B | etc. = Distribution
  'Is Active',          // TRUE / FALSE
];

// Default seed data — will be written on first setup only.
// Add your actual facilities here or upload directly to tbl_facility_mapping.
const DEFAULT_FACILITY_MAPPING = [
  ['SL Mother Hub',  'SL Mother Hub',  'MW-Self', true],
  ['SL Ambient',     'SL Ambient',     'MW-Self', true],
  ['Aramex',         '3PL-Aramex',     'MW-3PL',  true],
];

// ---------------------------------------------------------------------------
// SKU SUMMARY — Computed per-SKU per-facility aggregate
// ---------------------------------------------------------------------------
const SKU_SUMMARY_COLUMNS = [
  'Run Date',
  'SKU Code',
  'Product Name',
  'Brand',
  'Category',
  'Facility Code',
  'Facility Name',
  'Facility Type',
  'SOH',
  'SIT',
  'Damaged Stock',
  'Open Purchase',
  'Last 30 Days Sales',
  'Last 7 Days Sales',
  'COGS',
  'COGS Source',
  'Inventory Value',
  'Good Inventory Value',
  'Bad Inventory Value',
  'Good Qty',
  'Bad Qty',
  'Near Expiry Qty',
  'Critical Expiry Qty',
  'Expired Qty',
  'Near Expiry Value',
  'Critical Expiry Value',
  'Expired Value',
  'Value At Risk',
  'DRR30',
  'DRR7',
  'DOI30',
  'DOI7',
  'Health Bucket',
  'Is Discontinued',
];

// ---------------------------------------------------------------------------
// SKU AGG — One row per SKU (across all facilities). Used for management KPIs.
// Health bucket is assigned here at SKU level, not per-facility.
// ---------------------------------------------------------------------------
const SKU_AGG_COLUMNS = [
  'Run Date',
  'SKU Code',
  'Product Name',
  'Brand',
  'Category',
  'Mother WH SOH',       // SOH in Mother WHs only — used for DOI and health bucket
  'Network SOH',         // SOH in all other (distribution) facilities
  'Total SOH',           // Mother WH SOH + Network SOH
  'Total SIT',
  'Total Damaged',
  'Total Open Purchase',
  'Sales 30D',
  'Sales 7D',
  'DRR30',
  'DRR7',
  'DOI30',               // Based on Mother WH SOH / DRR30
  'DOI7',                // Based on Mother WH SOH / DRR7
  'COGS',
  'COGS Source',
  'Total Inventory Value',
  'Total Good Value',
  'Total Bad Value',
  'Total Good Qty',
  'Total Bad Qty',
  'Near Expiry Qty',
  'Critical Expiry Qty',
  'Expired Qty',
  'Near Expiry Value',
  'Critical Expiry Value',
  'Expired Value',
  'Value At Risk',
  'Health Bucket',
  'Is Discontinued',
  'Active Facilities',
];

// ---------------------------------------------------------------------------
// INVENTORY HEALTH — Bucket-level summary
// ---------------------------------------------------------------------------
const INVENTORY_HEALTH_COLUMNS = [
  'Run Date',
  'Bucket',
  'SKU Count',
  'Total Qty',
  'Inventory Value',
];

// ---------------------------------------------------------------------------
// EXPIRY SUMMARY — Per-batch expiry details
// ---------------------------------------------------------------------------
const EXPIRY_SUMMARY_COLUMNS = [
  'Run Date',
  'SKU Code',
  'Product Name',
  'Facility Code',
  'Facility Name',
  'Facility Type',    // MW-3PL | MW-Self | Darkstore | etc. — used to split Mother WH vs Others
  'Batch Code',
  'Expiry Date',
  'Days To Expiry',
  'Qty',
  'COGS',
  'Inventory Value',
  'Expiry Bucket',    // 'Expired' | 'Critical Expiry' | 'Near Expiry'
];

// ---------------------------------------------------------------------------
// WAREHOUSE UTILIZATION — SL_MH only
// ---------------------------------------------------------------------------
const WAREHOUSE_UTILIZATION_COLUMNS = [
  'Run Date',
  'Total Bins',
  'Occupied Bins',
  'Empty Bins',
  'Utilization Pct',
];

// Granular bin-level breakdown (appended to same sheet, separate section)
const BIN_DETAIL_COLUMNS = [
  'Run Date',
  'Bin ID',
  'Row',
  'Column No',
  'Level',
  'Is Occupied',
];

// ---------------------------------------------------------------------------
// DASHBOARD SUMMARY — Single-row KPI snapshot published after each run
// ---------------------------------------------------------------------------
const DASHBOARD_SUMMARY_COLUMNS = [
  'Run Date',
  'Run Timestamp',
  'Total Inventory Value',
  'Good Inventory Value',
  'Bad Inventory Value',
  'Near Expiry Value',
  'Critical Expiry Value',
  'Expired Value',
  'Value At Risk',
  'Warehouse Utilization Pct',
  'Total SKU Count',
  'OOS SKU Count',
  'Critical SKU Count',
  'Risk SKU Count',
  'Healthy SKU Count',
  'Overstock SKU Count',
  'Total Bins',
  'Occupied Bins',
  'Empty Bins',
  'COGS Missing SKU Count',
  'Discontinued SKU Count',
  'Discontinued Inventory Value',
  'Excluded Facilities',
  'Status',
  'Notes',
];

// ---------------------------------------------------------------------------
// EMAIL SUMMARY — Log of every email sent
// ---------------------------------------------------------------------------
const EMAIL_SUMMARY_COLUMNS = [
  'Sent At',
  'Recipients',
  'Subject',
  'Status',
  'Notes',
];

// ---------------------------------------------------------------------------
// SETTINGS — Key-value configuration store
// Admin manages this via the Settings UI. Do not hardcode keys elsewhere.
// ---------------------------------------------------------------------------
const SETTINGS_COLUMNS = [
  'Setting Key',
  'Setting Value',
  'Description',
  'Last Updated',
];

// Default settings seed — written once on first setup.
const DEFAULT_SETTINGS = [
  // Email
  ['email_recipients',           '',                   'Comma-separated list of email recipients for daily summary', ''],
  ['email_sender_filter',        'noreply@e.unicommerce.com', 'Gmail sender filter to identify inventory report emails',    ''],
  ['email_subject_filter',       'Export Job Complete', 'Fallback Gmail subject keyword (used if fg/shelf specific ones are blank)', ''],
  ['fg_subject_filter',          'Export Job Complete - FG INVENTORY REPORT',            'Full subject line of the FG Inventory report email',    ''],
  ['shelf_subject_filter',       'Export Job Complete - All facility Shelfwise Inventory','Full subject line of the Shelf Inventory report email', ''],
  ['dashboard_url',              'https://your-github-pages-url.github.io', 'Public dashboard URL included in email', ''],

  // Attachment detection
  ['fg_attachment_keyword',      'FG_Inventory',       'Keyword in filename to identify FG Inventory CSV',          ''],
  ['shelf_attachment_keyword',   'Shelf_Inventory',    'Keyword in filename to identify Shelf Inventory CSV',       ''],

  // Processing schedule
  ['trigger_hour',               '9',                  'Hour (24h) to run daily processing (e.g. 9 = 09:00)',       ''],
  ['trigger_minute',             '30',                 'Minute to run daily processing (e.g. 30 = :30)',            ''],
  ['lookback_hours',             '24',                 'How many hours back to search Gmail for reports',           ''],

  // Inventory health thresholds
  ['doi_critical_threshold',     '7',                  'DOI below this = Critical bucket',                         ''],
  ['doi_risk_min',               '8',                  'DOI range min for Risk bucket',                            ''],
  ['doi_risk_max',               '30',                 'DOI range max for Risk bucket',                            ''],
  ['doi_healthy_min',            '31',                 'DOI range min for Healthy bucket',                         ''],
  ['doi_healthy_max',            '90',                 'DOI range max for Healthy bucket',                         ''],
  ['doi_overstock_threshold',    '90',                 'DOI above this = Overstock bucket',                        ''],

  // Expiry thresholds (days)
  ['near_expiry_days',           '60',                 'Products expiring within this many days = Near Expiry',     ''],
  ['critical_expiry_days',       '30',                 'Products expiring within this many days = Critical Expiry', ''],

  // Auth
  ['allowed_domains',            'yourdomain.com',     'Comma-separated list of allowed Google Workspace domains',  ''],
  ['oauth_client_id',            'YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com', 'Google OAuth 2.0 Client ID for dashboard login', ''],

  // System
  ['spreadsheet_id',             '',                   'Auto-populated: Google Sheets ID of this workbook',        ''],
  ['timezone',                   'Asia/Kolkata',       'Timezone for all date/time calculations',                  ''],
  ['data_retention_days',        '90',                 'Days of historical data to retain in raw tables',          ''],

  // Auth
  ['session_secret',             '',                   'Secret key for signing session tokens. Set a random string here.', ''],
  ['admin_token',                '',                   'Token required for ?action=settings endpoint. Set a strong random string.', ''],
];

// ---------------------------------------------------------------------------
// INVENTORY LOGIC CONSTANTS
// Cross-reference with DEFAULT_SETTINGS — settings override these at runtime.
// These are compile-time fallback defaults only.
// ---------------------------------------------------------------------------
const INVENTORY_TYPE_GOOD = 'GOOD_INVENTORY';
const INVENTORY_TYPE_BAD  = 'BAD_INVENTORY';
const BATCH_STATUS_ACTIVE = 'Active';

// Facility type detection — only 'MW-Self' = Mother Warehouse (self-operated stock buffer).
// MW-3PL, Darkstore, Self-B2B, and all other types = distribution/network facilities.
function _isMotherwh(facilityType) {
  return String(facilityType || '').trim() === 'MW-Self';
}

// The only facility eligible for bin utilisation tracking
const BIN_UTILIZATION_FACILITY = 'SL Mother Hub';

// Health bucket labels (used as keys across all modules)
const HEALTH_BUCKET = {
  OOS       : 'OOS',
  CRITICAL  : 'Critical',
  RISK      : 'Risk',
  HEALTHY   : 'Healthy',
  OVERSTOCK : 'Overstock',
};

// Expiry bucket labels
const EXPIRY_BUCKET = {
  EXPIRED  : 'Expired',
  CRITICAL : 'Critical Expiry',
  NEAR     : 'Near Expiry',
};

// COGS source labels (for audit trail)
const COGS_SOURCE = {
  MASTER   : 'COGS Master',
  FALLBACK : 'FG Fallback',
};

// ---------------------------------------------------------------------------
// COLUMN INDEX HELPERS
// Returns 0-based index for a column name in a given column array.
// Usage: COL_IDX(FG_COLUMNS, 'Stock on Hand')
// ---------------------------------------------------------------------------
function COL_IDX(columnArray, name) {
  const idx = columnArray.indexOf(name);
  if (idx === -1) throw new Error(`Column "${name}" not found in column definition.`);
  return idx;
}

// ---------------------------------------------------------------------------
// RUNTIME SETTINGS CACHE
// Loaded once per execution. Use getSetting(key) everywhere.
// ---------------------------------------------------------------------------
let _settingsCache = null;

/**
 * Returns a setting value by key.
 * Falls back to DEFAULT_SETTINGS if sheet not yet initialised.
 * @param {string} key
 * @returns {string}
 */
function getSetting(key) {
  if (!_settingsCache) {
    _settingsCache = _loadSettings();
  }
  return _settingsCache[key] !== undefined ? _settingsCache[key] : _getDefaultSetting(key);
}

function _loadSettings() {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEETS.SETTINGS);
    if (!sheet) return {};
    const data  = sheet.getDataRange().getValues();
    const cache = {};
    for (let i = 1; i < data.length; i++) {
      const [key, value] = data[i];
      if (key) cache[String(key).trim()] = String(value).trim();
    }
    return cache;
  } catch (e) {
    Logger.log('Settings load error: ' + e.message);
    return {};
  }
}

function _getDefaultSetting(key) {
  const match = DEFAULT_SETTINGS.find(row => row[0] === key);
  return match ? match[1] : '';
}

/**
 * Invalidate settings cache (call after updating settings sheet).
 */
function clearSettingsCache() {
  _settingsCache = null;
}

/**
 * Convenience: get a setting as a parsed integer.
 */
function getSettingInt(key) {
  return parseInt(getSetting(key), 10) || 0;
}
