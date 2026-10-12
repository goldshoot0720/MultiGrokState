# multi-grok-state

Manage multiple **Grok CLI** accounts on one machine — archive logins, check live
usage/quota, and switch accounts without going through the browser again.

Built on the same mechanism the Grok CLI itself uses: a single `~/.grok/auth.json`
that Grok hot-reloads, plus the official `cli-chat-proxy` billing endpoint.

## Getting started

### One-line install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.sh | bash
```

Options go after `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.sh \
  | bash -s -- --install-dir "$HOME/tools/multigrokstate"
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--install-dir <path>` | `~/.multigrokstate` | Where to install |
| `--repo <owner/name>` | `goldshoot0720/MultiGrokState` | Source repository |
| `--branch <name>` | `main` | Branch or tag to install |
| `--no-link` | off | Skip `npm link`; run via `node bin/gs.js` |
| `-f`, `--force` | off | Reinstall from scratch |
| `-h`, `--help` | — | Usage |

The same settings work as environment variables (`INSTALL_DIR`, `REPO`,
`BRANCH`, `NO_LINK=1`, `FORCE=1`), which is handy when the script is fetched
from somewhere other than a pipe.

### One-line install (Windows)

PowerShell:

```powershell
irm https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.ps1 | iex
```

CMD (no PowerShell required):

```cmd
curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

### What the installers do

All three check for Node 18+, npm and git, download the source to
`~/.multigrokstate` (`%USERPROFILE%\.multigrokstate` on Windows), install
dependencies, register the `MultiGrokState` command globally, and run a smoke
test. Re-running updates in place; pass `--force` / `-Force` to reinstall from
scratch.

Two details specific to the macOS/Linux script:

- It re-executes itself from a temporary copy. `curl … | bash` feeds the
  script to the shell through **stdin**, and the shell reads it incrementally —
  so the first child process that reads stdin (`npm`, `git`, the Xcode Command
  Line Tools prompt) would otherwise swallow the rest of the script.
- If `npm link` fails (usually `EACCES` from a root-owned global prefix) it
  falls back to symlinks in `~/.local/bin` and tells you the exact `PATH` line
  to add.

PowerShell options — run it as a script block if you need to pass them:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.ps1))) `
    -InstallDir 'C:\Tools\MultiGrokState' -NoPath
```

> **If `irm` fails with `WebCmdletWebResponseException` / `HttpWebRequest`**
> this is a TLS or proxy problem in your PowerShell session, not with the
> script. Force TLS 1.2 first, then retry:
>
> ```powershell
> [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
> irm https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.ps1 | iex
> ```
>
> Or use the CMD variant below, which uses `curl` and avoids PowerShell's
> HTTP stack entirely.

### Manual install

```bash
cd D:/CODE/MultiGrokState
npm install              # only dependency is chalk
npm link                 # registers `MultiGrokState` globally
MultiGrokState           # show help
```

Run it in place without linking:

```bash
node bin/gs.js list          # from the project directory
```

```
MultiGrokState login [name]     # browser login → snapshot to accounts/<name>_auth.json
MultiGrokState logout           # archive auth.json as accounts/<email>_auth.json, then delete it
MultiGrokState logout <name>    # same, but archive under an explicit name
MultiGrokState switch <name>    # copy an archive back into auth.json
MultiGrokState usage            # weekly / monthly quota + reset time per account
MultiGrokState list --usage     # account table + live quota + reset time
MultiGrokState update           # check GitHub and pull the latest version
MultiGrokState where            # print resolved paths
```

## Updating

`MultiGrokState update` resolves the `main` branch to a commit SHA on GitHub,
compares it against the local `HEAD`, and — if they differ — runs
`git pull --ff-only` followed by `npm link`, then reports the new revision.

```
$ MultiGrokState update --check
  Checking for updates…
  repo goldshoot0720/MultiGrokState (main)  ·  ~/.multigrokstate

  ↑ Update available
    local  de8d410
    remote 3f9a2c1

  Run MultiGrokState update to install it.
```

Normal commands also run a **passive** check in the background and print a
one-line nudge when a newer commit exists:

```
  ↑ update available MultiGrokState update  (3f9a2c1)
```

Details worth knowing:

- The check compares **commit SHAs**, not version strings. That mirrors the
  installer's own update path and sidesteps the CDN cache that serves stale
  content for branch-name URLs.
- Results are cached for 6 hours next to your Grok home
  (`$GROK_HOME/.multigrokstate-update.json`), so the GitHub API is contacted at
  most once every few hours.
- The check is **best-effort**: no git, no network, or no remote → it stays
  silent and the command you actually ran is unaffected.
- Set `GROK_NO_UPDATE_CHECK=1` to disable the passive check entirely.

## How it works

### The auth file

`~/.grok/auth.json` is a JSON **map keyed by OAuth scope**, not a single token
blob. Every signed-in identity gets its own entry:

