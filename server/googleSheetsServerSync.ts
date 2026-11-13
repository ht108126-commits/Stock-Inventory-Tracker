import crypto from 'node:crypto';
import { DEFAULT_FEE_SETTINGS, formatTaipeiDateTime, isTaiwanMarketOpen } from '../shared/calculations';
import {
  buildAllSheetTabsData,
  extractSpreadsheetId,
  matchSheetTabName,
  parsePortfolioFromSheetTabs,
  SHEET_TAB_NAMES,
} from '../shared/sheetsEngine';
import { FeeSettings } from '../shared/types';
import { normalizeStockCode } from '../shared/twStockDictionary';
import { fetchBatchStockQuotes } from './quoteService';

export const USER_DEFAULT_SPREADSHEET_ID =
  process.env.DEFAULT_SPREADSHEET_ID || '1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw';

export interface ServerAutoSyncConfig {
  enabled: boolean;
  spreadsheetId: string;
  intervalMinutes: number;
  marketHoursOnly: boolean;
  feeSettings: FeeSettings;
  sessionAccessToken?: string;
  sessionTokenExpiresAt?: number;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  ownerEmail?: string;
}

export interface AutoSyncLogEntry {
  id: string;
  timestamp: string;
  trigger: 'scheduler_10m' | 'cloud_cron' | 'manual_server';
  status: 'success' | 'skipped' | 'error';
  spreadsheetId: string;
  updatedCount: number;
  authMethod: string;
  message: string;
  quotesSummary?: Array<{ code: string; name: string; price: number; changePercent: number }>;
}

// 純記憶體狀態（零資料庫儲存，登出時可立即銷毀）
let runtimeSyncConfig: ServerAutoSyncConfig = {
  enabled: true,
  spreadsheetId: USER_DEFAULT_SPREADSHEET_ID,
  intervalMinutes: Number(process.env.AUTO_SYNC_INTERVAL_MINUTES) || 10,
  marketHoursOnly: process.env.MARKET_HOURS_ONLY === 'true',
  feeSettings: { ...DEFAULT_FEE_SETTINGS },
};

let lastSyncAt: string | null = null;
let nextSyncAt: string | null = null;
let isServerSyncing = false;
const syncLogs: AutoSyncLogEntry[] = [];
let schedulerTimer: NodeJS.Timeout | null = null;

// Service Account / ADC Token 快取
let cachedServerToken: { token: string; expiresAt: number; method: string } | null = null;

/**
 * 指數退避重試包裝器 (針對 429 Too Many Requests 與 5xx Server Error 最多重試 3 次)
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) {
      return res;
    }
    attempt++;
    if (attempt > maxRetries) {
      return res;
    }
    const delayMs = Math.min(8000, 600 * Math.pow(2, attempt - 1) + Math.random() * 250);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

/**
 * 使用 Node 原生 crypto 簽署 Google Service Account JWT 並換取 Access Token
 */
async function getTokenFromServiceAccountJson(jsonStr: string): Promise<{
  token: string;
  expiresIn: number;
  email: string;
} | null> {
  try {
    const sa = JSON.parse(jsonStr);
    if (!sa.client_email || !sa.private_key) return null;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signingInput = `${b64Header}.${b64Payload}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(sa.private_key, 'base64url');
    const assertion = `${signingInput}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    return {
      token: data.access_token,
      expiresIn: data.expires_in || 3500,
      email: sa.client_email,
    };
  } catch {
    return null;
  }
}

/**
 * 在 Google Cloud Run 環境下，直接向 GCP Metadata Server 取得預設服務帳號 Access Token
 */
async function getTokenFromCloudRunMetadata(): Promise<{
  token: string;
  expiresIn: number;
} | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const url =
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token?scopes=https://www.googleapis.com/auth/spreadsheets';
    const res = await fetch(url, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    return {
      token: data.access_token,
      expiresIn: data.expires_in || 3000,
    };
  } catch {
    return null;
  }
}

/**
 * 使用 OAuth 2.0 Refresh Token 換取新的 Access Token
 */
