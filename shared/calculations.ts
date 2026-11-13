import {
  BuyRecord,
  DeductedLotSnapshot,
  DividendOverviewSummary,
  DividendRecord,
  FeeSettings,
  HoldingComputedMetrics,
  LotDeductionStrategy,
  PortfolioOverviewSummary,
  RealizedOverviewSummary,
  RealizedRecord,
  StockHolding,
  StockLot,
  TaxRateType,
  TradeCategory,
} from './types';
import { isEtfStock, lookupStockMeta, normalizeStockCode } from './twStockDictionary';

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
  brokerDiscount: 0.6, // 預設 6 折
  minRegularFee: 20,
  minOddLotFee: 1,
  includeEstSellFeeInUnrealized: false, // 預設相容原版規格：總市值 - 總投入成本 - 預估賣出證交稅
  autoRefreshIntervalMinutes: 10,
  marketHoursOnly: false,
};

/**
 * 計算單筆批次投入成本：股數 * 買進單價 + 買進手續費
 */
export function calculateLotCost(shares: number, price: number, buyFee: number): number {
  return Math.round(shares * price) + Math.round(buyFee || 0);
}

/**
 * 自動試算台股券商手續費 (0.1425% * 折數，含整股/零股低消)
 */
export function calculateBrokerageFee(
  grossAmount: number,
  category: TradeCategory = '整股',
  settings: FeeSettings = DEFAULT_FEE_SETTINGS
): number {
  if (grossAmount <= 0 || category === '配股') return 0;
  const rawFee = Math.floor(grossAmount * 0.001425 * settings.brokerDiscount);
  const isOddLot =
    category === '盤中零股' || category === '盤後零股' || category === '定期定額';
  const minFee = isOddLot ? settings.minOddLotFee : settings.minRegularFee;
  return Math.max(minFee, rawFee);
}

/**
 * 預估賣出證券交易稅（無條件捨去至整數）：
 * - 一般台股：Math.floor(市值 * 0.003) (0.3%)
 * - 台股 ETF：Math.floor(市值 * 0.001) (0.1%)
 */
export function calculateEstSellTax(
  marketValue: number,
  code: string,
  name?: string,
  category?: string,
  industry?: string
): number {
  if (marketValue <= 0) return 0;
  const etf = isEtfStock(code, name, category, industry);
  const rate = etf ? 0.001 : 0.003;
  return Math.floor(marketValue * rate);
}

/**
 * 根據賣出稅率類型計算賣出交易稅
 */
export function calculateSellTaxByType(
  grossSellAmount: number,
  taxRateType: TaxRateType,
  customTax = 0
): number {
  if (grossSellAmount <= 0) return 0;
  switch (taxRateType) {
    case 'stock_0.3':
      return Math.floor(grossSellAmount * 0.003);
    case 'etf_0.1':
      return Math.floor(grossSellAmount * 0.001);
    case 'daytrade_0.15':
      return Math.floor(grossSellAmount * 0.0015);
    case 'exempt_0':
      return 0;
    case 'custom':
      return Math.max(0, Math.round(customTax));
    default:
      return Math.floor(grossSellAmount * 0.003);
  }
}

/**
 * 計算單一持股之完整統計指標与未實現損益
 */
