import { spawn } from 'node:child_process';

import chalk from 'chalk';

import { listAccounts, readLiveAuth, primaryCredential, displayName, identityOf, humanExpiry, updateAccountCredential } from './accounts.js';
import { fetchUsage, bar, formatResetTime, formatCountdown, daysUntil, parseTimestamp } from './usage.js';
import { login, logout, switchTo, findGrokBinary } from './commands.js';
import { accountsDir, authJsonPath } from './paths.js';
import { ROOT, REPO, BRANCH, checkForUpdate, cachedUpdateNotice, shortSha } from './version.js';

const STATUS_STYLE = {
  valid: (s) => chalk.green(s),
  expiring: (s) => chalk.yellow(s),
  expired: (s) => chalk.red(s),
  unknown: (s) => chalk.gray(s),
  invalid: (s) => chalk.red(s),
};

function statusChip(state) {
  const paint = STATUS_STYLE[state] || chalk.gray;
  return paint(`● ${state}`);
}

/**
 * Terminal display width of a string.
 *
 * Counts ANSI escapes as zero (chalk wraps text in them) and CJK/wide
 * glyphs as two cells, which `.length` does not. Without this, a name like
 * "鋒兄" misaligns every column to its right.
 */
function displayWidth(text) {
  const stripped = text.replace(/\u001b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
      (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd); // CJK ext. B+
    width += wide ? 2 : 1;
  }
  return width;
}

