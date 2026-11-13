import {
   computeDividendOverview,
  computePortfolioOverview,
  computeRealizedOverview,
  DEFAULT_FEE_SETTINGS,
  formatTaipeiDateTime,
} from './calculations';
import {
  BuyRecord,
  DividendRecord,
  DividendType,
  FeeSettings,
  PortfolioState,
  RealizedRecord,
  StockHolding,
  StockLot,
  TradeCategory,
} from './types';
import { isEtfStock, lookupStockMeta, normalizeStockCode } from './twStockDictionary';

export const SHEET_TAB_NAMES = {
  OVERVIEW: '個股庫存統計總覽',
  TRANSACTIONS: '分筆交易明細',
  REALIZED: '已實現損益紀錄',
  DIVIDENDS: '配息配股紀錄',
} as const;

export type SheetTabKey = keyof typeof SHEET_TAB_NAMES;

/**
 * 解析 Google 試算表網址或直接輸入之 Spreadsheet ID
 */
export function extractSpreadsheetId(input: string): string {
  const trimmed = (input || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match && match[1]) return match[1];
  if (/^[a-zA-Z0-9-_]{20,60}$/.test(trimmed)) return trimmed;
  return '';
}

/**
 * 將數值字串安全轉為數字（移除 NT$, 逗號, %, 空白, 全形符號）
 */
export function parseSafeNumber(val: unknown, defaultVal = 0): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : defaultVal;
  if (val === null || val === undefined) return defaultVal;
  const str = String(val)
    .replace(/NT\$|\$|元|股|%|％|,|，|\s|\+/gi, '')
    .trim();
  if (!str || str === '-' || str === '--' || str === 'N/A') return defaultVal;
  const num = Number(str);
  return Number.isFinite(num) ? num : defaultVal;
}

/**
 * 修正因 Google Sheets 百分比格式誤套用導致損益數值放大 100 倍的異常
 */
export function fixHundredfoldPnlAnomaly(parsedPnl: number, expectedPnl: number): number {
  if (!Number.isFinite(parsedPnl)) return expectedPnl;
  if (Math.abs(expectedPnl) < 5) return parsedPnl;
  const diffDirect = Math.abs(parsedPnl - expectedPnl);
  const diffDiv100 = Math.abs(parsedPnl / 100 - expectedPnl);
  if (diffDiv100 < diffDirect * 0.1 && Math.abs(parsedPnl) >= Math.abs(expectedPnl) * 50) {
    return Math.round(parsedPnl / 100);
  }
  return Math.round(parsedPnl);
}

/**
 * 模糊比對工作表分頁名稱
 */
export function matchSheetTabName(
  availableTabTitles: string[],
  targetType: SheetTabKey
): string | null {
  const exactName = SHEET_TAB_NAMES[targetType];
  if (availableTabTitles.includes(exactName)) return exactName;

  const keywordsMap: Record<SheetTabKey, string[]> = {
    OVERVIEW: ['總覽', '庫存', '統計', '持股', 'overview', 'inventory'],
    TRANSACTIONS: ['分筆', '明細', '流水', '交易', 'transaction', 'lot'],
    REALIZED: ['已實現', '賣出', '損益紀錄', 'realized', 'sold'],
    DIVIDENDS: ['配息', '配股', '股利', '除權息', 'dividend'],
  };

  const keywords = keywordsMap[targetType];
  for (const title of availableTabTitles) {
    const lower = title.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      return title;
    }
  }
  return null;
}

/**
 * 自動掃描前 15 列偵測表頭列索引與各欄位對應位置 (detectTableColumns)
 */
export function detectTableColumns(
  rows: string[][],
  fieldPatterns: Record<string, string[]>
): { headerRowIndex: number; colMap: Record<string, number> } {
  const maxScan = Math.min(rows.length, 15);
  let bestRowIndex = -1;
  let bestMatchCount = 0;
  let bestColMap: Record<string, number> = {};

  for (let r = 0; r < maxScan; r++) {
    const row = rows[r] || [];
    const currentMap: Record<string, number> = {};
    let matchCount = 0;

    for (const [fieldKey, patterns] of Object.entries(fieldPatterns)) {
      for (let c = 0; c < row.length; c++) {
        const cellText = String(row[c] || '')
          .replace(/\s+/g, '')
          .toLowerCase();
        if (!cellText) continue;
        if (patterns.some((p) => cellText.includes(p.toLowerCase()))) {
          if (currentMap[fieldKey] === undefined) {
            currentMap[fieldKey] = c;
            matchCount++;
            break;
          }
        }
      }
    }

    if (matchCount > bestMatchCount && matchCount >= 3) {
      bestMatchCount = matchCount;
      bestRowIndex = r;
      bestColMap = currentMap;
    }
  }

  return { headerRowIndex: bestRowIndex, colMap: bestColMap };
}

/**
 * 備註欄位中批次識別碼編解碼輔助 (確保試算表雙向同步 100% 精準且不影響閱讀)
 */
