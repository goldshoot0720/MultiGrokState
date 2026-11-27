import { spawn } from 'node:child_process';

import chalk from 'chalk';

import { listAccounts, readLiveAuth, primaryCredential, displayName, identityOf, humanExpiry, updateAccountCredential } from './accounts.js';
import { fetchUsage, bar, formatResetTime, formatCountdown, daysUntil, parseTimestamp } from './usage.js';
import { login, logout, switchTo, findGrokBinary } from './commands.js';
import { accountsDir, authJsonPath } from './paths.js';
import { ROOT, REPO, BRANCH, checkForUpdate, cachedUpdateNotice, syncToRemote, revisionInfo, formatRevision } from './version.js';

if (process.env.NO_COLOR && process.env.FORCE_COLOR == null) chalk.level = 0;

const accent = chalk.level >= 2 ? chalk.hex('#78cfc6') : chalk.cyan;

function statusChip(state) {
  return state === 'valid' ? chalk.gray(state) : chalk.bold(state);
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

function paintPercent(pct) {
  return pct == null ? chalk.gray('—') : chalk.bold(`${pct.toFixed(1)}%`);
}

function paintBar(pct) {
  const glyphs = bar(pct, 20);
  return glyphs.replace(/█+/, (fill) => accent(fill))
    .replace(/░+/, (track) => chalk.gray(track));
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

function rule(label = '') {
  const width = Math.min(76, process.stdout.columns || 76);
  const start = label ? `  ${chalk.bold(label)}  ` : '  ';
  return start + chalk.gray('─'.repeat(Math.max(0, width - displayWidth(start) - 2)));
}

function heading(title) {
  console.log(`\n  ${accent('>_')} ${chalk.bold('MultiGrokState')} ${chalk.gray('/')} ${chalk.bold(title)}`);
  console.log(rule());
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
  const json = argv.includes('--json');
  const live = Boolean(argv.includes('--usage') || argv.includes('-u'));
  const accounts = listAccounts();

  if (json) {
    const liveAuth = readLiveAuth();
    const liveId = liveAuth ? identityOf(primaryCredential(liveAuth)?.data || {}) : null;
    const out = accounts.map((a) => ({
      name: a.name,
      email: a.email,
      displayName: a.displayName,
      status: a.status,
      expiresAt: a.expiresAt,
      isActive: Boolean(liveId && a.credential && identityOf(a.credential.data) === liveId),
    }));
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  heading('Account archive');
  if (!accounts.length) {
    console.log('  No accounts archived yet.');
    console.log(chalk.gray(`  Archive directory: ${accountsDir()}`));
    console.log(chalk.gray('  Run: ') + accent('MultiGrokState login'));
    console.log();
    return;
  }

  const liveAuth = readLiveAuth();
  const liveId = liveAuth ? identityOf(primaryCredential(liveAuth)?.data || {}) : null;

  const nameWidth = Math.max(12, ...accounts.map((a) => displayWidth(a.name) + 2));
  const numberWidth = String(accounts.length).length;
  const compact = process.stdout.isTTY && process.stdout.columns < Math.max(76, nameWidth + numberWidth + 58);
  console.log(`  ${chalk.bold(`${accounts.length} archived`)}\n`);
  if (!compact) {
    console.log('    ' + padVisible(chalk.gray('#'), numberWidth + 2) +
      padVisible(chalk.gray('name'), nameWidth) + padVisible(chalk.gray('account'), 31) + chalk.gray('token'));
  }

  for (const [i, a] of accounts.entries()) {
    const active = liveId && a.credential && identityOf(a.credential.data) === liveId;
    const marker = active ? accent('▶') : ' ';
    const name = active ? accent.bold(a.name) : chalk.bold(a.name);
    const index = chalk.gray(String(i + 1).padStart(numberWidth));
    const expiry = a.expiresAt ? chalk.gray(humanExpiry(a.expiresAt)) : '';
    const token = `${statusChip(a.status)} ${expiry}`.trimEnd();
    if (compact) {
      console.log(`  ${marker} ${index}  ${name}\n       ${a.email || a.displayName || '(no email)'}\n       ${token}`);
    } else {
      console.log(`  ${marker} ${index}  ${padVisible(name, nameWidth)}${accountLabel(a)} ${token}`);
    }
  }

  console.log(rule());
  console.log(chalk.gray(`  live: ${authJsonPath()}`));
  console.log();

  if (live) await printUsageTable(accounts);
}

async function printUsageTable(accounts) {
  console.log(rule('Live usage'));
  const indent = '    ';
  for (const a of accounts) {
    if (!a.credential) {
      console.log(`  ${chalk.bold(a.name)}  ${chalk.bold('no credential')}`);
      continue;
    }
    console.log(`  ${chalk.bold(a.name)}  ${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.credential, {
        onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
      });
      if (!u.ok) {
        console.log(`${indent}${chalk.red(`✖ ${u.error}`)}`);
        continue;
      }
      // Match `usage`: a plan with no reported allowance renders 0%, not blank.
      const pct = u.creditUsagePercent ?? (u.noCapReported ? 0 : null);
      const period = u.periodType === 'weekly' ? 'wk' : u.periodType === 'monthly' ? 'mo' : '  ';
      const allowance = allowanceText(u);
      console.log(
        `${indent}${paintBar(pct)} ${padVisible(paintPercent(pct), 7)} ${chalk.gray(`[${period}]`)} ${relativeDays(u.periodEnd)}`
      );
      if (allowance) console.log(`${indent}${allowance}`);
      const reset = resetLine(u.periodEnd);
      if (reset) console.log(`${indent}${reset}`);
    } catch (err) {
      console.log(`${indent}${chalk.red(`✖ ${err.message}`)}`);
    }
  }
  console.log(rule());
  console.log();
}

async function cmdUsage(argv) {
  const json = argv.includes('--json');
  const only = argv.filter((a) => !a.startsWith('-'));
  const all = listAccounts();
  const accounts = only.length ? all.filter((a) => only.includes(a.name)) : all;

  if (json) {
    const out = [];
    for (const a of accounts) {
      if (!a.credential) {
        out.push({ name: a.name, email: a.email, ok: false, error: 'no credential' });
        continue;
      }
      try {
        const u = await fetchUsage(a.credential, {
          onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
        });
        out.push({
          name: a.name,
          email: a.email,
          ok: u.ok,
          creditUsagePercent: u.creditUsagePercent,
          limit: u.limit,
          used: u.used,
          periodType: u.periodType,
          periodEnd: u.periodEnd,
          monthly: u.monthly
            ? {
                creditUsagePercent: u.monthly.creditUsagePercent,
                limit: u.monthly.limit,
                used: u.monthly.used,
                periodEnd: u.monthly.periodEnd,
              }
            : null,
          productUsage: u.productUsage,
          prepaidBalance: u.prepaidBalance,
          noCapReported: u.noCapReported,
          error: u.ok ? null : u.error,
        });
      } catch (err) {
        out.push({ name: a.name, email: a.email, ok: false, error: err.message });
      }
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  heading('Usage & quota');
  if (!accounts.length) {
    console.log('  Nothing to show. Archive an account first with ' + accent('MultiGrokState login'));
    console.log();
    return;
  }

  for (const a of accounts) {
    if (!a.credential) {
      console.log(`  ${chalk.white(a.name)} ${chalk.red('— no credential')}`);
      continue;
    }
    console.log(`  ${accent('│')} ${chalk.bold(a.name)}  ${chalk.gray(a.email || '')}`);
    try {
      const u = await fetchUsage(a.credential, {
        onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
      });
      if (!u.ok) {
        console.log(`    ${chalk.red('✖ ' + u.error)}`);
        console.log();
        continue;
      }
      // A plan with no reported allowance (common on SuperGrok weekly) still
      // renders a bar at 0%, the way the Grok CLI does, rather than a blank.
      const weeklyPct = u.creditUsagePercent ?? (u.noCapReported ? 0 : null);
      console.log(`    ${chalk.bold('weekly')}  ${paintBar(weeklyPct)} ${paintPercent(weeklyPct)}`);
      if (allowanceText(u)) console.log(`            ${allowanceText(u)}`);
      const weeklyReset = resetLine(u.periodEnd);
      if (weeklyReset) console.log(`            ${weeklyReset}`);
      if (u.monthly) {
        const monthlyPct = u.monthly.creditUsagePercent ?? (u.monthly.noCapReported ? 0 : null);
        console.log(`    ${chalk.bold('monthly')} ${paintBar(monthlyPct)} ${paintPercent(monthlyPct)}`);
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
      if (u.noCapReported) {
        console.log(`    ${chalk.gray('plan reports no usage for this window (bar shown at 0%)')}`);
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
  heading('Login');
  console.log('  Opening Grok CLI login…');
  console.log(chalk.gray(`  binary: ${findGrokBinary()}`));
  console.log();

  const res = await login(name);
  console.log();
  console.log(accent(`  ✔ Saved account `) + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.data)} <${res.data.email || 'no email'}>`));
  console.log(chalk.gray(`    → ${res.file}`));
  console.log();
}

function cmdLogout(argv) {
  const force = argv.includes('--force') || argv.includes('-f');
  const name = argv.find((a) => !a.startsWith('-'));
  const res = logout({ name, force });

  heading('Logout');
  if (!res.removed) {
    console.log(chalk.yellow('  No live auth.json — already signed out.'));
    if (res.removedLock) console.log(chalk.gray('    removed a stale auth.json.lock'));
  } else {
    console.log(accent('  ✔ Signed out') + chalk.gray(`  (removed ${authJsonPath()})`));
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
  if (!name) throw new Error('usage: MultiGrokState switch <name>');
  const res = switchTo(name);
  heading('Switch');
  console.log(accent('  ✔ Active account: ') + chalk.bold.white(res.name));
  console.log(chalk.gray(`    ${displayName(res.data)} <${res.data.email || 'no email'}>`));
  console.log(chalk.gray('    Grok picks this up on the next request (hot-reload).'));
  console.log();
}

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

async function cmdUpdate(argv) {
  const checkOnly = argv.includes('--check') || argv.includes('-c');

  console.log();
  console.log(accent.bold('  Checking for updates…'));
  console.log(chalk.gray(`  repo ${REPO} (${BRANCH})  ·  ${ROOT}`));
  console.log();

  const status = await checkForUpdate();
  if (!status.ok) {
    console.log(chalk.yellow(`  Could not check for updates: ${status.reason}`));
    if (status.current) console.log(chalk.gray(`  local ${formatRevision(status.current, status.currentInfo)}`));
    console.log();
    return;
  }

  if (!status.behind) {
    console.log(accent('  ✔ Already up to date') + chalk.gray(`  ${formatRevision(status.current, status.currentInfo)}`));
    console.log();
    return;
  }

  console.log(chalk.yellow('  ↑ Update available'));
  console.log(chalk.gray('    local  ') + chalk.white(formatRevision(status.current, status.currentInfo)));
  console.log(chalk.gray('    remote ') + chalk.white(formatRevision(status.latest, status.latestInfo)));
  console.log();

  if (checkOnly) {
    console.log(chalk.gray('  Run ') + chalk.cyan('MultiGrokState update') + chalk.gray(' to install it.'));
    console.log();
    return;
  }

  console.log(chalk.gray('  Syncing to the latest commit…'));
  console.log();
  const pull = await syncToRemote({ quiet: false, targetSha: status.latest });
  if (!pull.ok) {
    if (pull.dirty) {
      console.log(chalk.red('  ✖ Local changes would be overwritten.'));
      console.log(chalk.gray(`    Commit or discard them in ${ROOT}, then retry.`));
    } else {
      console.log(chalk.red(`  ✖ Update failed${pull.error ? `: ${pull.error}` : ''}`));
      console.log(chalk.gray(`    The checkout may be offline, or ${ROOT} may not be a git clone.`));
      console.log(chalk.gray(`    Re-running the installer will also refresh it.`));
    }
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
  console.log(accent('  ✔ Updated to ') + chalk.bold.white(formatRevision(pull.sha, await revisionInfo(pull.sha))));
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
  return '  ' + chalk.gray('↑ update available ') + chalk.cyan('MultiGrokState update') + chalk.gray(`  ${formatRevision(notice.latest, notice.latestInfo)}`);
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
  heading('Command guide');
  const groups = [
    ['Accounts', [
      ['login [name]', 'Open Grok login and archive the session'],
      ['logout [name] [-f]', 'Archive and sign out (-f replaces an existing archive)'],
      ['switch <name>', 'Activate an archived session'],
      ['list', 'Show saved accounts and token status'],
    ]],
    ['Quota', [
      ['list --usage', 'List accounts with live quota'],
      ['usage [name...]', 'Show weekly and monthly usage, allowances and reset times'],
    ]],
    ['Maintenance', [
      ['where', 'Show the resolved paths'],
      ['update --check', 'Check for a newer version'],
      ['update', 'Install the latest version'],
    ]],
  ];
  console.log(`  ${chalk.bold('MultiGrokState')} ${accent('<command>')} ${chalk.gray('[options]')}\n`);
  for (const [section, commands] of groups) {
    console.log(rule(section));
    for (const [command, description] of commands) {
      console.log(`    ${padVisible(accent(command), 22)}${description}`);
    }
    console.log();
  }
  console.log(rule('Output & environment'));
  console.log('    Add --json to list, usage or where for machine-readable output.');
  console.log(`    ${chalk.gray('GROK_HOME')} sets the session directory. ${chalk.gray('GROK_BIN')} selects the Grok executable.`);
  console.log(`    ${chalk.gray('GROK_NO_UPDATE_CHECK=1')} skips background update checks.\n`);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;

  // Suppress the background check when the user is already managing updates
  // directly, has opted out, or asked for machine-readable output — a stray
  // notice line would corrupt the JSON stream.
  const wantsNotice =
    process.env.GROK_NO_UPDATE_CHECK !== '1' &&
    cmd !== 'update' &&
    cmd !== 'upgrade' &&
    !argv.includes('--json');

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
      if (argv.includes('--json')) {
        process.stdout.write(
          JSON.stringify(
            {
              grokHome: authJsonPath(),
              archives: accountsDir(),
              grokBinary: findGrokBinary(),
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      heading('Paths');
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