/** Pad a (possibly colourised) string to a terminal display width. */
function padVisible(text, width) {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Truncate to a display width, never splitting an ANSI escape sequence. */
function truncateVisible(text, width) {
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const ch of text.replace(/\u001b\[[0-9;]*m/g, '')) {
    const w = displayWidth(ch);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/**
 * The "account" column. The email is the field that actually distinguishes
 * two archives, so it leads; the profile name is only appended when it adds
 * information (it often can't — see displayName()).
 */
function accountLabel(a, width = 30) {
  if (!a.email) {
    const fallback = a.displayName && a.displayName !== a.name ? a.displayName : '(no email)';
    return padVisible(chalk.gray(truncateVisible(fallback, width)), width);
  }

  const name = a.displayName && a.displayName !== a.email ? a.displayName : null;
  const withName = name ? `${a.email}  ${name}` : a.email;

  // Prefer "email  name"; fall back to the bare email so the distinguishing
  // field is never the thing that gets cut off.
  const text =
    name && displayWidth(withName) <= width
      ? `${chalk.white(a.email)}  ${chalk.gray(name)}`
      : chalk.white(truncateVisible(a.email, width));

  return padVisible(text, width);
}

/** Colour a usage percentage by how close it is to the cap. */
function paintPercent(pct) {
  if (pct == null) return chalk.gray('—');
  const text = `${pct.toFixed(1)}%`;
  if (pct >= 90) return chalk.red(text);
  if (pct >= 70) return chalk.yellow(text);
  return chalk.green(text);
}

function paintBar(pct) {
  if (pct == null) return chalk.gray('░'.repeat(20));
  const p = Number(pct) || 0;
  const glyphs = bar(p, 20);
  if (p >= 90) return chalk.red(glyphs);
  if (p >= 70) return chalk.yellow(glyphs);
  return chalk.green(glyphs);
}

/** "18 / 500" style allowance summary, or a hint when the plan has no cap. */
function allowanceText(u) {
  if (u.limit == null && u.used == null) return '';
  const used = u.used ?? 0;
  if (u.limit == null || u.limit === 0) {
    return chalk.gray(`used ${used} · no capped allowance on this plan`);
  }
  return chalk.gray(`${used} / ${u.limit}`);
}

function rule(label) {
  const width = 62;
  if (!label) return chalk.gray('─'.repeat(width));
  const head = ` ${label} `;
  return chalk.gray(head + '─'.repeat(Math.max(0, width - head.length - 1)));
}

/** "resets in 6d" — kept for the compact table view. */
function relativeDays(iso) {
  const cd = formatCountdown(iso);
  if (cd == null) return '';
  if (cd === 'now') return chalk.red('resets now');
  // Collapse the countdown to its coarse unit so the column stays narrow
  // and never disagrees with the full "Resets:" line beneath it.
  const d = daysUntil(iso);
  if (d != null && d >= 1) return chalk.gray(`resets in ${d}d`);
  return chalk.gray(`resets in ${cd}`);
}

/**
 * "Resets: October 18, 21:37 (in 6d 3h)" — the full reset line.
 * Colour shifts to yellow/red as the reset approaches, so an imminent
 * rollover is obvious at a glance.
 */
function resetLine(value, { label = 'Resets' } = {}) {
  if (parseTimestamp(value) == null) return null;
  const when = formatResetTime(value, { withYear: true });
  const countdown = formatCountdown(value);
  const days = daysUntil(value);

  const head = chalk.gray(`${label}:`);
  const paint = days != null && days <= 0 ? chalk.red : days != null && days <= 1 ? chalk.yellow : chalk.white;
  const absolute = paint(when);
  const rel = countdown && countdown !== 'now' ? chalk.gray(` (in ${countdown})`) : chalk.red(' (imminent)');
  return `${head} ${absolute}${rel}`;
}

/* ------------------------------------------------------------------ */

async function cmdList(argv) {
  const live = Boolean(argv.includes('--usage') || argv.includes('-u'));
  const accounts = listAccounts();

  if (!accounts.length) {
    console.log();
    console.log(chalk.yellow('  No accounts archived yet.'));
    console.log(chalk.gray(`  Archive directory: ${accountsDir()}`));
    console.log(chalk.gray('  Run: ') + chalk.cyan('gs login <name>'));
    console.log();
    return;
  }

  const liveAuth = readLiveAuth();
  const liveId = liveAuth ? identityOf(primaryCredential(liveAuth)?.data || {}) : null;

  console.log();
  console.log(chalk.bold.cyan('  Grok accounts') + chalk.gray(`  (${accounts.length})`));
  console.log(rule());
  console.log(
    '  ' +
      chalk.gray('#  ') +
      padVisible(chalk.bold('name'), 16) +
      padVisible(chalk.bold('account'), 30) +
      chalk.bold('token')
  );
  console.log(rule());

  for (const [i, a] of accounts.entries()) {
    const active = liveId && a.credential && identityOf(a.credential.data) === liveId;
    const marker = active ? chalk.green('▶') : chalk.gray(' ');
    const name = padVisible(active ? chalk.green.bold(a.name) : chalk.white(a.name), 16);
    const label = accountLabel(a);
    const expiry = a.expiresAt ? chalk.gray(humanExpiry(a.expiresAt)) : '';
    console.log(`  ${marker} ${chalk.gray(String(i + 1).padStart(2))} ${name}${label}${statusChip(a.status)} ${expiry}`);
  }

  console.log(rule());
  console.log(chalk.gray(`  live: ${authJsonPath()}`));
  console.log();

  if (live) await printUsageTable(accounts);
}

async function printUsageTable(accounts) {
  console.log(rule('live usage'));
  // Widen the name gutter if any name would overflow it.
  const gutter = Math.max(16, ...accounts.map((a) => a.name.length + 2));
  // Usage rows are indented under the account column, past the name gutter.
  const indent = ' '.repeat(2 + gutter);
  for (const a of accounts) {
    if (!a.credential) {
      console.log(`  ${chalk.gray(a.name.padEnd(gutter))}${chalk.red('no credential')}`);
      continue;
    }
    // Name + email on one line: the email is what tells two archives of the
    // same person apart.
    console.log(`  ${chalk.bold.white(a.name.padEnd(gutter))}${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.credential, {
        onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
      });
      if (!u.ok) {
        console.log(`${indent}${chalk.red(`✖ ${u.error}`)}`);
        continue;
      }
      const pct = u.creditUsagePercent;
      const period = u.periodType === 'weekly' ? 'wk' : u.periodType === 'monthly' ? 'mo' : '  ';
      const allowance = allowanceText(u);
      console.log(
        `${indent}${paintBar(pct)} ${paintPercent(pct).padEnd(14)} ${chalk.gray(`[${period}]`)} ${relativeDays(u.periodEnd)}`
      );
      if (allowance) console.log(`${indent}${' '.repeat(21)}${allowance}`);
      const reset = resetLine(u.periodEnd);
      if (reset) console.log(`${indent}${' '.repeat(21)}${reset}`);
    } catch (err) {
      console.log(`${indent}${chalk.red(`✖ ${err.message}`)}`);
    }
  }
  console.log(rule());
  console.log();
}

async function cmdUsage(argv) {
  const only = argv.filter((a) => !a.startsWith('-'));
  const all = listAccounts();
  const accounts = only.length ? all.filter((a) => only.includes(a.name)) : all;

  if (!accounts.length) {
    console.log();
    console.log(chalk.yellow('  Nothing to show. Archive an account first with ') + chalk.cyan('gs login <name>'));
    console.log();
    return;
  }

  console.log();
  console.log(chalk.bold.cyan('  Usage & quota'));
  console.log(rule());

  for (const a of accounts) {
    if (!a.credential) {
      console.log(`  ${chalk.white(a.name)} ${chalk.red('— no credential')}`);
      continue;
    }
    console.log(`  ${chalk.bold.white(a.name)} ${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.credential, {
        onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
      });
      if (!u.ok) {
        console.log(`    ${chalk.red('✖ ' + u.error)}`);
        console.log();
        continue;
      }
      console.log(`    weekly  ${paintBar(u.creditUsagePercent)} ${paintPercent(u.creditUsagePercent)}`);
      if (allowanceText(u)) console.log(`            ${allowanceText(u)}`);
      const weeklyReset = resetLine(u.periodEnd);
      if (weeklyReset) console.log(`            ${weeklyReset}`);
      if (u.monthly) {
        console.log(`    monthly ${paintBar(u.monthly.creditUsagePercent)} ${paintPercent(u.monthly.creditUsagePercent)}`);
        if (allowanceText(u.monthly)) console.log(`            ${allowanceText(u.monthly)}`);
        const monthlyReset = resetLine(u.monthly.periodEnd);
        if (monthlyReset) console.log(`            ${monthlyReset}`);
      }
      for (const [product, pct] of Object.entries(u.productUsage || {})) {
        console.log(`    ${chalk.gray(product.padEnd(14))} ${paintPercent(pct)}`);
      }
      if (u.prepaidBalance != null) {
        console.log(`    ${chalk.gray('prepaid balance')} ${chalk.white(u.prepaidBalance)}`);
      }
      if (u.creditUsagePercent == null) {
        console.log(`    ${chalk.gray('plan reports no capped credit allowance')}`);
      }
    } catch (err) {
      console.log(`    ${chalk.red('✖ ' + err.message)}`);
    }
    console.log();
  }
  console.log(rule());
  console.log();
}

async function cmdLogin(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  console.log();
  console.log(chalk.cyan('  Opening Grok CLI login…'));
  console.log(chalk.gray(`  binary: ${findGrokBinary()}`));
  console.log();

  const res = await login(name);
  console.log();
  console.log(chalk.green(`  ✔ Saved account `) + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.data)} <${res.data.email || 'no email'}>`));
  console.log(chalk.gray(`    → ${res.file}`));
  console.log();
}

function cmdLogout(argv) {
  const force = argv.includes('--force') || argv.includes('-f');
  const name = argv.find((a) => !a.startsWith('-'));
  const res = logout({ name, force });

  console.log();
  if (!res.removed) {
    console.log(chalk.yellow('  No live auth.json — already signed out.'));
    if (res.removedLock) console.log(chalk.gray('    removed a stale auth.json.lock'));
  } else {
    console.log(chalk.green('  ✔ Signed out') + chalk.gray(`  (removed ${authJsonPath()})`));
    if (res.removedLock) console.log(chalk.gray(`    removed ${authJsonPath()}.lock`));
    if (res.backedUp) {
      console.log(
        chalk.gray('    archived to ') +
          chalk.white(res.backedUp) +
          (res.email ? chalk.gray(`  <${res.email}>`) : '')
      );
    } else if (res.kept) {
      console.log(chalk.gray(`    ${res.name}_auth.json already existed — left as-is (use -f to overwrite)`));
    } else {
      console.log(chalk.yellow('    no email in the live session — nothing to archive under'));
    }
  }
  console.log();
}

function cmdSwitch(argv) {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) throw new Error('usage: gs switch <name>');
  const res = switchTo(name);
  console.log();
  console.log(chalk.green('  ✔ Active account: ') + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.data)} <${res.data.email || 'no email'}>`));
  console.log(chalk.gray('    Grok picks this up on the next request (hot-reload).'));
  console.log();
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

/**
 * Pull the latest source and re-link the global command.
 * Shared by `update` (foreground, streamed) and the passive notice path.
 */
function runUpdate({ quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', ROOT, 'pull', '--ff-only'], {
      stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    });
    let stderr = '';
    if (quiet) child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr }));
  });
}