```jsonc
{
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    "key": "eyJ0eXAiOi...",          // OAuth access token (JWT)
    "refresh_token": "CZxnkLd_1sfR...",
    "auth_mode": "oidc",
    "user_id": "087e65b7-55bc-43b8-bc47-563b55ecee3b",
    "email": "you@example.com",
    "first_name": "…",
    "last_name": "…",
    "team_id": "…",
    "expires_at": "2026-10-02T14:53:17.449Z",
    "oidc_issuer": "https://auth.x.ai",
    "oidc_client_id": "b1a00492-073a-47ea-816f-4c329264a828"
  }
}
```

The `scope_key` is `<issuer>::<client_id>`. The access token in `key` is a JWT
whose payload carries `exp`, `tier`, `team_id` and `scope`.

### `/login`

`MultiGrokState login <name>` shells out to the real `grok login`, which performs the normal
browser OIDC flow and writes `auth.json`. Once it exits cleanly we read that
file and copy it to:

```
~/.grok/accounts/<name>_auth.json
```

No credentials are ever minted by this tool — the Grok CLI owns the flow. We
just archive the result.

### `/logout`

Copies the live `auth.json` to `accounts/<email>_auth.json`, **then** deletes
`auth.json` and `auth.json.lock`. No email is needed from you — the local part
of the account's address becomes the filename:

| Live account | Archive written |
| --- | --- |
| `goldshoot0720@gmail.com` | `~/.grok/accounts/goldshoot0720_auth.json` |

That is what signs Grok out: with `auth.json` gone the CLI has no session.
Because `auth.json` is a map and `switch` leaves previous identities behind, the
archive is named after the entry with the **freshest access token** — the one
Grok would actually use — so the saved file matches the session you just ended.

- Pass a name (`logout myacct`) to archive under something else.
- If `accounts/<name>_auth.json` already exists it is **left as-is** rather than
  overwritten (the archive on disk may hold newer rotated tokens); pass `-f` /
  `--force` to overwrite.
- If the live session carries no email the file is deleted without an archive
  and the CLI says so.

### `/switch`

Reads an archive and **merges** it into the live `auth.json`, then writes
atomically with owner-only permissions (`0600`). Grok hot-reloads this file, so
already-running TUI sessions pick up the new account on their next API call —
no restart needed.

### Account identity

`list` and `usage` identify each archive by its **email**, because that is the
field that actually distinguishes two accounts:

```
  #  name            account                       token
──────────────────────────────────────────────────────────────
  ▶  1 work            goldshoot0720@gmail.com  鋒兄 ● valid in 5h 41m
     2 personal        someone.else@example.com      ● valid in 3h 12m
```

Two details behind that column:

- The email leads, with the profile name appended only when it adds
  information. xAI frequently stores the **same string in both `first_name`
  and `last_name`** (e.g. both `鋒兄`), which would otherwise render as the
  nonsensical `鋒兄 鋒兄`. `displayName()` collapses identical halves.
- Column padding counts **CJK glyphs as two cells**, so a name like `鋒兄` does
  not push the status column out of alignment.

If an archive has no email the column shows `(no email)` and the row falls back
to the profile name or the archive name.

### Usage / quota

```
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits   # weekly window
GET https://cli-chat-proxy.grok.com/v1/billing                  # monthly window
```

Required headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <access_token>` |
| `Accept` | `application/json` |
| `x-grok-client-mode` | `cli` |

The weekly (credits) response looks like:

```jsonc
{
  "config": {
    "currentPeriod": { "type": "USAGE_PERIOD_TYPE_WEEKLY", "start": "…", "end": "…" },
    "creditUsagePercent": 83.5,            // absent when the plan has no cap
    "productUsage": [ { "product": "grok-build", "usagePercent": 91.2 } ],
    "onDemandCap":   { "val": 0 },
    "onDemandUsed":  { "val": 0 },
    "prepaidBalance":{ "val": 0 },
    "isUnifiedBillingUser": true
  }
}
```

The monthly response uses a different shape and is normalised into the same
result:

```jsonc
{ "config": { "monthlyLimit": { "val": 500 }, "used": { "val": 18 }, "history": [ … ] } }
```

Money fields arrive wrapped as `{ val: n }`, so the parser unwraps them.
When `creditUsagePercent` is missing the percentage is derived from
`used / limit`.

A SuperGrok weekly window frequently carries **no usage fields at all** — no
`creditUsagePercent`, no `productUsage`, no limit. The Grok CLI displays that as
`0%` rather than a blank, so we do the same and add a note that the bar is a
placeholder:

```
    weekly  ░░░░░░░░░░░░░░░░░░░░ 0.0%
            Resets: October 18, 21:37, 2026 (in 6d 1h)
    ...
    plan reports no usage for this window (bar shown at 0%)
