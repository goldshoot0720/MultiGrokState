import fs from 'node:fs';
import path from 'node:path';

import { authJsonPath, accountsDir, accountFilePath, accountNameFromFile } from './paths.js';

/**
 * Grok's auth.json is a map keyed by a scope string:
 *   { "https://auth.x.ai::<client_id>": { key, refresh_token, email, user_id, expires_at, ... } }
 *
 * Everything below treats that structure as authoritative and never assumes
 * there is exactly one entry.
 */

export function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

/** Atomic + owner-only write, mirroring how the Grok CLI persists tokens. */
export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort — chmod is a no-op on some Windows setups */
  }
}

/**
 * Pull the credential entries out of an auth.json payload.
 * Returns [{ scopeKey, data }] — one per signed-in identity.
 */
export function listCredentials(auth) {
  if (!auth || typeof auth !== 'object') return [];
  return Object.entries(auth)
    .filter(([, v]) => v && typeof v === 'object' && (v.key || v.refresh_token))
    .map(([scopeKey, data]) => ({ scopeKey, data }));
}

/** The credential Grok would actually use: first one carrying an email. */
export function primaryCredential(auth) {
  const creds = listCredentials(auth);
  return creds.find((c) => c.data.email) || creds[0] || null;
}

/** Decode a JWT payload without verifying the signature (we only read claims). */
export function jwtClaims(token) {
  if (!token || typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

/** Expiry instant for a credential, or null if unknown. */
export function expiresAt(data) {
  if (data.expires_at) {
    const t = Date.parse(String(data.expires_at).replace(/Z$/, '+00:00'));
    if (!Number.isNaN(t)) return t;
  }
  const claims = jwtClaims(data.key);
  if (claims.exp) return claims.exp * 1000;
  return null;
}

export function tokenStatus(data, skewSeconds = 120) {
  const exp = expiresAt(data);
  if (exp == null) return { state: 'unknown', expiresAt: null };
  if (Date.now() >= exp - skewSeconds * 1000) {
    return { state: exp < Date.now() ? 'expired' : 'expiring', expiresAt: exp };
  }
  return { state: 'valid', expiresAt: exp };
}

export function humanExpiry(exp) {
  if (!exp) return 'unknown';
  const secs = Math.round((exp - Date.now()) / 1000);
  if (secs < 0) {
    const m = Math.round(-secs / 60);
    return m < 60 ? `expired ${m}m ago` : `expired ${Math.round(m / 60)}h ago`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

export function identityOf(data) {
  return data.user_id || data.principal_id || (data.email ? data.email.toLowerCase() : '') || 'unknown';
}

/**
 * Best-effort human name from the profile fields.
 *
 * xAI frequently stores the *same* string in both first_name and last_name
 * (e.g. both "鋒兄"), which would otherwise render as "鋒兄 鋒兄". Collapse
 * identical halves and fall back to the email rather than returning a
 * duplicated label.
 */
export function displayName(data) {
  const first = (data.first_name || '').trim();
  const last = (data.last_name || '').trim();

  let name = '';
  if (first && last) {
    name = first === last ? first : `${first} ${last}`;
  } else {
    name = first || last;
  }

  return name || data.email || identityOf(data);
}

/* ------------------------------------------------------------------ */
/* Account archive                                                     */
/* ------------------------------------------------------------------ */

export function readLiveAuth() {
  const file = authJsonPath();
  if (!fs.existsSync(file)) return null;
  return readJsonFile(file);
}

/** All archived accounts, newest metadata first, sorted by name. */
export function listAccounts() {
  const dir = accountsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('_auth.json'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const name = accountNameFromFile(file);
      try {
        const auth = readJsonFile(file);
        const cred = primaryCredential(auth);
        const st = cred ? tokenStatus(cred.data) : { state: 'unknown', expiresAt: null };
        return {
          name,
          file,
          email: cred?.data.email || null,
          displayName: cred ? displayName(cred.data) : name,
          status: st.state,
          expiresAt: st.expiresAt,
          credential: cred,
        };
      } catch (err) {
        return { name, file, email: null, status: 'invalid', error: err.message, credential: null };
      }
    });
}

export function readAccount(name) {
  const file = accountFilePath(name);
  if (!fs.existsSync(file)) return null;
  return { name, file, auth: readJsonFile(file) };
}

export function writeAccount(name, auth) {
  const file = accountFilePath(name);
  writeJsonFile(file, auth);
  return file;
}

/**
 * Replace the credential entry inside an archived account, preserving the
 * scope key and any sibling entries. Used when a token is refreshed.
 */
export function updateAccountCredential(name, data) {
  const acc = readAccount(name);
  if (!acc) return null;
  const auth = { ...acc.auth };
  const scopeKey = Object.keys(auth).find((k) => auth[k] && typeof auth[k] === 'object');
  if (!scopeKey) return null;
  auth[scopeKey] = { ...auth[scopeKey], ...data };
  writeJsonFile(acc.file, auth);
  return acc.file;
}

export function deleteAccount(name) {
  const file = accountFilePath(name);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** True when the live auth.json holds the same identity as the named archive. */
export function isActive(name) {
  const live = readLiveAuth();
  const acc = readAccount(name);
  if (!live || !acc) return false;
  const liveId = primaryCredential(live)?.data;
  const accCred = primaryCredential(acc.auth)?.data;
  if (!liveId || !accCred) return false;
  return identityOf(liveId) === identityOf(accCred);
}

export { authJsonPath, accountsDir, accountFilePath };
