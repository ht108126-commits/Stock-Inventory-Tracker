import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  calculateBrokerageFee,
  calculateDividendValues,
  calculateSellTaxByType,
} from '../../shared/calculations';
import {
  DividendRecord,
  DividendType,
  FeeSettings,
  LotDeductionStrategy,
  RealizedRecord,
  StockHolding,
  StockLot,
  TaxRateType,
  TradeCategory,
} from '../../shared/types';
import {
  isEtfStock,
  lookupStockMeta,
  normalizeStockCode,
} from '../../shared/twStockDictionary';

// ============================================================================
// 1. 新增買進 / 編輯批次 Modal
// ============================================================================
interface BuyLotModalProps {
  isOpen: boolean;
  onClose: () => void;
  feeSettings: FeeSettings;
  editingContext?: {
    holding: StockHolding;
    lot: StockLot;
  } | null;
  presetCode?: string;
  onSubmit: (data: {
    code: string;
    name: string;
    stockCategory: string;
    industry: string;
    date: string;
    tradeCategory: TradeCategory;
    shares: number;
    price: number;
    buyFee: number;
    currentPrice?: number;
    note: string;
    editingLotId?: string;
  }) => void;
}

export const BuyLotModal: React.FC<BuyLotModalProps> = ({
  isOpen,
  onClose,
  feeSettings,
  editingContext,
  presetCode,
  onSubmit,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [stockCategory, setStockCategory] = useState('上市');
  const [industry, setIndustry] = useState('半導體業');
  const [date, setDate] = useState(today);
  const [tradeCategory, setTradeCategory] = useState<TradeCategory>('整股');
  const [shares, setShares] = useState<number>(1000);
  const [price, setPrice] = useState<number>(100);
  const [buyFee, setBuyFee] = useState<number>(85);
  const [manualFee, setManualFee] = useState(false);
  const [note, setNote] = useState('');
  const [liveQuotePrice, setLiveQuotePrice] = useState<number | undefined>(undefined);
  const [loadingQuote, setLoadingQuote] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    if (editingContext) {
      const { holding, lot } = editingContext;
      setCode(holding.code);
      setName(holding.name);
      setStockCategory(holding.category || '上市');
      setIndustry(holding.industry || '');
      setDate(lot.date || today);
      setTradeCategory(lot.category || '整股');
      setShares(lot.shares);
      setPrice(lot.price);
      setBuyFee(lot.buyFee);
      setManualFee(true);
      setNote(lot.note || '');
      setLiveQuotePrice(holding.currentPrice);
    } else {
      const initCode = presetCode ? normalizeStockCode(presetCode) : '';
      const meta = initCode ? lookupStockMeta(initCode) : null;
      setCode(initCode);
      setName(meta && meta.name !== initCode ? meta.name : '');
      setStockCategory(meta?.category || '上市');
      setIndustry(meta?.industry || '');
      setDate(today);
      setTradeCategory('整股');
      setShares(1000);
      setPrice(meta?.refPrice || 100);
      setManualFee(false);
      setNote('');
      setLiveQuotePrice(meta?.refPrice);
    }
  }, [isOpen, editingContext, presetCode, today]);

  useEffect(() => {
    if (!manualFee) {
      const gross = Math.round((shares || 0) * (price || 0));
      setBuyFee(calculateBrokerageFee(gross, tradeCategory, feeSettings));
    }
  }, [shares, price, tradeCategory, feeSettings, manualFee]);

  if (!isOpen) return null;

  const handleCodeBlur = async () => {
    const norm = normalizeStockCode(code);
    if (!norm) return;
    setCode(norm);
    const meta = lookupStockMeta(norm);
    if (meta.name !== norm) {
      setName(meta.name);
      setStockCategory(meta.category);
      setIndustry(meta.industry);
    }
    setLoadingQuote(true);
    try {
      const res = await fetch(`/api/stock-price?code=${encodeURIComponent(norm)}`);
      if (res.ok) {
        const q = await res.json();
        if (q.name) setName(q.name);
        if (q.category) setStockCategory(q.category);
        if (q.industry) setIndustry(q.industry);
        if (q.price > 0) {
          setLiveQuotePrice(q.price);
          if (!editingContext) setPrice(q.price);
        }
      }
    } catch {
      // ignore
    } finally {
      setLoadingQuote(false);
    }
  };

  const grossAmount = Math.round((shares || 0) * (price || 0));
  const totalCost = grossAmount + Math.round(buyFee || 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeStockCode(code);
    if (!norm || shares <= 0) return;
    onSubmit({
      code: norm,
      name: name.trim() || lookupStockMeta(norm).name,
      stockCategory,
      industry: industry.trim() || lookupStockMeta(norm).industry,
      date,
      tradeCategory,
      shares: Math.round(shares),
      price: Number(price),
      buyFee: Math.round(buyFee || 0),
      currentPrice: liveQuotePrice || Number(price),
      note: note.trim(),
      editingLotId: editingContext?.lot.id,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: '16px', fontWeight: 700 }}>
            {editingContext ? `編輯買進批次 — ${editingContext.holding.name} (${editingContext.holding.code})` : '新增買進紀錄／入庫批次'}
          </h2>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">股票代碼 (自動補零與查詢報價)</label>
                <input
                  id="buy-stock-code"
                  className="form-input mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onBlur={handleCodeBlur}
                  placeholder="例如 2330, 0050, 00878"
                  required
                  disabled={Boolean(editingContext)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">
                  股票名稱 {loadingQuote && <span style={{ color: 'var(--brand-primary)' }}>(查詢即時股價中...)</span>}
                </label>
                <input
                  id="buy-stock-name"
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="自動帶出或手動輸入"
                  required
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">交易日期</label>
                <input
                  id="buy-date"
                  type="date"
                  className="form-input mono"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">交易類別</label>
                <select
                  id="buy-trade-category"
                  className="form-select"
                  value={tradeCategory}
                  onChange={(e) => setTradeCategory(e.target.value as TradeCategory)}
                >
                  <option value="整股">整股</option>
                  <option value="盤中零股">盤中零股</option>
                  <option value="盤後零股">盤後零股</option>
                  <option value="定期定額">定期定額</option>
                  <option value="配股">配股 (0 成本)</option>
                </select>
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">買進股數 (股)</label>
                <input
                  id="buy-shares"
                  type="number"
                  min={1}
                  step={1}
                  className="form-input mono"
                  value={shares}
                  onChange={(e) => setShares(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">買進成交單價 (NT$)</label>
                <input
                  id="buy-price"
                  type="number"
                  min={0}
                  step="0.01"
                  className="form-input mono"
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">
                  買進手續費 (預設 {(feeSettings.brokerDiscount * 10).toFixed(1)} 折自動試算)
                </label>
                <input
                  id="buy-fee"
                  type="number"
                  min={0}
                  step={1}
                  className="form-input mono"
                  value={buyFee}
                  onChange={(e) => {
                    setManualFee(true);
                    setBuyFee(Number(e.target.value));
                  }}
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">市場別</label>
                <select
                  className="form-select"
                  value={stockCategory}
                  onChange={(e) => setStockCategory(e.target.value)}
                >
                  <option value="上市">上市</option>
                  <option value="上櫃">上櫃</option>
                  <option value="ETF">ETF</option>
                  <option value="興櫃">興櫃</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">產業類別</label>
                <input
                  className="form-input"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="例如 半導體業、ETF-高股息"
                />
              </div>
              <div className="form-group">
                <label className="form-label">備註</label>
                <input
                  className="form-input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="選填備註"
                />
              </div>
            </div>

            <div
              className="feature-item"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '10px',
              }}
            >
              <div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  成交價金：NT$ {grossAmount.toLocaleString()} ＋ 買進手續費：NT$ {Math.round(buyFee).toLocaleString()}
                </div>
                <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '2px' }}>
                  單筆總投入成本：<span className="mono">NT$ {totalCost.toLocaleString()}</span>（均價{' '}
                  <span className="mono">{shares > 0 ? (totalCost / shares).toFixed(2) : '0.00'}</span>）
                </div>
              </div>
              <div className="badge-brand">自動回寫 Google Sheet</div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              {editingContext ? '儲存批次修改並同步' : '確認新增買進並同步'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// 2. 記錄賣出 / 編輯已實現損益 Modal
// ============================================================================
interface SellModalProps {
  isOpen: boolean;
  onClose: () => void;
  holdings: StockHolding[];
  feeSettings: FeeSettings;
  presetHolding?: StockHolding | null;
  presetLotId?: string;
  editingRealized?: RealizedRecord | null;
  onSubmit: (data: {
    code: string;
    name: string;
    sellDate: string;
    category: TradeCategory;
    sellShares: number;
    sellPrice: number;
    sellFee: number;
    taxRateType: TaxRateType;
    customTax: number;
    deductFromInventory: boolean;
    strategy: LotDeductionStrategy;
    targetLotId?: string;
    targetBuyPrice?: number;
    manualBuyFee?: number;
    note: string;
    editingRecordId?: string;
  }) => void;
}

export const SellModal: React.FC<SellModalProps> = ({
  isOpen,
  onClose,
  holdings,
  feeSettings,
  presetHolding,
  presetLotId,
  editingRealized,
  onSubmit,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sellDate, setSellDate] = useState(today);
  const [category, setCategory] = useState<TradeCategory>('整股');
  const [sellShares, setSellShares] = useState(1000);
  const [sellPrice, setSellPrice] = useState(100);
  const [sellFee, setSellFee] = useState(85);
  const [manualSellFee, setManualSellFee] = useState(false);
  const [taxRateType, setTaxRateType] = useState<TaxRateType>('stock_0.3');
  const [customTax, setCustomTax] = useState(0);
  const [deductFromInventory, setDeductFromInventory] = useState(true);
  const [strategy, setStrategy] = useState<LotDeductionStrategy>('fifo');
  const [targetLotId, setTargetLotId] = useState<string>('');
  const [targetBuyPrice, setTargetBuyPrice] = useState<number>(90);
  const [manualBuyFee, setManualBuyFee] = useState<number>(0);
  const [note, setNote] = useState('');

  const matchedHolding = holdings.find(
    (h) => normalizeStockCode(h.code) === normalizeStockCode(code)
  );

  useEffect(() => {
    if (!isOpen) return;
    if (editingRealized) {
      setCode(editingRealized.code);
      setName(editingRealized.name);
      setSellDate(editingRealized.sellDate);
      setCategory(editingRealized.category || '整股');
      setSellShares(editingRealized.shares);
      setSellPrice(editingRealized.sellPrice);
      setSellFee(editingRealized.sellFee);
      setManualSellFee(true);
      setTaxRateType(editingRealized.taxRateType || 'stock_0.3');
      setCustomTax(editingRealized.sellTax);
      setDeductFromInventory(editingRealized.deductedFromInventory);
      setStrategy(editingRealized.deductionStrategy || 'fifo');
      setTargetBuyPrice(Number(editingRealized.avgBuyPrice.toFixed(2)));
      setManualBuyFee(editingRealized.buyFeeDeducted || 0);
      setNote(editingRealized.note || '');
      return;
    }

    const h = presetHolding || holdings[0] || null;
    if (h) {
      const totalShares = h.lots.reduce((s, l) => s + l.shares, 0);
      const totalCost = h.lots.reduce(
        (s, l) => s + Math.round(l.shares * l.price) + l.buyFee,
        0
      );
      const avg = totalShares > 0 ? totalCost / totalShares : 0;
      const isEtf = isEtfStock(h.code, h.name, h.category, h.industry);

      setCode(h.code);
      setName(h.name);
      setSellDate(today);
      setCategory(totalShares >= 1000 ? '整股' : '盤中零股');
      const targetLot = presetLotId
        ? h.lots.find((l) => l.id === presetLotId)
        : h.lots[0];
      setSellShares(targetLot ? targetLot.shares : Math.min(1000, totalShares));
      setSellPrice(h.currentPrice || Number(avg.toFixed(2)));
      setManualSellFee(false);
      setTaxRateType(isEtf ? 'etf_0.1' : 'stock_0.3');
      setDeductFromInventory(true);
      if (presetLotId) {
        setStrategy('specific_lot');
        setTargetLotId(presetLotId);
      } else {
        setStrategy('fifo');
        setTargetLotId(h.lots[0]?.id || '');
      }
      setTargetBuyPrice(Number((targetLot?.price || avg).toFixed(2)));
      setManualBuyFee(0);
      setNote('');
    } else {
      setCode('');
      setName('');
      setSellDate(today);
      setDeductFromInventory(false);
    }
  }, [isOpen, presetHolding, presetLotId, editingRealized, holdings, today]);

  useEffect(() => {
    if (!manualSellFee) {
      const gross = Math.round((sellShares || 0) * (sellPrice || 0));
      setSellFee(calculateBrokerageFee(gross, category, feeSettings));
    }
  }, [sellShares, sellPrice, category, feeSettings, manualSellFee]);

  if (!isOpen) return null;

  const grossSell = Math.round((sellShares || 0) * (sellPrice || 0));
  const computedTax = calculateSellTaxByType(grossSell, taxRateType, customTax);

  // 預覽買進成本與比例買進手續費
  let previewBuyCost = Math.round((sellShares || 0) * (targetBuyPrice || 0)) + Math.round(manualBuyFee || 0);
  if (deductFromInventory && matchedHolding && matchedHolding.lots.length > 0 && !editingRealized) {
    const selectedLot =
      strategy === 'specific_lot'
        ? matchedHolding.lots.find((l) => l.id === targetLotId) || matchedHolding.lots[0]
        : matchedHolding.lots[0];
    if (selectedLot) {
      const estFee =
        selectedLot.shares > 0
          ? Math.round(selectedLot.buyFee * Math.min(1, sellShares / selectedLot.shares))
          : 0;
      previewBuyCost = Math.round(sellShares * selectedLot.price) + estFee;
    }
  }

  const previewNetProfit = grossSell - previewBuyCost - Math.round(sellFee || 0) - computedTax;
  const previewRoi = previewBuyCost > 0 ? (previewNetProfit / previewBuyCost) * 100 : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeStockCode(code);
    if (!norm || sellShares <= 0) return;
    onSubmit({
      code: norm,
      name: name.trim() || lookupStockMeta(norm).name,
      sellDate,
      category,
      sellShares: Math.round(sellShares),
      sellPrice: Number(sellPrice),
      sellFee: Math.round(sellFee || 0),
      taxRateType,
      customTax: Math.round(customTax || 0),
      deductFromInventory,
      strategy,
      targetLotId: strategy === 'specific_lot' ? targetLotId : undefined,
      targetBuyPrice: Number(targetBuyPrice),
      manualBuyFee: Math.round(manualBuyFee || 0),
      note: note.trim(),
      editingRecordId: editingRealized?.id,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: '16px', fontWeight: 700 }}>
            {editingRealized ? '編輯已實現損益紀錄（自動連動調整原庫存批次）' : '記錄賣出交易／批次沖銷'}
          </h2>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">選擇持股或輸入代碼</label>
                <input
                  id="sell-stock-code"
                  className="form-input mono"
                  list="holding-codes-list"
                  value={code}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCode(val);
                    const hit = holdings.find(
                      (h) => normalizeStockCode(h.code) === normalizeStockCode(val)
                    );
                    if (hit) {
                      setName(hit.name);
                      setSellPrice(hit.currentPrice);
                      setTaxRateType(
                        isEtfStock(hit.code, hit.name, hit.category) ? 'etf_0.1' : 'stock_0.3'
                      );
                      setTargetLotId(hit.lots[0]?.id || '');
                    } else {
                      const meta = lookupStockMeta(val);
                      if (meta.name !== normalizeStockCode(val)) setName(meta.name);
                    }
                  }}
                  required
                />
                <datalist id="holding-codes-list">
                  {holdings.map((h) => (
                    <option key={h.code} value={h.code}>
                      {h.name} (庫存 {h.lots.reduce((s, l) => s + l.shares, 0)} 股)
                    </option>
                  ))}
                </datalist>
              </div>
              <div className="form-group">
                <label className="form-label">股票名稱</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">賣出日期</label>
                <input
                  type="date"
                  className="form-input mono"
                  value={sellDate}
                  onChange={(e) => setSellDate(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">交易類別</label>
                <select
                  className="form-select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as TradeCategory)}
                >
                  <option value="整股">整股</option>
                  <option value="盤中零股">盤中零股</option>
                  <option value="盤後零股">盤後零股</option>
                  <option value="現股當沖">現股當沖</option>
                </select>
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">賣出股數 (股)</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="form-input mono"
                  value={sellShares}
                  onChange={(e) => setSellShares(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">賣出成交單價 (NT$)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="form-input mono"
                  value={sellPrice}
                  onChange={(e) => setSellPrice(Number(e.target.value))}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">賣出手續費 (NT$)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="form-input mono"
                  value={sellFee}
                  onChange={(e) => {
                    setManualSellFee(true);
                    setSellFee(Number(e.target.value));
                  }}
                />
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">證券交易稅率選擇</label>
                <select
                  className="form-select"
                  value={taxRateType}
                  onChange={(e) => setTaxRateType(e.target.value as TaxRateType)}
                >
                  <option value="stock_0.3">一般股票 (0.3%)</option>
                  <option value="etf_0.1">台股 ETF (0.1%)</option>
                  <option value="daytrade_0.15">現股當沖減半 (0.15%)</option>
                  <option value="exempt_0">免稅 (0%)</option>
                  <option value="custom">自訂稅額</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">賣出交易稅額 (NT$)</label>
                <input
                  type="number"
                  min={0}
                  className="form-input mono"
                  value={taxRateType === 'custom' ? customTax : computedTax}
                  disabled={taxRateType !== 'custom'}
                  onChange={(e) => setCustomTax(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="feature-item" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600 }}>
                <input
                  type="checkbox"
                  checked={deductFromInventory}
                  onChange={(e) => setDeductFromInventory(e.target.checked)}
                />
                同步從現有庫存扣減股數與買進手續費（分筆交易明細之原始買進紀錄將保持不變）
              </label>

              {deductFromInventory && matchedHolding ? (
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">批次沖銷順序</label>
                    <select
                      className="form-select"
                      value={strategy}
                      onChange={(e) => setStrategy(e.target.value as LotDeductionStrategy)}
                    >
                      <option value="fifo">先進先出 (FIFO — 依買進日期由舊到新)</option>
                      <option value="specific_lot">指定批次 (Specific Lot)</option>
                      <option value="cost_match">同成本匹配 (Cost Match — 優先沖銷最接近單價)</option>
                    </select>
                  </div>

                  {strategy === 'specific_lot' && (
                    <div className="form-group">
                      <label className="form-label">選擇要沖銷的買進批次</label>
                      <select
                        className="form-select mono"
                        value={targetLotId}
                        onChange={(e) => setTargetLotId(e.target.value)}
                      >
                        {matchedHolding.lots.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.date} | {l.shares}股 @ ${l.price} (手續費 ${l.buyFee})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {strategy === 'cost_match' && (
                    <div className="form-group">
                      <label className="form-label">指定匹配買進單價 (NT$)</label>
                      <input
                        type="number"
                        step="0.01"
                        className="form-input mono"
                        value={targetBuyPrice}
                        onChange={(e) => setTargetBuyPrice(Number(e.target.value))}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">買進成本單價 (NT$)</label>
                    <input
                      type="number"
                      step="0.01"
                      className="form-input mono"
                      value={targetBuyPrice}
                      onChange={(e) => setTargetBuyPrice(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">對應買進手續費 (NT$)</label>
                    <input
                      type="number"
                      className="form-input mono"
                      value={manualBuyFee}
                      onChange={(e) => setManualBuyFee(Number(e.target.value))}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">備註</label>
              <input
                className="form-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如 獲利了結、調整部位"
              />
            </div>

            <div className="feature-item">
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                賣出總金額：NT$ {grossSell.toLocaleString()} ｜ 預估投入成本(含買進手續費)：NT$ {previewBuyCost.toLocaleString()} ｜ 賣出稅費：NT$ {(Math.round(sellFee) + computedTax).toLocaleString()}
              </div>
              <div style={{ fontSize: '15px', fontWeight: 700, marginTop: '4px' }}>
                預估淨已實現損益：
                <span className={`mono ${previewNetProfit >= 0 ? 'text-up' : 'text-down'}`}>
                  {' '}
                  {previewNetProfit >= 0 ? '+' : ''}NT$ {previewNetProfit.toLocaleString()} ({previewRoi >= 0 ? '+' : ''}
                  {previewRoi.toFixed(2)}%)
                </span>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              {editingRealized ? '儲存修改並重新連動庫存' : '確認賣出並寫入試算表'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// 3. 配息與配股紀錄 Modal
// ============================================================================
interface DividendModalProps {
  isOpen: boolean;
  onClose: () => void;
  holdings: StockHolding[];
  onSubmit: (record: Omit<DividendRecord, 'id'>) => void;
}

export const DividendModal: React.FC<DividendModalProps> = ({
  isOpen,
  onClose,
  holdings,
  onSubmit,
}) => {
  const today = new Date().toISOString().slice(0, 10);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [dividendType, setDividendType] = useState<DividendType>('現金股利');
  const [exDate, setExDate] = useState(today);
  const [payDate, setPayDate] = useState(today);
  const [participatingShares, setParticipatingShares] = useState(1000);
  const [cashPerShare, setCashPerShare] = useState(2.5);
  const [stockPerShare, setStockPerShare] = useState(0);
  const [taxable54CRatio, setTaxable54CRatio] = useState(100);
  const [remittanceFee, setRemittanceFee] = useState(10);
  const [customNhiFee, setCustomNhiFee] = useState<number | undefined>(undefined);
  const [addedToInventory, setAddedToInventory] = useState(true);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    const h = holdings[0];
    if (h) {
      setCode(h.code);
      setName(h.name);
      setParticipatingShares(h.lots.reduce((s, l) => s + l.shares, 0));
      setTaxable54CRatio(isEtfStock(h.code, h.name, h.category) ? 40 : 100);
    } else {
      setCode('');
      setName('');
      setParticipatingShares(1000);
    }
    setDividendType('現金股利');
    setCashPerShare(2.0);
    setStockPerShare(0);
    setRemittanceFee(10);
    setCustomNhiFee(undefined);
    setAddedToInventory(true);
    setNote('');
  }, [isOpen, holdings]);

  if (!isOpen) return null;

  const effectiveCashPerShare = dividendType === '股票股利' ? 0 : cashPerShare;
  const effectiveStockPerShare = dividendType === '現金股利' ? 0 : stockPerShare;

  const calc = calculateDividendValues({
    participatingShares,
    cashPerShare: effectiveCashPerShare,
    stockPerShare: effectiveStockPerShare,
    taxable54CRatio,
    customNhiFee,
    remittanceFee: effectiveCashPerShare > 0 ? remittanceFee : 0,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeStockCode(code);
    if (!norm || participatingShares <= 0) return;

    onSubmit({
      code: norm,
      name: name.trim() || lookupStockMeta(norm).name,
      dividendType,
      exDate,
      payDate,
      participatingShares: Math.round(participatingShares),
      cashPerShare: effectiveCashPerShare,
      grossCash: calc.grossCash,
      taxable54CRatio,
      nhiFee: calc.nhiFee,
      remittanceFee: calc.remittanceFee,
      healthAndBankFee: calc.healthAndBankFee,
      netCash: calc.netCash,
      stockPerShare: effectiveStockPerShare,
      stockSharesReceived: calc.stockSharesReceived,
      addedToInventory: calc.stockSharesReceived > 0 ? addedToInventory : false,
      note: note.trim(),
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 style={{ fontSize: '16px', fontWeight: 700 }}>
            新增配息／配股紀錄（內建 2.11% 二代健保與 54C 應稅比例試算）
          </h2>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">股票代碼</label>
                <input
                  className="form-input mono"
                  list="holding-codes-list"
                  value={code}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCode(val);
                    const hit = holdings.find(
                      (h) => normalizeStockCode(h.code) === normalizeStockCode(val)
                    );
                    if (hit) {
                      setName(hit.name);
                      setParticipatingShares(hit.lots.reduce((s, l) => s + l.shares, 0));
                      setTaxable54CRatio(isEtfStock(hit.code, hit.name, hit.category) ? 40 : 100);
                    } else {
                      const meta = lookupStockMeta(val);
                      if (meta.name !== normalizeStockCode(val)) setName(meta.name);
                    }
                  }}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">股票名稱</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">股利類別</label>
                <select
                  className="form-select"
                  value={dividendType}
                  onChange={(e) => setDividendType(e.target.value as DividendType)}
                >
                  <option value="現金股利">現金股利</option>
                  <option value="股票股利">股票股利</option>
                  <option value="配息+配股">配息+配股</option>
                </select>
              </div>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">除權息交易日</label>
                <input
                  type="date"
                  className="form-input mono"
                  value={exDate}
                  onChange={(e) => setExDate(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">股利發放日</label>
                <input
                  type="date"
                  className="form-input mono"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">參與除權息股數 (股)</label>
                <input
                  type="number"
                  min={1}
                  className="form-input mono"
                  value={participatingShares}
                  onChange={(e) => setParticipatingShares(Number(e.target.value))}
                  required
                />
              </div>
            </div>

            {dividendType !== '股票股利' && (
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">每股現金股利 (NT$)</label>
                  <input
                    type="number"
                    min={0}
                    step="0.0001"
                    className="form-input mono"
                    value={cashPerShare}
                    onChange={(e) => setCashPerShare(Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">54C 境內股利所得佔比 (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="form-input mono"
                    value={taxable54CRatio}
                    onChange={(e) => setTaxable54CRatio(Number(e.target.value))}
                    title="一般個股為 100%；ETF 若含收益平準金或財產交易所得，僅 54C 部份達 2 萬元需扣 2.11% 二代健保"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">二代健保補充保費 (2.11%)</label>
                  <input
                    type="number"
                    min={0}
                    className="form-input mono"
                    value={customNhiFee !== undefined ? customNhiFee : calc.nhiFee}
                    onChange={(e) => setCustomNhiFee(Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">跨行匯費 (NT$)</label>
                  <input
                    type="number"
                    min={0}
                    className="form-input mono"
                    value={remittanceFee}
                    onChange={(e) => setRemittanceFee(Number(e.target.value))}
                  />
                </div>
              </div>
            )}

            {dividendType !== '現金股利' && (
              <div className="feature-item" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div className="form-grid">
                  <div className="form-group">
                    <label className="form-label">每股配股金額 (元，面額 10 元換算)</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      className="form-input mono"
                      value={stockPerShare}
                      onChange={(e) => setStockPerShare(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">自動換算獲配股數 (股)</label>
                    <input
                      type="number"
                      className="form-input mono"
                      value={calc.stockSharesReceived}
                      disabled
                    />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={addedToInventory}
                    onChange={(e) => setAddedToInventory(e.target.checked)}
                  />
                  將獲配之 {calc.stockSharesReceived} 股以「買進價 0、成本 0」批次自動計入庫存並攤薄平均成本
                </label>
              </div>
            )}

            <div className="form-group">
              <label className="form-label">備註</label>
              <input
                className="form-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如 2026 Q3 季配息"
              />
            </div>

            <div className="feature-item">
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                應發放現金：NT$ {calc.grossCash.toLocaleString()} － 健保/匯費：NT$ {calc.healthAndBankFee.toLocaleString()}
              </div>
              <div style={{ fontSize: '15px', fontWeight: 700, marginTop: '4px' }}>
                實收現金股利：<span className="mono text-up">NT$ {calc.netCash.toLocaleString()}</span>
                {calc.stockSharesReceived > 0 && (
                  <span>
                    {' '}
                    ｜ 獲配股票：<span className="mono text-up">+{calc.stockSharesReceived.toLocaleString()} 股</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary">
              儲存股利紀錄並同步試算表
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