```

#### Reset time

Every window prints when it rolls over, taken from `currentPeriod.end`
(weekly) and `billingPeriodEnd` (monthly):

```
  testacct you@example.com
    weekly  ████░░░░░░░░░░░░░░░░ 20.0%
            Resets: October 18, 21:37, 2026 (in 6d 2h)
    monthly ██░░░░░░░░░░░░░░░░░░  6.0%
            18 / 300
            Resets: November 1, 08:00, 2026 (in 19d 13h)
```

The absolute time is rendered in **your local timezone** (`October 18, 21:37`
matches what the Grok CLI shows in its own Usage panel). The parenthesised
countdown turns yellow inside one day and red once the reset is due.

Two details worth knowing, both handled in `src/usage.js`:

- xAI timestamps are RFC 3339 with a **numeric offset and microsecond
  precision** — `2026-10-18T13:37:26.239595+00:00`. `parseTimestamp()` guards
  this and returns `null` on anything unparseable, so a malformed value
  degrades to a missing line rather than `Invalid Date` leaking into the UI.
- `daysUntil()` **floors** rather than rounds up, so a `6d 2h` countdown reads
  as `6d` and never disagrees with the countdown beside it.

### Token refresh

Access tokens in `auth.json` are short-lived (it is a normal 7-day OIDC token
but the proxy also checks freshness). A stale token returns:

```json
{"error":"Invalid or expired credentials (… upstream=PermissionDenied …)"}
```

…on **HTTP 401**. When that happens the tool refreshes once and retries:

```
POST https://auth.x.ai/oauth2/token
grant_type=refresh_token&refresh_token=<rt>&client_id=<oidc_client_id>
```

The refreshed token is merged back into the credential and persisted, matching
the field layout Grok uses (`key`, `refresh_token`, `expires_at` as an RFC3339
`Z` timestamp).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROK_HOME` | `~/.grok` | Grok CLI home; `auth.json` lives here |
| `GROK_STATE_HOME` | `$GROK_HOME` | Where `accounts/` is stored |
| `GROK_BIN` | auto-detected | Path to the `grok` executable |
| `GROK_NO_UPDATE_CHECK` | unset | Set to `1` to disable the background update check |
| `GROK_BILLING_URL` | xAI proxy | Override the billing endpoint (used by the test harness) |
| `GROK_TOKEN_URL` | `auth.x.ai` | Override the token-refresh endpoint (used by the test harness) |

## Layout

```
bin/gs.js          CLI entry point (the file name is internal; the command is MultiGrokState)
src/paths.js       path resolution + name sanitising
src/accounts.js    auth.json parsing, archive read/write, JWT decode
src/usage.js       billing endpoint, token refresh, response normalisation
src/commands.js    login / logout / switch implementations
src/version.js     update checking (local HEAD vs GitHub SHA, TTL cache)
src/cli.js         chalk rendering + command dispatch
test/run.js        local test harness (mock API + isolated GROK_HOME)
install.ps1        PowerShell installer (irm ... | iex)
install.cmd        CMD installer (curl -o ... && ... && del)
install.sh         macOS / Linux installer (curl ... | bash)
```

## Uninstall

macOS / Linux:

```bash
npm unlink -g multi-grok-state          # remove the global command
rm -rf ~/.multigrokstate
```

Windows:

```powershell
npm unlink -g multi-grok-state          # remove the global command
Remove-Item -Recurse -Force "$env:USERPROFILE\.multigrokstate"
```

Your archived accounts under `~/.grok/accounts/` are left alone — delete them
manually if you want them gone.

## Local testing

The harness never touches your real `~/.grok`. It creates a throwaway
`GROK_HOME`, seeds fake accounts, and points the code at a local mock server
that reproduces xAI's behaviour — including the **401 → refresh → 200** flow.

The mock URL is injected through `GROK_BILLING_URL` / `GROK_TOKEN_URL`, so
**`src/usage.js` is never rewritten on disk**. (An earlier version patched the
file in place and restored it in a `finally` block; a killed run left the real
CLI pointing at a dead localhost port. A test guards against that regression.)

```bash
npm test              # run all 76 checks
node test/run.js --keep   # keep the sandbox for manual poking
```

Covered: archive listing, active-account detection, email/display-name
identity (including collapsed duplicate names), usage rendering (reported and
derived percentages), reset-time formatting (date, countdown, timezone
handling, malformed input), token rotation persistence, switch, logout
(archives the live session under its email, removes `auth.json` and
`auth.json.lock`, keeps existing archives, `-f` force-overwrite), unknown-account
errors, path traversal rejection, and source-file integrity.

## Security

- Archives and `auth.json` are written `0600` and atomically (temp + rename).
- Account names are sanitised, so a name can never escape the archive directory.
- Tokens are equivalent to Super access — keep `$HOME` private, never commit
  `~/.grok/accounts/`.

## Notes

- Only official xAI endpoints are contacted: `auth.x.ai` and
  `cli-chat-proxy.grok.com`.
- The `--usage` flag refreshes tokens for every listed account, which will
  rotate their `refresh_token`s in the archive.
