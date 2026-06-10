// =============================================================================
// app.js — Inventory Control Tower
// App shell: routing, auth, theme, shared UI utilities.
// =============================================================================

// ---------------------------------------------------------------------------
// APP INIT
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAuth();
});

function initAuth() {
  const session = getSession();
  if (session) {
    _launchApp(session);
  } else {
    document.getElementById('auth-overlay').style.display = 'flex';
  }
}

function _launchApp(session) {
  document.getElementById('auth-overlay').style.display = 'none';
  const app = document.getElementById('app');
  app.classList.add('visible');

  // Set user chip
  const chip = document.getElementById('user-chip-name');
  if (chip) chip.textContent = session.name || session.email;
  const avatar = document.getElementById('user-avatar');
  if (avatar) avatar.textContent = (session.name || session.email || 'U')[0].toUpperCase();

  // Wire nav
  initNav();

  // Load default page
  navigateTo('overview');
}

// ---------------------------------------------------------------------------
// GOOGLE SIGN-IN CALLBACK (called by GSI library)
// ---------------------------------------------------------------------------

window.handleGoogleSignIn = async function(response) {
  const errEl = document.getElementById('auth-error');
  errEl.style.display = 'none';

  // authenticateWithGoogle is synchronous in practice (just decodes JWT)
  // but declared async so we keep await for safety
  const result = await authenticateWithGoogle(response.credential);
  if (result.success) {
    _launchApp(result.session);
  } else {
    errEl.textContent = result.error || 'Sign-in failed. Contact your administrator.';
    errEl.style.display = 'block';
  }
};

// ---------------------------------------------------------------------------
// NAVIGATION / ROUTING
// ---------------------------------------------------------------------------

const MODULES = {
  overview         : { label: 'Overview',            icon: '📊', loader: loadOverview },
  health           : { label: 'Inventory Health',    icon: '🏥', loader: loadInventoryHealth },
  expiry           : { label: 'Expiry Management',   icon: '⏳', loader: loadExpiry },
  utilization      : { label: 'Warehouse',           icon: '🏭', loader: loadUtilization },
  sku              : { label: 'SKU Deep Dive',       icon: '🔍', loader: loadSkuDeepDive },
  'mother-warehouse': { label: 'Mother Warehouse',   icon: '🏗️', loader: loadMotherWarehouse },
  settings         : { label: 'Settings',            icon: '⚙️', loader: loadSettings },
};

let _currentModule = null;

function initNav() {
  document.querySelectorAll('.nav-item[data-module]').forEach(item => {
    item.addEventListener('click', () => {
      navigateTo(item.dataset.module);
      // Close mobile nav
      document.querySelector('.nav-rail')?.classList.remove('open');
    });
  });

  // Mobile hamburger
  const hamburger = document.getElementById('mobile-menu-btn');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      document.querySelector('.nav-rail')?.classList.toggle('open');
    });
  }
}

function navigateTo(moduleKey) {
  if (!MODULES[moduleKey]) return;
  _currentModule = moduleKey;

  // Update nav active state
  document.querySelectorAll('.nav-item[data-module]').forEach(el => {
    el.classList.toggle('active', el.dataset.module === moduleKey);
  });

  // Render module
  const content = document.getElementById('content-area');
  content.innerHTML = '';
  MODULES[moduleKey].loader(content);

  // Update URL hash
  window.location.hash = moduleKey;
}

// Handle back/forward
window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1);
  if (hash && MODULES[hash]) navigateTo(hash);
});

// ---------------------------------------------------------------------------
// THEME
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem('ict_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next    = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ict_theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ---------------------------------------------------------------------------
// SHARED FORMAT UTILITIES
// ---------------------------------------------------------------------------

function formatINR(val) {
  const n = parseFloat(val) || 0;
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2) + ' Cr';
  if (n >= 100000)   return '₹' + (n / 100000).toFixed(2) + ' L';
  if (n >= 1000)     return '₹' + Math.round(n).toLocaleString('en-IN');
  return '₹' + Math.round(n);
}

function formatNum(val) {
  return (parseFloat(val) || 0).toLocaleString('en-IN');
}

function formatPct(val) {
  return (parseFloat(val) || 0).toFixed(1) + '%';
}

function formatDOI(val) {
  const n = parseFloat(val) || 0;
  if (n >= 9999) return '∞';
  return n.toFixed(1);
}

function formatDate(val) {
  if (!val) return '—';
  const d = new Date(val);
  if (isNaN(d)) return String(val);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function bucketBadge(bucket) {
  const map = {
    'OOS'      : 'badge-oos',
    'Critical' : 'badge-critical',
    'Risk'     : 'badge-risk',
    'Healthy'  : 'badge-healthy',
    'Overstock': 'badge-overstock',
  };
  const cls = map[bucket] || '';
  return `<span class="badge ${cls}">${bucket}</span>`;
}

function expiryBadge(bucket) {
  const map = {
    'Expired'       : 'badge-expired',
    'Critical Expiry': 'badge-critical',
    'Near Expiry'   : 'badge-near',
  };
  const cls = map[bucket] || '';
  return `<span class="badge ${cls}">${bucket}</span>`;
}

function facilityBadge(code, type) {
  const cls = type === 'Mother Warehouse' ? 'badge-mother' : 'badge-node';
  return `<span class="badge ${cls}">${code}</span>`;
}

// ---------------------------------------------------------------------------
// TOAST NOTIFICATIONS
// ---------------------------------------------------------------------------

function showToast(message, type = 'info', durationMs = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, durationMs);
}

// ---------------------------------------------------------------------------
// TABLE SORT
// ---------------------------------------------------------------------------

