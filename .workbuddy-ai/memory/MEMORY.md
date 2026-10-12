# 專案：MultiGrokState

Node.js CLI，管理多個 Grok CLI 帳號。**對外指令名稱：`MultiGrokState`**（已 npm link 全域註冊）。
入口腳本檔名是 `bin/gs.js`（歷史遺留，內部路徑不對外，改指令名不用改它）。

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

## 約定
- 存檔路徑：`~/.grok/accounts/<name>_auth.json`。
- 寫檔一律原子寫入 + `0600`。
- 帳號名稱需 sanitize（禁 `/\`、空白轉 `_`），避免路徑逃逸。
- 只用官方端點：`auth.x.ai`、`cli-chat-proxy.grok.com`。

## 檔案
- `src/accounts.js` — auth.json 解析、存檔讀寫、JWT decode、`updateAccountCredential`（refresh 後寫回）
- `src/usage.js` — billing 端點、token refresh、payload 正規化
- `src/commands.js` — login / logout / switch
- `src/cli.js` — chalk 輸出與指令分派
- `test/run.js` — 離線測試 harness（mock API + 暫存 GROK_HOME），`npm test`

## 測試
- `npm test` = `node test/run.js`，21 項檢查，不碰真實 `~/.grok`。
- 重要：`fetchUsage(cred, { onTokenRefreshed })` 的 callback **必須傳**，否則 refresh 的新 token 不會寫回存檔。
- Windows 上用 async `spawn` 而非 `spawnSync`（後者對同一 node binary 會 EBUSY）。
