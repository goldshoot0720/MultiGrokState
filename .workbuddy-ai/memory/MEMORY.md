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

## 約定
- 存檔路徑：`~/.grok/accounts/<name>_auth.json`。
- 寫檔一律原子寫入 + `0600`。
- 帳號名稱需 sanitize（禁 `/\`、空白轉 `_`），避免路徑逃逸。
- 只用官方端點：`auth.x.ai`、`cli-chat-proxy.grok.com`。

## 檔案
- `src/accounts.js` — auth.json 解析、存檔讀寫、JWT decode、`updateAccountCredential`（refresh 後寫回）
- `src/usage.js` — billing 端點、token refresh、payload 正規化、reset 時間格式化
- `src/commands.js` — login / logout / switch
- `src/cli.js` — chalk 輸出與指令分派（含 `resetLine`）
- `test/run.js` — 離線測試 harness（mock API + 暫存 GROK_HOME），`npm test`（37 項）
- `install.cmd` / `install.ps1` — 一鍵安裝（CRLF、純 ASCII、SHA-based fetch）
- `.gitattributes` — `*.cmd -text`（見上方紅線，勿改回 `eol=crlf`）

## 測試
- `npm test` = `node test/run.js`，37 項檢查，不碰真實 `~/.grok`。
- 重要：`fetchUsage(cred, { onTokenRefreshed })` 的 callback **必須傳**，否則 refresh 的新 token 不會寫回存檔。
- Windows 上用 async `spawn` 而非 `spawnSync`（後者對同一 node binary 會 EBUSY）。
