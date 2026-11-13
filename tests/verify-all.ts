import assert from 'node:assert/strict';
import {
  calculateDividendValues,
  calculateEstSellTax,
  calculateLotCost,
  computePortfolioOverview,
  executeSellTransaction,
  restoreRealizedRecordToHoldings,
} from '../shared/calculations';
import {
  buildAllSheetTabsData,
  fixHundredfoldPnlAnomaly,
  parsePortfolioFromSheetTabs,
} from '../shared/sheetsEngine';
import { StockHolding } from '../shared/types';
import { isEtfStock, normalizeStockCode } from '../shared/twStockDictionary';

console.log('=== 開始執行個人股票庫存統計表核心測試 ===');

// 1. 測試股票代碼正規化與前導零修補
assert.equal(normalizeStockCode('50'), '0050', '50 應修補為 0050');
assert.equal(normalizeStockCode('878'), '00878', '878 應修補為 00878');
assert.equal(normalizeStockCode('919'), '00919', '919 應修補為 00919');
assert.equal(normalizeStockCode('6208'), '006208', '6208 應修補為 006208');
assert.equal(normalizeStockCode('679B'), '00679B', '679B 應修補為 00679B');
assert.equal(normalizeStockCode('TSE:2330.TW'), '2330', 'TSE:2330.TW 應清理為 2330');
assert.equal(isEtfStock('00878'), true, '00878 應識別為 ETF');
assert.equal(isEtfStock('2330'), false, '2330 應識別為一般台股');
console.log('✅ 1. 股票代碼正規化與 ETF 識別測試通過');

// 2. 測試預估賣出證交稅與未實現損益計算
assert.equal(calculateEstSellTax(1_000_000, '2330'), 3000, '一般台股證交稅應為 0.3%');
assert.equal(calculateEstSellTax(1_000_000, '0050'), 1000, '台股 ETF 證交稅應為 0.1%');

const sampleHoldings: StockHolding[] = [
  {
    code: '2330',
    name: '台積電',
    category: '上市',
    currentPrice: 1050,
    industry: '半導體業',
    note: '核心持股',
    lots: [
      {
        id: 'lot_1',
        date: '2026-01-10',
        category: '整股',
        shares: 1000,
        price: 900,
        buyFee: 769,
        note: '第一批',
      },
      {
        id: 'lot_2',
        date: '2026-02-15',
        category: '整股',
        shares: 1000,
        price: 1000,
        buyFee: 855,
        note: '第二批',
      },
    ],
  },
];

const overview = computePortfolioOverview(sampleHoldings);
const tsmc = overview.items[0];
assert.equal(tsmc.totalShares, 2000);
assert.equal(tsmc.totalCost, 900769 + 1000855);
assert.equal(tsmc.marketValue, 2_100_000);
assert.equal(tsmc.estSellTax, Math.floor(2_100_000 * 0.003));
assert.equal(
  tsmc.unrealizedProfit,
  2_100_000 - (900769 + 1000855) - Math.floor(2_100_000 * 0.003)
);
console.log('✅ 2. 分筆庫存與未實現損益計算測試通過');

// 3. 測試賣出批次沖銷 (部分賣出比例拆算手續費) 與刪除已實現紀錄精準還原
const sellRes = executeSellTransaction({
  holdings: sampleHoldings,
  code: '2330',
  sellDate: '2026-03-01',
  category: '盤中零股',
  sellShares: 400,
  sellPrice: 1080,
  sellFee: 369,
  taxRateType: 'stock_0.3',
  deductFromInventory: true,
  strategy: 'specific_lot',
  targetLotId: 'lot_1',
});

const remainingLot1 = sellRes.updatedHoldings[0].lots.find((l) => l.id === 'lot_1')!;
assert.equal(remainingLot1.shares, 600, '部分賣出 400 股後，批次 1 應剩餘 600 股');
const expectedDeductedFee = Math.round(769 * (400 / 1000));
assert.equal(
  sellRes.realizedRecord.buyFeeDeducted,
  expectedDeductedFee,
  '應按比例拆算扣除買進手續費'
);

// 還原測試
const restoredHoldings = restoreRealizedRecordToHoldings(
  sellRes.updatedHoldings,
  sellRes.realizedRecord
);
const restoredLot1 = restoredHoldings[0].lots.find((l) => l.id === 'lot_1')!;
assert.equal(restoredLot1.shares, 1000, '刪除已實現紀錄後應精準還原為 1000 股');
assert.equal(restoredLot1.buyFee, 769, '刪除已實現紀錄後應精準還原買進手續費 769 元');
console.log('✅ 3. 賣出批次沖銷與還原庫存測試通過');

// 4. 測試配息 2.11% 二代健保補充保費與股票股利換算
const divCalc = calculateDividendValues({
  participatingShares: 10000,
  cashPerShare: 2.5, // 應發放 25,000 元 (>= 20,000)
  stockPerShare: 0.5, // 每股配股 0.5 元 -> 10000 * (0.5/10) = 500 股
  taxable54CRatio: 100,
  remittanceFee: 10,
});
assert.equal(divCalc.grossCash, 25000);
assert.equal(divCalc.nhiFee, Math.round(25000 * 0.0211));
assert.equal(divCalc.netCash, 25000 - Math.round(25000 * 0.0211) - 10);
assert.equal(divCalc.stockSharesReceived, 500);
console.log('✅ 4. 配息 2.11% 二代健保與配股換算測試通過');

// 5. 測試 100 倍百分比誤套用修正與雙向試算表讀寫還原
assert.equal(fixHundredfoldPnlAnomaly(1500000, 15000), 15000, '應自動修正放大 100 倍的損益異常');

const builtTabs = buildAllSheetTabsData({
  holdings: sellRes.updatedHoldings,
  buyRecords: [
    {
      id: 'buy_lot_1',
      lotId: 'lot_1',
      code: '2330',
      name: '台積電',
      date: '2026-01-10',
      category: '整股',
      shares: 1000, // 原始買進股數永遠保持 1000 股不變！
      price: 900,
      buyFee: 769,
      totalCost: calculateLotCost(1000, 900, 769),
      note: '第一批',
    },
    {
      id: 'buy_lot_2',
      lotId: 'lot_2',
      code: '2330',
      name: '台積電',
      date: '2026-02-15',
      category: '整股',
      shares: 1000,
      price: 1000,
      buyFee: 855,
      totalCost: calculateLotCost(1000, 1000, 855),
      note: '第二批',
    },
  ],
  realizedRecords: [sellRes.realizedRecord],
  dividendRecords: [],
});

const parsedBack = parsePortfolioFromSheetTabs({
  overviewRows: builtTabs.overviewRows.map((r) => r.map(String)),
  transactionRows: builtTabs.transactionRows.map((r) => r.map(String)),
  realizedRows: builtTabs.realizedRows.map((r) => r.map(String)),
  dividendRows: builtTabs.dividendRows.map((r) => r.map(String)),
});

const reconstructedTotalShares = parsedBack.holdings[0].lots.reduce(
  (s, l) => s + l.shares,
  0
);
assert.equal(
  reconstructedTotalShares,
  1600,
  '從試算表四分頁重載並交叉校對後，剩餘庫存應精準為 1600 股'
);
assert.equal(
  parsedBack.buyRecords[0].shares,
  1000,
  '分筆交易明細之原始買進紀錄必須維持 1000 股不變'
);
console.log('✅ 5. Google Sheets 四分頁雙向讀寫與庫存交叉校對測試通過');
console.log('🎉 所有核心單元與整合測試 100% 通過！');
