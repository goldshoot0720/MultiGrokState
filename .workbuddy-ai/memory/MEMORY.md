# 專案：MultiGrokState

Node.js CLI，管理多個 Grok CLI 帳號。對外指令名 **`MultiGrokState`**（npm link 全域註冊）。
入口 **`bin/multigrokstate.js`**（薄殼：shebang → `runCli()` → 延遲 60ms `flushUpdateNotice()`）。
（2026-10-12 由 `bin/gs.js` 改名，讓檔名與指令名一致。）

## 檔案地圖
- `bin/multigrokstate.js` — CLI 入口（薄殼）
- `src/accounts.js` — auth.json 解析、存檔讀寫、JWT decode、`updateAccountCredential`
- `src/usage.js` — billing 端點、token refresh、payload 正規化、時間格式化
- `src/commands.js` — login / logout / switch（含 `resolveLiveIdentity()`）
- `src/cli.js` — chalk 輸出與指令分派（`cmdUpdate`、`--json` 輸出）
- `src/version.js` — 更新檢查（HEAD vs remote SHA、TTL 快取）
- `test/run.js` — 離線測試 harness（mock API + 暫存 GROK_HOME）
- `install.cmd` / `install.ps1` / `install.sh` — 一鍵安裝
- `gui/MultiGrokStateGui/` — Avalonia 桌面 GUI；`gui/run.cmd` 一鍵建置啟動
- `.gitattributes` — `*.cmd -text`（勿改回 `eol=crlf`）

## 發佈與安裝
- GitHub repo：**`goldshoot0720/MultiGrokState`**（PUBLIC，main）。使用者帳號 `goldshoot0720`（`gh auth` 已登入）。
- 一鍵安裝預設 `Repo` 必須是上面這個。上線後用 raw URL 驗證回 200。
- push 用 `gh auth setup-git`；`GIT_TERMINAL_PROMPT=0` 避免卡住。

## 提交慣例：每次改完自動 commit + push（2026-10-12 使用者要求）
- **改完任何東西就 commit 並 push，不用等使用者開口。**
- 已裝 **`.git/hooks/post-commit`**（本機、不進 repo）：每次 commit 後自動 `git push`
  當前分支到 upstream。失敗只印訊息、**絕不擋 commit**。跳過單次用 `GIT_AUTO_PUSH=0 git commit …`。
- 提交前仍要守紅線：先 `git fetch`，確認 `git merge-base --is-ancestor origin/main HEAD`。
- 這個 hook 是 **per-clone** 的（`.git/hooks` 不隨 repo 走）→ macOS checkout 要另外裝。

## 核心 API 事實
- `~/.grok/auth.json` 是 **map**：key = `https://auth.x.ai::<client_id>`，
  value = `{ key, refresh_token, email, user_id, expires_at, oidc_client_id, oidc_issuer }`。
  Grok CLI hot-reload 此檔 → 換檔即換帳號，無需重啟。
- OAuth client_id `b1a00492-073a-47ea-816f-4c329264a828`。
- 額度 API：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（週）、
  `GET .../v1/billing`（月）。Header 需 `Authorization: Bearer`、`x-grok-client-mode: cli`。
- token 幾乎總是過期 → 先 401 → 必須 `POST https://auth.x.ai/oauth2/token`（`grant_type=refresh_token`）換新再重打。
- 週報表：`config.creditUsagePercent`（無上限方案無此欄）、`currentPeriod`、`productUsage[]`。
  月報表：`config.{monthlyLimit,used,history}`。金額欄位包成 `{ val: n }`。
- reset 時間：週用 `config.currentPeriod.end`、月用 `config.billingPeriodEnd`。
  格式 RFC 3339 + offset + 微秒（`…T13:37:26.239595+00:00`），`Date.parse` 可吃。顯示本地時區。
