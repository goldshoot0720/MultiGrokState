# multi-grok-state

Manage multiple **Grok CLI** accounts on one machine — archive logins, check live
usage/quota, and switch accounts without going through the browser again.

Built on the same mechanism the Grok CLI itself uses: a single `~/.grok/auth.json`
that Grok hot-reloads, plus the official `cli-chat-proxy` billing endpoint.

## Getting started

### One-line install (Windows)

PowerShell:

```powershell
irm https://raw.githubusercontent.com/chbon/MultiGrokState/main/install.ps1 | iex
```

CMD (no PowerShell required):

```cmd
curl -fsSL https://raw.githubusercontent.com/chbon/MultiGrokState/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Both scripts check for Node 18+, npm and git, clone the source to
`%USERPROFILE%\.multigrokstate`, install dependencies, register the
`MultiGrokState` command globally, and run a smoke test. Re-running updates
in place; pass `-Force` (PowerShell) to reinstall from scratch.

PowerShell options — run it as a script block if you need to pass them:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/chbon/MultiGrokState/main/install.ps1))) `
    -InstallDir 'C:\Tools\MultiGrokState' -NoPath
```

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
MultiGrokState login <name>     # browser login → snapshot to accounts/<name>_auth.json
MultiGrokState logout           # delete live auth.json (archives untouched)
MultiGrokState switch <name>    # copy an archive back into auth.json
MultiGrokState usage            # weekly / monthly quota per account
MultiGrokState list --usage     # account table + live quota
MultiGrokState where            # print resolved paths
```

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

Deletes `~/.grok/auth.json`. That is what signs Grok out — the archives under
`accounts/` are deliberately left alone, which is the entire point of the tool.
Pass `-k <name>` to snapshot the live session into the archive first.

### `/switch`

Reads an archive and **merges** it into the live `auth.json`, then writes
atomically with owner-only permissions (`0600`). Grok hot-reloads this file, so
already-running TUI sessions pick up the new account on their next API call —
no restart needed.

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
`used / limit`; if there's no cap either, the bar shows `—` and the row reads
`no capped allowance on this plan`.

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

## Layout

```
bin/gs.js          CLI entry point (the file name is internal; the command is MultiGrokState)
src/paths.js       path resolution + name sanitising
src/accounts.js    auth.json parsing, archive read/write, JWT decode
src/usage.js       billing endpoint, token refresh, response normalisation
src/commands.js    login / logout / switch implementations
src/cli.js         chalk rendering + command dispatch
test/run.js        local test harness (mock API + isolated GROK_HOME)
install.ps1        PowerShell installer (irm ... | iex)
install.cmd        CMD installer (curl -o ... && ... && del)
```

## Uninstall

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

```bash
npm test              # run all 21 checks
node test/run.js --keep   # keep the sandbox for manual poking
```

Covered: archive listing, active-account detection, usage rendering (reported
and derived percentages), token rotation persistence, switch, logout (live file
removed, archives kept), `logout -k` backup, unknown-account errors and path
traversal rejection.

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
