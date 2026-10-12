/**
 * Local test harness.
 *
 * Spins up an isolated GROK_HOME (so your real ~/.grok is never touched) and a
 * fake billing endpoint that mimics xAI's responses — including the 401-then-
 * refresh behaviour we hit in production.
 *
 * Usage:
 *   node test/run.js            # run every scenario, print a summary
 *   node test/run.js --keep     # keep the sandbox dir for manual poking
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const gs = path.join(root, 'bin', 'gs.js');

/**
 * Prefer the node that is running this file. `node` may be an absolute path
 * (managed runtime) rather than a bare command name.
 */
const NODE = process.env.NODE_BIN || process.execPath;

const KEEP = process.argv.includes('--keep');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-test-'));

/* ------------------------------------------------------------------ */
/* Fake xAI backend                                                    */
/* ------------------------------------------------------------------ */

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
/** Each account gets its own stale token so the mock can tell them apart. */
const staleToken = (who) => `stale.${who}.token`;

/** Only freshly-minted tokens are valid; stale.* tokens are rejected with 401. */
const issued = new Map();
const isStale = (tok) => typeof tok === 'string' && tok.startsWith('stale.');

const accounts = {
  alpha: { creditUsagePercent: 83.5, weekly: 83.5, monthly: 41.2, limit: 500, used: 206 },
  beta: { creditUsagePercent: null, weekly: null, monthly: 5.0, limit: 0, used: 18 },
  gamma: { creditUsagePercent: 12.0, weekly: 12.0, monthly: 3.1, limit: 1000, used: 31 },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  // Token exchange
  if (url.pathname === '/oauth2/token' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const rt = params.get('refresh_token') || '';
      const who = rt.replace(/^refresh-/, '') || 'alpha';
      const fresh = `fresh.${who}.${Date.now()}`;
      issued.set(fresh, who);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: fresh, refresh_token: rt, expires_in: 3600 }));
    });
    return;
  }

  // Billing
  if (url.pathname === '/v1/billing') {
    const who = issued.get(token);
    if (!who || isStale(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=none, upstream=PermissionDenied, reason=no auth context)',
        })
      );
      return;
    }
    const a = accounts[who];
    const credits = url.searchParams.get('format') === 'credits';
    const payload = credits
      ? {
          config: {
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-10-11T13:37:26.239595+00:00',
              end: '2026-10-18T13:37:26.239595+00:00',
            },
            ...(a.creditUsagePercent != null ? { creditUsagePercent: a.creditUsagePercent } : {}),
            productUsage: a.creditUsagePercent != null
              ? [{ product: 'grok-build', usagePercent: a.creditUsagePercent }, { product: 'image', usagePercent: 4.0 }]
              : [],
            onDemandCap: { val: 0 },
            onDemandUsed: { val: 0 },
            prepaidBalance: { val: 0 },
            isUnifiedBillingUser: true,
            billingPeriodStart: '2026-10-11T13:37:26.239595+00:00',
            billingPeriodEnd: '2026-10-18T13:37:26.239595+00:00',
          },
        }
      : {
          config: {
            monthlyLimit: { val: a.limit },
            used: { val: a.used },
            onDemandCap: { val: 0 },
            billingPeriodStart: '2026-10-01T00:00:00+00:00',
            billingPeriodEnd: '2026-11-01T00:00:00+00:00',
            history: [],
          },
        };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404);
  res.end('{}');
});

/* ------------------------------------------------------------------ */
/* Sandbox fixtures                                                    */
/* ------------------------------------------------------------------ */

