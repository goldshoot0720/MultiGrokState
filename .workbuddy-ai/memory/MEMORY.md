# 專案：MultiGrokState

Node.js CLI，管理多個 Grok CLI 帳號。**對外指令名稱：`MultiGrokState`**（已 npm link 全域註冊）。
入口腳本檔名是 `bin/gs.js`（歷史遺留，內部路徑不對外，改指令名不用改它）。

## 發佈資訊
- GitHub repo：**`goldshoot0720/MultiGrokState`**（PUBLIC，main 分支）。
- 使用者 GitHub 帳號：`goldshoot0720`（`gh auth status` 已登入；另有 huang1988pioneer）。
- 一鍵安裝（`install.ps1` / `install.cmd`）的預設 `Repo` 必須是上面這個，不要寫錯。
- 上線後用 `curl -s -o /dev/null -w "%{http_code}" <raw-url>` 驗證回 200。
- 本機 git remote 已設好，push 用 `gh auth setup-git` 取得憑證（`GIT_TERMINAL_PROMPT=0` 避免卡住）。

## Windows 安裝腳本紅線（踩過兩次坑）
- `.cmd` / `.bat` **必須 CRLF**：bare LF 會讓 cmd.exe 解析爆掉 → 無限亂碼迴圈。
- **不要用 `.gitattributes` 的 `text eol=crlf`**：那會讓 git 在 object 裡存 LF、只在 checkout 時展開，
  而 GitHub raw 端點直接吐 blob → 使用者下載到的還是 LF。
  要寫 **`*.cmd -text`**，並 `git add --renormalize`，確認 `git ls-files --eol` 是 `i/crlf w/crlf`。
- **raw 端點有 CDN 快取**（branch 名）→ installer 應先用 GitHub API 把 branch 解析成 commit SHA，
  再 `git fetch --depth 1 <sha>`；SHA 不可變最穩。
- 驗證要驗「使用者真的會下載到的那個 URL」，不是只驗本地檔案。
- `install.cmd` 保持純 ASCII（em-dash 在 OEM 主控台會變 `??`）。

## 核心事實（不要重新摸索）
- `~/.grok/auth.json` 是 **map**：key = `https://auth.x.ai::<client_id>`，
  value = `{ key, refresh_token, email, user_id, expires_at, oidc_client_id, oidc_issuer, ... }`。
  Grok CLI 會 hot-reload 此檔 → 換檔即換帳號，無需重啟。
- OAuth client_id `b1a00492-073a-47ea-816f-4c329264a828`。
- 額度 API：`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`（週）、
  `GET .../v1/billing`（月）。Header 需 `Authorization: Bearer`、`x-grok-client-mode: cli`。
- **token 幾乎總是過期 → 先 401**，必須 `POST https://auth.x.ai/oauth2/token`
  （`grant_type=refresh_token`）換新 token 再重打。auth.json 的 token 過期不代表帳號失效，
  因為有 refresh_token 可續。
- 週報表：`config.creditUsagePercent`（無上限方案不存在此欄位）、`currentPeriod`、`productUsage[]`。
  月報表：`config.{monthlyLimit,used,history}`，格式不同。
  金額欄位包成 `{ val: n }`。
- **reset 時間**：週用 `config.currentPeriod.end`、月用 `config.billingPeriodEnd`。
  格式是 RFC 3339 + numeric offset + 微秒（`…T13:37:26.239595+00:00`），
  `Date.parse` 可吃。顯示本地時區，與 Grok CLI 面板一致（`October 18, 21:37`）。
  時間工具都在 `src/usage.js`：`parseTimestamp` / `formatResetTime` / `formatCountdown` / `daysUntil`。
  `daysUntil` 用 **floor**（ceil 會讓 `6d 2h` 顯示成 7d，跟倒數自相矛盾）。
