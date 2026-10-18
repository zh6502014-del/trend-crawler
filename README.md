# 趨勢爬蟲

每天自動從公開資料找出「實質很強、但還沒被擠滿」的美股小型股，以及 SEC 上正在募資的 Reg CF 新創，整理成一個私人 dashboard。

它產出的是**研究線索，不是投資建議**，也不預測股價。

LINE 個人研究助理的指令、免費額度、AI 選配設定與部署步驟，請看 [LINE Bot 操作與部署](LINE_BOT.md)。

```
GitHub Actions（每個交易日收盤後）
   ├─ yfinance          價量與財報   ┐
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
2. Settings → Secrets and variables → Actions，新增三個 secret：
   - `SUPABASE_URL`：Project URL
   - `SUPABASE_SERVICE_KEY`：service_role key（只放這裡，永遠不要放進網頁）
   - `SEC_USER_AGENT`：`你的名字 你的信箱@example.com`（SEC 規定要留聯絡方式，否則會擋）
3. Settings → Pages，Source 選 Deploy from a branch，資料夾選 `/docs`。

**3. 前端**
編輯 `docs/config.js`，填入 Project URL 和 **anon** key。到 Supabase → Authentication → URL Configuration，把 Site URL 設成你的 GitHub Pages 網址（登入連結才會導回來）。

**4. 第一次執行**
GitHub → Actions → daily-crawl → Run workflow，勾選 `full_refresh`。第一次要抓所有候選股的財報，大約 15 到 40 分鐘。之後每天只更新一週以上沒更新的部分，約幾分鐘。

跑完打開 Pages 網址，輸入 Email，點信裡的連結登入。

## 分數怎麼算

```
分數 = 100 × 幾何平均(成長, 驗證, 進場) × (1 − 0.6 × 擁擠)
```

| 項目 | 看什麼 | 來源 |
|---|---|---|
| 成長 | 營收年增、6 個月相對 SPY 的強度（都用當天全體的百分位） | yfinance |
| 驗證 | 連續幾季營收季增、毛利率 | yfinance |
| 進場 | 日均成交額、市值落在小資金買得到的範圍 | yfinance |
| 擁擠 | 分析師人數、機構持股、Hacker News 近 30 天提及。**越高越被扣分** | yfinance、HN |

用幾何平均（相乘）是刻意的：任何一項接近零，總分就接近零，對應「要嘛各方面都成立，要嘛不值得看」。

通過市值、成交量、資料完整度門檻的進**主榜**，其餘進**觀察清單**。風險標記（現金跑道短、虧損深、負債高、股本稀釋、成交薄、市值極小、已擁擠、資料不足）不影響分數，只提醒你。

所有門檻與權重都在 `crawler/config.py`，不用動其他程式。

## 日常維運

- **掛掉會通知你**：任何階段失敗，Actions 會開一個 `crawler-failure` issue；頁面頂端也會在資料超過 4 天沒更新時出現警示。
- **排程不會被停用**：每週一自動 commit 一次心跳檔（GitHub 對久無活動的 repo 會暫停排程，規則請以官方文件為準）。
- **資料庫大小**：`signals` 與 `scores` 每個交易日各新增約一千多列，粗估一年一百多 MB，Supabase 免費額度（500 MB）大約撐一兩年，實際請看你的用量頁面。這兩張表是回測的根本，不要輕易刪。
- **換自己的股票池**：放一個 `universe.csv`（欄位 `ticker,name`），把 `UNIVERSE_SOURCE` 設成 `csv`。
- **本機試跑**：`pip install -r crawler/requirements.txt`，設好環境變數後 `python -m crawler.run --dry-run`（不寫資料庫）。測試：`python -m pytest -q`。

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

## 還沒驗證的地方（請先看這裡）

這個專案在沒有網路的環境寫成。邏輯有離線測試（評分、解析、整條管線搭配假資料、前端搭配假的 Supabase），但**沒有對真實的 Yahoo、SEC、Hacker News、Supabase 跑過**。第一次執行後請檢查：

1. **Form C 欄位**：打開 `fundraises` 表，看營收、現金、截止日是不是有值。SEC 的 XML 標籤名稱我是憑記憶用寬鬆比對寫的，若某欄全空，調整 `crawler/formc.py` 的 `FIELD_PATTERNS`。
2. **yfinance 會壞**：它是非官方套件，Yahoo 一改版就可能暫時失效。遇到時先升級套件；管線遇到限流會自動停手並保存已抓的進度。
3. **Hacker News 是粗略的代理**：以公司名稱比對標題，同名或太通用的名字會誤判，多數小型股本來就是零。
4. **季度財報只有約 5 季**：「連續季增」是相鄰季的比較，不處理季節性。
5. **百分位是相對的**：分數是和當天股票池比出來的，不是絕對品質。池子整體很弱時，第一名也不一定好。
6. **第一週資料不完整**：基本面每天最多刷新 400 檔，第一次若沒勾 `full_refresh`，要幾天才會覆蓋完整。

## 資料來源與授權

- 價量與財報：Yahoo Finance，透過 yfinance。Yahoo 的條款以個人使用為主，**所以預設是私有模式**（要登入才看得到資料）。若你把 `schema.sql` 改成公開讀取，等於公開散布衍生資料，請先想清楚。
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
