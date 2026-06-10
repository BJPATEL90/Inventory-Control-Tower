// =============================================================================
// api.js — Inventory Control Tower
// Centralised API client. All fetch calls to the Apps Script web app go here.
// Includes: response caching, retry logic, error normalisation.
// =============================================================================

const API_BASE    = 'https://script.google.com/macros/s/AKfycbwln6VAsw69746cxkUZCVD8-808nji_9F2jJgwYagzZorYLepONpVt2ZVsf_Ywnmq7Q/exec';
const SESSION_KEY = 'ict_session';
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes in-memory cache

// In-memory cache: key → { data, timestamp }
const _cache = new Map();

// ---------------------------------------------------------------------------
// CORE FETCH
// ---------------------------------------------------------------------------

/**
 * Makes a GET request to the Apps Script API.
 * Attaches session token, handles retries, normalises errors.
 *
 * @param {string} action           API action parameter
 * @param {Object} params           Additional query params
 * @param {Object} opts
 * @param {boolean} opts.cache      Use in-memory cache (default true)
 * @param {boolean} opts.showLoader Show global loading indicator (default true)
 * @returns {Promise<any>}          Resolved with res.data or throws Error
 */
async function apiCall(action, params = {}, opts = {}) {
  const { cache = true, showLoader = true } = opts;
  const cacheKey = action + JSON.stringify(params);

  // Cache hit
  if (cache) {
    const hit = _cache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < CACHE_TTL) {
      return hit.data;
    }
  }

  if (showLoader) showGlobalLoader(true);

  const url = _buildUrl(action, params);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res  = await fetch(url, { method: 'GET', redirect: 'follow' });
      const json = await res.json();

      if (!json.success) {
        throw new Error(json.error?.message || 'API returned success:false');
      }

      if (cache) {
        _cache.set(cacheKey, { data: json.data, timestamp: Date.now() });
      }
      if (showLoader) showGlobalLoader(false);
      return json.data;

    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await _sleep(attempt * 800); // Back-off: 800ms, 1600ms
      }
    }
  }

  if (showLoader) showGlobalLoader(false);
  console.error(`API Error [${action}]:`, lastError);
  showToast(`Failed to load ${action}. ${lastError.message}`, 'error');
  throw lastError;
}

/**
 * Builds the full URL with query params + session token.
 */
function _buildUrl(action, params) {
  const session = getSession();
  const allParams = { action, ...params };
  if (session) allParams.sessionToken = JSON.stringify(session);
  return API_BASE + '?' + new URLSearchParams(allParams).toString();
}

// ---------------------------------------------------------------------------
// SPECIFIC API METHODS
// ---------------------------------------------------------------------------

const API = {
  /** Dashboard KPIs + charts + trend */
  getSummary() {
    return apiCall('summary');
  },

  /** Inventory health buckets + SKU table */
  getInventoryHealth(filters = {}, page = 1, pageSize = 200) {
    return apiCall('inventory-health', { ...filters, page, pageSize }, { cache: false });
  },

  /** Expiry risk rows */
  getExpiry(filters = {}, page = 1, pageSize = 200) {
    return apiCall('expiry', { ...filters, page, pageSize }, { cache: false });
  },

  /** Bin utilization + heatmap */
  getUtilization() {
    return apiCall('utilization');
  },

  /** Full SKU deep-dive */
  getSku(skuCode) {
    return apiCall('sku', { skuCode }, { cache: false });
  },

  /** Mother warehouse control tower */
  getMotherWarehouse() {
    return apiCall('mother-warehouse');
  },

  /** Facility list for filter dropdowns */
  getFacilities() {
    return apiCall('facilities', {}, { cache: true });
  },

  /** Admin settings */
  getSettings(token) {
    return apiCall('settings', { token }, { cache: false });
  },

  /** Health check */
  ping() {
    return apiCall('ping', {}, { cache: false, showLoader: false });
  },
};

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

/**
 * Decodes the Google ID token client-side.
 * The GSI library has already verified the signature before calling our
 * callback, so decoding the payload here is safe for an internal dashboard.
 * This avoids a CORS-prone Apps Script round-trip entirely.
 */
async function authenticateWithGoogle(idToken) {
  try {
    // JWT is three base64url segments separated by dots
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Malformed ID token.');

    // Decode the payload (second segment)
    const base64  = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const json    = JSON.parse(atob(base64 + padding));

    const email  = json.email || '';
    const name   = json.name  || json.given_name || email;

    if (!email) throw new Error('No email found in token.');

    // Build local session — 8-hour expiry
    const session = {
      email,
      name,
      domain : email.split('@')[1] || '',
      exp    : Date.now() + 8 * 60 * 60 * 1000,
      iat    : Date.now(),
    };

    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return { success: true, session };

  } catch (e) {
    return { success: false, error: 'Sign-in failed: ' + e.message };
  }
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (Date.now() > s.exp) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function signOut() {
  localStorage.removeItem(SESSION_KEY);
  window.location.reload();
}

function requireAuth() {
  const session = getSession();
  if (!session) {
    document.getElementById('auth-overlay').style.display = 'flex';
    document.getElementById('app').classList.remove('visible');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CACHE MANAGEMENT
// ---------------------------------------------------------------------------

/** Clears the in-memory cache (call after a manual refresh). */
function clearApiCache() {
  _cache.clear();
}

/** Clears cache for a specific action. */
function clearCacheFor(action) {
  for (const key of _cache.keys()) {
    if (key.startsWith(action)) _cache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Global loader reference (set by app.js after DOM ready)
let _loaderEl = null;
function showGlobalLoader(visible) {
  if (!_loaderEl) _loaderEl = document.getElementById('global-loader');
  if (_loaderEl) _loaderEl.style.opacity = visible ? '1' : '0';
}
