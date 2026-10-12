/**
 * Live usage / quota for a Grok account.
 *
 * Endpoints (official xAI, same ones the Grok CLI and grok-switch use):
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits   -> weekly window
 *   GET https://cli-chat-proxy.grok.com/v1/billing                  -> monthly window
 *
 * Auth is the OAuth access token from auth.json, sent as a Bearer token
 * together with `x-grok-client-mode: cli`.
 *
 * Note: the CLI's own token is short-lived, so we proactively refresh via
 * https://auth.x.ai/oauth2/token when the stored token is stale.
 */

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const USER_AGENT = 'multi-grok-state/1.0';

/** Unwrap either a bare number or xAI's `{ val: n }` money wrapper. */
function money(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.val === 'number') return v.val;
  return null;
}

const asFinite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Exchange a refresh_token for a fresh access token.
 * Returns the updated credential data, or null when refresh isn't possible.
 */
export async function refreshCredential(data) {
  if (!data.refresh_token || !data.oidc_client_id) return null;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: data.refresh_token,
    client_id: data.oidc_client_id,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;

  const json = await res.json().catch(() => null);
  if (!json?.access_token) return null;

  const updated = { ...data, key: json.access_token };
  if (json.refresh_token) updated.refresh_token = json.refresh_token;
  if (json.expires_in) {
    updated.expires_at = new Date(Date.now() + json.expires_in * 1000).toISOString();
  }
  return updated;
}

async function callBilling(token, { credits }) {
  const url = credits ? `${BILLING_URL}?format=credits` : BILLING_URL;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'x-grok-client-mode': 'cli',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  return res.json();
}

/** xAI returns verbose enum names like USAGE_PERIOD_TYPE_WEEKLY. */
function shortPeriod(type) {
  if (!type) return null;
  const t = String(type).toLowerCase();
  if (t.includes('weekly') || t.includes('week')) return 'weekly';
  if (t.includes('monthly') || t.includes('month')) return 'monthly';
  if (t.includes('daily') || t.includes('day')) return 'daily';
  return String(type);
}

/**
 * Parse an xAI timestamp into epoch ms.
 *
 * The API emits RFC 3339 with a numeric offset and microsecond precision,
 * e.g. `2026-10-18T13:37:26.239595+00:00`. `Date.parse` handles that, but we
 * guard anyway so a malformed value degrades to null instead of NaN leaking
 * into the UI. A trailing `Z` is normalised to `+00:00` for older engines.
 */
export function parseTimestamp(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : t;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Render a reset timestamp the way the Grok CLI does:
 *   "October 18, 21:37"
 * Rendered in the machine's local timezone. Returns null when unparseable.
 */
export function formatResetTime(value, { withYear = false } = {}) {
  const t = parseTimestamp(value);
  if (t == null) return null;
  const d = new Date(t);
  const base = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return withYear ? `${base}, ${d.getFullYear()}` : base;
}

/**
 * Whole days until a timestamp, floored so it never overstates the wait.
 * Floored (not rounded up) so it agrees with the "6d 2h" countdown form:
 * 6d 2h of remaining time must not read as "7d". Returns null when
 * unparseable, and 0 once the reset is due.
 */
export function daysUntil(value) {
  const t = parseTimestamp(value);
  if (t == null) return null;
  const delta = t - Date.now();
  if (delta <= 0) return 0;
  return Math.floor(delta / 86_400_000);
}

/** Human countdown such as "in 6d 3h" / "in 4h 12m" / "in 8m". */
export function formatCountdown(value) {
  const t = parseTimestamp(value);
  if (t == null) return null;
  let ms = t - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86_400_000);
  ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}


/**
 * Normalise a billing payload into a flat, display-ready shape.
 *
 * xAI has shipped at least two variants:
 *   credits view : { config: { creditUsagePercent, currentPeriod, productUsage[] } }
 *   monthly view : { config: { monthlyLimit, used, history[] } }
 * Only the credits view exposes a percentage, so when it's absent we derive
 * one from used/limit and safely return null when neither is present.
 */
export function parseBilling(body) {
  const config = body?.config && typeof body.config === 'object' ? body.config : body;
  if (!config || typeof config !== 'object') throw new Error('Missing billing config');

  const period = config.currentPeriod || {};
  const productUsage = {};
  if (Array.isArray(config.productUsage)) {
    for (const item of config.productUsage) {
      if (item?.product) productUsage[item.product] = asFinite(item.usagePercent) ?? 0;
    }
  }

  const limit = money(config.monthlyLimit);
  const used = money(config.used);
  let percent = asFinite(config.creditUsagePercent);
  let source = percent != null ? 'reported' : null;

  if (percent == null && limit != null && limit > 0 && used != null) {
    percent = (used / limit) * 100;
    source = 'derived';
  }

  return {
    ok: true,
    creditUsagePercent: percent,
    percentSource: source,
    limit,
    used,
    productUsage,
    periodType: shortPeriod(period.type) || (config.monthlyLimit != null ? 'monthly' : null),
    periodStart: period.start || config.billingPeriodStart || null,
    periodEnd: period.end || config.billingPeriodEnd || null,
    onDemandCap: money(config.onDemandCap),
    onDemandUsed: money(config.onDemandUsed),
    prepaidBalance: money(config.prepaidBalance),
    isUnified: typeof config.isUnifiedBillingUser === 'boolean' ? config.isUnifiedBillingUser : null,
  };
}

/**
 * Fetch usage for one credential entry.
 * @returns {Promise<object>} normalised billing status; `ok:false` on failure.
 */
export async function fetchUsage(cred, { onTokenRefreshed } = {}) {
  if (!cred?.data?.key) return { ok: false, error: 'no access token stored' };

  let data = cred.data;
  let weekly;
  try {
    weekly = parseBilling(await callBilling(data.key, { credits: true }));
  } catch (err) {
    // Stale token — refresh once, persist, retry.
    const refreshed = await refreshCredential(data).catch(() => null);
    if (!refreshed) return { ok: false, error: err.message };
    data = refreshed;
    try {
      weekly = parseBilling(await callBilling(data.key, { credits: true }));
    } catch (retryErr) {
      return { ok: false, error: retryErr.message };
    }
    onTokenRefreshed?.(data);
  }

  let monthly = null;
  try {
    monthly = parseBilling(await callBilling(data.key, { credits: false }));
  } catch {
    monthly = null;
  }

  return { ...weekly, ok: true, monthly, account: cred.data.email || null };
}

/** Render a chalk-agnostic progress bar (no colour codes, just glyphs). */
export function bar(percent, width = 20) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((width * pct) / 100);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** Format a money wrapper or raw number for display. */
export function moneyText(v) {
  if (v == null) return null;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export { BILLING_URL, TOKEN_URL };