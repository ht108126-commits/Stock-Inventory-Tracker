import { DEFAULT_FEE_SETTINGS } from '../../shared/calculations';
import {
  buildAllSheetTabsData,
  extractSpreadsheetId,
  matchSheetTabName,
  parsePortfolioFromSheetTabs,
  SHEET_TAB_NAMES,
  SheetTabKey,
} from '../../shared/sheetsEngine';
import { FeeSettings, LinkedSpreadsheet, PortfolioState } from '../../shared/types';

export const REQUIRED_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
  'profile',
].join(' ');

export const DEFAULT_USER_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw/edit?usp=drivesdk';
export const DEFAULT_USER_SHEET_ID = '1YWMTQS-wo_HUcQsWuewAZkn6wP36C-o2P5ftgc9WDCw';

export interface AuthSession {
  accessToken: string;
  email: string;
  name: string;
  picture?: string;
  issuedAt: number;
  sessionValidUntil: number; // 24 小時有效管理視窗
  tokenExpiresAt: number; // Google Access Token 實際到期時間戳
  mode: 'google_oauth' | 'manual_token';
}

export interface DriveSpreadsheetItem {
  id: string;
  name: string;
  modifiedTime: string;
  webViewLink?: string;
}

export class UnauthorizedSheetError extends Error {
  constructor(message = 'Google OAuth 授權憑證已失效 (401)，請重新授權連線。') {
    super(message);
    this.name = 'UnauthorizedSheetError';
  }
}

export class EmptyOverwriteProtectionError extends Error {
  constructor(
    message = '【空白誤覆蓋安全防護】偵測到本地資料為空，但雲端試算表「個股庫存統計總覽」仍有持股紀錄，系統已自動攔截寫入以保護您的試算表資料！'
  ) {
    super(message);
    this.name = 'EmptyOverwriteProtectionError';
  }
}

/**
 * 所有 Google API 請求針對 429 與 5xx 錯誤自動指數退避重試（最多 3 次）
 * 若回傳 401 則拋出 UnauthorizedSheetError 由上層清除失效 Token 並要求重新授權
 */