async function getTokenFromRefreshToken(): Promise<{
  token: string;
  expiresIn: number;
} | null> {
  const clientId = runtimeSyncConfig.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = runtimeSyncConfig.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = runtimeSyncConfig.refreshToken || process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;
    return {
      token: data.access_token,
      expiresIn: data.expires_in || 3500,
    };
  } catch {
    return null;
  }
}

/**
 * 取得後端可用的 Google Sheets API Access Token
 */
export async function resolveServerAccessToken(): Promise<{
  token: string;
  method: string;
} | null> {
  // 1. 優先檢查快取之 Service Account / Refresh Token
  if (cachedServerToken && cachedServerToken.expiresAt > Date.now() + 60_000) {
    return { token: cachedServerToken.token, method: cachedServerToken.method };
  }

  // 2. 檢查環境變數 GOOGLE_SERVICE_ACCOUNT_JSON
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const saToken = await getTokenFromServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (saToken) {
      cachedServerToken = {
        token: saToken.token,
        expiresAt: Date.now() + saToken.expiresIn * 1000,
        method: `ServiceAccount (${saToken.email})`,
      };
      return { token: saToken.token, method: cachedServerToken.method };
    }
  }

  // 3. 檢查 OAuth Refresh Token
  const refreshed = await getTokenFromRefreshToken();
  if (refreshed) {
    cachedServerToken = {
      token: refreshed.token,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
      method: 'OAuth2 RefreshToken',
    };
    return { token: refreshed.token, method: 'OAuth2 RefreshToken' };
  }

  // 4. 檢查使用者登入期間授權給記憶體之 Session Access Token
  if (
    runtimeSyncConfig.sessionAccessToken &&
    (!runtimeSyncConfig.sessionTokenExpiresAt ||
      runtimeSyncConfig.sessionTokenExpiresAt > Date.now())
  ) {
    return {
      token: runtimeSyncConfig.sessionAccessToken,
      method: 'Browser Session OAuth Token',
    };
  }

  // 5. 檢查 Google Cloud Run 原生 Metadata Server (ADC)
  const adcToken = await getTokenFromCloudRunMetadata();
  if (adcToken) {
    cachedServerToken = {
      token: adcToken.token,
      expiresAt: Date.now() + adcToken.expiresIn * 1000,
      method: 'CloudRun Default ServiceAccount (ADC)',
    };
    return { token: adcToken.token, method: cachedServerToken.method };
  }

  return null;
}

/**
 * 後端執行一次「讀取試算表 -> 抓取最新台股報價 -> 重算總覽 -> 僅更新分頁1 (pricesOnly: true)」
 * 讓你不開網頁也能每 10 分鐘自動更新 Google 試算表！
 */
