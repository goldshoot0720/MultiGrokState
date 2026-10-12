import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  readLiveAuth,
  primaryCredential,
  identityOf,
  displayName,
  writeAccount,
  listAccounts,
  isActive,
  authJsonPath,
} from './accounts.js';
import { grokHome } from './paths.js';

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
 * /logout — remove the live auth.json so Grok returns to signed-out state.
 * Archives are left untouched (that's the whole point of this tool).
 */
export function logout({ backupName } = {}) {
  const file = authJsonPath();
  if (!fs.existsSync(file)) return { removed: false };

  let backedUp = null;
  if (backupName) {
    const auth = readLiveAuth();
    if (auth) backedUp = writeAccount(backupName, auth);
  }

  fs.rmSync(file, { force: true });
  return { removed: true, backedUp };
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