export async function googleApiFetch(
  url: string,
  accessToken: string,
  options: RequestInit = {},
  maxRetries = 3
): Promise<Response> {
  let attempt = 0;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  while (true) {
    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      throw new UnauthorizedSheetError();
    }

    if (res.status !== 429 && res.status < 500) {
      return res;
    }

    attempt++;
    if (attempt > maxRetries) {
      return res;
    }

    const backoffMs = Math.min(8000, 500 * Math.pow(2, attempt - 1) + Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

/**
 * 透過 Google Drive API 列出使用者雲端硬碟近期試算表清單
 */
export async function listRecentDriveSpreadsheets(
  accessToken: string,
  pageSize = 20
): Promise<DriveSpreadsheetItem[]> {
  const query = encodeURIComponent(
    "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
  );
  const fields = encodeURIComponent('files(id,name,modifiedTime,webViewLink)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=modifiedTime desc&pageSize=${pageSize}&fields=${fields}`;

  const res = await googleApiFetch(url, accessToken);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`無法讀取 Google Drive 試算表清單 (HTTP ${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { files?: DriveSpreadsheetItem[] };
  return data.files || [];
}

/**
 * 一鍵在 Google Drive 建立全新標準 4 分頁格式試算表並初始化表頭與格式
 */
export async function createStandardSpreadsheet(
  accessToken: string,
  title = `我的股票庫存統計表 (${new Date().toISOString().slice(0, 10)})`
): Promise<LinkedSpreadsheet> {
  const createUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
  const body = {
    properties: {
      title,
      locale: 'zh_TW',
      timeZone: 'Asia/Taipei',
    },
    sheets: [
      {
        properties: {
          title: SHEET_TAB_NAMES.OVERVIEW,
          index: 0,
          gridProperties: { rowCount: 200, columnCount: 15, frozenRowCount: 4 },
        },
      },
      {
        properties: {
          title: SHEET_TAB_NAMES.TRANSACTIONS,
          index: 1,
          gridProperties: { rowCount: 500, columnCount: 15, frozenRowCount: 3 },
        },
      },
      {
        properties: {
          title: SHEET_TAB_NAMES.REALIZED,
          index: 2,
          gridProperties: { rowCount: 300, columnCount: 15, frozenRowCount: 4 },
        },
      },
      {
        properties: {
          title: SHEET_TAB_NAMES.DIVIDENDS,
          index: 3,
          gridProperties: { rowCount: 300, columnCount: 15, frozenRowCount: 4 },
        },
      },
    ],
  };

  const res = await googleApiFetch(createUrl, accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`建立 Google 試算表失敗 (HTTP ${res.status}): ${errText}`);
  }

  const created = (await res.json()) as {
    spreadsheetId: string;
    spreadsheetUrl?: string;
    properties?: { title?: string };
  };

  const emptyState: PortfolioState = {
    holdings: [],
    buyRecords: [],
    realizedRecords: [],
    dividendRecords: [],
  };

  // 初始化標準空白表頭與格式
  await syncPortfolioToSpreadsheet({
    accessToken,
    spreadsheetId: created.spreadsheetId,
    state: emptyState,
    pricesOnly: false,
    allowEmptyOverwrite: true,
  });

  return {
    spreadsheetId: created.spreadsheetId,
    title: created.properties?.title || title,
    url:
      created.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
    linkedAt: new Date().toISOString(),
  };
}

/**
 * 讀取並解析 Google 試算表中的所有持股與交易資料
 * 支援：
 * 1. 標準 Google Sheets API v4 讀取與模糊分頁比對
 * 2. 若標準分頁無資料，自動掃描工作簿所有分頁
 * 3. 若 API 受限，透過後端 `/api/sheets/csv-fallback` 呼叫 Google Sheets CSV 匯出端點備援解析
 */
export async function loadPortfolioFromSpreadsheet(
  accessToken: string,
  rawSpreadsheetIdOrUrl: string
): Promise<{
  portfolio: PortfolioState;
  spreadsheetMeta: LinkedSpreadsheet;
}> {
  const spreadsheetId = extractSpreadsheetId(rawSpreadsheetIdOrUrl);
  if (!spreadsheetId) {
    throw new Error('請輸入有效的 Google 試算表網址或 Spreadsheet ID');
  }

  try {
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?includeGridData=false`;
    const metaRes = await googleApiFetch(metaUrl, accessToken);

    if (!metaRes.ok) {
      throw new Error(`讀取試算表資訊失敗 (HTTP ${metaRes.status})`);
    }

    const metaJson = (await metaRes.json()) as {
      spreadsheetId: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
    };

    const sheetTitle = metaJson.properties?.title || '我的股票庫存統計表';
    const sheets = metaJson.sheets || [];
    const availableTitles = sheets
      .map((s) => s.properties?.title || '')
      .filter(Boolean);

    const overviewTab = matchSheetTabName(availableTitles, 'OVERVIEW');
    const txTab = matchSheetTabName(availableTitles, 'TRANSACTIONS');
    const realizedTab = matchSheetTabName(availableTitles, 'REALIZED');
    const divTab = matchSheetTabName(availableTitles, 'DIVIDENDS');

    const tabsToFetch = Array.from(
      new Set(
        [overviewTab, txTab, realizedTab, divTab, ...availableTitles].filter(
          (t): t is string => Boolean(t)
        )
      )
    );

    const rangesQuery = tabsToFetch
      .map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'!A1:Z600`)}`)
      .join('&');

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchGet?${rangesQuery}&valueRenderOption=FORMATTED_VALUE`;
    const batchRes = await googleApiFetch(batchUrl, accessToken);

    if (!batchRes.ok) {
      throw new Error(`批次讀取試算表分頁失敗 (HTTP ${batchRes.status})`);
    }

    const batchJson = (await batchRes.json()) as {
      valueRanges?: Array<{ range?: string; values?: string[][] }>;
    };
    const valueRanges = batchJson.valueRanges || [];

    const tabRowsMap = new Map<string, string[][]>();
    tabsToFetch.forEach((tabName, idx) => {
      tabRowsMap.set(tabName, valueRanges[idx]?.values || []);
    });

    let overviewRows = overviewTab ? tabRowsMap.get(overviewTab) || [] : [];
    let transactionRows = txTab ? tabRowsMap.get(txTab) || [] : [];
    const realizedRows = realizedTab ? tabRowsMap.get(realizedTab) || [] : [];
    const dividendRows = divTab ? tabRowsMap.get(divTab) || [] : [];

    // 若模糊比對未命中標準名稱，依序掃描工作簿所有分頁尋找庫存或分筆明細表頭
    if (overviewRows.length === 0 && transactionRows.length === 0) {
      for (const [tabName, rows] of tabRowsMap.entries()) {
        const flatHeader = rows
          .slice(0, 10)
          .map((r) => r.join(' '))
          .join(' ');
        if (flatHeader.includes('交易動作') && transactionRows.length === 0) {
          transactionRows = rows;
        } else if (
          (flatHeader.includes('持有股數') || flatHeader.includes('平均成本')) &&
          overviewRows.length === 0
        ) {
          overviewRows = rows;
        }
      }
    }

    const portfolio = parsePortfolioFromSheetTabs({
      overviewRows,
      transactionRows,
      realizedRows,
      dividendRows,
    });

    return {
      portfolio,
      spreadsheetMeta: {
        spreadsheetId,
        title: sheetTitle,
        url:
          metaJson.spreadsheetUrl ||
          `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        linkedAt: new Date().toISOString(),
      },
    };
  } catch (primaryErr: any) {
    if (primaryErr instanceof UnauthorizedSheetError) {
      throw primaryErr;
    }

    // 備援解析：嘗試呼叫 Google Sheets CSV 匯出端點 (gviz/tq?tqx=out:csv & export?format=csv)
    const fallbackRes = await fetch(
      `/api/sheets/csv-fallback?spreadsheetId=${encodeURIComponent(
        spreadsheetId
      )}&tabName=${encodeURIComponent(SHEET_TAB_NAMES.OVERVIEW)}`,
      {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      }
    );

    if (fallbackRes.ok) {
      const fbData = (await fallbackRes.json()) as { rows?: string[][] };
      if (fbData.rows && fbData.rows.length > 0) {
        const portfolio = parsePortfolioFromSheetTabs({
          overviewRows: fbData.rows,
        });
        return {
          portfolio,
          spreadsheetMeta: {
            spreadsheetId,
            title: '我的股票庫存統計表 (CSV 備援載入)',
            url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
            linkedAt: new Date().toISOString(),
          },
        };
      }
    }

    throw primaryErr;
  }
}

