# LINE 個人研究助理

目前以專案已有的台股、美股評分快照、自選股、筆記與提醒為核心。一般查詢與對話操作不需要 AI API；選配 AI 僅解讀公開評分資料。沒有新增盤中報價、通用聊天或個人行事曆服務。

## 免費可用範圍

查核日期：2026-10-18。以下是服務公布的規則，實際帳號方案與剩餘額度仍以各服務後台為準。

| 項目 | 免費範圍與本專案做法 |
| --- | --- |
| LINE 台灣輕用量 | 月費 0 元、每月 200 則。2026-11-01 調價公告維持輕用量不變。[官方公告](https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/) |
| 主動查詢 | 使用 Reply API，不計入上述訊息則數。仍受 API 與主機限制，並非保證無限服務。[官方說明](https://developers.line.biz/en/tips/2026/05/28/how-to-count-messages/) |
| 主動推播 | 單一收件者、每市場每快照最多一次；有值得通知的變動才發。提醒合併進摘要。預設檢查全帳號本月用量低於 100，並保留方案額度 20 則；查不到額度就不發。 |
| 長摘要 | 同一請求最多 5 個文字物件，對一名收件者仍計 1 則；超過容量就不發、不把提醒標成已通知。[計數規則](https://developers.line.biz/en/tips/2026/05/28/how-to-count-messages/) |
| Supabase | 免費資料庫 500 MB、每月 500,000 次 Edge Function 呼叫；低活動專案可能暫停。[官方定價](https://supabase.com/pricing) |
| GitHub Actions | 公開儲存庫的標準託管 runner 免費；私人 GitHub Free 帳號一般包含每月 2,000 分鐘。[官方帳務說明](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| Gemini（選配） | 預設關閉。啟用前確認所選模型與 API 專案有免費額度。程式每日上限預設 10 次、最多 20 次；同模型同資料快照共用快取。免費層輸入可能用於改善產品，因此只送公開評分欄位。[定價](https://ai.google.dev/gemini-api/docs/pricing)與[速率限制](https://ai.google.dev/gemini-api/docs/rate-limits) |

兩個市場即使每個日曆日各送一份，31 天也只是 62 次請求；實際只在工作日爬蟲更新且有異動時發送。週報目前由使用者輸入指令查詢，沒有額外週報推播。`LINE_MONTHLY_CAP` 是程式預算，不能判斷或更改帳號付費月費，也不能阻止其他服務使用同一帳號推播。

## 操作範例

| 輸入 | 行為 |
| --- | --- |
| `台股 2` → `下一頁` | 保留台股市場並切到第 3 頁 |
| `台積電` → `加入自選` | 查詢後，以目前股票執行操作 |
| `把台積電加入自選` | 先解析公司名稱；有多檔候選時顯示選項 |
| `筆記 2330 關注下次營收` | 儲存／取代該檔筆記，最多 2,000 字 |
| `筆記 2330`、`看筆記` | 讀取筆記；空白內容不再覆寫舊筆記 |
| `我的筆記`、`搜尋筆記 營收` | 最近 10 筆，或依內容搜尋 |
| `清除筆記 2330` | 明確清除該檔筆記 |
| `提醒 2330` | 選擇分數／排名條件，收盤資料更新後檢查 |
| `解讀 2330` | 預設提供數據摘要；啟用 AI 後背景整理，再點「查看解讀」 |
| `新話題` | 重設目前市場、股票與頁碼 |
| `額度` | 查 LINE 本月推播用量 |

上下文只保存市場、股票與頁碼，閒置 24 小時後不再使用。快速選單的美股／台股分頁也會更新市場。Bot 只接受 `LINE_USER_ID` 擁有者的一對一訊息；群組／聊天室事件不回覆。提醒是資料更新後的條件通知，並非即時股價提醒。

## 部署

1. 原有的 `supabase/schema.sql` 與 `supabase/schema_tw.sql` 資料表須已建立。此次新增的是 `supabase/schema_line.sql`，不修改既有評分與筆記資料。
2. GitHub Actions Secrets 沿用 `SUPABASE_ACCESS_TOKEN`、`SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_TOKEN`、`LINE_USER_ID`。若 Supabase Auth 有多個帳號，必須新增 `OWNER_UID`，指向自己的儀表板使用者 UUID；只有一個帳號時可自動選取。
3. 合併到 `main` 或手動執行 `deploy-line-bot`。流程先跑 Node／Python／PostgreSQL 測試，再以 service key 驗證資料表版本。版本正確則直接設定 secrets、部署 function；未確認版本時，才以 Supabase Management API 執行冪等 SQL。任何步驟失敗即停止。`PROJECT_REF` 延用既有工作流程設定。
4. 若部署 token 沒有資料庫 SQL 權限，可先在該專案的 Supabase SQL Editor 執行完整 `supabase/schema_line.sql`，再重跑部署；既有 `SUPABASE_SERVICE_KEY` 即可確認版本，不必增加部署 token 權限。版本函式只授權 service role，並在 SQL 交易完成後才生效。日後變更 SQL 須同步更新 schema 與 Python 腳本的版本值。自動執行 SQL 仍需 Management API 權限，參考 [Run a query API](https://supabase.com/docs/reference/api/v1-run-a-query)。
5. 確認 LINE Webhook 指向 `/functions/v1/line-webhook`，開啟 webhook 與重新傳送。部署維持 JWT verification 關閉，由 LINE 簽章驗證請求。
6. 在自己的 LINE 私聊依序驗收：`說明`、`台股 2`、`下一頁`、股票名稱、`加入自選`、寫／讀筆記、`額度`。`解讀` 在未啟用 AI 時也應回覆數據摘要。

美股原排程於台北時間週二至週六 05:30 開始爬蟲，完成後發美股摘要；台股於週一至週五 15:40 開始爬蟲，完成後發台股摘要。GitHub 排程可能延遲。沒有新快照或異動時不發送。

### 選配 AI

先確認 Google AI Studio 中所選專案與模型的免費資格；本程式無法驗證 Google 帳單狀態。使用已啟用計費的 API 專案可能產生費用。

- Secret：`GEMINI_API_KEY`。
- Variables：`LINE_AI_ENABLED=1`、`LINE_AI_DAILY_LIMIT=10`、`GEMINI_MODEL=gemini-2.5-flash`（以目前可用模型為準）。
- 重新執行 `deploy-line-bot`。停用時將 `LINE_AI_ENABLED` 改回 `0` 並重新部署。

AI 只接收明確列出的公開股票／評分欄位，不接收 LINE ID、自選清單、筆記或對話紀錄。不啟用搜尋接地、不切換付費供應商。每次新解讀先原子預扣一次日額度；失敗也不退還，避免重試耗盡上游額度。背景作業不推播，使用者點「查看解讀」取得結果。逾時、429 或額度用完時回到數據摘要；同快照的失敗狀態保留至快取清理。

## 送達、重試與維運

- `line_events` 防止同一 webhook 在不同執行個體重做，處理前先登記。若登記失敗回 503；已登記後執行中斷的事件不自動重做，使用者先查自選／提醒清單確認，再送新指令。這是避免重複寫入的取捨。
- `line_deliveries` 在送出前保存完整內容、提醒 ID 和 LINE retry key。同收件者／市場／日期重跑沿用原內容；LINE 已接受的相同 retry key 視為成功。超過 23 小時的未完成紀錄停止自動重試，需查 log 與 LINE 送達情況。**跨快照日期的網路不確定狀態仍不能保證恰好送達一次。**
- LINE 成功後才標記該份訊息包含的提醒；同時啟用 Telegram 時，僅 Telegram 成功不會消耗 LINE 提醒。LINE 接受請求不等於使用者已讀。
- 沒發成功、額度不足、超長摘要會記錄於爬蟲 log。這些情況不會自動重試到付費服務。
- events 與 AI cache／usage 在後續呼叫時清除超過 7 天的記錄；sessions 覆寫同一筆，deliveries 保留作為送達稽核。日後清理 deliveries 時須保留仍可能重跑的日期。
- 所有新增資料表開啟 RLS，不授權 anon/authenticated 讀寫，只有後端 service role 可以操作；不將完整對話或私密筆記寫入 AI 快取。

## 測試

```sh
pip install -r crawler/requirements.txt pytest
python -m pytest -q
node --test tests/*.test.mjs  # Node 22.18+
```

CI 另使用一次性 PostgreSQL 17，重複套用 schema 並驗證額度、去重、凍結訊息與權限。離線測試涵蓋七筆提醒完整顯示、UTF-16 長度、推播逾時重試、409 已接受、資料庫確認失敗、LINE／Telegram 部分成功、額度不足、台美股分流，以及 AI 關閉／快取／429。真實 LINE 送達與 AI 專案資格仍需部署後驗收。