export async function executeServerPriceSync(
  trigger: AutoSyncLogEntry['trigger'] = 'scheduler_10m',
  overrideToken?: string,
  overrideSpreadsheetId?: string
): Promise<AutoSyncLogEntry> {
  const spreadsheetId = extractSpreadsheetId(
    overrideSpreadsheetId || runtimeSyncConfig.spreadsheetId || USER_DEFAULT_SPREADSHEET_ID
  );
  const nowStr = formatTaipeiDateTime(new Date());

  if (!spreadsheetId) {
    const entry: AutoSyncLogEntry = {
      id: `sync_${Date.now()}`,
      timestamp: nowStr,
      trigger,
      status: 'skipped',
      spreadsheetId: '',
      updatedCount: 0,
      authMethod: 'none',
      message: '尚未設定目標 Google 試算表 ID',
    };
    pushSyncLog(entry);
    return entry;
  }

  if (
    trigger === 'scheduler_10m' &&
    runtimeSyncConfig.marketHoursOnly &&
    !isTaiwanMarketOpen()
  ) {
    const entry: AutoSyncLogEntry = {
      id: `sync_${Date.now()}`,
      timestamp: nowStr,
      trigger,
      status: 'skipped',
      spreadsheetId,
      updatedCount: 0,
      authMethod: 'market_hours_guard',
      message: '目前為台股休市時段（已開啟僅開盤時段更新保護），跳過本次背景刷新',
    };
    pushSyncLog(entry);
    return entry;
  }

  if (isServerSyncing) {
    const entry: AutoSyncLogEntry = {
      id: `sync_${Date.now()}`,
      timestamp: nowStr,
      trigger,
      status: 'skipped',
      spreadsheetId,
      updatedCount: 0,
      authMethod: 'lock',
      message: '前一次同步尚在進行中，已排入保護鎖略過重複觸發',
    };
    return entry;
  }

  isServerSyncing = true;
  try {
    let token = overrideToken || '';
    let authMethod = overrideToken ? 'Provided OAuth Token' : '';

    if (!token) {
      const resolved = await resolveServerAccessToken();
      if (!resolved) {
        const entry: AutoSyncLogEntry = {
          id: `sync_${Date.now()}`,
          timestamp: nowStr,
          trigger,
          status: 'skipped',
          spreadsheetId,
          updatedCount: 0,
          authMethod: 'unconfigured',
          message:
            '待授權：請在網頁登入 Google 帳號，或在 Cloud Run 設定服務帳號共用權限以啟用免開網頁背景刷新',
        };
        pushSyncLog(entry);
        return entry;
      }
      token = resolved.token;
      authMethod = resolved.method;
    }

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 1. 讀取工作簿 Metadata 找出分頁名稱與 sheetId
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?includeGridData=false`;
    const metaRes = await fetchWithRetry(metaUrl, { headers: authHeaders });

    if (metaRes.status === 401 || metaRes.status === 403) {
      if (runtimeSyncConfig.sessionAccessToken === token) {
        runtimeSyncConfig.sessionAccessToken = undefined;
      }
      cachedServerToken = null;
      throw new Error(
        `Google Sheets API 權限不足或憑證過期 (HTTP ${metaRes.status})。請確認已將試算表共用給服務帳號或重新登入授權。`
      );
    }

    if (!metaRes.ok) {
      throw new Error(`無法讀取試算表 Metadata (HTTP ${metaRes.status})`);
    }

    const metaJson = (await metaRes.json()) as {
      sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
    };
    const sheetsList = metaJson.sheets || [];
    const tabTitles = sheetsList
      .map((s) => s.properties?.title || '')
      .filter(Boolean);

    const overviewTabTitle =
      matchSheetTabName(tabTitles, 'OVERVIEW') || tabTitles[0] || SHEET_TAB_NAMES.OVERVIEW;
    const txTabTitle = matchSheetTabName(tabTitles, 'TRANSACTIONS');
    const realizedTabTitle = matchSheetTabName(tabTitles, 'REALIZED');

    // 2. 批次讀取分頁內容
    const rangesToRead = [overviewTabTitle];
    if (txTabTitle) rangesToRead.push(txTabTitle);
    if (realizedTabTitle) rangesToRead.push(realizedTabTitle);

    const rangesQuery = rangesToRead
      .map((r) => `ranges=${encodeURIComponent(`'${r.replace(/'/g, "''")}'!A1:Z500`)}`)
      .join('&');

    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchGet?${rangesQuery}&valueRenderOption=FORMATTED_VALUE`;
    const valuesRes = await fetchWithRetry(valuesUrl, { headers: authHeaders });
    if (!valuesRes.ok) {
      throw new Error(`無法讀取試算表資料列 (HTTP ${valuesRes.status})`);
    }

    const valuesJson = (await valuesRes.json()) as {
      valueRanges?: Array<{ range?: string; values?: string[][] }>;
    };
    const valueRanges = valuesJson.valueRanges || [];

    const overviewRows = valueRanges[0]?.values || [];
    const transactionRows = txTabTitle ? valueRanges[1]?.values || [] : [];
    const realizedRows =
      realizedTabTitle ? valueRanges[txTabTitle ? 2 : 1]?.values || [] : [];

    // 3. 解析出當前有效庫存
    const portfolio = parsePortfolioFromSheetTabs({
      overviewRows,
      transactionRows,
      realizedRows,
    });

    if (portfolio.holdings.length === 0) {
      const entry: AutoSyncLogEntry = {
        id: `sync_${Date.now()}`,
        timestamp: nowStr,
        trigger,
        status: 'skipped',
        spreadsheetId,
        updatedCount: 0,
        authMethod,
        message: '試算表目前無有效庫存持股（空白誤覆蓋安全防護已啟動，不執行覆寫）',
      };
      pushSyncLog(entry);
      return entry;
    }

    // 4. 批次向 TWSE / TPEx / Yahoo 抓取所有持股最新即時報價
    const codes = portfolio.holdings.map((h) => normalizeStockCode(h.code));
    const quotesMap = await fetchBatchStockQuotes(codes, true);

    const quotesSummary: AutoSyncLogEntry['quotesSummary'] = [];
    for (const holding of portfolio.holdings) {
      const norm = normalizeStockCode(holding.code);
      const quote = quotesMap[norm];
      if (quote && quote.price > 0) {
        holding.currentPrice = quote.price;
        holding.previousClose = quote.previousClose;
        holding.change = quote.change;
        holding.changePercent = quote.changePercent;
        if (!holding.name || holding.name === holding.code) {
          holding.name = quote.name;
        }
        quotesSummary.push({
          code: norm,
          name: holding.name,
          price: quote.price,
          changePercent: quote.changePercent,
        });
      }
    }

    // 5. 重新計算分頁 1「個股庫存統計總覽」資料列 (pricesOnly: true 絕不更動分頁 2、3、4)
    const built = buildAllSheetTabsData(portfolio, runtimeSyncConfig.feeSettings);

    // 先清空分頁 1 舊內容，再寫入最新總覽
    const escapedOverviewTitle = `'${overviewTabTitle.replace(/'/g, "''")}'`;
    await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(`${escapedOverviewTitle}!A:ZZ`)}:clear`,
      {
        method: 'POST',
        headers: authHeaders,
      }
    );

    const updateRes = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(
        `${escapedOverviewTitle}!A1`
      )}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          range: `${escapedOverviewTitle}!A1`,
          majorDimension: 'ROWS',
          values: built.overviewRows,
        }),
      }
    );

    if (!updateRes.ok) {
      throw new Error(`寫入個股庫存統計總覽失敗 (HTTP ${updateRes.status})`);
    }

    // 6. 套用數字與百分比保護格式 (確保股票代碼前導零與損益整數格式不跑掉)
    const overviewSheetObj = sheetsList.find(
      (s) => s.properties?.title === overviewTabTitle
    );
    if (overviewSheetObj?.properties?.sheetId !== undefined) {
      const sheetId = overviewSheetObj.properties.sheetId;
      await fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
          spreadsheetId
        )}:batchUpdate`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            requests: [
              // 股票代碼欄 (Col A) 強制純文字格式避免 0050 / 00878 前導零被吃掉
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 4,
                    endRowIndex: 4 + portfolio.holdings.length + 5,
                    startColumnIndex: 0,
                    endColumnIndex: 1,
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: { type: 'TEXT' },
                    },
                  },
                  fields: 'userEnteredFormat.numberFormat',
                },
              },
              // 總成本、總市值、預估損益 (Col G, H, I -> index 6, 7, 8) 強制整數格式
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 4,
                    endRowIndex: 4 + portfolio.holdings.length + 5,
                    startColumnIndex: 6,
                    endColumnIndex: 9,
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: {
                        type: 'NUMBER',
                        pattern: '#,##0;[Red]-#,##0;0',
                      },
                    },
                  },
                  fields: 'userEnteredFormat.numberFormat',
                },
              },
              // 預估報酬率與投組比重 (Col J, K -> index 9, 10) 強制純文字避免百分比放大 100 倍
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startRowIndex: 4,
                    endRowIndex: 4 + portfolio.holdings.length + 5,
                    startColumnIndex: 9,
                    endColumnIndex: 11,
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: { type: 'TEXT' },
                    },
                  },
                  fields: 'userEnteredFormat.numberFormat',
                },
              },
            ],
          }),
        }
      ).catch(() => {});
    }

    lastSyncAt = nowStr;
    const entry: AutoSyncLogEntry = {
      id: `sync_${Date.now()}`,
      timestamp: nowStr,
      trigger,
      status: 'success',
      spreadsheetId,
      updatedCount: portfolio.holdings.length,
      authMethod,
      message: `成功刷新 ${portfolio.holdings.length} 檔持股即時現價並回寫「${overviewTabTitle}」`,
      quotesSummary,
    };
    pushSyncLog(entry);
    return entry;
  } catch (err: any) {
    const entry: AutoSyncLogEntry = {
      id: `sync_${Date.now()}`,
      timestamp: nowStr,
      trigger,
      status: 'error',
      spreadsheetId,
      updatedCount: 0,
      authMethod: 'error',
      message: err?.message || '後端自動刷新試算表發生未知錯誤',
    };
    pushSyncLog(entry);
    return entry;
  } finally {
    isServerSyncing = false;
  }
}

