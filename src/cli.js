import chalk from 'chalk';

import { listAccounts, readLiveAuth, primaryCredential, displayName, identityOf, humanExpiry, updateAccountCredential } from './accounts.js';
import { fetchUsage, bar } from './usage.js';
import { login, logout, switchTo, findGrokBinary } from './commands.js';
import { accountsDir, authJsonPath } from './paths.js';

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

function relativeDays(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  if (days <= 0) return chalk.gray('resets soon');
  return chalk.gray(`resets in ${days}d`);
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
      chalk.bold('name'.padEnd(16)) +
      chalk.bold('account'.padEnd(30)) +
      chalk.bold('token')
  );
  console.log(rule());

  for (const [i, a] of accounts.entries()) {
    const active = liveId && a.credential && identityOf(a.credential.data) === liveId;
    const marker = active ? chalk.green('▶') : chalk.gray(' ');
    const name = (active ? chalk.green.bold(a.name) : chalk.white(a.name)).padEnd(active ? 16 : 16);
    const label = (a.email ? `${a.displayName}` : chalk.gray('(no email)')).slice(0, 28).padEnd(30);
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
  for (const a of accounts) {
    if (!a.credential) {
      console.log(`  ${chalk.gray(a.name.padEnd(16))}${chalk.red('no credential')}`);
      continue;
    }
    process.stdout.write(`  ${chalk.white(a.name.padEnd(16))}`);
    try {
      const u = await fetchUsage(a.credential, {
        onTokenRefreshed: (data) => updateAccountCredential(a.name, data),
      });
      if (!u.ok) {
        console.log(chalk.red(`✖ ${u.error}`));
        continue;
      }
      const pct = u.creditUsagePercent;
      const period = u.periodType === 'weekly' ? 'wk' : u.periodType === 'monthly' ? 'mo' : '  ';
      const allowance = allowanceText(u);
      console.log(
        `${paintBar(pct)} ${paintPercent(pct).padEnd(14)} ${chalk.gray(`[${period}]`)} ${relativeDays(u.periodEnd)}` +
          (allowance ? `\n  ${' '.repeat(16)}${allowance}` : '')
      );
    } catch (err) {
      console.log(chalk.red(`✖ ${err.message}`));
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
      if (u.monthly) {
        console.log(`    monthly ${paintBar(u.monthly.creditUsagePercent)} ${paintPercent(u.monthly.creditUsagePercent)}`);
        if (allowanceText(u.monthly)) console.log(`            ${allowanceText(u.monthly)}`);
      }
      if (u.periodEnd) console.log(`    ${chalk.gray(relativeDays(u.periodEnd) + '  ·  ' + u.periodEnd)}`);
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
  const keep = argv.includes('--keep') || argv.includes('-k');
  const name = argv.find((a) => !a.startsWith('-'));
  const res = logout({ backupName: keep ? name || `backup_${Date.now()}` : null });

  console.log();
  if (!res.removed) {
    console.log(chalk.yellow('  No live auth.json — already signed out.'));
  } else {
    console.log(chalk.green('  ✔ Signed out') + chalk.gray(`  (removed ${authJsonPath()})`));
    if (res.backedUp) console.log(chalk.gray(`    archived to ${res.backedUp}`));
    else console.log(chalk.gray('    archived accounts were left untouched'));
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

function cmdHelp() {
  const CMD = 'MultiGrokState';
  console.log(`
${chalk.bold.cyan('  MultiGrokState')} ${chalk.gray('— manage multiple Grok CLI accounts')}

${chalk.bold('  Usage')}
    ${chalk.cyan(`${CMD} login <name>`)}       Run ${chalk.gray('grok login')} then snapshot auth.json → ${chalk.gray('accounts/<name>_auth.json')}
    ${chalk.cyan(`${CMD} logout`)}              Delete the live auth.json (archives untouched)
    ${chalk.cyan(`${CMD} logout -k <name>`)}   Same, but archive the live session first
    ${chalk.cyan(`${CMD} switch <name>`)}       Copy an archived account into the live auth.json
    ${chalk.cyan(`${CMD} list`)}                List archived accounts
    ${chalk.cyan(`${CMD} list --usage`)}        List accounts and fetch live quota
    ${chalk.cyan(`${CMD} usage [name...]`)}     Show weekly / monthly usage for accounts
    ${chalk.cyan(`${CMD} where`)}               Print the resolved paths

${chalk.bold('  How it works')}
    ${chalk.gray('•')} Grok keeps its session in ${chalk.white('~/.grok/auth.json')} (map of scope → tokens).
    ${chalk.gray('•')} ${chalk.cyan('login')} runs the official CLI flow, then copies that file to
      ${chalk.white('~/.grok/accounts/<name>_auth.json')} — the archive.
    ${chalk.gray('•')} ${chalk.cyan('switch')} merges an archive back into auth.json; Grok hot-reloads it.
    ${chalk.gray('•')} ${chalk.cyan('usage')} calls ${chalk.gray('cli-chat-proxy.grok.com/v1/billing')} with the
      stored token, refreshing via ${chalk.gray('auth.x.ai/oauth2/token')} when stale.

${chalk.bold('  Environment')}
    ${chalk.gray('GROK_HOME')}         override ~/.grok
    ${chalk.gray('GROK_BIN')}          path to the grok executable
`);
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
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