export function computeHoldingMetrics(
  holding: StockHolding,
  totalPortfolioMarketValue: number,
  feeSettings: FeeSettings = DEFAULT_FEE_SETTINGS
): HoldingComputedMetrics {
  const activeLots = holding.lots.filter((l) => l.shares > 0);
  const totalShares = activeLots.reduce((sum, l) => sum + l.shares, 0);
  const totalCost = activeLots.reduce(
    (sum, l) => sum + calculateLotCost(l.shares, l.price, l.buyFee),
    0
  );
  const avgCostPrice = totalShares > 0 ? totalCost / totalShares : 0;
  const currentPrice = holding.currentPrice > 0 ? holding.currentPrice : avgCostPrice;
  const marketValue = Math.round(totalShares * currentPrice);
  const isEtf = isEtfStock(holding.code, holding.name, holding.category, holding.industry);
  const estSellTax = calculateEstSellTax(
    marketValue,
    holding.code,
    holding.name,
    holding.category,
    holding.industry
  );
  const estSellFee = calculateBrokerageFee(
    marketValue,
    totalShares >= 1000 ? '整股' : '盤中零股',
    feeSettings
  );

  // 未實現淨損益：預設「總市值 - 總投入成本 - 預估賣出證交稅」，若開啟加扣預估手續費則再減 estSellFee
  const unrealizedProfit =
    marketValue -
    totalCost -
    estSellTax -
    (feeSettings.includeEstSellFeeInUnrealized ? estSellFee : 0);

  const unrealizedReturnRate = totalCost > 0 ? (unrealizedProfit / totalCost) * 100 : 0;
  const portfolioWeight =
    totalPortfolioMarketValue > 0 ? (marketValue / totalPortfolioMarketValue) * 100 : 0;

  return {
    code: normalizeStockCode(holding.code),
    name: holding.name,
    category: holding.category || (isEtf ? 'ETF' : '上市'),
    totalShares,
    avgCostPrice,
    currentPrice,
    totalCost,
    marketValue,
    estSellTax,
    estSellFee,
    unrealizedProfit,
    unrealizedReturnRate,
    portfolioWeight,
    industry: holding.industry || lookupStockMeta(holding.code).industry,
    note: holding.note || '',
    isEtf,
  };
}

/**
 * 計算整體投資組合總覽摘要 (對應分頁 1：個股庫存統計總覽)
 */
export function computePortfolioOverview(
  holdings: StockHolding[],
  feeSettings: FeeSettings = DEFAULT_FEE_SETTINGS,
  updatedAt?: string
): PortfolioOverviewSummary {
  const validHoldings = holdings.filter(
    (h) => h.lots && h.lots.reduce((s, l) => s + l.shares, 0) > 0
  );

  // 先算總市值以供計算各股投資組合比重
  const totalMarketValue = validHoldings.reduce((sum, h) => {
    const shares = h.lots.reduce((s, l) => s + l.shares, 0);
    const cost = h.lots.reduce((s, l) => s + calculateLotCost(l.shares, l.price, l.buyFee), 0);
    const avg = shares > 0 ? cost / shares : 0;
    const price = h.currentPrice > 0 ? h.currentPrice : avg;
    return sum + Math.round(shares * price);
  }, 0);

  const items = validHoldings.map((h) =>
    computeHoldingMetrics(h, totalMarketValue, feeSettings)
  );

  const totalCost = items.reduce((s, i) => s + i.totalCost, 0);
  const totalEstTax = items.reduce((s, i) => s + i.estSellTax, 0);
  const totalEstSellFee = items.reduce((s, i) => s + i.estSellFee, 0);
  const totalUnrealizedProfit = items.reduce((s, i) => s + i.unrealizedProfit, 0);
  const totalUnrealizedReturnRate =
    totalCost > 0 ? (totalUnrealizedProfit / totalCost) * 100 : 0;

  let profitableCount = 0;
  let losingCount = 0;
  let flatCount = 0;
  for (const item of items) {
    if (item.unrealizedProfit > 0) profitableCount++;
    else if (item.unrealizedProfit < 0) losingCount++;
    else flatCount++;
  }

  return {
    updatedAt: updatedAt || formatTaipeiDateTime(new Date()),
    totalCost,
    totalMarketValue,
    totalEstTax,
    totalEstSellFee,
    totalUnrealizedProfit,
    totalUnrealizedReturnRate,
    holdingCount: items.length,
    profitableCount,
    losingCount,
    flatCount,
    items,
  };
}

/**
 * 執行賣出批次沖銷 (支援 specific_lot / cost_match / fifo)
 * 回傳更新後的 holdings 與該筆 RealizedRecord
 */