function pushSyncLog(entry: AutoSyncLogEntry) {
  syncLogs.unshift(entry);
  if (syncLogs.length > 30) {
    syncLogs.length = 30;
  }
}

/**
 * 啟動或重啟後端每 N 分鐘（預設 10 分鐘）自動刷新排程器
 */
export function startServerAutoSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  const intervalMs = Math.max(1, runtimeSyncConfig.intervalMinutes || 10) * 60 * 1000;
  nextSyncAt = formatTaipeiDateTime(new Date(Date.now() + intervalMs));

  schedulerTimer = setInterval(async () => {
    if (!runtimeSyncConfig.enabled) return;
    nextSyncAt = formatTaipeiDateTime(new Date(Date.now() + intervalMs));
    await executeServerPriceSync('scheduler_10m');
  }, intervalMs);
}

/**
 * 供前端註冊或更新後端自動同步設定（例如使用者登入後自動綁定 Token 與 Spreadsheet ID）
 */
export function updateServerAutoSyncConfig(partial: Partial<ServerAutoSyncConfig>) {
  const prevInterval = runtimeSyncConfig.intervalMinutes;
  runtimeSyncConfig = {
    ...runtimeSyncConfig,
    ...partial,
    spreadsheetId: extractSpreadsheetId(
      partial.spreadsheetId || runtimeSyncConfig.spreadsheetId || USER_DEFAULT_SPREADSHEET_ID
    ),
  };
  if (partial.intervalMinutes && partial.intervalMinutes !== prevInterval) {
    startServerAutoSyncScheduler();
  }
}

