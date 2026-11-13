#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="stock-notebook-8b041"
REGION="asia-east1"
SERVICE_NAME="stock-inventory-tracker"
OWNER_EMAIL="ht108126@gmail.com"
SPREADSHEET_ID="1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw"
CRON_SECRET="sit_cron_secret_8b041"

echo "================================================================="
echo "🚀 開始部署【個人股票庫存統計表】至 Google Cloud Run"
echo "📌 GCP Project ID : ${PROJECT_ID}"
echo "📌 專屬擁有者信箱 : ${OWNER_EMAIL}"
echo "📌 綁定試算表 ID  : ${SPREADSHEET_ID}"
echo "================================================================="

# 1. 切換 GCP 專案
gcloud config set project "${PROJECT_ID}"

# 2. 啟用必要 Google Cloud APIs
echo "⏳ 正在啟用 Cloud Run, Cloud Build, Cloud Scheduler, Google Sheets 與 Drive API..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  sheets.googleapis.com \
  drive.googleapis.com \
  --project="${PROJECT_ID}"

# 3. 從原始碼建置並部署至 Cloud Run (台灣彰濱 asia-east1)
echo "⏳ 正在建置容器並部署至 Cloud Run (${REGION})..."
gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},DEFAULT_SPREADSHEET_ID=${SPREADSHEET_ID},ALLOWED_OWNER_EMAILS=${OWNER_EMAIL},CRON_SECRET=${CRON_SECRET}" \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --quiet

# 4. 取得部署完成的 Cloud Run 服務網址與預設服務帳號
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# 5. 建立或更新每 10 分鐘自動觸發後端刷新股價的 Cloud Scheduler 排程
echo "⏳ 正在設定每 10 分鐘自動刷新試算表股價之 Cloud Scheduler 排程..."
if gcloud scheduler jobs describe sync-tw-stock-prices-10m --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http sync-tw-stock-prices-10m \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="*/10 * * * *" \
    --time-zone="Asia/Taipei" \
    --uri="${SERVICE_URL}/api/cron/sync-prices?source=cloud_scheduler" \
    --http-method=POST \
    --update-headers="x-cron-secret=${CRON_SECRET}" \
    --quiet
else
  gcloud scheduler jobs create http sync-tw-stock-prices-10m \
    --project="${PROJECT_ID}" \
    --location="${REGION}" \
    --schedule="*/10 * * * *" \
    --time-zone="Asia/Taipei" \
    --uri="${SERVICE_URL}/api/cron/sync-prices?source=cloud_scheduler" \
    --http-method=POST \
    --headers="x-cron-secret=${CRON_SECRET}" \
    --quiet || true
fi

echo ""
echo "================================================================="
echo "✅ 部署完成！"
echo "🌐 您的私人網站網址：${SERVICE_URL}"
echo "🔒 已鎖定僅允許擁有者信箱登入：${OWNER_EMAIL}"
echo ""
echo "💡 【最後一步：啟用免開網站每 10 分鐘自動刷新試算表】"
echo "請打開您的 Google 試算表："
echo "https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit"
echo "點選右上角「共用 (Share)」，將以下 Cloud Run 服務帳號加入為【編輯者 (Editor)】："
echo "👉 ${DEFAULT_SA}"
echo "================================================================="
