export type TradeCategory = '整股' | '盤中零股' | '盤後零股' | '定期定額' | '配股' | '現股當沖';
export type StockCategory = '上市' | '上櫃' | '興櫃' | 'ETF';
export type TaxRateType = 'stock_0.3' | 'etf_0.1' | 'daytrade_0.15' | 'exempt_0' | 'custom';
export type LotDeductionStrategy = 'specific_lot' | 'cost_match' | 'fifo';
export type DividendType = '現金股利' | '股票股利' | '配息+配股';

export interface StockLot {
  id: string;
  date: string; // YYYY-MM-DD
  category: TradeCategory;
  shares: number; // 當前剩餘股數
  originalShares?: number; // 原始買進股數
  price: number; // 買進成交單價
  buyFee: number; // 當前剩餘對應買進手續費
  originalBuyFee?: number; // 原始買進手續費
  note: string;
  isDividendLot?: boolean;
  dividendRecordId?: string;
}

export interface StockHolding {
  code: string;
  name: string;
  category: StockCategory | string;
  currentPrice: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
  industry: string;
  note: string;
  lots: StockLot[];
  lastUpdated?: string;
  priceSource?: string;
}

export interface BuyRecord {
  id: string;
  lotId: string;
  code: string;
  name: string;
  date: string;
  category: TradeCategory;
  shares: number; // 永遠保留當初實際買進的原始股數
  price: number; // 成交單價
  buyFee: number; // 原始買進手續費
  totalCost: number; // 原始投入成本 (shares * price + buyFee)
  note: string;
  isDividendLot?: boolean;
  dividendRecordId?: string;
}

export interface DeductedLotSnapshot {
  lotId: string;
  date: string;
  category: TradeCategory;
  sharesDeducted: number;
  buyPrice: number;
  buyFeeDeducted: number;
  costDeducted: number;
  note: string;
}

export interface RealizedRecord {
  id: string;
  code: string;
  name: string;
  sellDate: string;
  category: TradeCategory;
  shares: number;
  avgBuyPrice: number;
  sellPrice: number;
  totalBuyCost: number; // 含對應買進手續費 buyFeeDeducted
  buyFeeDeducted: number;
  grossSellAmount: number;
  sellFee: number;
  sellTax: number;
  taxRateType: TaxRateType;
  netProfit: number; // 賣出總金額 - (買進成交價金 + 對應買進手續費) - 賣出手續費 - 賣出交易稅
  returnRate: number; // %
  note: string;
  deductedFromInventory: boolean;
  deductionStrategy?: LotDeductionStrategy;
  deductedLots?: DeductedLotSnapshot[];
  stockCategory?: string;
  industry?: string;
}

export interface DividendRecord {
  id: string;
  code: string;
  name: string;
  dividendType: DividendType;
  exDate: string; // 除權息交易日
  payDate: string; // 股利發放日
  participatingShares: number; // 除權息股數
  cashPerShare: number; // 每股現金
  grossCash: number; // 應發放現金
  taxable54CRatio: number; // 54C 應稅比例 (0~100)，預設一般股 100%，ETF 可自訂
  nhiFee: number; // 二代健保補充保費 (2.11%)
  remittanceFee: number; // 匯費
  healthAndBankFee: number; // 健保/匯費合計
  netCash: number; // 實收現金
  stockPerShare: number; // 每股配股 (元)
  stockSharesReceived: number; // 獲配股數
  addedToInventory: boolean; // 計入庫存狀態
  createdLotId?: string;
  note: string;
}

export interface PortfolioState {
  holdings: StockHolding[];
  buyRecords: BuyRecord[];
  realizedRecords: RealizedRecord[];
  dividendRecords: DividendRecord[];
  lastPriceSyncAt?: string;
  lastSheetSyncAt?: string;
}

export interface FeeSettings {
  brokerDiscount: number; // 預設 0.6 (6折)
  minRegularFee: number; // 預設 20 元
  minOddLotFee: number; // 預設 1 元
  includeEstSellFeeInUnrealized: boolean; // 預設 false (相容原版僅扣預估賣出證交稅)，可切換加扣預估賣出手續費
  autoRefreshIntervalMinutes: number; // 預設 10 分鐘
  marketHoursOnly: boolean; // 是否僅於台股開盤時段自動更新
}

export interface LinkedSpreadsheet {
  spreadsheetId: string;
  title: string;
  url: string;
  linkedAt: string;
}

export interface StockQuoteResult {
  code: string;
  name: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  category: StockCategory | string;
  industry: string;
  source: 'TWSE_MIS' | 'TPEX_MIS' | 'YAHOO_API' | 'YAHOO_WEB' | 'FALLBACK_DICT';
  updatedAt: string;
  marketOpen?: boolean;
}

export interface HoldingComputedMetrics {
  code: string;
  name: string;
  category: string;
  totalShares: number;
  avgCostPrice: number;
  currentPrice: number;
  totalCost: number;
  marketValue: number;
  estSellTax: number;
  estSellFee: number;
  unrealizedProfit: number;
  unrealizedReturnRate: number; // %
  portfolioWeight: number; // %
  industry: string;
  note: string;
  isEtf: boolean;
}

export interface PortfolioOverviewSummary {
  updatedAt: string;
  totalCost: number;
  totalMarketValue: number;
  totalEstTax: number;
  totalEstSellFee: number;
  totalUnrealizedProfit: number;
  totalUnrealizedReturnRate: number; // %
  holdingCount: number;
  profitableCount: number;
  losingCount: number;
  flatCount: number;
  items: HoldingComputedMetrics[];
}

export interface RealizedOverviewSummary {
  totalRealizedProfit: number;
  totalSellAmount: number;
  totalInvestedCost: number;
  totalReturnRate: number; // %
  winCount: number;
  lossCount: number;
  totalCount: number;
  winRate: number; // %
}

export interface DividendOverviewSummary {
  totalNetCash: number;
  totalStockShares: number;
  currentYearNetCash: number;
  totalHealthAndBankFee: number;
  totalCount: number;
}
