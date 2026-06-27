// =============================================================================
// Auth.gs — Inventory Control Tower
// Google Sign-In authentication for the GitHub Pages dashboard.
//
// Flow:
//   1. Dashboard loads → checks localStorage for valid session token
//   2. If no token → shows Google Sign-In button
//   3. User signs in → Google ID token sent to Apps Script ?action=auth&idToken=...
//   4. Apps Script verifies token via Google tokeninfo endpoint
//   5. Checks email domain against allowed_domains setting
//   6. Returns a signed session object { email, name, exp, sig }
//   7. Dashboard stores session in localStorage, attaches to all API calls
//   8. All API endpoints call verifySession() before returning data
//
// Setup:
//   - Create OAuth 2.0 Client ID in Google Cloud Console (Web Application type)
//   - Add your GitHub Pages URL to "Authorised JavaScript origins"
//   - Paste the Client ID into tbl_settings → oauth_client_id
// =============================================================================

// ---------------------------------------------------------------------------
// AUTH ENDPOINT — called via doGet ?action=auth
// ---------------------------------------------------------------------------

/**
 * Verifies a Google ID token sent from the dashboard.
 * Returns a session object on success, error on failure.
 * Called from API.gs doGet router when action=auth.
 *
 * @param {Object} params  e.parameter from doGet
 * @returns {Object}
 */
function apiAuth(params) {
  const idToken = (params.idToken || '').trim();
  if (!idToken) return { success: false, error: 'idToken parameter is required.' };

  try {
    // Verify token with Google
    const userInfo = _verifyGoogleIdToken(idToken);
    if (!userInfo) return { success: false, error: 'Invalid or expired Google ID token.' };

    // Check domain allowlist
    const domainCheck = _checkAllowedDomain(userInfo.email);
    if (!domainCheck.allowed) {
      return {
        success: false,
        error  : `Access denied. Domain "${domainCheck.domain}" is not authorised. Contact your administrator.`,
      };
    }

    // Build session token
    const session = _buildSession(userInfo);
    Logger.log(`Auth: Successful login — ${userInfo.email}`);

    return { success: true, session };

  } catch (e) {
    Logger.log('Auth error: ' + e.message);
    return { success: false, error: 'Authentication failed. Please try again.' };
  }
}

/**
 * Verifies a session token on subsequent API calls.
 * Returns { valid: true, email, name } or { valid: false, reason }.
 *
 * @param {string} sessionToken  JSON string from localStorage
 * @returns {{ valid: boolean, email?: string, name?: string, reason?: string }}
 */
function verifySession(sessionToken) {
  if (!sessionToken) return { valid: false, reason: 'No session token.' };

  try {
    const session = JSON.parse(sessionToken);

    // Check expiry
    if (Date.now() > session.exp) {
      return { valid: false, reason: 'Session expired. Please sign in again.' };
    }

    // Verify signature
    if (!_verifySessionSignature(session)) {
      return { valid: false, reason: 'Invalid session signature.' };
    }

    // Re-check domain (in case allowed_domains changed)
    const domainCheck = _checkAllowedDomain(session.email);
    if (!domainCheck.allowed) {
      return { valid: false, reason: 'Domain no longer authorised.' };
    }

    return { valid: true, email: session.email, name: session.name };

  } catch (e) {
    return { valid: false, reason: 'Malformed session token.' };
  }
}

// ---------------------------------------------------------------------------
// GOOGLE TOKEN VERIFICATION
// ---------------------------------------------------------------------------

/**
 * Calls Google's tokeninfo endpoint to verify an ID token.
 * Returns user info object or null on failure.
 *
 * @param {string} idToken
 * @returns {{ email: string, name: string, sub: string } | null}
 */
function _verifyGoogleIdToken(idToken) {
  const url      = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code     = response.getResponseCode();

  if (code !== 200) {
    Logger.log(`Token verification failed: HTTP ${code} — ${response.getContentText()}`);
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log('Token parse error: ' + e.message);
    return null;
  }

  // Verify audience matches our OAuth Client ID
  const expectedClientId = getSetting('oauth_client_id');
  if (expectedClientId && payload.aud !== expectedClientId) {
    Logger.log(`Token audience mismatch. Expected: ${expectedClientId}, Got: ${payload.aud}`);
    return null;
  }

  // Verify token not expired (Google also checks this, but belt-and-suspenders)
  const exp = parseInt(payload.exp, 10) * 1000;
  if (Date.now() > exp) {
    Logger.log('Token expired at: ' + new Date(exp).toISOString());
    return null;
  }

  return {
    email  : payload.email         || '',
    name   : payload.name          || payload.email || '',
    sub    : payload.sub           || '',
    picture: payload.picture       || '',
  };
}

// ---------------------------------------------------------------------------
// DOMAIN ALLOWLIST
// ---------------------------------------------------------------------------

/**
 * Checks if an email's domain is in the allowed_domains setting.
 * allowed_domains is a comma-separated list, e.g. "company.com, partner.org"
 *
 * @param {string} email
 * @returns {{ allowed: boolean, domain: string }}
 */
function _checkAllowedDomain(email) {
  const domain          = (email || '').split('@')[1] || '';
  const allowedRaw      = getSetting('allowed_domains') || '';
  const allowedDomains  = allowedRaw
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);

  // If no domains configured, allow all (useful during initial setup)
  if (allowedDomains.length === 0) {
    Logger.log('WARNING: No allowed_domains configured — allowing all domains.');
    return { allowed: true, domain };
  }

  const allowed = allowedDomains.includes(domain.toLowerCase());
  if (!allowed) Logger.log(`Domain check failed: "${domain}" not in [${allowedDomains.join(', ')}]`);

  return { allowed, domain };
}