/**
 * 清除指定分頁內容 (clearSheetTabs)
 * 優先以整張工作表範圍清除，若失敗則退回 A:ZZ 與單表 :clear
 */
async function clearSheetTabs(
  accessToken: string,
  spreadsheetId: string,
  tabTitles: string[]
): Promise<void> {
  if (tabTitles.length === 0) return;

  const escapedRanges = tabTitles.map((t) => `'${t.replace(/'/g, "''")}'`);
  const batchClearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values:batchClear`;

  // 1. 先嘗試整張工作表範圍格式 batchClear
  const res1 = await googleApiFetch(batchClearUrl, accessToken, {
    method: 'POST',
    body: JSON.stringify({ ranges: escapedRanges }),
  });

  if (res1.ok) return;

  // 2. 退回 A:ZZ 範圍 batchClear
  const azzRanges = escapedRanges.map((r) => `${r}!A:ZZ`);
  const res2 = await googleApiFetch(batchClearUrl, accessToken, {
    method: 'POST',
    body: JSON.stringify({ ranges: azzRanges }),
  });

  if (res2.ok) return;

  // 3. 退回逐一單表 :clear
  for (const r of azzRanges) {
    await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(r)}:clear`,
      accessToken,
      { method: 'POST' }
    ).catch(() => {});
  }
}

/**
 * 將本地最新投資組合狀態寫回已綁定的 Google 試算表
 * 實作：
 * - 空白誤覆蓋安全防護
 * - pricesOnly: true 僅更新分頁 1（個股庫存統計總覽）
 * - 自動偵測並補建缺失的標準分頁
 * - 全表清空後寫入 (clearSheetTabs) 防止底部殘留舊列
 * - batchUpdate 自動設定條件格式、損益整數格式 (#,##0;[Red]-#,##0;0) 與報酬率純文字格式
 */
