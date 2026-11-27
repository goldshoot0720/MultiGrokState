# MultiGrokState

Node CLI that archives Grok CLI accounts and shows live quota. The Avalonia window only renders what the CLI prints. Command name is `MultiGrokState`. Entry is `bin/multigrokstate.js`.

Long history lives in `.workbuddy-ai/memory/MEMORY.md`. Endpoint shapes and the installer live in `README.md`. When those disagree with the code, follow the code.

## Change the right layer

Auth, refresh, and quota live in `src/`. The GUI in `gui/MultiGrokStateGui/` shells out and parses JSON.

A new displayed field is done when `usage --json` or `list --json` contains it, the matching C# model copies it, and the window binds it. Do not reimplement billing or token refresh in C#.

`list --json` returns the account table and stops. It does not fetch quota, even with `--usage`. Quota is `usage --json`.

`--json` must stay free of the update notice. `runCli` already skips that notice when the argv contains `--json`. A stray line breaks `JSON.parse`.

## Credentials

Live session: `~/.grok/auth.json`, a map of scope key to credential. Archives: `~/.grok/accounts/<name>_auth.json`, written atomically as mode `0600`. `GROK_HOME` moves the Grok home. `GROK_STATE_HOME` moves only the archive directory.

Never print `key`, `refresh_token`, or `oidc_client_id`. Never commit `auth.json` or `*_auth.json`.

`logout` names the archive from the credential with the newest access token (`resolveLiveIdentity`), using the email local-part. An existing archive stays unless `-f`. `login` leaves the live file in place.

Refreshing a token writes the new `refresh_token` back into that archive. `usage` and `list --usage` do this for every account they query.

Account names pass through `sanitizeName`. Identity on screen is the email. `displayName()` collapses identical `first_name` and `last_name`. Table padding counts a CJK glyph as two columns.

## Quota

Only these hosts: `auth.x.ai`, `cli-chat-proxy.grok.com`. Tests point elsewhere with `GROK_BILLING_URL` and `GROK_TOKEN_URL`. Leave those reads in `src/usage.js`. Do not hard-code a mock URL into source.

A weekly window with no usage fields renders `0%` and `noCapReported`. Do not render a dash. `daysUntil` floors. Reset timestamps are RFC 3339 with a numeric offset and microseconds; unparseable values become a missing line.

## GUI

CLI resolution in `CliService`: `MULTIGROKSTATE_CLI`, then this repo's `bin/multigrokstate.js`, then the global `MultiGrokState` command. Captured stdout and stderr are UTF-8. The interactive login and logout windows are a visible terminal.

`npm ci` before `npm test` or a GUI launch. Without `chalk`, the status bar fills with `ERR_MODULE_NOT_FOUND`.

The project targets `net8.0`. On a machine whose only runtime is .NET 10, launch with `DOTNET_ROLL_FORWARD=Major`. `gui/MultiGrokState.app` already exports that. Open that bundle to see the Dock tile. `MacDockIcon` sets the Dock image when the process is `dotnet`. The window icon is `Assets/app-icon.ico`.

Do not commit a screenshot that shows a real email.

## Update and install

`update` compares commit SHAs. It fetches that SHA and `git reset --hard`s onto it. It does not `git pull`. A dirty tree stops the update. `remoteSha()` tries the GitHub API, then `git ls-remote`.

`*.cmd`, `*.bat`, and `*.ps1` are marked `-text` in `.gitattributes`, so the CRLF bytes in the working tree are the blob. Shell scripts stay LF.

Renaming `bin/multigrokstate.js` also updates `package.json`, `test/run.js`, `CliService.cs`, and both Windows installers.

## Verify

`npm test` passes against the sandbox in `test/run.js`. It must not touch the real `~/.grok`.

A GUI change is done when `dotnet build -c Release` succeeds in `gui/MultiGrokStateGui` and the affected window action has been exercised: list, refresh, or switch.

## Ship

Push to `https://github.com/goldshoot0720/MultiGrokState` `main` when the user says `自動提交至` or `提交至` that URL. Before the push, `git fetch` and confirm `origin/main` is an ancestor of `HEAD`. Commit as `goldshoot0720 <goldshoot0720@gmail.com>` with `git -c`, without changing stored git config.
