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
const gs = path.join(root, 'bin', 'multigrokstate.js');

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
  // Real xAI profiles often store the same string in first_name and
  // last_name; `list` must show the email, not "鋒兄 鋒兄".
  delta: { creditUsagePercent: 50.0, weekly: 50.0, monthly: 10.0, limit: 200, used: 100 },
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

function makeAuth(account, refreshToken, { expired = true, profile } = {}) {
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
      ...(profile || {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Test runner                                                         */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

/** Mock-server URLs, filled in by main() once the port is known. */
let MOCK_ENDPOINTS = {};

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
 *
 * Endpoints are injected through `MOCK_ENDPOINTS` (set in main) as env vars
 * — never by rewriting src/usage.js, which could leave the source corrupted
 * if the process was killed before its restore ran.
 */
function runGs(args, endpoints = MOCK_ENDPOINTS) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [gs, ...args], {
      cwd: root,
      env: { ...process.env, GROK_HOME: sandbox, ...endpoints },
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

  // Point the CLI at the mock server through env vars. The source file is
  // never modified, so a crashed or concurrent run cannot corrupt it.
  MOCK_ENDPOINTS = {
    GROK_BILLING_URL: `${base}/v1/billing`,
    GROK_TOKEN_URL: `${base}/oauth2/token`,
  };

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
    // Same string in both name fields — the duplicate-name regression case.
    fs.writeFileSync(
      path.join(accountsDir, 'delta_auth.json'),
      JSON.stringify(
        makeAuth('delta', 'refresh-delta', {
          profile: { first_name: '鋒兄', last_name: '鋒兄', email: 'goldshoot0720@gmail.com' },
        }),
        null,
        2
      )
    );

    console.log('\x1b[1m1. list\x1b[0m');
    const list = await runGs(['list']);
    check('lists every archive', ['alpha', 'beta', 'gamma', 'delta'].every((n) => list.stdout.includes(n)), list.stdout);
    check('alpha marked active (matches live auth.json)', /▶.*alpha/s.test(list.stdout), list.stdout);

    // The account column must show the email — it is what distinguishes two
    // archives belonging to the same person.
    check('list shows the account email', list.stdout.includes('alpha@example.com'), list.stdout);
    check('every account shows an email', (() => {
      const expected = {
        alpha: 'alpha@example.com',
        beta: 'beta@example.com',
        gamma: 'gamma@example.com',
        delta: 'goldshoot0720@gmail.com',
      };
      return Object.entries(expected).every(([name, mail]) => {
        // The name and its email must appear on the same row.
        const row = list.stdout.split('\n').find((l) => l.includes(name));
        return row && row.includes(mail);
      });
    })(), list.stdout);
    check('column header names the email field', /account/.test(list.stdout), list.stdout);

    // A profile with first_name === last_name must not render "鋒兄 鋒兄".
    check('duplicate first/last name is collapsed', !list.stdout.includes('鋒兄 鋒兄'), list.stdout);
    check('duplicate-name account still shows its email', list.stdout.includes('goldshoot0720@gmail.com'), list.stdout);

    console.log('\n\x1b[1m2. usage  (stale tokens -> 401 -> refresh -> 200)\x1b[0m');
    const usage = await runGs(['usage']);
    check('alpha weekly 83.5%', usage.stdout.includes('83.5%'), usage.stdout);
    check('renders a progress bar', /█+░+/.test(usage.stdout), usage.stdout);
    check('beta reports no capped allowance', usage.stdout.includes('no capped allowance'), usage.stdout);
    // A plan with no reported usage renders 0%, matching the Grok CLI panel,
    // rather than a blank em-dash.
    check('beta weekly with no data still shows 0.0%', /beta[\s\S]*?weekly[^\n]*0\.0%/.test(usage.stdout), usage.stdout);
    check('beta monthly with zero limit shows 0.0%', /beta[\s\S]*?monthly[^\n]*0\.0%/.test(usage.stdout), usage.stdout);
    check('no-cap plan says the bar is a placeholder', usage.stdout.includes('bar shown at 0%'), usage.stdout);
    check('gamma weekly 12.0%', usage.stdout.includes('12.0%'), usage.stdout);
    check('product breakdown shown (grok-build)', usage.stdout.includes('grok-build'), usage.stdout);

    console.log('\n\x1b[1m2b. --json output  (consumed by the desktop GUI)\x1b[0m');
    const listJson = await runGs(['list', '--json']);
    let listData = [];
    let listParsed = false;
    try {
      listData = JSON.parse(listJson.stdout);
      listParsed = Array.isArray(listData);
    } catch {
      listParsed = false;
    }
    check('list --json is valid JSON', listParsed, listJson.stdout);
    check('list --json returns every archive', listData.length === 4, listJson.stdout);
    check(
      'list --json marks exactly the active account',
      listData.filter((a) => a.isActive).map((a) => a.name).join() === 'alpha',
      listJson.stdout
    );
    check(
      'list --json carries email + token status',
      listData.every((a) => 'email' in a && 'status' in a && 'displayName' in a),
      listJson.stdout
    );

    const usageJson = await runGs(['usage', '--json']);
    let usageData = [];
    try {
      usageData = JSON.parse(usageJson.stdout);
    } catch {
      usageData = [];
    }
    check('usage --json is valid JSON', Array.isArray(usageData) && usageData.length === 4, usageJson.stdout);
    const alphaU = usageData.find((u) => u.name === 'alpha') || {};
    check('usage --json reports alpha weekly 83.5', alphaU.ok === true && alphaU.creditUsagePercent === 83.5, JSON.stringify(alphaU));
    check(
      'usage --json carries the monthly window',
      alphaU.monthly && alphaU.monthly.limit === 500 && alphaU.monthly.used === 206,
      JSON.stringify(alphaU.monthly)
    );
    check('usage --json derives the monthly percent', alphaU.monthly && Math.abs(alphaU.monthly.creditUsagePercent - 41.2) < 0.001, JSON.stringify(alphaU.monthly));
    check('usage --json carries productUsage', alphaU.productUsage && alphaU.productUsage['grok-build'] === 83.5, JSON.stringify(alphaU.productUsage));
    check('usage --json carries the weekly reset', alphaU.periodEnd === '2026-10-18T13:37:26.239595+00:00', String(alphaU.periodEnd));
    const betaU = usageData.find((u) => u.name === 'beta') || {};
    check('usage --json flags a no-cap window', betaU.noCapReported === true, JSON.stringify(betaU));
    check('usage --json surfaces per-account errors', usageData.every((u) => 'ok' in u && 'error' in u), usageJson.stdout);

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

    console.log('\n\x1b[1m5. logout  (archives by email, then removes auth.json + lock)\x1b[0m');
    fs.writeFileSync(path.join(sandbox, 'auth.json.lock'), '{"pid":1234}');
    const lo = await runGs(['logout']);
    check('logout reports signed out', lo.stdout.includes('Signed out'), lo.stdout + lo.stderr);
    check('live auth.json is gone', !fs.existsSync(path.join(sandbox, 'auth.json')));
    check('auth.json.lock is gone', !fs.existsSync(path.join(sandbox, 'auth.json.lock')));
    check(
      'live session archived under its email',
      fs.existsSync(path.join(accountsDir, 'beta_auth.json')),
      lo.stdout + lo.stderr
    );
    check('logout names the archive it wrote', lo.stdout.includes('beta_auth.json'), lo.stdout + lo.stderr);
    check('logout still lists the archives', (() => {
      const listAfter = fs.readdirSync(accountsDir);
      return ['alpha', 'beta', 'gamma', 'delta'].every((n) => listAfter.includes(`${n}_auth.json`));
    })(), lo.stdout);

    console.log('\n\x1b[1m6. usage works with no live auth.json\x1b[0m');
    const usage2 = await runGs(['usage', 'gamma']);
    check('gamma still queryable after logout', usage2.stdout.includes('12.0%'), usage2.stdout);

    console.log('\n\x1b[1m7. logout  (explicit name, never clobbers an archive)\x1b[0m');
    await runGs(['switch', 'gamma']);
    // Pre-existing archive that must survive untouched without -f.
    const gammaFile = path.join(accountsDir, 'gamma_auth.json');
    const gammaBefore = fs.readFileSync(gammaFile, 'utf8');
    const lo2 = await runGs(['logout']);
    check('existing archive is kept, not overwritten', fs.readFileSync(gammaFile, 'utf8') === gammaBefore);
    check('logout says the archive already existed', /already existed/i.test(lo2.stdout), lo2.stdout + lo2.stderr);
    check('live auth.json removed again', !fs.existsSync(path.join(sandbox, 'auth.json')));

    await runGs(['switch', 'gamma']);
    const lo3 = await runGs(['logout', '-f']);
    check('-f overwrites the existing archive', lo3.stdout.includes('archived to'), lo3.stdout);

    await runGs(['switch', 'beta']);
    const lo4 = await runGs(['logout', 'renamed']);
    check('explicit name wins over the email', fs.existsSync(path.join(accountsDir, 'renamed_auth.json')), lo4.stdout);

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
    // 6d 2h ahead of "now", so the countdown / day-count assertions hold
    // whenever the suite runs instead of only before the fixture date.
    const future = new Date(Date.now() + 6 * 86_400_000 + 2 * 3_600_000).toISOString();
    check('parseTimestamp accepts +00:00 offset', fd.parseTimestamp(plusOffset) != null);
    check('parseTimestamp accepts microseconds', fd.parseTimestamp(plusOffset) === Date.parse('2026-10-18T13:37:26.239Z'));
    check('parseTimestamp returns null on junk', fd.parseTimestamp('not-a-date') === null && fd.parseTimestamp(null) === null && fd.parseTimestamp('') === null);
    check('formatResetTime renders "Month D, HH:MM"', /^October 18, \d{2}:\d{2}$/.test(fd.formatResetTime(plusOffset)), fd.formatResetTime(plusOffset));
    check('formatResetTime withYear appends the year', /, 2026$/.test(fd.formatResetTime(plusOffset, { withYear: true })), fd.formatResetTime(plusOffset, { withYear: true }));
    check('formatResetTime returns null on junk', fd.formatResetTime('nope') === null);
    check('formatCountdown returns null on junk', fd.formatCountdown('nope') === null);
    check('formatCountdown reports a positive window', /^\d+d \d+h$/.test(fd.formatCountdown(future)), fd.formatCountdown(future));
    // The fixture's own reset date is a hard-coded calendar day, so the
    // countdown/day checks run against a timestamp a fixed distance ahead —
    // otherwise they would start failing the moment the clock passes it.
    check('daysUntil floors (never overstates)', (() => {
      const remaining = fd.parseTimestamp(future) - Date.now();
      const days = fd.daysUntil(future);
      const notOverstated = days * 86_400_000 <= remaining;
      const isFloor = remaining - days * 86_400_000 < 86_400_000;
      return notOverstated && isFloor;
    })(), `${fd.daysUntil(future)} vs ${((fd.parseTimestamp(future) - Date.now()) / 86_400_000).toFixed(3)}d`);
    check('daysUntil is 0 for a past timestamp', fd.daysUntil('2020-01-01T00:00:00Z') === 0, String(fd.daysUntil('2020-01-01T00:00:00Z')));
    check('day count never exceeds countdown', (() => {
      const d = fd.daysUntil(future);
      const cd = fd.formatCountdown(future);
      const cdDays = parseInt(cd, 10);
      return d <= cdDays;
    })(), `${fd.daysUntil(future)} vs ${fd.formatCountdown(future)}`);

    console.log('\n\x1b[1m11. display name / email identity\x1b[0m');
    const acct = await import(pathToFileURL(path.join(root, 'src', 'accounts.js')).href);

    check('normal first+last name is joined', acct.displayName({ first_name: 'John', last_name: 'Doe' }) === 'John Doe');
    check('identical first/last name is not duplicated', acct.displayName({ first_name: '鋒兄', last_name: '鋒兄' }) === '鋒兄');
    check('only first name works', acct.displayName({ first_name: 'John', last_name: '' }) === 'John');
    check('only last name works', acct.displayName({ first_name: '', last_name: 'Doe' }) === 'Doe');
    check('falls back to email when nameless', acct.displayName({ email: 'x@y.com' }) === 'x@y.com');
    check('never returns an empty string', acct.displayName({}) === 'unknown', acct.displayName({}));

    // The list command must not leak a duplicated name into its output.
    const rawList = await runGs(['list']);
    check('list output contains no duplicated name', !/鋒兄\s+鋒兄/.test(rawList.stdout), rawList.stdout);
    // Every row must carry an email so accounts are distinguishable.
    const rows = rawList.stdout.split('\n').filter((l) => /[▶\s]\s*\d+\s+\S+\s+\S+@\S+/.test(l));
    check('list renders at least one email row', rows.length >= 4, `matched ${rows.length} rows`);

    console.log('\n\x1b[1m12. version comparison logic\x1b[0m');
    const ver = await import(pathToFileURL(path.join(root, 'src', 'version.js')).href);
    check('exposes the repo coordinate', ver.REPO === 'goldshoot0720/MultiGrokState', ver.REPO);
    check('exposes the tracked branch', ver.BRANCH === 'main', ver.BRANCH);
    check('shortSha trims to 7 chars', ver.shortSha('de8d410f7ad8c2d1') === 'de8d410');
    check('shortSha handles null', ver.shortSha(null) === 'unknown');

    const local = await ver.localStatus();
    check('localStatus resolves a commit SHA offline', typeof local.sha === 'string' && /^[0-9a-f]{40}$/.test(local.sha), JSON.stringify(local));

    // The git-protocol resolver must not depend on the REST API, which is
    // rate-limited to 60 req/h per IP and is often exhausted on shared links.
    check('remoteShaGit is a separate, git-based resolver', typeof ver.remoteShaGit === 'function');
    check('remoteShaApi is exposed', typeof ver.remoteShaApi === 'function');

    // A network failure must degrade to ok:false, never throw.
    const offline = await ver.checkForUpdate({ repo: 'goldshoot0720/nonexistent-repo-xyz-000' });
    check('unreachable repo degrades to ok:false', offline.ok === false, JSON.stringify(offline));
    check('unreachable repo explains itself', /github|reach/i.test(offline.reason || ''), offline.reason);

    // The installer leaves the checkout detached at FETCH_HEAD. `git pull` is
    // a silent no-op there, so the updater must use fetch+reset instead — and
    // localStatus must report the detached state so callers can tell.
    //
    // `local` is the *ambient* checkout: detached for anyone who installed via
    // install.sh, on a branch for a developer's clone. The two states are
    // therefore probed in isolated repos below — asserting them against the
    // ambient checkout fails on every real installation.
    check('localStatus reports a detached flag', 'detached' in local, JSON.stringify(local));
    check('syncToRemote is exposed for the updater', typeof ver.syncToRemote === 'function');
    check('isClean is exposed', typeof ver.isClean === 'function');
    // isClean() is a real oracle, so assert its observable contract rather than
    // the ambient tree state — a developer editing files mid-run must not fail.
    check('isClean returns a boolean', typeof (await ver.isClean()) === 'boolean');
    check('isClean rejects a non-repo path', (await ver.isClean(path.join(sandbox, 'nope'))) === false);

    /** Run a git command inside `dir`, rejecting on a non-zero exit. */
    const gitIn = (dir) => (args) =>
      new Promise((resolve, reject) => {
        const c = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
        let o = '', e = '';
        c.stdout.on('data', (d) => (o += d));
        c.stderr.on('data', (d) => (e += d));
        c.on('error', reject);
        c.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(e || `exit ${code}`))));
      });
    const PROBE_ID = ['-c', 'user.email=probe@example.com', '-c', 'user.name=probe'];

    // A checkout on a real branch must NOT be reported as detached. Built
    // offline so the assertion never depends on the ambient repo.
    const branchDir = path.join(sandbox, 'branch-probe');
    {
      const g = gitIn(branchDir);
      fs.mkdirSync(branchDir, { recursive: true });
      try {
        await g(['init', '-q', '.']);
        await g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await g([...PROBE_ID, 'commit', '-q', '--allow-empty', '-m', 'probe']);
        const br = await ver.localStatus(branchDir);
        check('a real branch is not flagged detached', br.detached === false, JSON.stringify(br));
        check('a real branch reports its name', br.branch === 'main', JSON.stringify(br));
        check('a real branch still resolves a SHA',
              typeof br.sha === 'string' && /^[0-9a-f]{40}$/.test(br.sha), JSON.stringify(br));
      } catch (err) {
        check('branch checkout probe ran', false, err.message);
      }
      fs.rmSync(branchDir, { recursive: true, force: true });
    }

    // A detached HEAD must be detected as detached, not mislabelled as a branch.
    // Reproduced locally (commit, then detach) so the probe needs neither the
    // network nor the ambient SHA — an installer's FETCH_HEAD checkout presents
    // the same state to git: `rev-parse --abbrev-ref HEAD` is literally "HEAD".
    const detDir = path.join(sandbox, 'detached-probe');
    {
      const g = gitIn(detDir);
      fs.mkdirSync(detDir, { recursive: true });
      try {
        await g(['init', '-q', '.']);
        await g([...PROBE_ID, 'commit', '-q', '--allow-empty', '-m', 'probe']);
        await g(['checkout', '-q', '--detach', 'HEAD']);
        const det = await ver.localStatus(detDir);
        check('detached checkout is flagged detached', det.detached === true, JSON.stringify(det));
        check('detached checkout has no branch name', det.branch === null, JSON.stringify(det));
      } catch (err) {
        check('detached checkout probe ran', false, err.message);
      }
      fs.rmSync(detDir, { recursive: true, force: true });
    }

    console.log('\n\x1b[1m13. background update notice\x1b[0m');
    // Seed a cached "behind" record inside the sandbox GROK_HOME and confirm
    // the nudge is printed without any network access.
    const cachePath = path.join(sandbox, '.multigrokstate-update.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        ok: true,
        current: 'de8d410f7ad8c2d1438690485b1d799d201f1485',
        latest: 'abc1234ffffffffffffffffffffffffffffffff',
        behind: true,
        checkedAt: Date.now(),
      })
    );
    const nudged = await runGs(['list']);
    check('behind cache prints an update nudge', /update available/i.test(nudged.stdout), nudged.stdout);
    check('nudge names the update command', /MultiGrokState update/.test(nudged.stdout), nudged.stdout);

    // The opt-out must silence it entirely.
    const quiet = await new Promise((resolve) => {
      const child = spawn(NODE, [gs, 'list'], {
        cwd: root,
        env: { ...process.env, GROK_HOME: sandbox, GROK_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.on('close', () => resolve(stdout));
    });
    check('GROK_NO_UPDATE_CHECK=1 silences the nudge', !/update available/i.test(quiet), quiet);

    console.log('\n\x1b[1m14. update --check\x1b[0m');
    // No network in the harness sandbox guarantees the graceful path, but the
    // command must always exit 0 and never crash.
    const upd = await runGs(['update', '--check']);
    check('update --check exits cleanly', upd.status === 0, upd.stderr);
    check('update --check reports a status line', /Checking for updates|up to date|Could not check|Update available/i.test(upd.stdout), upd.stdout);

    console.log('\n\x1b[1m15. harness leaves the source untouched\x1b[0m');
    // Regression guard: the harness once patched src/usage.js in place and
    // restored it in `finally`. A killed run left the real CLI pointed at a
    // dead localhost port. Env-var injection must keep the file pristine.
    const usageSrc = fs.readFileSync(path.join(root, 'src', 'usage.js'), 'utf8');
    check('src/usage.js has no localhost URL', !/127\.0\.0\.1|localhost/.test(usageSrc), usageSrc.match(/.*localhost.*/)?.[0] || '');
    check('src/usage.js keeps the real billing host', usageSrc.includes('cli-chat-proxy.grok.com'), '');
    check('src/usage.js keeps the real token host', usageSrc.includes('auth.x.ai/oauth2/token'), '');
    check('endpoints are env-overridable', /process\.env\.GROK_BILLING_URL/.test(usageSrc) && /process\.env\.GROK_TOKEN_URL/.test(usageSrc), '');
  } finally {
    // No source restore needed — src/usage.js is never modified.
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
