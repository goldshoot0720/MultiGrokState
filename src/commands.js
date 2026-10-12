import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readLiveAuth,
  primaryCredential,
  listCredentials,
  identityOf,
  displayName,
  expiresAt,
  writeAccount,
  listAccounts,
  isActive,
  authJsonPath,
} from './accounts.js';
import { grokHome, accountFilePath, sanitizeName } from './paths.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Locate the Grok CLI binary. */
export function findGrokBinary() {
  if (process.env.GROK_BIN) return process.env.GROK_BIN;
  const candidates = [
    path.join(grokHome(), 'bin', 'grok.exe'),
    path.join(grokHome(), 'bin', 'grok'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'grok', 'grok.exe'),
    '/usr/local/bin/grok',
    '/opt/homebrew/bin/grok',
    path.join(process.env.HOME || '', '.local', 'bin', 'grok'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'grok'; // fall back to PATH lookup
}

/**
 * Run `grok login` so the CLI performs its normal browser OAuth flow.
 * stderr stays attached to the terminal so the user sees the URL / progress.
 */
export function runGrokLogin() {
  const bin = findGrokBinary();
  return new Promise((resolve) => {
    const child = spawn(bin, ['login'], { stdio: ['inherit', 'inherit', 'inherit'], shell: false });
    child.on('error', (err) => resolve({ code: -1, error: err.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1 }));
  });
}

/**
 * /login — run the browser login, then snapshot the result into
 * accounts/<name>_auth.json.
 */
export async function login(name, { quiet = false } = {}) {
  const before = readLiveAuth();
  const beforeId = before ? identityOf(primaryCredential(before)?.data || {}) : null;

  const result = await runGrokLogin();
  if (result.error) throw new Error(`could not start Grok CLI: ${result.error}`);
  if (result.code !== 0) throw new Error(`grok login exited with code ${result.code}`);

  const after = readLiveAuth();
  if (!after) throw new Error(`login finished but ${authJsonPath()} was not written`);

  const cred = primaryCredential(after);
  if (!cred) throw new Error('auth.json contains no credential');

  const identity = identityOf(cred.data);
  const resolvedName = name || cred.data.email?.split('@')[0] || identity.slice(0, 8);

  if (beforeId && beforeId === identity && !name) {
    // Re-login of the same account — still snapshot, but say so.
    if (!quiet) console.log(`Re-authenticated ${displayName(cred.data)}`);
  }

  const file = writeAccount(resolvedName, after);
  return { name: resolvedName, file, data: cred.data, identity };
}

/**
 * Resolve the *identity* of the live session, which is not simply
 * `primaryCredential().email` — auth.json is a map and previous `switch`
 * calls leave other identities behind. The entry Grok actually uses is the
 * one whose access token is freshest, so that is the entry we name the
 * archive after.
 *
 * Returns { auth, cred, email, name } or null when nothing usable exists.
 */
export function resolveLiveIdentity(auth) {
  if (!auth) return null;
  const creds = listCredentials(auth);
  if (!creds.length) return null;

  const newest = creds
    .slice()
    .sort((a, b) => (expiresAt(b.data) ?? 0) - (expiresAt(a.data) ?? 0))[0];
  const cred = newest.data.email ? newest : primaryCredential(auth) || newest;

  const email = cred.data.email || null;
  // "goldshoot0720@gmail.com" → "goldshoot0720", sanitised for the filesystem.
  const localPart = email ? email.split('@')[0] : '';
  const name = sanitizeName(localPart) || sanitizeName(identityOf(cred.data)) || null;

  return { auth, cred, email, name };
}

/**
 * /logout — archive the live session, then remove `auth.json` (and the
 * `auth.json.lock` Grok leaves beside it) so the CLI returns to signed-out.
 *
 * The archive is named after the account's *email* — `goldshoot0720_auth.json`
 * — because that is the field that distinguishes two identities, and it keeps
 * `login` and `logout` writing the same filename. Pass `name` to override.
 *
 * Existing archives are never overwritten unless `force` is set.
 */
export function logout({ name, force = false } = {}) {
  const file = authJsonPath();
  const lock = `${file}.lock`;

  if (!fs.existsSync(file)) {
    removeLock(lock);
    return { removed: false, removedLock: false, backedUp: null, name: null, kept: false };
  }

  const resolved = resolveLiveIdentity(readLiveAuth());
  const target = sanitizeName(name) || resolved?.name || null;

  let backedUp = null;
  let kept = false;

  if (target) {
    const dest = accountFilePath(target);
    if (fs.existsSync(dest) && !force) {
      // Already archived — don't clobber an untouched copy with a session
      // whose tokens may be older (or already rotated).
      kept = true;
    } else {
      backedUp = writeAccount(target, resolved.auth);
    }
  }

  fs.rmSync(file, { force: true });
  const removedLock = removeLock(lock);

  return { removed: true, removedLock, backedUp, name: target, email: resolved?.email || null, kept };
}

/** Drop Grok's advisory lock file if it is still around. */
function removeLock(lock) {
  if (!fs.existsSync(lock)) return false;
  fs.rmSync(lock, { force: true });
  return true;
}

/**
 * /switch — write an archived account into the live auth.json.
 * Grok hot-reloads this file, so running sessions pick it up.
 */
export function switchTo(name) {
  const accounts = listAccounts();
  const target = accounts.find((a) => a.name === name);
  if (!target) {
    const available = accounts.map((a) => a.name).join(', ') || '(none)';
    throw new Error(`unknown account "${name}". Available: ${available}`);
  }
  if (!target.credential) throw new Error(`account "${name}" has no usable credential`);

  const auth = JSON.parse(fs.readFileSync(target.file, 'utf8'));
  const live = readLiveAuth();

  // Preserve other identities already present in auth.json; only swap the
  // archived identity, so unrelated sessions aren't clobbered.
  const merged = { ...(live || {}), ...auth };

  fs.mkdirSync(path.dirname(authJsonPath()), { recursive: true });
  const tmp = `${authJsonPath()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, authJsonPath());
  try {
    fs.chmodSync(authJsonPath(), 0o600);
  } catch {
    /* best effort */
  }

  return { name, file: authJsonPath(), data: target.credential.data };
}

export { isActive, projectRoot };