- **SuperGrok 週視窗常常完全不回 usage 欄位**（無 `creditUsagePercent` / `productUsage` / limit）。
  Grok CLI 面板顯示成 `0%`，我們也照做（`noCapReported` 旗標 + 附註說明 bar 是佔位）。
  **不要印 `—`**，使用者會以為壞掉。

## ⚠️ 使用者實際執行的是 `~/.multigrokstate`
- PATH 上的 `MultiGrokState` 是 **npm link 到 `C:\Users\chbon\.multigrokstate`**，
  不是開發目錄 `D:\CODE\MultiGrokState`。
- **改完程式務必同步那份 checkout**，否則使用者跑到的還是舊版：
  `cd ~/.multigrokstate && git fetch --depth 1 origin main && git checkout FETCH_HEAD`。
- 那份會有 **CRLF/LF 假 modified**（`bin/gs.js` 等），`git checkout -- <file>` 清掉即可。

## 約定
- 存檔路徑：`~/.grok/accounts/<name>_auth.json`。
- 寫檔一律原子寫入 + `0600`。
- 帳號名稱需 sanitize（禁 `/\`、空白轉 `_`），避免路徑逃逸。
- 只用官方端點：`auth.x.ai`、`cli-chat-proxy.grok.com`。

## login / logout 語意（使用者明確定義，勿改）
- `login [name]` → 跑 `grok login` 產生 `auth.json` → 複製成 `accounts/<name>_auth.json`（live 檔保留）。
- `logout` → **先複製** `auth.json` 成 `accounts/<email>_auth.json`（取 email local part，
  例 `goldshoot0720@gmail.com` → `goldshoot0720_auth.json`）**→ 再刪 `auth.json` 與 `auth.json.lock`**。
  - 顯式 name 可覆蓋檔名：`logout <name>`。
  - **既有存檔不覆蓋**（磁碟上可能有更新 rotate 過的 token），要 `-f` / `--force` 才強制。
  - auth.json 是 map 且 `switch` 會殘留舊 identity → 存檔名要取
    **access token 最新（expiresAt 最大）** 那筆（`resolveLiveIdentity()`），
    不是簡單的 `primaryCredential().email`。

## 檔案
- `src/accounts.js` — auth.json 解析、存檔讀寫、JWT decode、`updateAccountCredential`（refresh 後寫回）
- `src/usage.js` — billing 端點、token refresh、payload 正規化、reset 時間格式化
- `src/commands.js` — login / logout / switch（logout 含 `resolveLiveIdentity()`）
- `src/cli.js` — chalk 輸出與指令分派（含 `resetLine`、`cmdUpdate`）
- `src/version.js` — 更新檢查（local HEAD vs remote SHA、git fallback、TTL 快取）
- `test/run.js` — 離線測試 harness（mock API + 暫存 GROK_HOME），`npm test`（76 項）
- `install.cmd` / `install.ps1` — 一鍵安裝（CRLF、純 ASCII、SHA-based fetch）
- `.gitattributes` — `*.cmd -text`（見上方紅線，勿改回 `eol=crlf`）

## 更新檢查（update / 背景提示）
- 邏輯在 **`src/version.js`**；`update` / `update --check` 在 `src/cli.js` 的 `cmdUpdate()`。
- 比對的是 **commit SHA**（local `git rev-parse HEAD` vs remote branch tip），不是版本字串。
- **⚠️ GitHub REST API 會 rate limit（未認證 60 req/h per IP，共享 IP 常態 403），
  `git ls-remote` 不會。** 所以 `remoteSha()` 必須「API 優先 + git fallback」，
  絕對不能只靠 API，否則使用者端會常態性「檢查失敗」。
- 背景檢查有 6h TTL 快取：`$GROK_HOME/.multigrokstate-update.json`。
- `GROK_NO_UPDATE_CHECK=1` 可完全關閉背景檢查。
- 背景提示靠 `globalThis.__gsUpdateNotice` + `flushUpdateNotice()`，
  由 `bin/gs.js` 在指令結束後延遲 60ms 印出（避免阻塞）。

## 測試 harness 紅線
- **絕對不要改寫 production source 檔**（如 `src/usage.js` 的 URL 常數）。
  曾經因此把 `127.0.0.1:3690` 留在 source 裡（中斷沒還原）→ 之後所有測試 401 全掛，
  看起來像功能壞掉其實是測試汙染。
- 正確做法：`src/usage.js` 的端點讀 `process.env.GROK_BILLING_URL` / `GROK_TOKEN_URL`，
  harness 用 env var（`MOCK_ENDPOINTS`）注入，source 永不修改。
- `test/run.js` 第 15 節就是防這個回歸的。

## 帳號識別顯示（list / usage）
- **一律以 email 識別帳號**，不用 profile name — 同一人的多個 archive
  name 可能完全一樣，email 才有區分度。
- **xAI 常把同一字串同時放進 `first_name` 和 `last_name`**（實例：兩者都是 `鋒兄`），
  舊的 `.join(' ')` 會產生 `鋒兄 鋒兄`。`displayName()` 已改成 first===last 時只留一份。
- 欄位對齊要用 `displayWidth()`：**CJK 算 2 格**、ANSI escape 算 0 格。
  用 `String.length` 會讓 `鋒兄` 之後的欄位全部歪掉。
- `list` 的 account 欄：email 在前，名字只在「有額外資訊且塞得下」時附加。

## 測試
- `npm test` = `node test/run.js`，**76 項**檢查，不碰真實 `~/.grok`。
- 重要：`fetchUsage(cred, { onTokenRefreshed })` 的 callback **必須傳**，否則 refresh 的新 token 不會寫回存檔。
- Windows 上用 async `spawn` 而非 `spawnSync`（後者對同一 node binary 會 EBUSY）。
- ESM 在 Windows 不能 `import(絕對路徑)`，要用 `pathToFileURL(...).href`。

## macOS 開發 checkout
- `/Users/feng33/Documents/MultiGrokState` 原本只是複製過來、**沒有 `.git`**；
  已 `git init` + `git remote add origin` + `git symbolic-ref HEAD refs/heads/main`
  + `git reset --mixed origin/main` 接回遠端歷史（這招可保留工作區檔案又接上歷史）。
- commit 身分：`goldshoot0720 <goldshoot0720@gmail.com>`（repo-local config）。
- 一鍵安裝腳本：`install.sh`（macOS / Linux，POSIX sh）、`install.ps1`、`install.cmd`。

## ⚠️ raw.githubusercontent.com 的負快取（新檔案）
**新加入 repo 的檔案，用 branch 路徑抓會回 404，即使 push 完全成功。**
實測 `install.sh` push 後 `.../main/install.sh` 回 404 約 2 分鐘才變 200；
同時 `.../<sha>/install.sh`、`cdn.jsdelivr.net/gh/...@main/...`、
`github.com/.../raw/main/...` **全部都是 200**。
→ 看到 404 **先別重 push**，用下面方式確認檔案真的在：
`git ls-tree origin/main --name-only`、`gh api repos/<repo>/contents/<file>`，
或改用 SHA-pinned URL 驗證內容。
**驗證「使用者會下載到的那個 URL」時要考慮這個延遲**，別急著判定失敗。

## install.sh 的紅線（詳見當日 log）
- `curl | bash` 走 stdin → 必須自我重執行成暫存檔 + `< /dev/null`（用 `MG_REEXEC` 防迴圈）。
- `npm link` 會 chmod bin → 安裝後設 `core.fileMode false`。
- 優先用 `npm ci`（不寫 lock），失敗才 `npm install`，最後還原 `package-lock.json`。
- `FORCE` 只能代表「使用者明確要求」；內部重建要用別的旗標，
  否則會誤授權刪掉外來目錄。
