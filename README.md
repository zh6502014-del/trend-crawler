# 趨勢爬蟲

每天自動從公開資料找出「實質很強、但還沒被擠滿」的美股小型股，以及 SEC 上正在募資的 Reg CF 新創，整理成一個私人 dashboard。

它產出的是**研究線索，不是投資建議**，也不預測股價。

```
GitHub Actions（每個交易日收盤後）
   ├─ Massive           價量         ┐
   ├─ SEC companyfacts  財報         │
   ├─ Hacker News API   社群關注度   ├─ 計分 ─▶ Supabase ─▶ docs/ 靜態頁（GitHub Pages）
   └─ SEC EDGAR Form C  Reg CF 募資案 ┘
```

## 設定（約 20 分鐘）

**1. Supabase**
1. 建一個專案，打開 SQL Editor，貼上 `supabase/schema.sql` 執行。
2. Project Settings → API，記下 Project URL、`anon` key、`service_role` key。
3. Authentication 裡關掉「Allow new users to sign up」（選單名稱隨版本略有不同，在 Sign In / Providers 一帶）。
4. Authentication → Users → Add user，建立你自己的 Email。

**2. GitHub**
1. 把整個資料夾推到一個 repo。
2. Settings → Secrets and variables → Actions，新增以下 secret：
   - `SUPABASE_URL`：Project URL
   - `SUPABASE_SERVICE_KEY`：service_role key（只放這裡，永遠不要放進網頁）
   - `MASSIVE_API_KEY`：Massive 價格 API 金鑰
   - `SEC_USER_AGENT`：`你的名字 你的信箱@example.com`（SEC 規定要留聯絡方式，否則會擋）
3. Settings → Pages，Source 選 Deploy from a branch，資料夾選 `/docs`。

**3. 前端**
編輯 `docs/config.js`，填入 Project URL 和 **anon** key。到 Supabase → Authentication → URL Configuration，把 Site URL 設成你的 GitHub Pages 網址（登入連結才會導回來）。

**4. 第一次執行**
GitHub → Actions → daily-crawl → Run workflow，勾選 `full_refresh`。第一次會建立約 400 個日曆日的價格快取，並更新候選股財報；免費 API 的請求間隔至少 13 秒，初次價格載入約需一小時，財報另計。後續只抓缺少的價格日期與到期財報。

跑完打開 Pages 網址，輸入 Email，點信裡的連結登入。

## 分數怎麼算

```
分數 = 100 × 幾何平均(成長, 驗證, 進場) × (1 − 0.6 × 擁擠)
```

| 項目 | 看什麼 | 來源 |
|---|---|---|
| 成長 | 營收年增、6 個月相對 SPY 的強度（都用當天全體的百分位） | Massive、SEC |
| 驗證 | 連續幾季營收季增、毛利率；金融業改用淨利率 | SEC |
| 進場 | 日均成交額、市值落在小資金買得到的範圍 | Massive、SEC |
| 擁擠 | Hacker News 近 30 天提及與日均成交額。**越高越被扣分** | Massive、HN |

用幾何平均（相乘）是刻意的：任何一項接近零，總分就接近零，對應「要嘛各方面都成立，要嘛不值得看」。

通過市值、成交量、資料完整度門檻、分數最高的前 150 檔進**主榜**，其餘進**觀察清單**。風險標記（現金跑道短、虧損深、負債高、股本稀釋、成交薄、市值極小、已擁擠、資料不足）不影響分數，只提醒你。

所有門檻與權重都在 `crawler/config.py`，不用動其他程式。

## 日常維運

- **掛掉會通知你**：任何階段失敗，Actions 會開一個 `crawler-failure` issue；頁面頂端也會在資料超過 4 天沒更新時出現警示。
- **排程不會被停用**：每週一自動 commit 一次心跳檔（GitHub 對久無活動的 repo 會暫停排程，規則請以官方文件為準）。
- **資料庫大小**：`signals`、`scores` 與發布紀錄持續累積；全市場價格快取只保留最近 400 個日曆日。請監看實際儲存用量，勿直接刪除歷史評分。
- **換自己的股票池**：放一個 `universe.csv`（欄位 `ticker,name,cik`；SEC 基本面需要 CIK），把 `UNIVERSE_SOURCE` 設成 `csv`。
- **本機試跑**：`pip install -r crawler/requirements.txt`，設好環境變數後 `python -m crawler.run --only public --dry-run`（不寫資料庫，仍會呼叫外部資料來源）。測試：`python -m pytest -q`。

## 累積 8 週後：第一次回測

這個工具有沒有用，要靠歷史快照回答。看「分數越高的那一群，之後 4 週的右尾（最好的那幾檔）有沒有比較厚」，而不是平均報酬：

```sql
with base as (
  select sc.ticker, sc.as_of, sc.board,
         ntile(10) over (partition by sc.as_of, sc.board order by sc.score desc) as decile,
         sg.price as p0
  from scores sc join signals sg using (ticker, as_of)
), fwd as (
  select b.*, f.price as p1
  from base b
  join lateral (
    select price from signals s2
    where s2.ticker = b.ticker and s2.as_of >= b.as_of + 28
    order by s2.as_of limit 1
  ) f on true
)
select board, decile, count(*) as n,
       round(avg(p1 / p0 - 1)::numeric, 4) as avg_ret,
       round(percentile_cont(0.9) within group (order by p1 / p0 - 1)::numeric, 4) as p90_ret,
       round(max(p1 / p0 - 1)::numeric, 4) as best
from fwd group by 1, 2 order by 1, 2;
```