export async function syncPortfolioToSpreadsheet(params: {
  accessToken: string;
  spreadsheetId: string;
  state: PortfolioState;
  feeSettings?: FeeSettings;
  pricesOnly?: boolean;
  allowEmptyOverwrite?: boolean;
}): Promise<{ updatedAt: string }> {
  const {
    accessToken,
    state,
    feeSettings = DEFAULT_FEE_SETTINGS,
    pricesOnly = false,
    allowEmptyOverwrite = false,
  } = params;
  const spreadsheetId = extractSpreadsheetId(params.spreadsheetId);
  if (!spreadsheetId) {
    throw new Error('缺少有效的 Spreadsheet ID');
  }

  // 1. 讀取工作簿現有分頁結構
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}?includeGridData=false`;
  const metaRes = await googleApiFetch(metaUrl, accessToken);
  if (!metaRes.ok) {
    throw new Error(`無法取得試算表結構 (HTTP ${metaRes.status})`);
  }

  const metaJson = (await metaRes.json()) as {
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  };
  let sheets = metaJson.sheets || [];
  let availableTitles = sheets
    .map((s) => s.properties?.title || '')
    .filter(Boolean);

  // 2. 空白誤覆蓋安全防護：
  // 若本地所有資料集合（庫存、買進、已實現、股利）皆為空，同步前先檢查雲端分頁 1 是否仍有持股資料
  const isLocalCompletelyEmpty =
    state.holdings.length === 0 &&
    state.buyRecords.length === 0 &&
    state.realizedRecords.length === 0 &&
    state.dividendRecords.length === 0;

  if (isLocalCompletelyEmpty && !allowEmptyOverwrite) {
    const existingOverviewTab =
      matchSheetTabName(availableTitles, 'OVERVIEW') || availableTitles[0];
    if (existingOverviewTab) {
      const checkRange = `'${existingOverviewTab.replace(/'/g, "''")}'!A1:M15`;
      const checkUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${encodeURIComponent(checkRange)}`;
      const checkRes = await googleApiFetch(checkUrl, accessToken);
      if (checkRes.ok) {
        const checkData = (await checkRes.json()) as { values?: string[][] };
        const rows = checkData.values || [];
        // 若超過 4 列（表頭之後仍有持股列），攔截寫入並拋出保護警示！
        if (rows.length > 4 && rows.slice(4).some((r) => r && r[0] && String(r[0]).trim())) {
          throw new EmptyOverwriteProtectionError();
        }
      }
    }
  }

  // 3. 檢查標準四分頁是否存在，若缺失則自動補建
  const resolvedTabs: Record<SheetTabKey, string> = {
    OVERVIEW:
      matchSheetTabName(availableTitles, 'OVERVIEW') || SHEET_TAB_NAMES.OVERVIEW,
    TRANSACTIONS:
      matchSheetTabName(availableTitles, 'TRANSACTIONS') ||
      SHEET_TAB_NAMES.TRANSACTIONS,
    REALIZED:
      matchSheetTabName(availableTitles, 'REALIZED') || SHEET_TAB_NAMES.REALIZED,
    DIVIDENDS:
      matchSheetTabName(availableTitles, 'DIVIDENDS') || SHEET_TAB_NAMES.DIVIDENDS,
  };

  const tabsToEnsure: SheetTabKey[] = pricesOnly
    ? ['OVERVIEW']
    : ['OVERVIEW', 'TRANSACTIONS', 'REALIZED', 'DIVIDENDS'];

  const missingTabRequests: any[] = [];
  for (const key of tabsToEnsure) {
    const targetName = resolvedTabs[key];
    if (!availableTitles.includes(targetName)) {
      missingTabRequests.push({
        addSheet: {
          properties: {
            title: targetName,
            gridProperties: { rowCount: 400, columnCount: 15 },
          },
        },
      });
    }
  }

  if (missingTabRequests.length > 0) {
    const addRes = await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ requests: missingTabRequests }),
      }
    );
    if (addRes.ok) {
      const refreshedMeta = await googleApiFetch(metaUrl, accessToken);
      if (refreshedMeta.ok) {
        const rmJson = (await refreshedMeta.json()) as typeof metaJson;
        sheets = rmJson.sheets || sheets;
        availableTitles = sheets
          .map((s) => s.properties?.title || '')
          .filter(Boolean);
      }
    }
  }

  // 4. 準備要寫入的資料列
  const built = buildAllSheetTabsData(state, feeSettings);

  // 5. 先清空要更新的分頁 (pricesOnly 僅清空分頁 1；完整同步則清空全 4 個分頁)
  const tabsToClear = pricesOnly
    ? [resolvedTabs.OVERVIEW]
    : [
        resolvedTabs.OVERVIEW,
        resolvedTabs.TRANSACTIONS,
        resolvedTabs.REALIZED,
        resolvedTabs.DIVIDENDS,
      ];

  await clearSheetTabs(accessToken, spreadsheetId, tabsToClear);

  // 6. 批次寫入最新內容
  const dataPayload: Array<{ range: string; majorDimension: 'ROWS'; values: (string | number)[][] }> =
    [
      {
        range: `'${resolvedTabs.OVERVIEW.replace(/'/g, "''")}'!A1`,
        majorDimension: 'ROWS',
        values: built.overviewRows,
      },
    ];

  if (!pricesOnly) {
    dataPayload.push(
      {
        range: `'${resolvedTabs.TRANSACTIONS.replace(/'/g, "''")}'!A1`,
        majorDimension: 'ROWS',
        values: built.transactionRows,
      },
      {
        range: `'${resolvedTabs.REALIZED.replace(/'/g, "''")}'!A1`,
        majorDimension: 'ROWS',
        values: built.realizedRows,
      },
      {
        range: `'${resolvedTabs.DIVIDENDS.replace(/'/g, "''")}'!A1`,
        majorDimension: 'ROWS',
        values: built.dividendRows,
      }
    );
  }

  const batchWriteUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}/values:batchUpdate`;
  const writeRes = await googleApiFetch(batchWriteUrl, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: dataPayload,
    }),
  });

  if (!writeRes.ok) {
    const errText = await writeRes.text().catch(() => '');
    throw new Error(`同步寫入 Google 試算表失敗 (HTTP ${writeRes.status}): ${errText}`);
  }

  // 7. 呼叫 batchUpdate 自動設定損益整數格式 (#,##0;[Red]-#,##0;0)、報酬率純文字格式與表頭樣式
  const formatRequests: any[] = [];
  const getSheetId = (title: string) =>
    sheets.find((s) => s.properties?.title === title)?.properties?.sheetId;

  const overviewSheetId = getSheetId(resolvedTabs.OVERVIEW);
  if (overviewSheetId !== undefined) {
    formatRequests.push(
      // 總成本(6)、總市值(7)、預估損益(8) 強制整數格式
      {
        repeatCell: {
          range: {
            sheetId: overviewSheetId,
            startRowIndex: 4,
            endRowIndex: Math.max(20, built.overviewRows.length + 2),
            startColumnIndex: 6,
            endColumnIndex: 9,
          },
          cell: {
            userEnteredFormat: {
              numberFormat: { type: 'NUMBER', pattern: '#,##0;[Red]-#,##0;0' },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      },
      // 報酬率(9)、比重(10) 強制純文字格式
      {
        repeatCell: {
          range: {
            sheetId: overviewSheetId,
            startRowIndex: 4,
            endRowIndex: Math.max(20, built.overviewRows.length + 2),
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
      }
    );
  }

  if (!pricesOnly) {
    const txSheetId = getSheetId(resolvedTabs.TRANSACTIONS);
    if (txSheetId !== undefined) {
      formatRequests.push(
        // 損益欄 (Col K -> index 10) 強制整數格式
        {
          repeatCell: {
            range: {
              sheetId: txSheetId,
              startRowIndex: 3,
              endRowIndex: Math.max(30, built.transactionRows.length + 2),
              startColumnIndex: 10,
              endColumnIndex: 11,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '#,##0;[Red]-#,##0;0' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 報酬率欄 (Col L -> index 11) 強制純文字格式
        {
          repeatCell: {
            range: {
              sheetId: txSheetId,
              startRowIndex: 3,
              endRowIndex: Math.max(30, built.transactionRows.length + 2),
              startColumnIndex: 11,
              endColumnIndex: 12,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'TEXT' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        }
      );
    }

    const realizedSheetId = getSheetId(resolvedTabs.REALIZED);
    if (realizedSheetId !== undefined) {
      formatRequests.push(
        // 已實現損益欄 (Col K -> index 10) 強制整數格式
        {
          repeatCell: {
            range: {
              sheetId: realizedSheetId,
              startRowIndex: 4,
              endRowIndex: Math.max(20, built.realizedRows.length + 2),
              startColumnIndex: 10,
              endColumnIndex: 11,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '#,##0;[Red]-#,##0;0' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        // 報酬率欄 (Col L -> index 11) 強制純文字格式
        {
          repeatCell: {
            range: {
              sheetId: realizedSheetId,
              startRowIndex: 4,
              endRowIndex: Math.max(20, built.realizedRows.length + 2),
              startColumnIndex: 11,
              endColumnIndex: 12,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'TEXT' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        }
      );
    }
  }

  if (formatRequests.length > 0) {
    await googleApiFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ requests: formatRequests }),
      }
    ).catch(() => {});
  }

  return { updatedAt: new Date().toISOString() };
}
