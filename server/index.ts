import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpreadsheetId, parseCsvToRows } from '../shared/sheetsEngine';
import { normalizeStockCode } from '../shared/twStockDictionary';
import {
  clearServerSessionCredentials,
  executeServerPriceSync,
  getServerAutoSyncStatus,
  resolveServerAccessToken,
  startServerAutoSyncScheduler,
  updateServerAutoSyncConfig,
  USER_DEFAULT_OWNER_EMAIL,
  USER_DEFAULT_SPREADSHEET_ID,
  USER_GCP_PROJECT_ID,
} from './googleSheetsServerSync';
import { fetchBatchStockQuotes, fetchSingleStockQuote } from './quoteService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(cors());
app.use(express.json({ limit: '5mb' }));

/**
 * 檢查是否通過私人白名單信箱驗證 (預設鎖定擁有者信箱 ht108126@gmail.com)
 */
function checkOwnerEmailAllowed(email?: string): { allowed: boolean; reason?: string } {
  const rawList = USER_DEFAULT_OWNER_EMAIL;
  const allowedList = rawList
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (allowedList.length === 0) {
    return { allowed: true };
  }
  if (!email) {
    return {
      allowed: false,
      reason: '此私人網站已啟用擁有者白名單保護 (ht108126@gmail.com)，請使用授權的 Google 帳號登入。',
    };
  }
  const normalized = email.trim().toLowerCase();
  if (!allowedList.includes(normalized)) {
    return {
      allowed: false,
      reason: `拒絕存取：帳號 ${email} 不在私人網站擁有者白名單 (ht108126@gmail.com) 中。`,
    };
  }
  return { allowed: true };
}

// 1. 單檔股票即時報價 API: GET /api/stock-price?code=XXX
app.get('/api/stock-price', async (req, res) => {
  try {
    const rawCode = String(req.query.code || '').trim();
    if (!rawCode) {
      res.status(400).json({ error: '請提供股票代碼參數 ?code=XXX' });
      return;
    }
    const bypassCache = req.query.force === 'true';
    const quote = await fetchSingleStockQuote(rawCode, bypassCache);
    res.json(quote);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '查詢單檔報價失敗' });
  }
});

// 2. 批次股票即時報價 API: POST /api/batch-stock-prices
app.post('/api/batch-stock-prices', async (req, res) => {
  try {
    const codes: string[] = Array.isArray(req.body?.codes) ? req.body.codes : [];
    const bypassCache = Boolean(req.body?.force);
    if (codes.length === 0) {
      res.json({ quotes: {}, updatedAt: new Date().toISOString() });
      return;
    }
    const quotes = await fetchBatchStockQuotes(
      codes.map((c) => normalizeStockCode(c)),
      bypassCache
    );
    res.json({
      quotes,
      count: Object.keys(quotes).length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || '批次查詢報價失敗' });
  }
});