// ---------------------------------------------------------------------------
// SESSION TOKEN
// ---------------------------------------------------------------------------

/**
 * Builds a signed session object.
 * Sessions expire after 8 hours (configurable).
 *
 * The "signature" is an HMAC-style hash using a server-side secret.
 * This prevents clients from forging session tokens.
 *
 * @param {{ email, name, sub }} userInfo
 * @returns {Object} session
 */
function _buildSession(userInfo) {
  const sessionHours = 8;
  const exp          = Date.now() + sessionHours * 60 * 60 * 1000;

  const session = {
    email : userInfo.email,
    name  : userInfo.name,
    sub   : userInfo.sub,
    exp   : exp,
    iat   : Date.now(),
  };

  session.sig = _signSession(session);
  return session;
}

/**
 * Creates a deterministic signature for a session object.
 * Uses a secret derived from the spreadsheet ID (always available, never changes).
 * For production: set a dedicated 'session_secret' in tbl_settings.
 */
function _signSession(session) {
  const secret  = getSetting('session_secret') || SPREADSHEET_ID;
  const payload = `${session.email}|${session.exp}|${session.iat}|${session.sub}`;
  const digest  = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    payload + secret
  );
  // Convert byte array to hex string
  return digest.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

/**
 * Verifies a session's signature matches what we would have produced.
 */
function _verifySessionSignature(session) {
  const expected = _signSession({
    email: session.email,
    exp  : session.exp,
    iat  : session.iat,
    sub  : session.sub,
  });
  return expected === session.sig;
}

// ---------------------------------------------------------------------------
// AUTH ACTION — wired into API.gs doGet router
// ---------------------------------------------------------------------------
// Add this case to the switch in API.gs doGet:
//
//   case 'auth':
//     data = apiAuth(params);
//     break;
//
// This is intentionally kept as a comment here rather than modifying API.gs,
// so the auth case can be added when you're ready to enable it.
// The apiAuth() function is already callable from API.gs since all .gs files
// share the same script scope.

// ---------------------------------------------------------------------------
// ADMIN: List recent auth attempts (from email summary logs)
// ---------------------------------------------------------------------------

/**
 * Returns the last 50 email log entries for audit purposes.
 * Called from the Settings page.
 */
function getRecentAuthLog() {
  const rows = readSheetAsObjects(SHEETS.EMAIL_SUMMARY);
  return rows.slice(-50).reverse().map(r => ({
    sentAt    : r['Sent At'],
    recipients: r['Recipients'],
    status    : r['Status'],
    notes     : r['Notes'],
  }));
}

// ---------------------------------------------------------------------------
// FRONTEND SNIPPET
// ---------------------------------------------------------------------------
// The following is the Google Sign-In integration code for index.html.
// Copy this into your <head> and <body> sections.
//
// Replace YOUR_OAUTH_CLIENT_ID with the value from tbl_settings.
//
/*

<!-- In <head> -->
<script src="https://accounts.google.com/gsi/client" async defer></script>

<!-- In <body>, where you want the sign-in button -->
<div id="auth-overlay" style="display:none;">
  <div class="auth-card">
    <h2>Inventory Control Tower</h2>
    <p>Sign in with your company Google account to continue.</p>
    <div id="g_id_onload"
         data-client_id="YOUR_OAUTH_CLIENT_ID"
         data-callback="handleGoogleSignIn"
         data-auto_prompt="true">
    </div>
    <div class="g_id_signin"
         data-type="standard"
         data-size="large"
         data-theme="outline"
         data-text="sign_in_with"
         data-shape="rectangular"
         data-logo_alignment="left">
    </div>
    <p id="auth-error" style="color:red;display:none;"></p>
  </div>
</div>

<!-- In your JS (api.js or app.js) -->
<script>
const API_BASE = 'https://script.google.com/macros/s/AKfycbwln6VAsw69746cxkUZCVD8-808nji_9F2jJgwYagzZorYLepONpVt2ZVsf_Ywnmq7Q/exec';
const SESSION_KEY = 'ict_session';

function handleGoogleSignIn(response) {
  const idToken = response.credential;
  fetch(`${API_BASE}?action=auth&idToken=${encodeURIComponent(idToken)}`)
    .then(r => r.json())
    .then(res => {
      if (res.data && res.data.success) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(res.data.session));
        document.getElementById('auth-overlay').style.display = 'none';
        initDashboard(); // your main init function
      } else {
        const errEl = document.getElementById('auth-error');
        errEl.textContent = (res.data && res.data.error) || 'Sign-in failed.';
        errEl.style.display = 'block';
      }
    })
    .catch(err => console.error('Auth error:', err));
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    if (Date.now() > session.exp) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch (e) { return null; }
}

function requireAuth() {
  const session = getSession();
  if (!session) {
    document.getElementById('auth-overlay').style.display = 'flex';
    return false;
  }
  return true;
}

// Attach session token to every API call
function apiCall(action, extraParams = {}) {
  const session = getSession();
  const params  = new URLSearchParams({ action, ...extraParams });
  if (session) params.set('sessionToken', JSON.stringify(session));
  return fetch(`${API_BASE}?${params.toString()}`).then(r => r.json());
}
</script>

*/