export function executeSellTransaction(params: {
  holdings: StockHolding[];
  code: string;
  name?: string;
  sellDate: string;
  category: TradeCategory;
  sellShares: number;
  sellPrice: number;
  sellFee: number;
  taxRateType: TaxRateType;
  customTax?: number;
  deductFromInventory: boolean;
  strategy: LotDeductionStrategy;
  targetLotId?: string;
  targetBuyPrice?: number;
  manualBuyFee?: number;
  note?: string;
}): {
  updatedHoldings: StockHolding[];
  realizedRecord: RealizedRecord;
} {
  const normCode = normalizeStockCode(params.code);
  const meta = lookupStockMeta(normCode);
  const clonedHoldings: StockHolding[] = JSON.parse(JSON.stringify(params.holdings));
  const holdingIdx = clonedHoldings.findIndex(
    (h) => normalizeStockCode(h.code) === normCode
  );
  const holding = holdingIdx >= 0 ? clonedHoldings[holdingIdx] : undefined;

  const stockName = params.name || holding?.name || meta.name;
  const stockCategory = holding?.category || meta.category;
  const industry = holding?.industry || meta.industry;

  const grossSellAmount = Math.round(params.sellShares * params.sellPrice);
  const sellTax = calculateSellTaxByType(
    grossSellAmount,
    params.taxRateType,
    params.customTax
  );
  const sellFee = Math.round(params.sellFee || 0);

  const deductedLots: DeductedLotSnapshot[] = [];
  let totalBuyPriceAmount = 0; // 買進成交價金合計
  let totalBuyFeeDeducted = 0; // 對應買進手續費合計

  if (params.deductFromInventory && holding && holding.lots.length > 0) {
    // 排序可沖銷批次
    const availableLots = holding.lots.filter((l) => l.shares > 0);
    const sortedLots = [...availableLots];

    if (params.strategy === 'specific_lot' && params.targetLotId) {
      sortedLots.sort((a, b) => {
        if (a.id === params.targetLotId) return -1;
        if (b.id === params.targetLotId) return 1;
        return a.date.localeCompare(b.date);
      });
    } else if (params.strategy === 'cost_match' && params.targetBuyPrice !== undefined) {
      const targetPrice = params.targetBuyPrice;
      sortedLots.sort((a, b) => {
        const diffA = Math.abs(a.price - targetPrice);
        const diffB = Math.abs(b.price - targetPrice);
        if (Math.abs(diffA - diffB) > 0.0001) return diffA - diffB;
        return a.date.localeCompare(b.date);
      });
    } else {
      // FIFO 先進先出 (日期由舊到新)
      sortedLots.sort((a, b) => a.date.localeCompare(b.date));
    }

    let remainingToSell = params.sellShares;

    for (const sortedLot of sortedLots) {
      if (remainingToSell <= 0) break;
      const realLot = holding.lots.find((l) => l.id === sortedLot.id);
      if (!realLot || realLot.shares <= 0) continue;

      const deductShares = Math.min(realLot.shares, remainingToSell);
      const ratio = deductShares / realLot.shares;
      const feeDeducted =
        deductShares === realLot.shares
          ? realLot.buyFee
          : Math.round(realLot.buyFee * ratio);
      const rawPriceCost = Math.round(deductShares * realLot.price);
      const lotCostDeducted = rawPriceCost + feeDeducted;

      deductedLots.push({
        lotId: realLot.id,
        date: realLot.date,
        category: realLot.category,
        sharesDeducted: deductShares,
        buyPrice: realLot.price,
        buyFeeDeducted: feeDeducted,
        costDeducted: lotCostDeducted,
        note: realLot.note,
      });

      totalBuyPriceAmount += rawPriceCost;
      totalBuyFeeDeducted += feeDeducted;

      realLot.shares -= deductShares;
      realLot.buyFee = Math.max(0, realLot.buyFee - feeDeducted);
      remainingToSell -= deductShares;
    }

    // 若庫存股數不足賣出股數，剩餘部分以目標成本價或均價估算
    if (remainingToSell > 0) {
      const fallbackPrice =
        params.targetBuyPrice !== undefined ? params.targetBuyPrice : params.sellPrice;
      totalBuyPriceAmount += Math.round(remainingToSell * fallbackPrice);
    }

    // 清除已扣完之批次；若整檔無剩餘股數則移除該持股
    holding.lots = holding.lots.filter((l) => l.shares > 0);
    if (holding.lots.length === 0) {
      clonedHoldings.splice(holdingIdx, 1);
    }
  } else {
    // 不扣減現有庫存，直接按輸入之買進成本均價與買進手續費計算
    const buyPrice =
      params.targetBuyPrice !== undefined ? params.targetBuyPrice : params.sellPrice;
    totalBuyPriceAmount = Math.round(params.sellShares * buyPrice);
    totalBuyFeeDeducted = Math.round(params.manualBuyFee || 0);
  }

  const totalBuyCost = totalBuyPriceAmount + totalBuyFeeDeducted;
  const avgBuyPrice =
    params.sellShares > 0 ? totalBuyPriceAmount / params.sellShares : 0;

  // 淨已實現損益公式：賣出總金額 - (買進成交價金 + 對應買進手續費) - 賣出手續費 - 賣出交易稅
  const netProfit = grossSellAmount - totalBuyCost - sellFee - sellTax;
  const returnRate = totalBuyCost > 0 ? (netProfit / totalBuyCost) * 100 : 0;

  const realizedRecord: RealizedRecord = {
    id: `realized_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    code: normCode,
    name: stockName,
    sellDate: params.sellDate,
    category: params.category,
    shares: params.sellShares,
    avgBuyPrice,
    sellPrice: params.sellPrice,
    totalBuyCost,
    buyFeeDeducted: totalBuyFeeDeducted,
    grossSellAmount,
    sellFee,
    sellTax,
    taxRateType: params.taxRateType,
    netProfit,
    returnRate,
    note: params.note || '',
    deductedFromInventory: params.deductFromInventory,
    deductionStrategy: params.strategy,
    deductedLots,
    stockCategory,
    industry,
  };

  return {
    updatedHoldings: clonedHoldings,
    realizedRecord,
  };
}

/**
 * 刪除已實現損益紀錄時，依據 deductedLots 將股數、成本與買進手續費精準還原回庫存批次
 * （若整檔已售完則自動重建該持股）
 */
export function restoreRealizedRecordToHoldings(
  holdings: StockHolding[],
  record: RealizedRecord
): StockHolding[] {
  if (!record.deductedFromInventory || !record.deductedLots || record.deductedLots.length === 0) {
    return holdings;
  }

  const normCode = normalizeStockCode(record.code);
  const meta = lookupStockMeta(normCode);
  const cloned: StockHolding[] = JSON.parse(JSON.stringify(holdings));
  let holding = cloned.find((h) => normalizeStockCode(h.code) === normCode);

  if (!holding) {
    holding = {
      code: normCode,
      name: record.name || meta.name,
      category: record.stockCategory || meta.category,
      currentPrice: record.sellPrice || meta.refPrice || record.avgBuyPrice,
      industry: record.industry || meta.industry,
      note: '',
      lots: [],
    };
    cloned.push(holding);
  }

  for (const snap of record.deductedLots) {
    const existingLot = holding.lots.find((l) => l.id === snap.lotId);
    if (existingLot) {
      existingLot.shares += snap.sharesDeducted;
      existingLot.buyFee += snap.buyFeeDeducted;
    } else {
      holding.lots.push({
        id: snap.lotId,
        date: snap.date,
        category: snap.category,
        shares: snap.sharesDeducted,
        originalShares: snap.sharesDeducted,
        price: snap.buyPrice,
        buyFee: snap.buyFeeDeducted,
        originalBuyFee: snap.buyFeeDeducted,
        note: snap.note || '',
      });
    }
  }

  holding.lots.sort((a, b) => a.date.localeCompare(b.date));
  return cloned;
}

/**
 * 彙總計算已實現損益統計摘要 (對應分頁 3：已實現損益紀錄)
 */
export function computeRealizedOverview(
  records: RealizedRecord[]
): RealizedOverviewSummary {
  const totalRealizedProfit = records.reduce((s, r) => s + r.netProfit, 0);
  const totalSellAmount = records.reduce((s, r) => s + r.grossSellAmount, 0);
  const totalInvestedCost = records.reduce((s, r) => s + r.totalBuyCost, 0);
  const totalReturnRate =
    totalInvestedCost > 0 ? (totalRealizedProfit / totalInvestedCost) * 100 : 0;

  let winCount = 0;
  let lossCount = 0;
  for (const r of records) {
    if (r.netProfit > 0) winCount++;
    else if (r.netProfit < 0) lossCount++;
  }
  const totalCount = records.length;
  const winRate = totalCount > 0 ? (winCount / totalCount) * 100 : 0;

  return {
    totalRealizedProfit,
    totalSellAmount,
    totalInvestedCost,
    totalReturnRate,
    winCount,
    lossCount,
    totalCount,
    winRate,
  };
}

/**
 * 計算配息與配股各項數值（含 2.11% 二代健保補充保費與 54C 應稅比例優化）
 */
export function calculateDividendValues(params: {
  participatingShares: number;
  cashPerShare: number;
  stockPerShare: number;
  taxable54CRatio?: number; // 0~100, default 100
  customNhiFee?: number;
  remittanceFee?: number;
}): {
  grossCash: number;
  nhiFee: number;
  remittanceFee: number;
  healthAndBankFee: number;
  netCash: number;
  stockSharesReceived: number;
} {
  const shares = Math.max(0, params.participatingShares || 0);
  const cashPerShare = Math.max(0, params.cashPerShare || 0);
  const stockPerShare = Math.max(0, params.stockPerShare || 0);
  const ratio =
    params.taxable54CRatio !== undefined
      ? Math.min(100, Math.max(0, params.taxable54CRatio))
      : 100;

  const grossCash = Math.round(shares * cashPerShare);
  const taxableAmount = Math.min(10_000_000, Math.round(grossCash * (ratio / 100)));

  // 當單筆 54C 應稅股利總額 >= NT$ 20,000 時自動計算 2.11% 二代健保補充保費
  const autoNhiFee = taxableAmount >= 20000 ? Math.round(taxableAmount * 0.0211) : 0;
  const nhiFee =
    params.customNhiFee !== undefined ? Math.max(0, Math.round(params.customNhiFee)) : autoNhiFee;
  const remittanceFee =
    params.remittanceFee !== undefined ? Math.max(0, Math.round(params.remittanceFee)) : 0;
  const healthAndBankFee = nhiFee + remittanceFee;
  const netCash = Math.max(0, grossCash - healthAndBankFee);

  // 股票股利依 Math.round(參與股數 * (每股配股 / 10)) 換算獲配股數
  const stockSharesReceived = Math.round(shares * (stockPerShare / 10));

  return {
    grossCash,
    nhiFee,
    remittanceFee,
    healthAndBankFee,
    netCash,
    stockSharesReceived,
  };
}

/**
 * 彙總配息配股統計摘要 (對應分頁 4：配息配股紀錄)
 */
export function computeDividendOverview(
  records: DividendRecord[],
  currentYear = new Date().getFullYear()
): DividendOverviewSummary {
  const totalNetCash = records.reduce((s, r) => s + r.netCash, 0);
  const totalStockShares = records.reduce((s, r) => s + r.stockSharesReceived, 0);
  const totalHealthAndBankFee = records.reduce((s, r) => s + r.healthAndBankFee, 0);
  const yearPrefix = String(currentYear);
  const currentYearNetCash = records
    .filter((r) => (r.payDate || r.exDate || '').startsWith(yearPrefix))
    .reduce((s, r) => s + r.netCash, 0);

  return {
    totalNetCash,
    totalStockShares,
    currentYearNetCash,
    totalHealthAndBankFee,
    totalCount: records.length,
  };
}

/**
 * 投資組合深度分析：
 * 持股集中度、產業分佈、月度損益與勝率、各標的累計總貢獻排行 (已實現 + 股利 + 未實現)
 */
export function computePortfolioAnalytics(
  holdings: StockHolding[],
  realizedRecords: RealizedRecord[],
  dividendRecords: DividendRecord[],
  feeSettings: FeeSettings = DEFAULT_FEE_SETTINGS
) {
  const overview = computePortfolioOverview(holdings, feeSettings);

  // 1. 持股集中度 (依市值排序)
  const concentration = [...overview.items]
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((item) => ({
      code: item.code,
      name: item.name,
      marketValue: item.marketValue,
      weight: item.portfolioWeight,
      unrealizedProfit: item.unrealizedProfit,
      returnRate: item.unrealizedReturnRate,
    }));

  // 2. 產業配置比重
  const industryMap = new Map<string, { industry: string; marketValue: number; count: number }>();
  for (const item of overview.items) {
    const ind = item.industry || '未分類';
    const cur = industryMap.get(ind) || { industry: ind, marketValue: 0, count: 0 };
    cur.marketValue += item.marketValue;
    cur.count += 1;
    industryMap.set(ind, cur);
  }
  const industryBreakdown = Array.from(industryMap.values())
    .sort((a, b) => b.marketValue - a.marketValue)
    .map((x) => ({
      ...x,
      weight: overview.totalMarketValue > 0 ? (x.marketValue / overview.totalMarketValue) * 100 : 0,
    }));

  // 3. 最佳與最差績效標的 (未實現損益金額 & 報酬率)
  const sortedByProfit = [...overview.items].sort(
    (a, b) => b.unrealizedProfit - a.unrealizedProfit
  );
  const bestPerformer = sortedByProfit.length > 0 ? sortedByProfit[0] : null;
  const worstPerformer =
    sortedByProfit.length > 0 ? sortedByProfit[sortedByProfit.length - 1] : null;

  // 4. 月度已實現損益與勝率統計
  const monthlyMap = new Map<
    string,
    { month: string; netProfit: number; winCount: number; totalCount: number; sellAmount: number }
  >();
  for (const r of realizedRecords) {
    const month = (r.sellDate || '').slice(0, 7) || '未知月份';
    const cur = monthlyMap.get(month) || {
      month,
      netProfit: 0,
      winCount: 0,
      totalCount: 0,
      sellAmount: 0,
    };
    cur.netProfit += r.netProfit;
    cur.totalCount += 1;
    cur.sellAmount += r.grossSellAmount;
    if (r.netProfit > 0) cur.winCount += 1;
    monthlyMap.set(month, cur);
  }
  const monthlyStats = Array.from(monthlyMap.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((m) => ({
      ...m,
      winRate: m.totalCount > 0 ? (m.winCount / m.totalCount) * 100 : 0,
    }));

  // 5. 各標的累計總貢獻排行 (已實現 + 實收現金股利 + 未實現)
  const contribMap = new Map<
    string,
    {
      code: string;
      name: string;
      unrealizedProfit: number;
      realizedProfit: number;
      dividendCash: number;
      dividendStockShares: number;
      totalContribution: number;
    }
  >();

  for (const item of overview.items) {
    contribMap.set(item.code, {
      code: item.code,
      name: item.name,
      unrealizedProfit: item.unrealizedProfit,
      realizedProfit: 0,
      dividendCash: 0,
      dividendStockShares: 0,
      totalContribution: item.unrealizedProfit,
    });
  }

  for (const r of realizedRecords) {
    const code = normalizeStockCode(r.code);
    const cur = contribMap.get(code) || {
      code,
      name: r.name,
      unrealizedProfit: 0,
      realizedProfit: 0,
      dividendCash: 0,
      dividendStockShares: 0,
      totalContribution: 0,
    };
    cur.realizedProfit += r.netProfit;
    cur.totalContribution = cur.unrealizedProfit + cur.realizedProfit + cur.dividendCash;
    contribMap.set(code, cur);
  }

  for (const d of dividendRecords) {
    const code = normalizeStockCode(d.code);
    const cur = contribMap.get(code) || {
      code,
      name: d.name,
      unrealizedProfit: 0,
      realizedProfit: 0,
      dividendCash: 0,
      dividendStockShares: 0,
      totalContribution: 0,
    };
    cur.dividendCash += d.netCash;
    cur.dividendStockShares += d.stockSharesReceived;
    cur.totalContribution = cur.unrealizedProfit + cur.realizedProfit + cur.dividendCash;
    contribMap.set(code, cur);
  }

  const totalContributionRanking = Array.from(contribMap.values()).sort(
    (a, b) => b.totalContribution - a.totalContribution
  );

  return {
    concentration,
    industryBreakdown,
    bestPerformer,
    worstPerformer,
    monthlyStats,
    totalContributionRanking,
  };
}

/**
 * 格式化台北時間 (YYYY/MM/DD HH:mm:ss)
 */
export function formatTaipeiDateTime(date: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }
}

/**
 * 判斷目前是否為台股交易時段 (週一至週五 08:50 ~ 13:45 Asia/Taipei)
 */
export function isTaiwanMarketOpen(date: Date = new Date()): boolean {
  try {
    const taipeiStr = date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' });
    const taipeiDate = new Date(taipeiStr);
    const day = taipeiDate.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    const minutes = taipeiDate.getHours() * 60 + taipeiDate.getMinutes();
    // 08:50 (530) ~ 13:45 (825)
    return minutes >= 530 && minutes <= 825;
  } catch {
    return true;
  }
}