async function cmdUpdate(argv) {
  const checkOnly = argv.includes('--check') || argv.includes('-c');

  console.log();
  console.log(chalk.bold.cyan('  Checking for updates…'));
  console.log(chalk.gray(`  repo ${REPO} (${BRANCH})  ·  ${ROOT}`));
  console.log();

  const status = await checkForUpdate();
  if (!status.ok) {
    console.log(chalk.yellow(`  Could not check for updates: ${status.reason}`));
    if (status.current) console.log(chalk.gray(`  local ${shortSha(status.current)}`));
    console.log();
    return;
  }

  if (!status.behind) {
    console.log(chalk.green('  ✔ Already up to date') + chalk.gray(`  (${shortSha(status.current)})`));
    console.log();
    return;
  }

  console.log(chalk.yellow('  ↑ Update available'));
  console.log(chalk.gray('    local  ') + chalk.white(shortSha(status.current)));
  console.log(chalk.gray('    remote ') + chalk.white(shortSha(status.latest)));
  console.log();

  if (checkOnly) {
    console.log(chalk.gray('  Run ') + chalk.cyan('MultiGrokState update') + chalk.gray(' to install it.'));
    console.log();
    return;
  }

  console.log(chalk.gray('  Pulling latest source…'));
  console.log();
  const pull = await runUpdate();
  if (!pull.ok) {
    console.log(chalk.red(`  ✖ git pull failed${pull.error ? `: ${pull.error}` : ''}`));
    console.log(chalk.gray('    The source check out is dirty, diverged, or offline.'));
    console.log(chalk.gray(`    You can also re-run the installer to refresh ${ROOT}.`));
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(chalk.gray('  Re-linking the global command…'));
  const link = await new Promise((resolve) => {
    const child = spawn('npm', ['link', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });

  console.log();
  console.log(chalk.green('  ✔ Updated to ') + chalk.bold.white(shortSha(status.latest)));
  if (!link.ok) {
    console.log(chalk.yellow('    npm link failed — the source is updated, but the global command may be stale.'));
  }
  console.log();
}

/**
 * One-line nudge shown after normal commands when a newer commit exists.
 * Populated asynchronously by the background check; flushed on exit so it
 * never delays the command the user actually ran.
 */
function updateNoticeLine() {
  const notice = globalThis.__gsUpdateNotice;
  if (!notice) return null;
  return '  ' + chalk.gray('↑ update available ') + chalk.cyan('MultiGrokState update') + chalk.gray(`  (${shortSha(notice.latest)})`);
}

/** Print the pending notice (if any) once, on the way out. */
export function flushUpdateNotice() {
  if (globalThis.__gsUpdateNoticeShown) return;
  const notice = updateNoticeLine();
  if (!notice) return;
  globalThis.__gsUpdateNoticeShown = true;
  console.log();
  console.log(notice);
  console.log();
}

function cmdHelp() {
  const CMD = 'MultiGrokState';
  console.log(`
${chalk.bold.cyan('  MultiGrokState')} ${chalk.gray('— manage multiple Grok CLI accounts')}

${chalk.bold('  Usage')}
    ${chalk.cyan(`${CMD} login [name]`)}       Run ${chalk.gray('grok login')} then snapshot auth.json → ${chalk.gray('accounts/<name>_auth.json')}
    ${chalk.cyan(`${CMD} logout`)}              Archive auth.json as ${chalk.gray('accounts/<email>_auth.json')}, then delete it
    ${chalk.cyan(`${CMD} logout <name>`)}       Same, but archive under an explicit name
    ${chalk.cyan(`${CMD} logout -f`)}           Overwrite an existing archive instead of keeping it
    ${chalk.cyan(`${CMD} switch <name>`)}       Copy an archived account into the live auth.json
    ${chalk.cyan(`${CMD} list`)}                List archived accounts
    ${chalk.cyan(`${CMD} list --usage`)}        List accounts and fetch live quota
    ${chalk.cyan(`${CMD} usage [name...]`)}     Show weekly / monthly usage, reset time & quota
    ${chalk.cyan(`${CMD} update`)}              Check GitHub and pull the latest version
    ${chalk.cyan(`${CMD} update --check`)}      Only report whether an update is available
    ${chalk.cyan(`${CMD} where`)}               Print the resolved paths

${chalk.bold('  Usage output')}
    Each window shows a bar, a percentage, an allowance total, and when it
    rolls over, e.g. ${chalk.white('Resets: October 18, 21:37, 2026 (in 6d 2h)')}
    (local time; the countdown turns yellow inside a day, red once due).

${chalk.bold('  How it works')}
    ${chalk.gray('•')} Grok keeps its session in ${chalk.white('~/.grok/auth.json')} (map of scope → tokens).
    ${chalk.gray('•')} ${chalk.cyan('login')} runs the official CLI flow, then copies that file to
      ${chalk.white('~/.grok/accounts/<name>_auth.json')} — the archive.
    ${chalk.gray('•')} ${chalk.cyan('logout')} copies that file to ${chalk.white('accounts/<email>_auth.json')}
      first, then deletes ${chalk.white('auth.json')} + ${chalk.white('auth.json.lock')}.
    ${chalk.gray('•')} ${chalk.cyan('switch')} merges an archive back into auth.json; Grok hot-reloads it.
    ${chalk.gray('•')} ${chalk.cyan('usage')} calls ${chalk.gray('cli-chat-proxy.grok.com/v1/billing')} with the
      stored token, refreshing via ${chalk.gray('auth.x.ai/oauth2/token')} when stale.

${chalk.bold('  Environment')}
    ${chalk.gray('GROK_HOME')}         override ~/.grok
    ${chalk.gray('GROK_BIN')}          path to the grok executable
    ${chalk.gray('GROK_NO_UPDATE_CHECK=1')}  disable the background update check
`);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;

  // Suppress the background check when the user is already managing updates
  // directly, or has opted out.
  const wantsNotice =
    process.env.GROK_NO_UPDATE_CHECK !== '1' && cmd !== 'update' && cmd !== 'upgrade';

  if (wantsNotice) {
    // Never let a slow network stall the real command: give the check a short
    // grace period, then print whatever the cache already knows.
    const check = cachedUpdateNotice()
      .then((notice) => {
        if (notice) globalThis.__gsUpdateNotice = notice;
      })
      .catch(() => {});
    // Fire-and-forget; the notice is flushed at process exit by the entry point.
    check.finally(() => flushUpdateNotice());
  }

  switch (cmd) {
    case 'login':
    case 'add':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout(rest);
    case 'switch':
    case 'use':
      return cmdSwitch(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'usage':
      return cmdUsage(rest);
    case 'update':
    case 'upgrade':
      return cmdUpdate(rest);
    case 'where':
      console.log();
      console.log(chalk.gray('  grok home   ') + chalk.white(authJsonPath()));
      console.log(chalk.gray('  archives    ') + chalk.white(accountsDir()));
      console.log(chalk.gray('  grok binary ') + chalk.white(findGrokBinary()));
      console.log();
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default:
      console.log(chalk.yellow(`  Unknown command "${cmd}"`));
      return cmdHelp();
  }
}