function makeAuth(account, refreshToken, { expired = true } = {}) {
  return {
    [`https://auth.x.ai::${CLIENT_ID}`]: {
      key: staleToken(account),
      refresh_token: refreshToken,
      auth_mode: 'oidc',
      user_id: `user-${account}`,
      email: `${account}@example.com`,
      first_name: account[0].toUpperCase() + account.slice(1),
      last_name: 'Tester',
      team_id: 'team-0001',
      expires_at: expired
        ? new Date(Date.now() - 86_400_000).toISOString()
        : new Date(Date.now() + 7 * 86_400_000).toISOString(),
      oidc_issuer: 'https://auth.x.ai',
      oidc_client_id: CLIENT_ID,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m✔\x1b[0m ${label}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m✖\x1b[0m ${label}${detail ? `\n      \x1b[90m${detail}\x1b[0m` : ''}`);
  }
}

/**
 * Run the CLI in the sandbox. Uses async spawn because Windows can throw
 * EBUSY when spawnSync re-enters the same node binary.
 */
function runGs(args) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [gs, ...args], {
      cwd: root,
      env: { ...process.env, GROK_HOME: sandbox },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => resolve({ status: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

async function main() {
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  const base = `http://127.0.0.1:${port}`;

  console.log(`\n\x1b[1mGrok state — local test harness\x1b[0m`);
  console.log(`  sandbox : ${sandbox}`);
  console.log(`  mock api: ${base}\n`);

  // Rewrite endpoints to the mock server for the duration of the test.
  const usagePath = path.join(root, 'src', 'usage.js');
  const original = fs.readFileSync(usagePath, 'utf8');
  const patched = original
    .replace(/const BILLING_URL = '[^']+'/, `const BILLING_URL = '${base}/v1/billing'`)
    .replace(/const TOKEN_URL = '[^']+'/, `const TOKEN_URL = '${base}/oauth2/token'`);
  fs.writeFileSync(usagePath, patched);
  const restoreUsage = () => fs.writeFileSync(usagePath, original);

  try {
    const accountsDir = path.join(sandbox, 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sandbox, 'auth.json'),
      JSON.stringify(makeAuth('alpha', 'refresh-alpha'), null, 2)
    );
    fs.writeFileSync(
      path.join(accountsDir, 'alpha_auth.json'),
      JSON.stringify(makeAuth('alpha', 'refresh-alpha'), null, 2)
    );
    fs.writeFileSync(
      path.join(accountsDir, 'beta_auth.json'),
      JSON.stringify(makeAuth('beta', 'refresh-beta'), null, 2)
    );
    fs.writeFileSync(
      path.join(accountsDir, 'gamma_auth.json'),
      JSON.stringify(makeAuth('gamma', 'refresh-gamma', { expired: false }), null, 2)
    );

    console.log('\x1b[1m1. list\x1b[0m');
    const list = await runGs(['list']);
    check('lists all three archives', ['alpha', 'beta', 'gamma'].every((n) => list.stdout.includes(n)), list.stdout);
    check('alpha marked active (matches live auth.json)', /▶.*alpha/s.test(list.stdout), list.stdout);

    console.log('\n\x1b[1m2. usage  (stale tokens -> 401 -> refresh -> 200)\x1b[0m');
    const usage = await runGs(['usage']);
    check('alpha weekly 83.5%', usage.stdout.includes('83.5%'), usage.stdout);
    check('renders a progress bar', /█+░+/.test(usage.stdout), usage.stdout);
    check('beta reports no capped allowance', usage.stdout.includes('no capped allowance'), usage.stdout);
    check('beta monthly has zero limit so no percentage', /beta[\s\S]*?monthly[^\n]*—/.test(usage.stdout), usage.stdout);
    check('gamma weekly 12.0%', usage.stdout.includes('12.0%'), usage.stdout);
    check('product breakdown shown (grok-build)', usage.stdout.includes('grok-build'), usage.stdout);

    console.log('\n\x1b[1m3. token refresh was persisted\x1b[0m');
    const alphaAfter = JSON.parse(fs.readFileSync(path.join(accountsDir, 'alpha_auth.json'), 'utf8'));
    const alphaToken = Object.values(alphaAfter)[0].key;
    check('archived token rotated off the stale value', alphaToken !== staleToken('alpha'), alphaToken);
    check('rotation preserved the refresh token', Object.values(alphaAfter)[0].refresh_token === 'refresh-alpha');

    console.log('\n\x1b[1m4. switch\x1b[0m');
    const sw = await runGs(['switch', 'beta']);
    check('switch reports success', sw.stdout.includes('beta'), sw.stdout + sw.stderr);
    const live = JSON.parse(fs.readFileSync(path.join(sandbox, 'auth.json'), 'utf8'));
    check('live auth.json now holds beta', Object.values(live)[0].email === 'beta@example.com', JSON.stringify(live));

    console.log('\n\x1b[1m5. logout  (removes live auth.json, keeps archives)\x1b[0m');
    const lo = await runGs(['logout']);
    check('logout reports signed out', lo.stdout.includes('Signed out'), lo.stdout + lo.stderr);
    check('live auth.json is gone', !fs.existsSync(path.join(sandbox, 'auth.json')));
    check('archives survive', fs.readdirSync(accountsDir).length === 3);

    console.log('\n\x1b[1m6. usage works with no live auth.json\x1b[0m');
    const usage2 = await runGs(['usage', 'gamma']);
    check('gamma still queryable after logout', usage2.stdout.includes('12.0%'), usage2.stdout);

    console.log('\n\x1b[1m7. logout -k  (backup before delete)\x1b[0m');
    await runGs(['switch', 'gamma']);
    const lo2 = await runGs(['logout', '-k', 'gamma_backup']);
    check('backup written on logout -k', fs.existsSync(path.join(accountsDir, 'gamma_backup_auth.json')), lo2.stdout + lo2.stderr);
    check('live auth.json removed again', !fs.existsSync(path.join(sandbox, 'auth.json')));

    console.log('\n\x1b[1m8. error handling\x1b[0m');
    const bad = await runGs(['switch', 'does-not-exist']);
    check('unknown account fails loudly', bad.status !== 0 && /unknown account/i.test(bad.stderr + bad.stdout), bad.stderr + bad.stdout);
    const badName = await runGs(['switch', '../../evil']);
    check('path traversal rejected', badName.status !== 0, badName.stderr);

    console.log('\n\x1b[1m9. name sanitisation\x1b[0m');
    const weird = await runGs(['switch', 'my account!!']);
    check('spaces/punctuation handled without crash', weird.status === 0 || /unknown account/i.test(weird.stderr + weird.stdout), weird.stderr + weird.stdout);

    console.log('\n\x1b[1m10. reset time formatting\x1b[0m');
    // The reset line must appear in both usage views, showing a real date
    // rather than only a relative day count.
    check('usage prints a "Resets:" line', /Resets:\s*\w+ \d{1,2}, \d{2}:\d{2}/.test(usage.stdout), usage.stdout);
    check('usage shows the weekly reset date', /October 18, \d{2}:\d{2}/.test(usage.stdout), usage.stdout);
    check('usage shows the monthly reset date', /November 1, \d{2}:\d{2}/.test(usage.stdout), usage.stdout);
    check('usage includes a countdown', /\(in \d+[dh]/.test(usage.stdout), usage.stdout);

    const listUsage = await runGs(['list', '--usage']);
    check('list --usage prints a reset line', /Resets:\s*\w+ \d{1,2}, \d{2}:\d{2}/.test(listUsage.stdout), listUsage.stdout);

    // Formatter unit checks — guards the RFC 3339 oddities xAI actually emits
    // (numeric +00:00 offset, microsecond precision, missing fields).
    const fd = await import(pathToFileURL(path.join(root, 'src', 'usage.js')).href);
    const plusOffset = '2026-10-18T13:37:26.239595+00:00';
    check('parseTimestamp accepts +00:00 offset', fd.parseTimestamp(plusOffset) != null);
    check('parseTimestamp accepts microseconds', fd.parseTimestamp(plusOffset) === Date.parse('2026-10-18T13:37:26.239Z'));
    check('parseTimestamp returns null on junk', fd.parseTimestamp('not-a-date') === null && fd.parseTimestamp(null) === null && fd.parseTimestamp('') === null);
    check('formatResetTime renders "Month D, HH:MM"', /^October 18, \d{2}:\d{2}$/.test(fd.formatResetTime(plusOffset)), fd.formatResetTime(plusOffset));
    check('formatResetTime withYear appends the year', /, 2026$/.test(fd.formatResetTime(plusOffset, { withYear: true })), fd.formatResetTime(plusOffset, { withYear: true }));
    check('formatResetTime returns null on junk', fd.formatResetTime('nope') === null);
    check('formatCountdown returns null on junk', fd.formatCountdown('nope') === null);
    check('formatCountdown reports a positive window', /^\d+d \d+h$/.test(fd.formatCountdown(plusOffset)), fd.formatCountdown(plusOffset));
    check('daysUntil floors (never overstates)', fd.daysUntil(plusOffset) === 6, String(fd.daysUntil(plusOffset)));
    check('daysUntil is 0 for a past timestamp', fd.daysUntil('2020-01-01T00:00:00Z') === 0, String(fd.daysUntil('2020-01-01T00:00:00Z')));
    check('day count never exceeds countdown', (() => {
      const d = fd.daysUntil(plusOffset);
      const cd = fd.formatCountdown(plusOffset);
      const cdDays = parseInt(cd, 10);
      return d <= cdDays;
    })(), `${fd.daysUntil(plusOffset)} vs ${fd.formatCountdown(plusOffset)}`);
  } finally {
    restoreUsage();
    server.close();
    if (!KEEP) fs.rmSync(sandbox, { recursive: true, force: true });
    else console.log(`\n  \x1b[90msandbox kept at ${sandbox}\x1b[0m`);
  }

  const total = pass + fail;
  const colour = fail === 0 ? '\x1b[32m' : '\x1b[31m';
  console.log(`\n${colour}\x1b[1m${pass}/${total} checks passed\x1b[0m\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
