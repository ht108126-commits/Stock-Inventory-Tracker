# 個人股票庫存統計表（純 Google Sheet 雲端直連 ＋ 10 分鐘自動報價中樞）

本專案為專為台股投資人設計之**零後端資料庫儲存、100% 直連讀寫個人 Google 試算表**全端應用程式（React + TypeScript 前端 ＋ Express 即時報價與無頭同步後端），並針對 **Google Cloud Run 私人部署**與**免開網站每 10 分鐘自動更新試算表股價**進行深度架構升級。

---

## 一、解決痛點與 6 大核心架構優化

1. **【徹底解決痛點】免開網站也能每 10 分鐘自動刷新 Google Sheet 即時價格**：
   - **原因分析**：舊版設計僅在瀏覽器前端使用 `setInterval` 更新，只要關閉網頁或手機鎖屏就停止更新；且瀏覽器端 Google OAuth Access Token 實際效期僅 1 小時（3,600 秒），網頁開著超過 1 小時也會因 `401` 中斷同步。
   - **雙引擎解決方案**：
     - **引擎 A（後端無頭背景同步 `/api/cron/sync-prices`）**：Express 後端直接整合試算表讀寫引擎與證交所報價 API，支援 Google Cloud Run 預設服務帳號 (ADC)、Service Account JSON 與 OAuth Refresh Token。搭配 Cloud Scheduler 每 10 分鐘喚醒一次，**即使完全不開網站，你的 Google Sheet 也會每 10 分鐘自動更新最新現價、市值與損益**。
     - **引擎 B（Google 試算表內建 Apps Script 零成本排程器）**：系統內建一鍵複製的 Google Apps Script 程式碼（已綁定你的試算表 `1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw`），貼入 Google Sheet 的「擴充功能 > Apps Script」並設定每 10 分鐘時間觸發，連 Cloud Run 休眠時都能零成本自動刷價。
     - **引擎 C（前端常駐倒數計時器 ＋ 靜默續約）**：開啟網頁時頂部顯示 10 分鐘即時倒數，並支援 `login_hint` 自動續約。

2. **【報價防呆修正】解決台股盤前試撮 (08:30–09:00) 或冷門股無成交時現價歸零的 Bug**：
   - TWSE / TPEx MIS 在盤前試算或當盤無成交時，`z`（當盤成交價）會回傳 `"-"`。本系統實作多層價格推導：優先取 `z`（最新成交價）→ `oz`（零股成交價）→ 五檔最佳委買委賣中間價 (`b`/`a`) → `y`（昨收價），**絕不以 `0` 或 `NaN` 覆寫試算表**。

3. **【代碼正規化升級】智慧修補 5 碼／6 碼 ETF 被吃掉的前導零**：
   - 除修補 `50` → `0050` 外，針對台股一般公司代碼自 `1101` 起跳之規則，智慧識別被 Google Sheets 吃掉雙零的熱門 ETF（如 `878` → `00878`、`919` → `00919`、`929` → `00929`、`6208` → `006208`、`679B` → `00679B`）。

4. **【財務公式優化】券商手續費折數試算與預估賣出手續費開關**：
   - 支援自訂券商手續費折數（如 6 折、2.8 折）與整股/零股最低手續費門檻。
   - 未實現損益支援一鍵切換「原版公式（僅扣預估賣出證交稅）」與「精準淨值公式（扣預估證交稅＋預估賣出手續費）」。

5. **【ETF 配息稅務修正】新增「54C 境內股利所得佔比」設定**：
   - 台股 ETF 配息常含高比例「收益平準金」與「資本利得（76）」，依法免扣二代健保。本系統支援設定 54C 應稅比例與單筆 1,000 萬上限，僅在 54C 應稅金額達 NT$ 20,000 時課徵 2.11% 二代健保補充保費。

---

## 二、如何部署到 Google Cloud Run 並設定「只有你自己看得到這個網站」？

### 步驟 1：一鍵部署至 Google Cloud Run（同時啟用私人信箱白名單鎖定）

在專案目錄下執行以下 `gcloud` 指令（請將 `你的信箱@gmail.com` 替換為你的個人 Google 帳號）：