function encodeNoteWithMeta(cleanNote: string, metaTag?: string): string {
  const base = (cleanNote || '').replace(/\s*\[#[A-Za-z0-9_:-]+\]\s*/g, '').trim();
  if (!metaTag) return base;
  return base ? `${base} [#${metaTag}]` : `[#${metaTag}]`;
}

function decodeNoteMeta(rawNote: string): { cleanNote: string; metaTag: string | null } {
  const raw = String(rawNote || '').trim();
  const match = raw.match(/\[#([A-Za-z0-9_:-]+)\]/);
  const cleanNote = raw.replace(/\s*\[#[A-Za-z0-9_:-]+\]\s*/g, '').trim();
  return {
    cleanNote,
    metaTag: match ? match[1] : null,
  };
}

/**
 * 產生標準 4 分頁二維陣列資料
 * - 分頁 1：個股庫存統計總覽
 * - 分頁 2：分筆交易明細 (依日期由新到舊)
 * - 分頁 3：已實現損益紀錄
 * - 分頁 4：配息配股紀錄
 */
export function buildAllSheetTabsData(
  state: PortfolioState,
  feeSettings: FeeSettings = DEFAULT_FEE_SETTINGS
): {
  overviewRows: (string | number)[][];
  transactionRows: (string | number)[][];
  realizedRows: (string | number)[][];
  dividendRows: (string | number)[][];
} {
  const nowStr = formatTaipeiDateTime(new Date());

  // =========================================================================
  // 分頁 1：個股庫存統計總覽
  // =========================================================================
  const overview = computePortfolioOverview(state.holdings, feeSettings, nowStr);
  const overviewRows: (string | number)[][] = [
    ['個人股票庫存統計總覽', '', '最後更新時間', overview.updatedAt, '', '', '', '', '', '', '', '', ''],
    [
      '總投入成本',
      overview.totalCost,
      '總持股市值',
      overview.totalMarketValue,
      '預估總損益',
      overview.totalUnrealizedProfit,
      '總報酬率',
      `${overview.totalUnrealizedReturnRate >= 0 ? '+' : ''}${overview.totalUnrealizedReturnRate.toFixed(2)}%`,
      '持股檔數',
      `${overview.holdingCount} 檔`,
      '獲利/虧損檔數',
      `${overview.profitableCount} 獲利 / ${overview.losingCount} 虧損`,
      '',
    ],
    [],
    [
      '股票代碼',
      '股票名稱',
      '類別',
      '持有股數',
      '平均成本價',
      '當前現價',
      '總成本',
      '總市值',
      '預估損益',
      '預估報酬率 (%)',
      '投資組合比重 (%)',
      '產業類別',
      '備註',
    ],
  ];

  for (const item of overview.items) {
    overviewRows.push([
      item.code,
      item.name,
      item.category,
      item.totalShares,
      Number(item.avgCostPrice.toFixed(2)),
      Number(item.currentPrice.toFixed(2)),
      item.totalCost,
      item.marketValue,
      item.unrealizedProfit,
      `${item.unrealizedReturnRate >= 0 ? '+' : ''}${item.unrealizedReturnRate.toFixed(2)}%`,
      `${item.portfolioWeight.toFixed(2)}%`,
      item.industry,
      item.note,
    ]);
  }

  // =========================================================================
  // 分頁 2：分筆交易明細 (整合買進流水 BuyRecord 與賣出紀錄 RealizedRecord，由新到舊排序)
  // =========================================================================
  // 確保所有庫存批次都有對應的 BuyRecord (若直接從庫存載入則自動補齊)
  const mergedBuyRecords: BuyRecord[] = [...state.buyRecords];
  const existingLotIds = new Set(mergedBuyRecords.map((b) => b.lotId));
  for (const h of state.holdings) {
    for (const lot of h.lots) {
      if (!existingLotIds.has(lot.id)) {
        const origShares = lot.originalShares || lot.shares;
        const origFee = lot.originalBuyFee !== undefined ? lot.originalBuyFee : lot.buyFee;
        mergedBuyRecords.push({
          id: `buy_${lot.id}`,
          lotId: lot.id,
          code: normalizeStockCode(h.code),
          name: h.name,
          date: lot.date,
          category: lot.category,
          shares: origShares,
          price: lot.price,
          buyFee: origFee,
          totalCost: Math.round(origShares * lot.price) + origFee,
          note: lot.note,
          isDividendLot: lot.isDividendLot,
          dividendRecordId: lot.dividendRecordId,
        });
      }
    }
  }

  // 建立當前現價查詢表，計算買進紀錄之參考未實現損益
  const priceMap = new Map<string, { price: number; category: string; industry: string }>();
  for (const h of state.holdings) {
    priceMap.set(normalizeStockCode(h.code), {
      price: h.currentPrice,
      category: h.category,
      industry: h.industry,
    });
  }

  interface CombinedTxRow {
    date: string;
    sortOrder: number; // 同日期時賣出排在買進前
    cells: (string | number)[];
  }

  const combinedTx: CombinedTxRow[] = [];

  for (const buy of mergedBuyRecords) {
    const code = normalizeStockCode(buy.code);
    const grossAmount = Math.round(buy.shares * buy.price);
    const totalCost = buy.totalCost || grossAmount + (buy.buyFee || 0);
    const avgCost = buy.shares > 0 ? totalCost / buy.shares : buy.price;
    const ref = priceMap.get(code);
    const currentPrice = ref?.price || buy.price;
    const marketVal = Math.round(buy.shares * currentPrice);
    const estTax = Math.floor(
      marketVal * (isEtfStock(code, buy.name, ref?.category, ref?.industry) ? 0.001 : 0.003)
    );
    const estPnl = marketVal - totalCost - estTax;
    const estRoi = totalCost > 0 ? (estPnl / totalCost) * 100 : 0;

    combinedTx.push({
      date: buy.date || '1970-01-01',
      sortOrder: 1,
      cells: [
        '買進',
        code,
        buy.name,
        buy.date,
        buy.category || '整股',
        buy.shares, // 關鍵不變性原則：永遠保留當初實際買進的原始股數
        Number(buy.price.toFixed(2)),
        grossAmount,
        Number(avgCost.toFixed(2)),
        totalCost, // 永遠保留原始投入成本
        estPnl,
        `${estRoi >= 0 ? '+' : ''}${estRoi.toFixed(2)}%`,
        encodeNoteWithMeta(buy.note, buy.lotId),
      ],
    });
  }

  for (const sell of state.realizedRecords) {
    const code = normalizeStockCode(sell.code);
    combinedTx.push({
      date: sell.sellDate || '1970-01-01',
      sortOrder: 2,
      cells: [
        '賣出',
        code,
        sell.name,
        sell.sellDate,
        sell.category || '整股',
        sell.shares,
        Number(sell.sellPrice.toFixed(2)),
        sell.grossSellAmount,
        Number(sell.avgBuyPrice.toFixed(2)),
        sell.totalBuyCost,
        sell.netProfit,
        `${sell.returnRate >= 0 ? '+' : ''}${sell.returnRate.toFixed(2)}%`,
        sell.note || '',
      ],
    });
  }

  // 依交易日期由新到舊排序
  combinedTx.sort((a, b) => {
    const cmp = b.date.localeCompare(a.date);
    if (cmp !== 0) return cmp;
    return b.sortOrder - a.sortOrder;
  });

  const transactionRows: (string | number)[][] = [
    [
      '分筆交易明細（買進流水與賣出紀錄）',
      '',
      '最後更新時間',
      nowStr,
      '總筆數',
      `${combinedTx.length} 筆`,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
    [],
    [
      '交易動作',
      '股票代碼',
      '股票名稱',
      '交易日期',
      '交易類別',
      '交易股數',
      '成交單價',
      '交易總額',
      '成本均價',
      '投入成本',
      '損益',
      '報酬率 (%)',
      '備註',
    ],
    ...combinedTx.map((tx) => tx.cells),
  ];

  // =========================================================================
  // 分頁 3：已實現損益紀錄
  // =========================================================================
  const realizedSummary = computeRealizedOverview(state.realizedRecords);
  const sortedRealized = [...state.realizedRecords].sort((a, b) =>
    (b.sellDate || '').localeCompare(a.sellDate || '')
  );

  const realizedRows: (string | number)[][] = [
    ['已實現損益統計紀錄', '', '最後更新時間', nowStr, '', '', '', '', '', '', '', '', ''],
    [
      '累積已實現損益',
      realizedSummary.totalRealizedProfit,
      '賣出總金額',
      realizedSummary.totalSellAmount,
      '投入成本',
      realizedSummary.totalInvestedCost,
      '總報酬率',
      `${realizedSummary.totalReturnRate >= 0 ? '+' : ''}${realizedSummary.totalReturnRate.toFixed(2)}%`,
      '勝率與勝敗筆數',
      `${realizedSummary.winRate.toFixed(1)}% (${realizedSummary.winCount}勝 ${realizedSummary.lossCount}敗 / 共${realizedSummary.totalCount}筆)`,
      '',
      '',
      '',
    ],
    [],
    [
      '股票代碼',
      '股票名稱',
      '賣出日期',
      '交易類別',
      '賣出股數',
      '買進成本均價',
      '賣出成交單價',
      '投入成本',
      '賣出金額',
      '稅費合計',
      '已實現損益',
      '報酬率 (%)',
      '備註',
    ],
  ];

  for (const r of sortedRealized) {
    // 若有指定批次扣抵紀錄，將精簡批次扣抵摘要附加於備註尾端以便重載時 100% 還原
    const lotMeta =
      r.deductedLots && r.deductedLots.length > 0
        ? `DL:${r.deductedLots.map((d) => `${d.lotId}:${d.sharesDeducted}:${d.buyFeeDeducted}`).join('|')}`
        : undefined;

    realizedRows.push([
      normalizeStockCode(r.code),
      r.name,
      r.sellDate,
      r.category || '整股',
      r.shares,
      Number(r.avgBuyPrice.toFixed(2)),
      Number(r.sellPrice.toFixed(2)),
      r.totalBuyCost,
      r.grossSellAmount,
      (r.sellFee || 0) + (r.sellTax || 0),
      r.netProfit,
      `${r.returnRate >= 0 ? '+' : ''}${r.returnRate.toFixed(2)}%`,
      encodeNoteWithMeta(r.note, lotMeta),
    ]);
  }

  // =========================================================================
  // 分頁 4：配息配股紀錄
  // =========================================================================
  const divSummary = computeDividendOverview(state.dividendRecords);
  const sortedDividends = [...state.dividendRecords].sort((a, b) =>
    (b.exDate || b.payDate || '').localeCompare(a.exDate || a.payDate || '')
  );

  const dividendRows: (string | number)[][] = [
    ['配息配股統計紀錄', '', '最後更新時間', nowStr, '', '', '', '', '', '', '', '', '', ''],
    [
      '累計實收現金股利',
      divSummary.totalNetCash,
      '累計獲配股票股數',
      divSummary.totalStockShares,
      '本年度實收股利',
      divSummary.currentYearNetCash,
      '健保保費與匯費總額',
      divSummary.totalHealthAndBankFee,
      '總筆數',
      `${divSummary.totalCount} 筆`,
      '',
      '',
      '',
      '',
    ],
    [],
    [
      '股票代碼',
      '股票名稱',
      '股利類別',
      '除權息交易日',
      '股利發放日',
      '除權息股數',
      '每股現金',
      '應發放現金',
      '健保/匯費',
      '實收現金',
      '每股配股',
      '獲配股數',
      '計入庫存狀態',
      '備註',
    ],
  ];

  for (const d of sortedDividends) {
    dividendRows.push([
      normalizeStockCode(d.code),
      d.name,
      d.dividendType,
      d.exDate,
      d.payDate,
      d.participatingShares,
      Number(d.cashPerShare.toFixed(4)),
      d.grossCash,
      d.healthAndBankFee,
      d.netCash,
      Number(d.stockPerShare.toFixed(4)),
      d.stockSharesReceived,
      d.addedToInventory ? '已計入庫存' : '僅記錄不入庫',
      encodeNoteWithMeta(d.note, d.createdLotId),
    ]);
  }

  return {
    overviewRows,
    transactionRows,
    realizedRows,
    dividendRows,
  };
}

/**
 * 從 Google Sheets 四個分頁原始二維陣列解析並校對還原完整 PortfolioState
 * 實作：
 * 1. 寬鬆欄位自動偵測 (detectTableColumns)
 * 2. 自動補回前導零 (50 -> 0050, 878 -> 00878)
 * 3. 100 倍百分比格式誤套用損益自動修正
 * 4. 分筆買進明細 + 已實現損益扣抵 + 個股庫存統計總覽 三方交叉校對
 */
export function parsePortfolioFromSheetTabs(rawTabs: {
  overviewRows?: string[][];
  transactionRows?: string[][];
  realizedRows?: string[][];
  dividendRows?: string[][];
}): PortfolioState {
  const overviewRows = rawTabs.overviewRows || [];
  const transactionRows = rawTabs.transactionRows || [];
  const realizedRows = rawTabs.realizedRows || [];
  const dividendRows = rawTabs.dividendRows || [];

  // ---------------------------------------------------------------------------
  // Step 1: 解析分頁 1「個股庫存統計總覽」作為最終庫存股數、現價與備註之權威校對基準
  // ---------------------------------------------------------------------------
  const overviewSpec = detectTableColumns(overviewRows, {
    code: ['股票代碼', '代號', '代碼', 'code', 'symbol'],
    name: ['股票名稱', '股名', '名稱', 'name'],
    category: ['類別', '市場', '類型', 'category'],
    shares: ['持有股數', '庫存股數', '股數', 'shares'],
    avgCost: ['平均成本', '成本均價', '均價', 'avg'],
    currentPrice: ['當前現價', '現價', '市價', '成交價', 'price'],
    totalCost: ['總成本', '投入成本', '成本總額'],
    marketValue: ['總市值', '市值'],
    profit: ['預估損益', '未實現損益', '損益'],
    industry: ['產業類別', '產業', 'industry'],
    note: ['備註', '說明', 'note'],
  });

  interface OverviewSummaryRow {
    code: string;
    name: string;
    category: string;
    shares: number;
    avgCost: number;
    currentPrice: number;
    totalCost: number;
    industry: string;
    note: string;
  }

  const overviewMap = new Map<string, OverviewSummaryRow>();
  if (overviewSpec.headerRowIndex >= 0) {
    const c = overviewSpec.colMap;
    for (let i = overviewSpec.headerRowIndex + 1; i < overviewRows.length; i++) {
      const row = overviewRows[i] || [];
      const rawCode = c.code !== undefined ? row[c.code] : '';
      if (!rawCode || String(rawCode).includes('合計') || String(rawCode).includes('總計')) {
        continue;
      }
      const code = normalizeStockCode(rawCode);
      if (!code || !/^[0-9A-Z]{4,6}$/.test(code)) continue;

      const shares = parseSafeNumber(c.shares !== undefined ? row[c.shares] : 0);
      if (shares <= 0) continue;

      const meta = lookupStockMeta(code);
      const avgCost = parseSafeNumber(c.avgCost !== undefined ? row[c.avgCost] : 0);
      const totalCost =
        parseSafeNumber(c.totalCost !== undefined ? row[c.totalCost] : 0) ||
        Math.round(shares * avgCost);
      const currentPrice =
        parseSafeNumber(c.currentPrice !== undefined ? row[c.currentPrice] : 0) ||
        avgCost ||
        meta.refPrice ||
        0;

      overviewMap.set(code, {
        code,
        name: (c.name !== undefined ? String(row[c.name] || '').trim() : '') || meta.name,
        category:
          (c.category !== undefined ? String(row[c.category] || '').trim() : '') ||
          meta.category,
        shares,
        avgCost: avgCost || (shares > 0 ? totalCost / shares : 0),
        currentPrice,
        totalCost,
        industry:
          (c.industry !== undefined ? String(row[c.industry] || '').trim() : '') ||
          meta.industry,
        note: c.note !== undefined ? String(row[c.note] || '').trim() : '',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: 解析分頁 3「已實現損益紀錄」
  // ---------------------------------------------------------------------------
  const realizedSpec = detectTableColumns(realizedRows, {
    code: ['股票代碼', '代號', '代碼'],
    name: ['股票名稱', '股名', '名稱'],
    sellDate: ['賣出日期', '交易日期', '日期'],
    category: ['交易類別', '類別'],
    shares: ['賣出股數', '交易股數', '股數'],
    avgBuyPrice: ['買進成本均價', '成本均價', '買進均價'],
    sellPrice: ['賣出成交單價', '賣出單價', '成交單價'],
    totalBuyCost: ['投入成本', '買進成本', '總成本'],
    grossSellAmount: ['賣出金額', '交易總額', '賣出總額'],
    feesAndTax: ['稅費合計', '手續費與稅', '稅費'],
    netProfit: ['已實現損益', '淨損益', '損益'],
    returnRate: ['報酬率'],
    note: ['備註', '說明'],
  });

  const parsedRealizedRecords: RealizedRecord[] = [];
  if (realizedSpec.headerRowIndex >= 0) {
    const c = realizedSpec.colMap;
    for (let i = realizedSpec.headerRowIndex + 1; i < realizedRows.length; i++) {
      const row = realizedRows[i] || [];
      const rawCode = c.code !== undefined ? row[c.code] : '';
      const code = normalizeStockCode(rawCode);
      if (!code || !/^[0-9A-Z]{4,6}$/.test(code)) continue;

      const shares = parseSafeNumber(c.shares !== undefined ? row[c.shares] : 0);
      if (shares <= 0) continue;

      const meta = lookupStockMeta(code);
      const avgBuyPrice = parseSafeNumber(
        c.avgBuyPrice !== undefined ? row[c.avgBuyPrice] : 0
      );
      const sellPrice = parseSafeNumber(c.sellPrice !== undefined ? row[c.sellPrice] : 0);
      const totalBuyCost =
        parseSafeNumber(c.totalBuyCost !== undefined ? row[c.totalBuyCost] : 0) ||
        Math.round(shares * avgBuyPrice);
      const grossSellAmount =
        parseSafeNumber(c.grossSellAmount !== undefined ? row[c.grossSellAmount] : 0) ||
        Math.round(shares * sellPrice);
      const feesAndTax = parseSafeNumber(
        c.feesAndTax !== undefined ? row[c.feesAndTax] : 0
      );
      const expectedPnl = grossSellAmount - totalBuyCost - feesAndTax;
      const rawPnl = parseSafeNumber(
        c.netProfit !== undefined ? row[c.netProfit] : expectedPnl,
        expectedPnl
      );
      const netProfit = fixHundredfoldPnlAnomaly(rawPnl, expectedPnl);
      const returnRate = totalBuyCost > 0 ? (netProfit / totalBuyCost) * 100 : 0;

      const isEtf = isEtfStock(code, meta.name);
      const estTax = Math.floor(grossSellAmount * (isEtf ? 0.001 : 0.003));
      const sellTax = feesAndTax >= estTax ? estTax : Math.floor(feesAndTax * 0.6);
      const sellFee = Math.max(0, feesAndTax - sellTax);
      const buyFeeDeducted = Math.max(0, totalBuyCost - Math.round(shares * avgBuyPrice));

      const rawNote = c.note !== undefined ? String(row[c.note] || '') : '';
      const { cleanNote, metaTag } = decodeNoteMeta(rawNote);
      const deductedLots = [];
      if (metaTag && metaTag.startsWith('DL:')) {
        const parts = metaTag.slice(3).split('|');
        for (const p of parts) {
          const [lotId, shStr, feeStr] = p.split(':');
          const sh = Number(shStr) || 0;
          const fee = Number(feeStr) || 0;
          if (lotId && sh > 0) {
            deductedLots.push({
              lotId,
              date: c.sellDate !== undefined ? String(row[c.sellDate] || '') : '',
              category: ((c.category !== undefined ? row[c.category] : '整股') ||
                '整股') as TradeCategory,
              sharesDeducted: sh,
              buyPrice: avgBuyPrice,
              buyFeeDeducted: fee,
              costDeducted: Math.round(sh * avgBuyPrice) + fee,
              note: '',
            });
          }
        }
      }

      parsedRealizedRecords.push({
        id: `realized_import_${i}_${code}`,
        code,
        name: (c.name !== undefined ? String(row[c.name] || '').trim() : '') || meta.name,
        sellDate:
          (c.sellDate !== undefined ? String(row[c.sellDate] || '').trim() : '') ||
          new Date().toISOString().slice(0, 10),
        category: ((c.category !== undefined ? String(row[c.category] || '').trim() : '') ||
          '整股') as TradeCategory,
        shares,
        avgBuyPrice,
        sellPrice,
        totalBuyCost,
        buyFeeDeducted,
        grossSellAmount,
        sellFee,
        sellTax,
        taxRateType: isEtf ? 'etf_0.1' : 'stock_0.3',
        netProfit,
        returnRate,
        note: cleanNote,
        deductedFromInventory: true,
        deductedLots: deductedLots.length > 0 ? deductedLots : undefined,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: 解析分頁 4「配息配股紀錄」
  // ---------------------------------------------------------------------------
  const divSpec = detectTableColumns(dividendRows, {
    code: ['股票代碼', '代號', '代碼'],
    name: ['股票名稱', '股名', '名稱'],
    dividendType: ['股利類別', '配息類別', '類別'],
    exDate: ['除權息交易日', '除息日', '除權息日'],
    payDate: ['股利發放日', '發放日'],
    participatingShares: ['除權息股數', '參與股數', '持有股數'],
    cashPerShare: ['每股現金', '現金股利'],
    grossCash: ['應發放現金', '應發股利'],
    healthAndBankFee: ['健保/匯費', '二代健保', '匯費'],
    netCash: ['實收現金', '實領現金', '實收股利'],
    stockPerShare: ['每股配股', '股票股利'],
    stockSharesReceived: ['獲配股數', '配股股數'],
    addedToInventory: ['計入庫存狀態', '計入庫存', '狀態'],
    note: ['備註', '說明'],
  });

  const parsedDividendRecords: DividendRecord[] = [];
  if (divSpec.headerRowIndex >= 0) {
    const c = divSpec.colMap;
    for (let i = divSpec.headerRowIndex + 1; i < dividendRows.length; i++) {
      const row = dividendRows[i] || [];
      const rawCode = c.code !== undefined ? row[c.code] : '';
      const code = normalizeStockCode(rawCode);
      if (!code || !/^[0-9A-Z]{4,6}$/.test(code)) continue;

      const meta = lookupStockMeta(code);
      const participatingShares = parseSafeNumber(
        c.participatingShares !== undefined ? row[c.participatingShares] : 0
      );
      const cashPerShare = parseSafeNumber(
        c.cashPerShare !== undefined ? row[c.cashPerShare] : 0
      );
      const grossCash =
        parseSafeNumber(c.grossCash !== undefined ? row[c.grossCash] : 0) ||
        Math.round(participatingShares * cashPerShare);
      const healthAndBankFee = parseSafeNumber(
        c.healthAndBankFee !== undefined ? row[c.healthAndBankFee] : 0
      );
      const netCash =
        parseSafeNumber(c.netCash !== undefined ? row[c.netCash] : 0) ||
        Math.max(0, grossCash - healthAndBankFee);
      const stockPerShare = parseSafeNumber(
        c.stockPerShare !== undefined ? row[c.stockPerShare] : 0
      );
      const stockSharesReceived =
        parseSafeNumber(
          c.stockSharesReceived !== undefined ? row[c.stockSharesReceived] : 0
        ) || Math.round(participatingShares * (stockPerShare / 10));

      const statusStr =
        c.addedToInventory !== undefined ? String(row[c.addedToInventory] || '') : '';
      const addedToInventory =
        statusStr.includes('已計入') || statusStr.toLowerCase() === 'true';

      const rawNote = c.note !== undefined ? String(row[c.note] || '') : '';
      const { cleanNote, metaTag } = decodeNoteMeta(rawNote);

      const divTypeRaw =
        c.dividendType !== undefined ? String(row[c.dividendType] || '').trim() : '';
      let dividendType: DividendType = '現金股利';
      if (divTypeRaw.includes('配息') && divTypeRaw.includes('配股')) {
        dividendType = '配息+配股';
      } else if (divTypeRaw.includes('股票') || (stockSharesReceived > 0 && grossCash === 0)) {
        dividendType = '股票股利';
      } else if (stockSharesReceived > 0 && grossCash > 0) {
        dividendType = '配息+配股';
      }

      parsedDividendRecords.push({
        id: `div_import_${i}_${code}`,
        code,
        name: (c.name !== undefined ? String(row[c.name] || '').trim() : '') || meta.name,
        dividendType,
        exDate: c.exDate !== undefined ? String(row[c.exDate] || '').trim() : '',
        payDate: c.payDate !== undefined ? String(row[c.payDate] || '').trim() : '',
        participatingShares,
        cashPerShare,
        grossCash,
        taxable54CRatio: 100,
        nhiFee: healthAndBankFee > 10 ? healthAndBankFee : 0,
        remittanceFee: healthAndBankFee > 0 && healthAndBankFee <= 10 ? healthAndBankFee : 0,
        healthAndBankFee,
        netCash,
        stockPerShare,
        stockSharesReceived,
        addedToInventory,
        createdLotId: metaTag || undefined,
        note: cleanNote,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: 解析分頁 2「分筆交易明細」之買進紀錄 (或賣出紀錄備援)
  // ---------------------------------------------------------------------------
  const txSpec = detectTableColumns(transactionRows, {
    action: ['交易動作', '買賣別', '動作', '型態', 'action', 'type'],
    code: ['股票代碼', '代號', '代碼'],
    name: ['股票名稱', '股名', '名稱'],
    date: ['交易日期', '買進日期', '日期'],
    category: ['交易類別', '類別'],
    shares: ['交易股數', '買進股數', '股數'],
    price: ['成交單價', '買進單價', '單價'],
    grossAmount: ['交易總額', '成交價金', '成交總額'],
    avgCost: ['成本均價'],
    totalCost: ['投入成本', '總成本'],
    pnl: ['損益'],
    note: ['備註', '說明'],
  });

  const parsedBuyRecords: BuyRecord[] = [];
  if (txSpec.headerRowIndex >= 0) {
    const c = txSpec.colMap;
    for (let i = txSpec.headerRowIndex + 1; i < transactionRows.length; i++) {
      const row = transactionRows[i] || [];
      const actionStr = c.action !== undefined ? String(row[c.action] || '').trim() : '買進';
      const rawCode = c.code !== undefined ? row[c.code] : '';
      const code = normalizeStockCode(rawCode);
      if (!code || !/^[0-9A-Z]{4,6}$/.test(code)) continue;

      const shares = parseSafeNumber(c.shares !== undefined ? row[c.shares] : 0);
      if (shares <= 0) continue;

      const meta = lookupStockMeta(code);
      const date =
        (c.date !== undefined ? String(row[c.date] || '').trim() : '') ||
        new Date().toISOString().slice(0, 10);
      const category = ((c.category !== undefined ? String(row[c.category] || '').trim() : '') ||
        '整股') as TradeCategory;
      const price = parseSafeNumber(c.price !== undefined ? row[c.price] : 0);
      const grossAmount =
        parseSafeNumber(c.grossAmount !== undefined ? row[c.grossAmount] : 0) ||
        Math.round(shares * price);
      const totalCost =
        parseSafeNumber(c.totalCost !== undefined ? row[c.totalCost] : 0) || grossAmount;
      const buyFee = Math.max(0, totalCost - grossAmount);

      const rawNote = c.note !== undefined ? String(row[c.note] || '') : '';
      const { cleanNote, metaTag } = decodeNoteMeta(rawNote);

      if (actionStr.includes('賣')) {
        // 若分頁 3「已實現損益紀錄」無資料，則從分頁 2 的賣出列備援還原
        if (parsedRealizedRecords.length === 0) {
          const avgBuyPrice = parseSafeNumber(c.avgCost !== undefined ? row[c.avgCost] : price);
          const buyCost = Math.round(shares * avgBuyPrice);
          const expectedPnl = grossAmount - buyCost;
          const rawPnl = parseSafeNumber(c.pnl !== undefined ? row[c.pnl] : expectedPnl);
          const netProfit = fixHundredfoldPnlAnomaly(rawPnl, expectedPnl);
          parsedRealizedRecords.push({
            id: `realized_tx_${i}_${code}`,
            code,
            name: (c.name !== undefined ? String(row[c.name] || '').trim() : '') || meta.name,
            sellDate: date,
            category,
            shares,
            avgBuyPrice,
            sellPrice: price,
            totalBuyCost: buyCost,
            buyFeeDeducted: 0,
            grossSellAmount: grossAmount,
            sellFee: 0,
            sellTax: Math.max(0, expectedPnl - netProfit),
            taxRateType: isEtfStock(code) ? 'etf_0.1' : 'stock_0.3',
            netProfit,
            returnRate: buyCost > 0 ? (netProfit / buyCost) * 100 : 0,
            note: cleanNote,
            deductedFromInventory: true,
          });
        }
        continue;
      }

      const lotId = metaTag || `lot_${code}_${date}_${i}`;
      parsedBuyRecords.push({
        id: `buy_${lotId}`,
        lotId,
        code,
        name: (c.name !== undefined ? String(row[c.name] || '').trim() : '') || meta.name,
        date,
        category,
        shares,
        price,
        buyFee,
        totalCost,
        note: cleanNote,
        isDividendLot: category === '配股' || price === 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: 庫存校對邏輯 (Reconciliation Engine)
  // 將分筆買進明細與「已實現損益紀錄」及「個股庫存統計總覽」交叉比對，
  // 自動扣除已賣出股數並過濾已全數出清或已刪除的股票，還原 100% 精準的當前庫存狀態。
  // ---------------------------------------------------------------------------
  const holdingsByCode = new Map<string, StockHolding>();

  // 5a. 先由分筆買進明細建立初始批次 (按日期由舊到新排序)
  const chronologicalBuys = [...parsedBuyRecords].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  for (const buy of chronologicalBuys) {
    // 若「個股庫存統計總覽」有資料，但該股票已不在總覽中 -> 代表已全數出清或已刪除，直接過濾！
    if (overviewMap.size > 0 && !overviewMap.has(buy.code)) {
      continue;
    }

    const ov = overviewMap.get(buy.code);
    const meta = lookupStockMeta(buy.code);
    let holding = holdingsByCode.get(buy.code);
    if (!holding) {
      holding = {
        code: buy.code,
        name: ov?.name || buy.name || meta.name,
        category: ov?.category || meta.category,
        currentPrice: ov?.currentPrice || meta.refPrice || buy.price,
        industry: ov?.industry || meta.industry,
        note: ov?.note || '',
        lots: [],
      };
      holdingsByCode.set(buy.code, holding);
    }

    holding.lots.push({
      id: buy.lotId,
      date: buy.date,
      category: buy.category,
      shares: buy.shares,
      originalShares: buy.shares,
      price: buy.price,
      buyFee: buy.buyFee,
      originalBuyFee: buy.buyFee,
      note: buy.note,
      isDividendLot: buy.isDividendLot,
    });
  }

  // 5b. 檢查配息配股紀錄中「已計入庫存」之配股批次，若尚未在分筆明細中則補入
  for (const div of parsedDividendRecords) {
    if (!div.addedToInventory || div.stockSharesReceived <= 0) continue;
    if (overviewMap.size > 0 && !overviewMap.has(div.code)) continue;

    const ov = overviewMap.get(div.code);
    const meta = lookupStockMeta(div.code);
    let holding = holdingsByCode.get(div.code);
    if (!holding) {
      holding = {
        code: div.code,
        name: ov?.name || div.name || meta.name,
        category: ov?.category || meta.category,
        currentPrice: ov?.currentPrice || meta.refPrice || 0,
        industry: ov?.industry || meta.industry,
        note: ov?.note || '',
        lots: [],
      };
      holdingsByCode.set(div.code, holding);
    }

    const alreadyExists = holding.lots.some(
      (l) =>
        (div.createdLotId && l.id === div.createdLotId) ||
        (l.price === 0 &&
          l.shares === div.stockSharesReceived &&
          (l.date === div.payDate || l.date === div.exDate))
    );
    if (!alreadyExists) {
      const lotId = div.createdLotId || `lot_div_${div.id}`;
      div.createdLotId = lotId;
      holding.lots.push({
        id: lotId,
        date: div.payDate || div.exDate || new Date().toISOString().slice(0, 10),
        category: '配股',
        shares: div.stockSharesReceived,
        originalShares: div.stockSharesReceived,
        price: 0,
        buyFee: 0,
        originalBuyFee: 0,
        note: div.note || '股票股利配股入庫',
        isDividendLot: true,
        dividendRecordId: div.id,
      });
    }
  }

  // 5c. 依「已實現損益紀錄」扣除已賣出股數 (優先依指定批次 deductedLots -> 同成本價匹配 -> FIFO)
  const chronologicalSells = [...parsedRealizedRecords].sort((a, b) =>
    a.sellDate.localeCompare(b.sellDate)
  );

  for (const sell of chronologicalSells) {
    const holding = holdingsByCode.get(sell.code);
    if (!holding || holding.lots.length === 0) continue;

    // 若個股庫存統計總覽有紀錄，先檢查目前加總是否已經等於總覽股數 (避免重複扣減)
    const ov = overviewMap.get(sell.code);
    const currentTotalShares = holding.lots.reduce((s, l) => s + l.shares, 0);
    if (ov && currentTotalShares <= ov.shares) {
      continue;
    }

    let remainingToDeduct = sell.shares;
    const reconstructedSnapshots = [];

    // 優先 1：若有明確指定批次紀錄 (deductedLots)
    if (sell.deductedLots && sell.deductedLots.length > 0) {
      for (const snap of sell.deductedLots) {
        const targetLot = holding.lots.find((l) => l.id === snap.lotId && l.shares > 0);
        if (targetLot) {
          const deduct = Math.min(targetLot.shares, snap.sharesDeducted, remainingToDeduct);
          const feeDeduct =
            deduct === targetLot.shares
              ? targetLot.buyFee
              : Math.round(targetLot.buyFee * (deduct / targetLot.shares));
          targetLot.shares -= deduct;
          targetLot.buyFee = Math.max(0, targetLot.buyFee - feeDeduct);
          remainingToDeduct -= deduct;
          reconstructedSnapshots.push({
            lotId: targetLot.id,
            date: targetLot.date,
            category: targetLot.category,
            sharesDeducted: deduct,
            buyPrice: targetLot.price,
            buyFeeDeducted: feeDeduct,
            costDeducted: Math.round(deduct * targetLot.price) + feeDeduct,
            note: targetLot.note,
          });
        }
      }
    }

    // 優先 2：依買進成本均價匹配 + 日期先後 (cost_match -> FIFO)
    if (remainingToDeduct > 0) {
      const candidateLots = holding.lots
        .filter((l) => l.shares > 0)
        .sort((a, b) => {
          const diffA = Math.abs(a.price - sell.avgBuyPrice);
          const diffB = Math.abs(b.price - sell.avgBuyPrice);
          if (Math.abs(diffA - diffB) > 0.05) return diffA - diffB;
          return a.date.localeCompare(b.date);
        });

      for (const lot of candidateLots) {
        if (remainingToDeduct <= 0) break;
        const deduct = Math.min(lot.shares, remainingToDeduct);
        const feeDeduct =
          deduct === lot.shares
            ? lot.buyFee
            : Math.round(lot.buyFee * (deduct / lot.shares));
        lot.shares -= deduct;
        lot.buyFee = Math.max(0, lot.buyFee - feeDeduct);
        remainingToDeduct -= deduct;
        reconstructedSnapshots.push({
          lotId: lot.id,
          date: lot.date,
          category: lot.category,
          sharesDeducted: deduct,
          buyPrice: lot.price,
          buyFeeDeducted: feeDeduct,
          costDeducted: Math.round(deduct * lot.price) + feeDeduct,
          note: lot.note,
        });
      }
    }

    if (reconstructedSnapshots.length > 0 && (!sell.deductedLots || sell.deductedLots.length === 0)) {
      sell.deductedLots = reconstructedSnapshots;
    }

    holding.lots = holding.lots.filter((l) => l.shares > 0);
  }

  // 5d. 與分頁 1「個股庫存統計總覽」進行最終校對：
  // - 若某檔股票在總覽中存在，但分筆明細沒它的資料（或股數不一致），以總覽之真實股數校對補足或縮減
  for (const [code, ov] of overviewMap.entries()) {
    let holding = holdingsByCode.get(code);
    if (!holding || holding.lots.length === 0) {
      const lotId = `lot_ov_${code}`;
      const buyFee = Math.max(0, ov.totalCost - Math.round(ov.shares * ov.avgCost));
      holding = {
        code,
        name: ov.name,
        category: ov.category,
        currentPrice: ov.currentPrice,
        industry: ov.industry,
        note: ov.note,
        lots: [
          {
            id: lotId,
            date: new Date().toISOString().slice(0, 10),
            category: ov.shares >= 1000 ? '整股' : '盤中零股',
            shares: ov.shares,
            originalShares: ov.shares,
            price: Number(ov.avgCost.toFixed(2)),
            buyFee,
            originalBuyFee: buyFee,
            note: ov.note,
          },
        ],
      };
      holdingsByCode.set(code, holding);
      if (!parsedBuyRecords.some((b) => b.code === code)) {
        parsedBuyRecords.push({
          id: `buy_${lotId}`,
          lotId,
          code,
          name: ov.name,
          date: new Date().toISOString().slice(0, 10),
          category: ov.shares >= 1000 ? '整股' : '盤中零股',
          shares: ov.shares,
          price: Number(ov.avgCost.toFixed(2)),
          buyFee,
          totalCost: ov.totalCost,
          note: ov.note,
        });
      }
    } else {
      // 校對總股數是否與總覽一致
      const lotSum = holding.lots.reduce((s, l) => s + l.shares, 0);
      if (lotSum > ov.shares) {
        // 若分筆剩餘股數大於總覽股數，依 FIFO 扣除差額
        let diff = lotSum - ov.shares;
        for (const lot of holding.lots) {
          if (diff <= 0) break;
          const cut = Math.min(lot.shares, diff);
          const feeCut =
            cut === lot.shares ? lot.buyFee : Math.round(lot.buyFee * (cut / lot.shares));
          lot.shares -= cut;
          lot.buyFee = Math.max(0, lot.buyFee - feeCut);
          diff -= cut;
        }
        holding.lots = holding.lots.filter((l) => l.shares > 0);
      } else if (lotSum < ov.shares) {
        // 若分筆剩餘股數小於總覽股數，補入差額批次
        const diff = ov.shares - lotSum;
        holding.lots.push({
          id: `lot_reconcile_${code}`,
          date: new Date().toISOString().slice(0, 10),
          category: diff >= 1000 ? '整股' : '盤中零股',
          shares: diff,
          originalShares: diff,
          price: Number(ov.avgCost.toFixed(2)),
          buyFee: 0,
          originalBuyFee: 0,
          note: '庫存校對差額批次',
        });
      }
    }
  }

  const finalHoldings = Array.from(holdingsByCode.values()).filter(
    (h) => h.lots.reduce((s, l) => s + l.shares, 0) > 0
  );

  return {
    holdings: finalHoldings,
    buyRecords: parsedBuyRecords,
    realizedRecords: parsedRealizedRecords,
    dividendRecords: parsedDividendRecords,
    lastSheetSyncAt: formatTaipeiDateTime(new Date()),
  };
}

/**
 * 合併兩個 PortfolioState (用於「合併匯入 Merge」模式)
 */
export function mergePortfolioStates(
  current: PortfolioState,
  incoming: PortfolioState
): PortfolioState {
  const holdingsMap = new Map<string, StockHolding>();
  for (const h of current.holdings) {
    holdingsMap.set(normalizeStockCode(h.code), JSON.parse(JSON.stringify(h)));
  }

  for (const inc of incoming.holdings) {
    const code = normalizeStockCode(inc.code);
    const existing = holdingsMap.get(code);
    if (!existing) {
      holdingsMap.set(code, JSON.parse(JSON.stringify(inc)));
    } else {
      existing.currentPrice = inc.currentPrice || existing.currentPrice;
      for (const lot of inc.lots) {
        const dup = existing.lots.some(
          (l) =>
            l.id === lot.id ||
            (l.date === lot.date &&
              l.shares === lot.shares &&
              Math.abs(l.price - lot.price) < 0.01)
        );
        if (!dup) {
          existing.lots.push({ ...lot });
        }
      }
    }
  }

  const buyMap = new Map<string, BuyRecord>();
  for (const b of [...current.buyRecords, ...incoming.buyRecords]) {
    const key = `${normalizeStockCode(b.code)}_${b.date}_${b.shares}_${b.price.toFixed(2)}`;
    if (!buyMap.has(key)) buyMap.set(key, b);
  }

  const realizedMap = new Map<string, RealizedRecord>();
  for (const r of [...current.realizedRecords, ...incoming.realizedRecords]) {
    const key = `${normalizeStockCode(r.code)}_${r.sellDate}_${r.shares}_${r.sellPrice.toFixed(2)}`;
    if (!realizedMap.has(key)) realizedMap.set(key, r);
  }

  const divMap = new Map<string, DividendRecord>();
  for (const d of [...current.dividendRecords, ...incoming.dividendRecords]) {
    const key = `${normalizeStockCode(d.code)}_${d.exDate || d.payDate}_${d.participatingShares}_${d.grossCash}_${d.stockSharesReceived}`;
    if (!divMap.has(key)) divMap.set(key, d);
  }

  return {
    holdings: Array.from(holdingsMap.values()),
    buyRecords: Array.from(buyMap.values()),
    realizedRecords: Array.from(realizedMap.values()),
    dividendRecords: Array.from(divMap.values()),
    lastSheetSyncAt: formatTaipeiDateTime(new Date()),
  };
}

/**
 * 簡易 RFC-4180 相容 CSV 解析器（用於 Google Sheets CSV 匯出端點備援解析）
 */
export function parseCsvToRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentCell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentCell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentCell.trim());
        currentCell = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
        i++;
      } else if (ch === '\n') {
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
      } else {
        currentCell += ch;
      }
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows;
}

/**
 * 將二維陣列匯出為含 UTF-8 BOM 的 CSV 字串
 */
export function rowsToUtf8BomCsv(rows: (string | number)[][]): string {
  const lines = rows.map((row) =>
    row
      .map((cell) => {
        const str = cell === null || cell === undefined ? '' : String(cell);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(',')
  );
  return '\uFEFF' + lines.join('\r\n');
}