解讀時要小心：樣本短、雜訊大；下市的股票之後沒有價格，會被這個查詢排除，讓結果偏樂觀（存活者偏誤）。

## 現有專案升級（2026-10-18）

這次更新以 GitHub 版本 `5707b08` 為基底，保留台股、金融業淨利率評分、主榜 150 檔限制、大戶訊號、自選筆記、Form C-U、LINE、Telegram 與估值回測。

1. 在部署新版爬蟲前，執行 `supabase/migrations/20261018_reliable_publication.sql`。這份遷移已包含金融業淨利率欄位；若已執行較早版本，只需另執行 `supabase/migrations/20261018_usability_profit_margin.sql`，補上前台所需的 `latest_board.profit_margin`。`schema.sql` 是完整安裝用。升級保留既有歷史與讀取權限。
2. 部署更新分支，確認 Actions Secrets 已設定。價格預設仍為 `massive`；可選用 Repository Variable `PRICE_SOURCE=yahoo`，只切換價格來源，基本面仍使用 SEC。
3. 手動執行 `daily-crawl`，`only=public`。舊的調整價快取會逐日重建為原始價快取；原始價在讀取時統一套用分割事件。中斷後可續跑，不必再次勾選 `full_refresh`。
4. 確認 `crawl_runs.stats.public.published=true`、`batch_id` 存在，且 `latest_board` 的筆數與該批次 `row_count` 相符，再恢復例行排程。`partial` 可能已有完整發布，但有來源缺漏，請檢查 `warnings`。

遷移後，`latest_board` 只顯示完整發布的批次。首次新版發布完成前榜單會暫時為空，舊歷史仍保留，因此請把遷移與首次執行安排在同一次維護時段。新版價格快取也供績效報表使用；若重建尚未完成，報表會保留上一次結果並回報警告。

- **完整發布**：先上傳暫存列，再由資料庫交易一次發布。上傳不完整或驗證失敗不影響上一份完整榜單；同日重跑會替換當天股票池。
- **基本面期限**：7 天到期重抓，超過 21 天不再參與評分；期限內沿用舊資料會顯示標記。`FULL_REFRESH=1` 會真正重抓尚未到期的資料。
- **Hacker News 快取**：成功查詢（包括零筆）保存 24 小時；查詢失敗不當成零筆，也不快取。
- **可追溯性**：發布紀錄保存評分版本、程式雜湊、設定、股票池與來源狀態，原始評分欄位與來源日期存入 `signals`。
- **前端**：各來源獨立載入、可重新載入，顯示來源日期與缺漏，並防止跨批次分頁混用。
- **操作與市場切換**：登入寄送期間防止重複提交，斷線後可重試；台股連結、日期與來源使用台股資料；成績單忽略切換前的延遲回應；鍵盤可進入筆記並返回原列。
- **篩選與手機版**：保留美股、台股與募資條件。手機將進階篩選與資料來源說明收合，顯示已套用的條件數量；重要錯誤仍直接呈現。「條件組名稱」可將目前美股篩選存為按鈕，僅儲存在此瀏覽器，最多保留 8 組。

## 測試與資料限制

```sh
pip install -r crawler/requirements.txt -r requirements-dev.txt
python -m pytest -q
npm install --ignore-scripts
npx playwright install chromium
npm test
# 只跑前台測試（真實 Tabulator / Chart.js，模擬 Supabase）
npm run test:ui
```

檢查涵蓋 SEC/台股解析、評分、快取、發布交易與 RLS、介面登入/重試/篩選，以及既有 LINE 指令。`tests/usability.test.cjs` 保留原本 20 個易用性情境，另補手機篩選、台股條件還原、鍵盤循環與瀏覽器儲存失敗情境，使用與前台相同版本的表格和圖表套件。這是自動化操作測試，並非真人受測結果。測試使用本機資料與模擬服務，不會向使用者發送 LINE 或 Telegram 訊息。真實 API 權限與 Supabase 部署仍需在線上驗證。

Massive 的報酬率包含股票分割調整、不包含股息；Yahoo 選項包含分割與股息調整，切換來源時不能視為相同報酬定義。SEC 財報取得日期也不是財報期間，申報本身可能落後。HN 名稱比對仍可能有同名誤差；百分位分數仍受當日股票池影響。

## 資料來源與授權

- 價量：預設 Massive，也可選 Yahoo Finance（yfinance）。基本面：SEC EDGAR companyfacts。預設仍需登入才能讀取；公開資料前請確認各來源授權。
- 募資案：SEC EDGAR（公開申報）。請維持 `SEC_USER_AGENT`，並不要調高請求頻率。
- 社群關注度：Hacker News Search API。
- 前端套件（皆 MIT，已鎖定版本，無需建置）：Tabulator 6.3.0、Chart.js 4.4.4、supabase-js 2.45.4。要再加一層保護，可以替 `docs/index.html` 的三個 script 加上 SRI（`integrity` 屬性）。

## 檔案

```
supabase/schema.sql          資料表、檢視、權限（預設私有）
crawler/                     config 門檻 · universe · prices · fundamentals · attention · score · formc · run
.github/workflows/daily.yml  排程、失敗通知、心跳
docs/                        index.html · style.css · app.js · config.js
tests/test_core.py           離線測試
```