```bash
# 1. 設定 GCP 專案與台灣彰濱機房 (asia-east1)
gcloud config set project YOUR_GCP_PROJECT_ID
gcloud config set run/region asia-east1

# 2. 部署並鎖定 ALLOWED_OWNER_EMAILS 為你本人的信箱
gcloud run deploy stock-inventory-tracker \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --set-env-vars="DEFAULT_SPREADSHEET_ID=1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw,ALLOWED_OWNER_EMAILS=你的信箱@gmail.com,CRON_SECRET=your_private_cron_secret_888" \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi
```

### 步驟 2：讓網站「只有你自己看得到」的三道防護機制

1. **防護一：應用程式層級 `ALLOWED_OWNER_EMAILS` 信箱白名單鎖（最直覺）**
   - 未登入時，系統記憶體與畫面 100% 空白，不含任何股票資料。
   - 只要設定了 `ALLOWED_OWNER_EMAILS=你的信箱@gmail.com`，任何其他人就算拿到網址並嘗試用他們的 Google 帳號登入，前端與後端 `/api/auth/verify-owner` 都會立即攔截並拒絕存取。
2. **防護二：Google Cloud IAP (Identity-Aware Proxy) 官方閘道鎖（最高機密級，連登入頁都不給外人看）**
   - 前往 **Google Cloud Console > Security > Identity-Aware Proxy (IAP)**。
   - 找到 `stock-inventory-tracker` 服務並開啟 IAP 開關。
   - 點選右側「新增主體 (Add Principal)」，輸入你的個人 Gmail 信箱，授予角色 **`IAP-secured Web App User`**。
   - 開啟後，任何未授權者在連線到你的網站容器前，就會在 Google 官方邊界閘道被直接阻擋。
3. **防護三：Cloud Run 原生 IAM 驗證 (`--no-allow-unauthenticated`)**
   - 若部署時將 `--allow-unauthenticated` 改為 `--no-allow-unauthenticated`，則所有外部流量皆無法直接開啟網址，你可透過本機執行 `gcloud run services proxy stock-inventory-tracker --port=8080` 在本機 `http://localhost:8080` 私密開啟。

---

## 三、如何設定「不開網站也每 10 分鐘自動更新 Google 試算表價格」？

你有兩種免開網頁的自動更新方式可選：

### 方法 A：在 Google 試算表內貼上自動排程腳本（完全免費、最簡單）
1. 開啟你的 Google 試算表 [我的股票庫存統計表](https://docs.google.com/spreadsheets/d/1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw/edit)。
2. 點選上方選單 **「擴充功能」>「Apps Script」**。
3. 點擊本網站右上角 **「免開網頁 10 分鐘排程 & Cloud Run」>「2. 免開網頁 Apps Script 排程器」**，一鍵複製腳本貼上並儲存。
4. 在 Apps Script 左側點選鬧鐘圖示 **「觸發條件 (Triggers)」>「新增觸發條件」**，設定 `autoRefreshTaiwanStockPrices` 為 **「時間驅動 > 分鐘計時器 > 每 10 分鐘」** 即可完成！

### 方法 B：使用 Cloud Run 後端 ＋ Cloud Scheduler 每 10 分鐘自動同步
1. 在 GCP Console 查看你的 Cloud Run 服務所使用的 **服務帳號信箱 (Service Account Email)**（例如 `xxx-compute@developer.gserviceaccount.com`）。
2. 打開你的 Google 試算表，點選右上角「共用 (Share)」，將該服務帳號信箱加入為 **「編輯者 (Editor)」**。
3. 建立 Cloud Scheduler 每 10 分鐘觸發後端 `/api/cron/sync-prices`：
   ```bash
   gcloud scheduler jobs create http sync-tw-stock-prices-10m \
     --location=asia-east1 \
     --schedule="*/10 9-14 * * 1-5" \
     --time-zone="Asia/Taipei" \
     --uri="https://你的CloudRun網址.run.app/api/cron/sync-prices?source=cloud_scheduler" \
     --http-method=POST \
     --headers="x-cron-secret=your_private_cron_secret_888"
   ```