- SuperGrok 週視窗常完全不回 usage 欄位 → 顯示 `0%`（`noCapReported` 旗標 + 附註），**不要印 `—`**。
- 時間工具在 `src/usage.js`：`parseTimestamp` / `formatResetTime` / `formatCountdown` / `daysUntil`（用 floor）。

## 帳號模型與指令語意（勿改）
- 存檔路徑 `~/.grok/accounts/<name>_auth.json`；原子寫入 + `0600`；name 需 sanitize（禁 `/\`、空白→`_`）。
- 只用官方端點：`auth.x.ai`、`cli-chat-proxy.grok.com`。
- `login [name]` → 跑 `grok login` 產生 auth.json → 複製成 `accounts/<name>_auth.json`（live 檔保留）。
- `logout` → 先複製 auth.json 成 `accounts/<email>_auth.json`（email local part）→ 再刪 auth.json 與 .lock。
  - 顯式 name 可覆蓋；既有存檔不覆蓋（要 `-f`）。
  - 存檔名取 **access token 最新（expiresAt 最大）** 那筆（`resolveLiveIdentity()`），非 `primaryCredential().email`。
- 識別顯示**一律用 email**；`displayName()` 處理 first===last 的重複。
  欄位對齊用 `displayWidth()`（CJK 算 2 格、ANSI 算 0 格）。

## GUI（Avalonia）
- Avalonia 12 + CommunityToolkit.Mvvm，net8.0，`dotnet build -c Release`。啟動 `gui/run.cmd`。
- GUI 完全不碰 auth/quota 邏輯，shell out CLI 解析 JSON：`list --json`、`usage --json`、`where --json`。
- `--json` 時必須關背景更新提示（`wantsNotice` 含 `&& !argv.includes('--json')`），否則 JSON.parse 爆。
- CLI 解析順序（`Services/CliService.cs`）：`MULTIGROKSTATE_CLI` env → 同 repo `bin/multigrokstate.js` → 全域 `MultiGrokState`。
- 互動指令開可見終端機 `cmd.exe /c node … & pause`，關窗觸發 `InteractiveCommandCompleted` → refresh。
- **⚠️ .NET 讀子行程 stdout 預設用系統 ANSI 碼頁（CP950）解碼 → UTF-8 CJK 吃掉 JSON 引號。
  必須設 `psi.StandardOutputEncoding = Encoding.UTF8`（+ StandardErrorEncoding）。**
- Avalonia csproj 沒開 `ImplicitUsings` → 要自己加。
- 截圖驗證：用系統 Python 3.14 Pillow；`SetForegroundWindow` 對背景行程無效 →
  用 `PrintWindow(hwnd,hdc,2)` + `GetDIBits`（後者要設 argtypes）。
- 背景啟動的行程在該輪對話結束會被殺 → 「啟動→sleep→截圖→kill」同一指令完成。截圖含真實 email → **不可進 public repo**。

## 更新機制
- 邏輯在 `src/version.js`；`update` / `update --check` 在 `src/cli.js` 的 `cmdUpdate()`。
- 比對 **commit SHA**（local `git rev-parse HEAD` vs remote branch tip）。
- **⚠️ GitHub REST API 會 rate limit（未認證 60/h，共享 IP 常 403），`git ls-remote` 不會
  → `remoteSha()` 必須「API 優先 + git fallback」。**
- **⚠️ 絕不用 `git pull`**：安裝副本永遠 detached HEAD，`git pull` 會靜默 no-op。
  正確 = `syncToRemote()`：`remoteSha()` → `git fetch --depth 1 origin <sha>` → `git reset --hard FETCH_HEAD`，先 `isClean()` 守門。
- 背景檢查 6h TTL 快取 `$GROK_HOME/.multigrokstate-update.json`；`GROK_NO_UPDATE_CHECK=1` 關閉。
- 提示靠 `globalThis.__gsUpdateNotice` + `flushUpdateNotice()`，`bin/multigrokstate.js` 結束後延遲 60ms 印。

## 兩份 clone（安裝副本 vs 工作目錄）
- 全域指令 = npm link → **`~/.multigrokstate`**；開發 = **`D:/CODE/MultiGrokState`**。
- 改工作目錄**不會**自動反映全域指令 → `MultiGrokState update` 或重跑 installer。
- ⚠️ repo 疑似有**並行 session** 同時 commit/push。commit 前先 `git fetch`，確認 `git merge-base --is-ancestor origin/main HEAD` 再 push。

## 測試
- `npm test` = `node test/run.js`，98 項，不碰真實 `~/.grok`。**測試前先 `npm ci`**（否則 `Cannot find package 'chalk'`）。
- **不要斷言當下 checkout 的 git 狀態**（install.sh 留 detached、開發在分支）→ 兩種狀態都要在 sandbox 造出來測。
- **不要斷言固定日曆日期**（時間一過就過期）→ 用相對時戳 + 性質檢查。
- `fetchUsage(cred, { onTokenRefreshed })` 的 callback **必須傳**。
- Windows 用 async `spawn`（`spawnSync` 對同 node binary EBUSY）。ESM 不能 `import(絕對路徑)`，用 `pathToFileURL().href`。
- 測試 harness 紅線：**絕不改寫 production source**（曾把 mock URL 留在 source → 全測試 401）。
  端點讀 `process.env.GROK_BILLING_URL` / `GROK_TOKEN_URL`，harness 用 env 注入。`test/run.js` 第 15 節防此回歸。

## 紅線 / 環境坑
- **Windows 安裝腳本**：`.cmd` / `.bat` 必須 **CRLF**（LF → cmd.exe 亂碼迴圈）。
  `.gitattributes` 用 **`*.cmd -text`**（勿用 `eol=crlf`，raw 端點會吐 LF），`git add --renormalize`，
  `git ls-files --eol` 要 `i/crlf w/crlf`。installer 先解析 branch→SHA 再 `git fetch --depth 1 <sha>`（raw 端點有 CDN 快取）。`install.cmd` 純 ASCII。
- **raw.githubusercontent.com 負快取**：新檔案用 branch 路徑可能 404 約 2 分鐘（SHA 路徑 / jsDelivr 已 200）。
  看到 404 別急著重 push，用 `git ls-tree origin/main` 或 `gh api …/contents/<file>` 確認。
- **install.sh**：`curl | bash` 走 stdin → 自我重執行成暫存檔 + `< /dev/null`（`MG_REEXEC` 防迴圈）；
  `npm link` 會 chmod bin → 設 `core.fileMode false`；優先 `npm ci` 失敗才 `npm install`；`FORCE` 只代表使用者明確要求。
- **bin 名不可只差大小寫**（APFS / NTFS 不區分）→ 只留 `MultiGrokState`。
  **`npm link` 回傳碼不可信**，用「指令是否解析得到」判斷（install.sh 檢查 `$(npm prefix -g)/bin/MultiGrokState` 可執行）。
- `spawn(cmd,args,{cwd})` 的 cwd 不可用 Git-Bash POSIX 路徑（`/tmp/…`）→ 用 `C:/…`。
- 改 `bin/` 入口檔名要同步 5 處：`package.json`（bin×2 + scripts）、`test/run.js`、`gui/…/Services/CliService.cs`、
  `install.cmd`、`install.ps1`（install 用位元組層級替換）；`package-lock.json` bin 區塊用 `npm install --package-lock-only` 重生。

## macOS 開發 checkout
- `/Users/feng33/Documents/MultiGrokState`：`git init` + `remote add origin` + `symbolic-ref HEAD refs/heads/main`
  + `git reset --mixed origin/main` 接回歷史（保留工作區檔案）。
- commit 身分 `goldshoot0720 <goldshoot0720@gmail.com>`（repo-local）。
- 安裝腳本：`install.sh`（POSIX sh）、`install.ps1`、`install.cmd`。