/**
 * Makes a <table> sortable by clicking headers.
 * @param {HTMLTableElement} table
 * @param {Array<{ key: string, type: 'str'|'num'|'date' }>} colDefs
 * @param {Function} renderFn  Called with (sortedData) to re-render tbody
 */
function makeSortable(table, colDefs, data, renderFn) {
  let sortCol = null, sortDir = 1;
  table.querySelectorAll('thead th').forEach((th, i) => {
    if (!colDefs[i]) return;
    th.style.cursor = 'pointer';
    th.innerHTML += ' <span class="sort-icon">⇅</span>';
    th.addEventListener('click', () => {
      if (sortCol === i) sortDir *= -1;
      else { sortCol = i; sortDir = 1; }
      table.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'));
      th.classList.add('sorted');
      th.querySelector('.sort-icon').textContent = sortDir === 1 ? '↑' : '↓';
      const sorted = [...data].sort((a, b) => {
        const def = colDefs[i];
        let va = a[def.key], vb = b[def.key];
        if (def.type === 'num') { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
        else if (def.type === 'date') { va = new Date(va); vb = new Date(vb); }
        else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
        return va < vb ? -sortDir : va > vb ? sortDir : 0;
      });
      renderFn(sorted);
    });
  });
}

// ---------------------------------------------------------------------------
// CSV / EXCEL EXPORT
// ---------------------------------------------------------------------------

/**
 * Exports a 2D array to a CSV file download.
 * @param {string[][]} rows   First row = headers
 * @param {string} filename
 */
function exportCSV(rows, filename) {
  const csv = rows.map(row =>
    row.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }).join(',')
  ).join('\n');

  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  _downloadBlob(blob, filename + '.csv');
  showToast(`Exported ${rows.length - 1} rows to ${filename}.csv`, 'success');
}

/**
 * Converts table data to a simple Excel-compatible TSV.
 */
function exportExcel(rows, filename) {
  const tsv = rows.map(row => row.map(c => String(c ?? '')).join('\t')).join('\n');
  const blob = new Blob([tsv], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  _downloadBlob(blob, filename + '.xls');
  showToast(`Exported to ${filename}.xls`, 'success');
}

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// PAGINATION HELPER
// ---------------------------------------------------------------------------

/**
 * Renders pagination controls into a container element.
 * @param {HTMLElement} container
 * @param {{ page, pageSize, totalCount, totalPages }} pagination
 * @param {Function} onPageChange  Called with new page number
 */
function renderPagination(container, pagination, onPageChange) {
  const { page, pageSize, totalCount, totalPages } = pagination;
  const start = Math.min((page - 1) * pageSize + 1, totalCount);
  const end   = Math.min(page * pageSize, totalCount);

  container.innerHTML = `
    <div class="pagination">
      <span class="pagination-info">Showing ${formatNum(start)}–${formatNum(end)} of ${formatNum(totalCount)}</span>
      <button class="page-btn" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">‹</button>
      ${_pageButtons(page, totalPages)}
      <button class="page-btn" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">›</button>
    </div>`;

  container.querySelectorAll('.page-btn[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page);
      if (!isNaN(p) && p >= 1 && p <= totalPages) onPageChange(p);
    });
  });
}

function _pageButtons(current, total) {
  const pages = [];
  const range = new Set([1, total, current - 1, current, current + 1].filter(p => p >= 1 && p <= total));
  let prev = null;
  [...range].sort((a,b) => a-b).forEach(p => {
    if (prev && p - prev > 1) pages.push('<span style="padding:0 4px;color:var(--text-muted)">…</span>');
    pages.push(`<button class="page-btn ${p === current ? 'active' : ''}" data-page="${p}">${p}</button>`);
    prev = p;
  });
  return pages.join('');
}

// ---------------------------------------------------------------------------
// LOADING / EMPTY HELPERS
// ---------------------------------------------------------------------------

function renderLoading(container, message = 'Loading data...') {
  container.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner"></div>
      <span class="loading-text">${message}</span>
    </div>`;
}

function renderEmpty(container, message = 'No data available.', icon = '📭') {
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <p>${message}</p>
    </div>`;
}

function renderError(container, message) {
  container.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">⚠️</div>
      <p style="color:var(--red)">${message}</p>
      <button class="btn btn-secondary mt-16" onclick="navigateTo('${_currentModule}')">Retry</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// CHART.JS DEFAULT CONFIG
// ---------------------------------------------------------------------------

function applyChartDefaults() {
  if (!window.Chart) return;
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  Chart.defaults.color           = isDark ? '#8b949e' : '#57606a';
  Chart.defaults.borderColor     = isDark ? '#30363d' : '#d0d7de';
  Chart.defaults.font.family     = "'Inter', sans-serif";
  Chart.defaults.font.size       = 11;
  Chart.defaults.plugins.legend.display = true;
  Chart.defaults.plugins.tooltip.backgroundColor = isDark ? '#1c2128' : '#ffffff';
  Chart.defaults.plugins.tooltip.titleColor       = isDark ? '#e6edf3' : '#1f2328';
  Chart.defaults.plugins.tooltip.bodyColor        = isDark ? '#8b949e' : '#57606a';
  Chart.defaults.plugins.tooltip.borderColor      = isDark ? '#30363d' : '#d0d7de';
  Chart.defaults.plugins.tooltip.borderWidth      = 1;
}

// Apply defaults when theme changes
const _themeObserver = new MutationObserver(applyChartDefaults);
_themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Chart colour palette
const CHART_COLORS = {
  blue   : '#58a6ff',
  green  : '#3fb950',
  red    : '#f85149',
  amber  : '#f0883e',
  purple : '#bc8cff',
  yellow : '#e3b341',
  teal   : '#39d353',
  pink   : '#ff79c6',
};
const CHART_PALETTE = Object.values(CHART_COLORS);
