#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="stock-notebook-8b041"
PROJECT_NUMBER="276754032979"
DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
REGION="asia-east1"
SERVICE_NAME="stock-inventory-tracker"
OWNER_EMAIL="ht108126@gmail.com"
SPREADSHEET_ID="1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw"
CRON_SECRET="sit_cron_secret_8b041"

echo "================================================================="
echo "🚀 開始部署【個人股票庫存統計表】至 Google Cloud Run"
echo "📌 GCP Project ID   : ${PROJECT_ID}"
echo "📌 預設服務帳號     : ${DEFAULT_SA}"
echo "📌 專屬擁有者信箱   : ${OWNER_EMAIL}"
echo "📌 綁定試算表 ID    : ${SPREADSHEET_ID}"
echo "================================================================="

# 1. 切換 GCP 專案
gcloud config set project "${PROJECT_ID}"

# 2. 啟用必要 Google Cloud APIs
echo "⏳ [1/5] 正在啟用 Cloud Run, Cloud Build, Artifact Registry, Cloud Scheduler, Sheets 與 Drive API..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  sheets.googleapis.com \
  drive.googleapis.com \
  --project="${PROJECT_ID}"

# 3. 自動補齊預設服務帳號 (276754032979-compute@developer.gserviceaccount.com) 所需之 IAM 建置權限
echo "⏳ [2/5] 正在為服務帳號 ${DEFAULT_SA} 授予 Cloud Build / Storage / Artifact Registry 權限..."
for ROLE in \
  "roles/storage.admin" \
  "roles/storage.objectAdmin" \
  "roles/artifactregistry.admin" \
  "roles/logging.logWriter" \
  "roles/cloudbuild.builds.builder" \
  "roles/run.admin" \
  "roles/iam.serviceAccountUser"; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEFAULT_SA}" \
    --role="${ROLE}" \
    --condition=None \
    --quiet >/dev/null
done

echo "⏳ 等待 12 秒讓 Google Cloud IAM 權限生效..."
sleep 12

# 4. 建置並部署至 Cloud Run (台灣彰濱 asia-east1)
echo "⏳ [3/5] 正在建置容器並部署至 Cloud Run (${REGION})..."
if ! gcloud run deploy "${SERVICE_NAME}" \
  --source . \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},DEFAULT_SPREADSHEET_ID=${SPREADSHEET_ID},ALLOWED_OWNER_EMAILS=${OWNER_EMAIL},CRON_SECRET=${CRON_SECRET}" \
  --min-instances=0 \
  --max-instances=2 \
  --memory=512Mi \
  --quiet; then
  echo "⚠️ 偵測到 Cloud Build IAM 尚在同步，改用 Cloud Shell 本機 Docker 直接建置並推送映像檔..."
  gcloud artifacts repositories create cloud-run-source-deploy \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Cloud Run Docker repository" \
    --project="${PROJECT_ID}" --quiet || true

  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
  IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-run-source-deploy/${SERVICE_NAME}:latest"
  docker build -t "${IMAGE_URI}" .
  docker push "${IMAGE_URI}"

  gcloud run deploy "${SERVICE_NAME}" \
    --image "${IMAGE_URI}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --allow-unauthenticated \
    --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},DEFAULT_SPREADSHEET_ID=${SPREADSHEET_ID},ALLOWED_OWNER_EMAILS=${OWNER_EMAIL},CRON_SECRET=${CRON_SECRET}" \
    --min-instances=0 \
    --max-instances=2 \
    --memory=512Mi \
    --quiet
fi

# 5. 取得部署完成的 Cloud Run 服務網址
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" --project "${PROJECT_ID}" --region "${REGION}" --format="value(status.url)")

# 6. 建立或更新每 10 分鐘自動觸發後端刷新股價的 Cloud Scheduler 排程
echo "⏳ [4/5] 正在設定每 10 分鐘自動刷新試算表股價之 Cloud Scheduler 排程..."
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
echo "✅ [5/5] 部署大功告成！"
echo "🌐 您的私人網站網址：${SERVICE_URL}"
echo "🔒 已鎖定僅允許擁有者信箱登入：${OWNER_EMAIL}"
echo ""
echo "💡 【啟用免開網站每 10 分鐘自動刷新試算表】"
echo "請打開您的 Google 試算表："
echo "https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit"
echo "點選右上角「共用 (Share)」，將以下服務帳號信箱加入為【編輯者 (Editor)】："
echo "👉 ${DEFAULT_SA}"
echo "================================================================="