// 3. Google Sheets CSV 匯出備援代理端點 (解決瀏覽器直接抓取 gviz/tq 與 export?format=csv 之 CORS 限制)
app.get('/api/sheets/csv-fallback', async (req, res) => {
  try {
    const spreadsheetId = extractSpreadsheetId(String(req.query.spreadsheetId || ''));
    const tabName = String(req.query.tabName || '').trim();
    const gid = String(req.query.gid || '0').trim();
    const accessToken = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();

    if (!spreadsheetId) {
      res.status(400).json({ error: '無效的 Spreadsheet ID' });
      return;
    }

    const candidateUrls = [
      tabName
        ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
            spreadsheetId
          )}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`
        : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
            spreadsheetId
          )}/gviz/tq?tqx=out:csv`,
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(
        spreadsheetId
      )}/export?format=csv&gid=${encodeURIComponent(gid)}`,
    ];

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; StockInventoryTracker/2.0)',
    };
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    for (const url of candidateUrls) {
      const response = await fetch(url, { headers });
      if (!response.ok) continue;
      const text = await response.text();
      // 若回傳 HTML 登入頁而非 CSV，跳過
      if (text.trim().startsWith('<!DOCTYPE') || text.includes('<html')) {
        continue;
      }
      const rows = parseCsvToRows(text);
      if (rows.length > 0) {
        res.json({ rows, sourceUrl: url });
        return;
      }
    }

    res.status(403).json({
      error: '無法透過 CSV 備援端點讀取試算表，請確認已登入 Google 帳號並完成 OAuth 授權。',
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'CSV 備援解析失敗' });
  }
});

// 4. 驗證私人網站擁有者身分 API (在 Cloud Run 環境下自動為擁有者簽發預設服務帳號 Access Token)
app.post('/api/auth/verify-owner', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const check = checkOwnerEmailAllowed(email);
  let serverTokenInfo: { token: string; method: string } | null = null;
  if (check.allowed) {
    serverTokenInfo = await resolveServerAccessToken().catch(() => null);
  }
  res.json({
    allowed: check.allowed,
    reason: check.reason,
    ownerEmail: USER_DEFAULT_OWNER_EMAIL,
    gcpProjectId: USER_GCP_PROJECT_ID,
    defaultSpreadsheetId: USER_DEFAULT_SPREADSHEET_ID,
    serverAccessToken: serverTokenInfo?.token || null,
    serverAuthMethod: serverTokenInfo?.method || null,
  });
});

// 5. 取得後端 10 分鐘自動刷新引擎狀態
app.get('/api/auto-sync/status', (_req, res) => {
  res.json(getServerAutoSyncStatus());
});

// 6. 註冊或更新後端 10 分鐘自動同步設定 (含使用者登入期間之 OAuth Token 同步)
app.post('/api/auto-sync/register', (req, res) => {
  const {
    enabled,
    spreadsheetId,
    intervalMinutes,
    marketHoursOnly,
    feeSettings,
    accessToken,
    expiresAt,
    ownerEmail,
  } = req.body || {};

  if (ownerEmail) {
    const check = checkOwnerEmailAllowed(ownerEmail);
    if (!check.allowed) {
      res.status(403).json({ error: check.reason });
      return;
    }
  }

  updateServerAutoSyncConfig({
    ...(enabled !== undefined ? { enabled: Boolean(enabled) } : {}),
    ...(spreadsheetId ? { spreadsheetId: String(spreadsheetId) } : {}),
    ...(intervalMinutes ? { intervalMinutes: Number(intervalMinutes) } : {}),
    ...(marketHoursOnly !== undefined ? { marketHoursOnly: Boolean(marketHoursOnly) } : {}),
    ...(feeSettings ? { feeSettings } : {}),
    ...(accessToken ? { sessionAccessToken: String(accessToken) } : {}),
    ...(expiresAt ? { sessionTokenExpiresAt: Number(expiresAt) } : {}),
    ...(ownerEmail ? { ownerEmail: String(ownerEmail) } : {}),
  });

  res.json({
    ok: true,
    status: getServerAutoSyncStatus(),
  });
});

// 7. 登出時立即清除後端記憶體憑證 (零殘留隱私架構)
app.post('/api/auto-sync/clear', (_req, res) => {
  clearServerSessionCredentials();
  res.json({ ok: true, message: '已立即銷毀後端記憶體中之授權憑證' });
});

// 8. Cloud Scheduler / Google Apps Script / 手動觸發後端試算表即時報價更新端點
const handleCronSync = async (req: express.Request, res: express.Response) => {
  const configuredSecret = process.env.CRON_SECRET;
  if (configuredSecret) {
    const providedSecret =
      req.headers['x-cron-secret'] || req.query.secret || req.body?.secret;
    if (providedSecret !== configuredSecret) {
      res.status(401).json({ error: '無效的 CRON_SECRET 排程密鑰' });
      return;
    }
  }

  const triggerType =
    req.query.source === 'cloud_scheduler' || req.headers['user-agent']?.includes('Google-Cloud-Scheduler')
      ? 'cloud_cron'
      : 'manual_server';

  const overrideToken =
    req.body?.accessToken ||
    req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() ||
    undefined;
  const overrideSheetId =
    req.body?.spreadsheetId || (req.query.spreadsheetId as string) || undefined;

  const logEntry = await executeServerPriceSync(
    triggerType,
    overrideToken,
    overrideSheetId
  );
  res.json(logEntry);
};

app.post('/api/cron/sync-prices', handleCronSync);
app.get('/api/cron/sync-prices', handleCronSync);

// 9. 健康檢查端點 (供 Google Cloud Run 探針使用)
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'stock-inventory-tracker',
    defaultSpreadsheetId: USER_DEFAULT_SPREADSHEET_ID,
    timestamp: new Date().toISOString(),
  });
});

// 10. 生產環境靜態檔案託管 (Google Cloud Run 單一容器全端部署)
const distDir = path.resolve(__dirname, '../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Stock-Inventory-Tracker] Server listening on http://0.0.0.0:${PORT}`);
  startServerAutoSyncScheduler();
});