/**
 * 使用者登出時，立即清除後端記憶體中之 Session 憑證與綁定設定（嚴格遵守零殘留隱私規範）
 */
export function clearServerSessionCredentials() {
  runtimeSyncConfig.sessionAccessToken = undefined;
  runtimeSyncConfig.sessionTokenExpiresAt = undefined;
  runtimeSyncConfig.ownerEmail = undefined;
}

/**
 * 取得後端自動刷新引擎狀態與歷史紀錄
 */
export function getServerAutoSyncStatus() {
  const allowedEmails = (process.env.ALLOWED_OWNER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled: runtimeSyncConfig.enabled,
    spreadsheetId: runtimeSyncConfig.spreadsheetId,
    intervalMinutes: runtimeSyncConfig.intervalMinutes,
    marketHoursOnly: runtimeSyncConfig.marketHoursOnly,
    marketOpenNow: isTaiwanMarketOpen(),
    hasSessionToken: Boolean(runtimeSyncConfig.sessionAccessToken),
    hasServiceAccountEnv: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    hasRefreshTokenEnv: Boolean(
      process.env.GOOGLE_REFRESH_TOKEN || runtimeSyncConfig.refreshToken
    ),
    ownerWhitelistEnabled: allowedEmails.length > 0,
    allowedEmails,
    lastSyncAt,
    nextSyncAt,
    recentLogs: syncLogs.slice(0, 15),
  };
}
