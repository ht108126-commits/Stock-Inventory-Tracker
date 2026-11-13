import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cloud,
  Coins,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  History,
  Link2,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  Settings,
  Shield,
  TrendingUp,
  Trash2,
  Unlink,
} from 'lucide-react';
import {
  calculateLotCost,
  computeDividendOverview,
  computePortfolioAnalytics,
  computePortfolioOverview,
  computeRealizedOverview,
  DEFAULT_FEE_SETTINGS,
  executeSellTransaction,
  formatTaipeiDateTime,
  restoreRealizedRecordToHoldings,
} from '../shared/calculations';
import {
  buildAllSheetTabsData,
  extractSpreadsheetId,
  mergePortfolioStates,
  rowsToUtf8BomCsv,
} from '../shared/sheetsEngine';
import {
  BuyRecord,
  DividendRecord,
  FeeSettings,
  LinkedSpreadsheet,
  LotDeductionStrategy,
  PortfolioState,
  RealizedRecord,
  StockHolding,
  StockLot,
  TaxRateType,
  TradeCategory,
} from '../shared/types';
import { lookupStockMeta, normalizeStockCode } from '../shared/twStockDictionary';
import { CloudRunAutomationModal } from './components/CloudRunAutomationModal';
import {
  BuyLotModal,
  DividendModal,
  SellModal,
} from './components/TransactionModals';
import {
  AuthSession,
  createStandardSpreadsheet,
  DEFAULT_USER_SHEET_ID,
  DEFAULT_USER_SHEET_URL,
  DriveSpreadsheetItem,
  EmptyOverwriteProtectionError,
  listRecentDriveSpreadsheets,
  loadPortfolioFromSpreadsheet,
  REQUIRED_GOOGLE_SCOPES,
  syncPortfolioToSpreadsheet,
  UnauthorizedSheetError,
} from './services/googleSheetsClient';

const STORAGE_KEYS = {
  AUTH_SESSION: 'sit_oauth_session_v2',
  LOGIN_HINT: 'sit_oauth_login_hint_v2',
  LINKED_SHEET: 'sit_linked_spreadsheet_v2',
  CLIENT_ID: 'sit_google_client_id_v2',
  FEE_SETTINGS: 'sit_fee_settings_v2',
};

const EMPTY_PORTFOLIO: PortfolioState = {
  holdings: [],
  buyRecords: [],
  realizedRecords: [],
  dividendRecords: [],
};

declare global {
  interface Window {
    google?: any;
  }
}

export const App: React.FC = () => {
  // =========================================================================
  // 1. 授權與試算表連結狀態 (未登入時 100% 空白，登出時立即銷毀)
  // =========================================================================
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [linkedSpreadsheet, setLinkedSpreadsheet] = useState<LinkedSpreadsheet | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioState>(EMPTY_PORTFOLIO);
  const [feeSettings, setFeeSettings] = useState<FeeSettings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.FEE_SETTINGS);
      return saved ? { ...DEFAULT_FEE_SETTINGS, ...JSON.parse(saved) } : DEFAULT_FEE_SETTINGS;
    } catch {
      return DEFAULT_FEE_SETTINGS;
    }
  });

  // Google OAuth 設定與手動 Token 支援
  const [googleClientId, setGoogleClientId] = useState<string>(
    () =>
      (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID ||
      localStorage.getItem(STORAGE_KEYS.CLIENT_ID) ||
      ''
  );
  const [manualAccessToken, setManualAccessToken] = useState('');
  const [manualUserEmail, setManualUserEmail] = useState('ht108126@gmail.com');
  const [authError, setAuthError] = useState<string | null>(null);

  // 試算表綁定與匯入選項
  const [sheetInputUrl, setSheetInputUrl] = useState(DEFAULT_USER_SHEET_URL);
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('replace');
  const [driveFiles, setDriveFiles] = useState<DriveSpreadsheetItem[]>([]);
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [isLoadingSheet, setIsLoadingSheet] = useState(false);

  // 同步排隊佇列與狀態鎖 (isSyncingRef + pendingSyncRef)
  const isSyncingRef = useRef(false);
  const pendingSyncRef = useRef<{
    state: PortfolioState;
    pricesOnly: boolean;
    allowEmptyOverwrite?: boolean;
  } | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');

  // 即時報價與 10 分鐘自動倒數計時器
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
  const [refreshingSingleCode, setRefreshingSingleCode] = useState<string | null>(null);
  const [secondsUntilNextRefresh, setSecondsUntilNextRefresh] = useState<number>(600);
  const [serverAutoSyncStatus, setServerAutoSyncStatus] = useState<any>(null);
  const [isSyncingServerNow, setIsSyncingServerNow] = useState(false);

  // UI 分頁與展開批次控制
  const [activeTab, setActiveTab] = useState<
    'overview' | 'transactions' | 'realized' | 'dividends' | 'analytics'
  >('overview');
  const [expandedCodes, setExpandedCodes] = useState<Record<string, boolean>>({});
  const [editingPriceCode, setEditingPriceCode] = useState<string | null>(null);
  const [editingPriceValue, setEditingPriceValue] = useState<string>('');

  // 交易與設定 Modals
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);
  const [editingLotContext, setEditingLotContext] = useState<{
    holding: StockHolding;
    lot: StockLot;
  } | null>(null);
  const [presetBuyCode, setPresetBuyCode] = useState<string | undefined>(undefined);

  const [isSellModalOpen, setIsSellModalOpen] = useState(false);
  const [presetSellHolding, setPresetSellHolding] = useState<StockHolding | null>(null);
  const [presetSellLotId, setPresetSellLotId] = useState<string | undefined>(undefined);
  const [editingRealized, setEditingRealized] = useState<RealizedRecord | null>(null);

  const [isDividendModalOpen, setIsDividendModalOpen] = useState(false);
  const [isCloudRunModalOpen, setIsCloudRunModalOpen] = useState(false);
  const [isFeeSettingsOpen, setIsFeeSettingsOpen] = useState(false);

  // =========================================================================
  // 2. 取得後端 10 分鐘自動刷新引擎狀態
  // =========================================================================
  const fetchServerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-sync/status');
      if (res.ok) {
        const data = await res.json();
        setServerAutoSyncStatus(data);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchServerStatus();
  }, [fetchServerStatus]);

  // =========================================================================
  // 3. 登出並立即銷毀所有記憶體與本機儲存之資料與憑證
  // =========================================================================
  const handleLogout = useCallback(async () => {
    const tokenToRevoke = authSession?.accessToken;
    // 立即銷毀記憶體中的所有庫存、交易、試算表連結設定與授權憑證
    setPortfolio({
      holdings: [],
      buyRecords: [],
      realizedRecords: [],
      dividendRecords: [],
    });
    setLinkedSpreadsheet(null);
    setAuthSession(null);
    setDriveFiles([]);
    setExpandedCodes({});
    setSyncStatus('idle');
    setSyncMessage('');
    isSyncingRef.current = false;
    pendingSyncRef.current = null;

    localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
    localStorage.removeItem(STORAGE_KEYS.LINKED_SHEET);
    localStorage.removeItem(STORAGE_KEYS.LOGIN_HINT);

    // 通知後端立即銷毀記憶體中之 Session Token
    await fetch('/api/auto-sync/clear', { method: 'POST' }).catch(() => {});

    if (tokenToRevoke && window.google?.accounts?.oauth2?.revoke) {
      try {
        window.google.accounts.oauth2.revoke(tokenToRevoke, () => {});
      } catch {
        // ignore
      }
    }
    fetchServerStatus();
  }, [authSession, fetchServerStatus]);

  // =========================================================================
  // 4. Google OAuth 2.0 續約與登入流程 (維持 24 小時有效管理 + login_hint)
  // =========================================================================
  const requestGoogleOAuthPopup = useCallback(
    (loginHint?: string) => {
      setAuthError(null);
      const clientId = googleClientId.trim();
      if (!clientId) {
        setAuthError(
          '請先填入您的 Google OAuth Client ID，或使用下方「直接貼上 OAuth Access Token」／「沙盒模式」登入。'
        );
        return;
      }

      if (!window.google?.accounts?.oauth2) {
        setAuthError('Google Identity Services SDK 尚未載入完成，請稍候重試。');
        return;
      }

      localStorage.setItem(STORAGE_KEYS.CLIENT_ID, clientId);

      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: REQUIRED_GOOGLE_SCOPES,
        hint: loginHint || localStorage.getItem(STORAGE_KEYS.LOGIN_HINT) || 'ht108126@gmail.com',
        prompt: loginHint ? '' : 'select_account',
        callback: async (tokenResponse: any) => {
          if (tokenResponse?.error) {
            setAuthError(`Google OAuth 授權失敗: ${tokenResponse.error}`);
            return;
          }
          const accessToken = tokenResponse.access_token;
          const expiresInSec = Number(tokenResponse.expires_in) || 3599;

          // 查詢使用者個人資訊並檢查私人網站白名單
          let email = loginHint || 'ht108126@gmail.com';
          let name = 'Google 授權使用者';
          let picture = '';

          try {
            const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (profileRes.ok) {
              const profile = await profileRes.json();
              email = profile.email || email;
              name = profile.name || email;
              picture = profile.picture || '';
            }
          } catch {
            // ignore
          }

          // 向後端驗證是否通過 ALLOWED_OWNER_EMAILS 私人白名單
          const verifyRes = await fetch('/api/auth/verify-owner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          }).catch(() => null);

          if (verifyRes && verifyRes.ok) {
            const vData = await verifyRes.json();
            if (!vData.allowed) {
              setAuthError(vData.reason || '此帳號無權存取本私人網站');
              return;
            }
          }

          const now = Date.now();
          const newSession: AuthSession = {
            accessToken,
            email,
            name,
            picture,
            issuedAt: now,
            sessionValidUntil: now + 24 * 60 * 60 * 1000, // 24 小時（1天）有效管理
            tokenExpiresAt: now + expiresInSec * 1000,
            mode: 'google_oauth',
          };

          setAuthSession(newSession);
          localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, JSON.stringify(newSession));
          localStorage.setItem(STORAGE_KEYS.LOGIN_HINT, email);

          // 同步註冊至後端 10 分鐘自動刷新引擎
          await fetch('/api/auto-sync/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              accessToken,
              expiresAt: newSession.tokenExpiresAt,
              ownerEmail: email,
              intervalMinutes: feeSettings.autoRefreshIntervalMinutes,
              marketHoursOnly: feeSettings.marketHoursOnly,
              feeSettings,
            }),
          }).catch(() => {});
          fetchServerStatus();
        },
      });

      tokenClient.requestAccessToken();
    },
    [googleClientId, feeSettings, fetchServerStatus]
  );

  // 檢查本機 24 小時內有效 Session 與自動 login_hint 快速續約
  useEffect(() => {
    try {
      const savedSessionStr = localStorage.getItem(STORAGE_KEYS.AUTH_SESSION);
      const savedSheetStr = localStorage.getItem(STORAGE_KEYS.LINKED_SHEET);
      if (savedSheetStr) {
        setLinkedSpreadsheet(JSON.parse(savedSheetStr));
      }
      if (savedSessionStr) {
        const parsed: AuthSession = JSON.parse(savedSessionStr);
        const now = Date.now();
        if (parsed.sessionValidUntil > now) {
          if (parsed.tokenExpiresAt > now + 60_000) {
            setAuthSession(parsed);
          } else if (parsed.mode === 'google_oauth' && googleClientId) {
            // 在 24 小時有效管理期內但 Access Token 滿 1 小時需更新時，自動帶入 login_hint 快速續約
            requestGoogleOAuthPopup(parsed.email);
          }
        } else {
          localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
        }
      }
    } catch {
      // ignore
    }
  }, []);

  // =========================================================================
  // 5. 背景同步排隊佇列引擎 (isSyncingRef + pendingSyncRef)
  // =========================================================================
  const executeQueuedSync = useCallback(
    async (
      targetState: PortfolioState,
      pricesOnly: boolean,
      allowEmptyOverwrite = false
    ) => {
      if (!authSession || !linkedSpreadsheet) return;

      // 若為沙盒模擬模式（token 為 sandbox_token），模擬雲端同步完成
      if (authSession.accessToken.startsWith('sandbox_')) {
        setSyncStatus('syncing');
        setSyncMessage(pricesOnly ? '正在回寫最新現價至試算表總覽...' : '正在同步全表 4 分頁至試算表...');
        await new Promise((r) => setTimeout(r, 350));
        setSyncStatus('success');
        setSyncMessage(`已同步 (${formatTaipeiDateTime(new Date())})`);
        return;
      }

      if (isSyncingRef.current) {
        // 排入待處理佇列，確保連續操作不遺漏任何異動（若已有完整同步待處理，則保留完整同步）
        const prevPending = pendingSyncRef.current;
        pendingSyncRef.current = {
          state: targetState,
          pricesOnly: prevPending ? prevPending.pricesOnly && pricesOnly : pricesOnly,
          allowEmptyOverwrite:
            prevPending?.allowEmptyOverwrite || allowEmptyOverwrite,
        };
        return;
      }

      isSyncingRef.current = true;
      setSyncStatus('syncing');
      setSyncMessage(
        pricesOnly
          ? '正在將最新現價回寫至「個股庫存統計總覽」...'
          : '正在將異動完整回寫至 Google 試算表 4 大分頁...'
      );

      try {
        await syncPortfolioToSpreadsheet({
          accessToken: authSession.accessToken,
          spreadsheetId: linkedSpreadsheet.spreadsheetId,
          state: targetState,
          feeSettings,
          pricesOnly,
          allowEmptyOverwrite,
        });

        const nowFormatted = formatTaipeiDateTime(new Date());
        setSyncStatus('success');
        setSyncMessage(
          pricesOnly
            ? `現價已回寫試算表 (${nowFormatted})`
            : `全表已同步至試算表 (${nowFormatted})`
        );
      } catch (err: any) {
        if (err instanceof UnauthorizedSheetError) {
          // 401 自動清除失效 Token 並要求重新授權
          setSyncStatus('error');
          setSyncMessage('Google OAuth 憑證已過期 (401)，請重新授權');
          const hint = authSession.email;
          setAuthSession(null);
          localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
          if (googleClientId && hint) {
            requestGoogleOAuthPopup(hint);
          }
        } else if (err instanceof EmptyOverwriteProtectionError) {
          setSyncStatus('error');
          setSyncMessage(err.message);
        } else {
          setSyncStatus('error');
          setSyncMessage(err?.message || '同步寫入 Google 試算表發生錯誤');
        }
      } finally {
        isSyncingRef.current = false;
        if (pendingSyncRef.current) {
          const nextJob = pendingSyncRef.current;
          pendingSyncRef.current = null;
          executeQueuedSync(
            nextJob.state,
            nextJob.pricesOnly,
            nextJob.allowEmptyOverwrite
          );
        }
      }
    },
    [authSession, linkedSpreadsheet, feeSettings, googleClientId, requestGoogleOAuthPopup]
  );

  // =========================================================================
  // 6. 即時市場報價抓取與自動回寫 (POST /api/batch-stock-prices + pricesOnly: true)
  // =========================================================================
  const refreshAllPricesAndSync = useCallback(
    async (forceBypassCache = false, baseState?: PortfolioState) => {
      const currentState = baseState || portfolio;
      if (currentState.holdings.length === 0) return;

      setIsRefreshingPrices(true);
      try {
        const codes = currentState.holdings.map((h) => normalizeStockCode(h.code));
        const res = await fetch('/api/batch-stock-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes, force: forceBypassCache }),
        });

        if (!res.ok) return;
        const data = await res.json();
        const quotesMap = data.quotes || {};

        const updatedHoldings = currentState.holdings.map((h) => {
          const norm = normalizeStockCode(h.code);
          const q = quotesMap[norm];
          if (!q || !q.price || q.price <= 0) return h;
          return {
            ...h,
            code: norm,
            name: h.name && h.name !== h.code ? h.name : q.name || h.name,
            currentPrice: q.price,
            previousClose: q.previousClose,
            change: q.change,
            changePercent: q.changePercent,
            category: h.category || q.category,
            industry: h.industry || q.industry,
            lastUpdated: q.updatedAt,
            priceSource: q.source,
          };
        });

        const nextState: PortfolioState = {
          ...currentState,
          holdings: updatedHoldings,
          lastPriceSyncAt: formatTaipeiDateTime(new Date()),
        };

        setPortfolio(nextState);
        // 自動以 pricesOnly: true 寫回 Google 試算表總覽頁
        await executeQueuedSync(nextState, true);
      } catch {
        // ignore
      } finally {
        setIsRefreshingPrices(false);
        setSecondsUntilNextRefresh(
          Math.max(1, feeSettings.autoRefreshIntervalMinutes || 10) * 60
        );
      }
    },
    [portfolio, feeSettings.autoRefreshIntervalMinutes, executeQueuedSync]
  );

  // 單檔股票即時報價手動更新 (GET /api/stock-price?code=XXX)
  const refreshSingleStockPrice = async (rawCode: string) => {
    const code = normalizeStockCode(rawCode);
    setRefreshingSingleCode(code);
    try {
      const res = await fetch(
        `/api/stock-price?code=${encodeURIComponent(code)}&force=true`
      );
      if (!res.ok) return;
      const q = await res.json();
      if (!q || !q.price || q.price <= 0) return;

      const updatedHoldings = portfolio.holdings.map((h) => {
        if (normalizeStockCode(h.code) !== code) return h;
        return {
          ...h,
          currentPrice: q.price,
          previousClose: q.previousClose,
          change: q.change,
          changePercent: q.changePercent,
          lastUpdated: q.updatedAt,
          priceSource: q.source,
        };
      });

      const nextState: PortfolioState = {
        ...portfolio,
        holdings: updatedHoldings,
        lastPriceSyncAt: formatTaipeiDateTime(new Date()),
      };
      setPortfolio(nextState);
      await executeQueuedSync(nextState, true);
    } finally {
      setRefreshingSingleCode(null);
    }
  };

  // 每 10 分鐘自動倒數並批次刷新報價回寫 Google Sheet
  useEffect(() => {
    if (!authSession || !linkedSpreadsheet) return;

    const timer = setInterval(() => {
      setSecondsUntilNextRefresh((prev) => {
        if (prev <= 1) {
          refreshAllPricesAndSync(true);
          return Math.max(1, feeSettings.autoRefreshIntervalMinutes || 10) * 60;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [
    authSession,
    linkedSpreadsheet,
    feeSettings.autoRefreshIntervalMinutes,
    refreshAllPricesAndSync,
  ]);

  // =========================================================================
  // 7. 登入後載入已綁定試算表流程
  // =========================================================================
  const handleLoadAndBindSpreadsheet = useCallback(
    async (targetIdOrUrl: string, mode: 'replace' | 'merge' = 'replace') => {
      if (!authSession) return;
      setIsLoadingSheet(true);
      setAuthError(null);

      try {
        const sheetId = extractSpreadsheetId(targetIdOrUrl);
        if (!sheetId) {
          throw new Error('請輸入有效的 Google 試算表網址或 Spreadsheet ID');
        }

        // 若為沙盒模式，初始化標準綁定並獲取即時報價
        if (authSession.accessToken.startsWith('sandbox_')) {
          const meta: LinkedSpreadsheet = {
            spreadsheetId: sheetId,
            title:
              sheetId === DEFAULT_USER_SHEET_ID
                ? '我的股票庫存統計表'
                : `綁定試算表 (${sheetId.slice(0, 8)}...)`,
            url: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
            linkedAt: new Date().toISOString(),
          };
          setLinkedSpreadsheet(meta);
          localStorage.setItem(STORAGE_KEYS.LINKED_SHEET, JSON.stringify(meta));
          setSyncStatus('success');
          setSyncMessage('已綁定試算表（沙盒直連模式）');
          return;
        }

        const { portfolio: loadedPortfolio, spreadsheetMeta } =
          await loadPortfolioFromSpreadsheet(authSession.accessToken, sheetId);

        const nextPortfolio =
          mode === 'merge'
            ? mergePortfolioStates(portfolio, loadedPortfolio)
            : loadedPortfolio;

        setPortfolio(nextPortfolio);
        setLinkedSpreadsheet(spreadsheetMeta);
        localStorage.setItem(
          STORAGE_KEYS.LINKED_SHEET,
          JSON.stringify(spreadsheetMeta)
        );

        // 同步註冊至後端 10 分鐘自動刷新引擎
        await fetch('/api/auto-sync/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            spreadsheetId: spreadsheetMeta.spreadsheetId,
            accessToken: authSession.accessToken,
            expiresAt: authSession.tokenExpiresAt,
            ownerEmail: authSession.email,
            intervalMinutes: feeSettings.autoRefreshIntervalMinutes,
            marketHoursOnly: feeSettings.marketHoursOnly,
            feeSettings,
          }),
        }).catch(() => {});

        fetchServerStatus();

        // 載入完成後自動觸發一次即時市價更新並以 pricesOnly: true 回寫
        if (nextPortfolio.holdings.length > 0) {
          await refreshAllPricesAndSync(true, nextPortfolio);
        }
      } catch (err: any) {
        if (err instanceof UnauthorizedSheetError) {
          setAuthError('Google OAuth 憑證已過期 (401)，請重新點擊登入授權。');
          setAuthSession(null);
          localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
        } else {
          setAuthError(err?.message || '讀取 Google 試算表失敗');
        }
      } finally {
        setIsLoadingSheet(false);
      }
    },
    [authSession, portfolio, feeSettings, fetchServerStatus, refreshAllPricesAndSync]
  );

  // 登入成功且已有綁定試算表時，自動讀取並刷新市價
  const initialAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (
      authSession &&
      linkedSpreadsheet &&
      !initialAutoLoadedRef.current &&
      !authSession.accessToken.startsWith('sandbox_')
    ) {
      initialAutoLoadedRef.current = true;
      handleLoadAndBindSpreadsheet(linkedSpreadsheet.spreadsheetId, 'replace');
    }
    if (!authSession) {
      initialAutoLoadedRef.current = false;
    }
  }, [authSession, linkedSpreadsheet, handleLoadAndBindSpreadsheet]);

  // =========================================================================
  // 8. 庫存與交易資料異動 Handlers (皆自動觸發背景寫回 Google 試算表)
  // =========================================================================
  const handleAddOrEditBuyLot = (data: {
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
  }) => {
    const normCode = normalizeStockCode(data.code);
    const clonedHoldings: StockHolding[] = JSON.parse(
      JSON.stringify(portfolio.holdings)
    );
    const clonedBuys: BuyRecord[] = JSON.parse(JSON.stringify(portfolio.buyRecords));

    if (data.editingLotId) {
      // 修改既有批次
      const h = clonedHoldings.find(
        (item) => normalizeStockCode(item.code) === normCode
      );
      if (h) {
        h.name = data.name;
        h.category = data.stockCategory;
        h.industry = data.industry;
        const lot = h.lots.find((l) => l.id === data.editingLotId);
        if (lot) {
          lot.date = data.date;
          lot.category = data.tradeCategory;
          lot.shares = data.shares;
          lot.originalShares = data.shares;
          lot.price = data.price;
          lot.buyFee = data.buyFee;
          lot.originalBuyFee = data.buyFee;
          lot.note = data.note;
        }
      }
      const buyRec = clonedBuys.find((b) => b.lotId === data.editingLotId);
      if (buyRec) {
        buyRec.name = data.name;
        buyRec.date = data.date;
        buyRec.category = data.tradeCategory;
        buyRec.shares = data.shares;
        buyRec.price = data.price;
        buyRec.buyFee = data.buyFee;
        buyRec.totalCost = calculateLotCost(data.shares, data.price, data.buyFee);
        buyRec.note = data.note;
      }
    } else {
      // 新增買進批次
      const lotId = `lot_${normCode}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const newLot: StockLot = {
        id: lotId,
        date: data.date,
        category: data.tradeCategory,
        shares: data.shares,
        originalShares: data.shares,
        price: data.price,
        buyFee: data.buyFee,
        originalBuyFee: data.buyFee,
        note: data.note,
        isDividendLot: data.tradeCategory === '配股' || data.price === 0,
      };

      let h = clonedHoldings.find(
        (item) => normalizeStockCode(item.code) === normCode
      );
      if (!h) {
        h = {
          code: normCode,
          name: data.name,
          category: data.stockCategory,
          currentPrice: data.currentPrice || data.price,
          industry: data.industry,
          note: '',
          lots: [newLot],
        };
        clonedHoldings.push(h);
      } else {
        h.name = data.name || h.name;
        if (data.currentPrice && data.currentPrice > 0) {
          h.currentPrice = data.currentPrice;
        }
        h.lots.push(newLot);
        h.lots.sort((a, b) => a.date.localeCompare(b.date));
      }

      clonedBuys.push({
        id: `buy_${lotId}`,
        lotId,
        code: normCode,
        name: data.name,
        date: data.date,
        category: data.tradeCategory,
        shares: data.shares,
        price: data.price,
        buyFee: data.buyFee,
        totalCost: calculateLotCost(data.shares, data.price, data.buyFee),
        note: data.note,
      });
    }

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: clonedHoldings,
      buyRecords: clonedBuys,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false);
  };

  // 刪除單一買進批次或整檔持股
  const handleDeleteLot = (code: string, lotId: string) => {
    const normCode = normalizeStockCode(code);
    const clonedHoldings: StockHolding[] = JSON.parse(
      JSON.stringify(portfolio.holdings)
    );
    const idx = clonedHoldings.findIndex(
      (h) => normalizeStockCode(h.code) === normCode
    );
    if (idx < 0) return;

    clonedHoldings[idx].lots = clonedHoldings[idx].lots.filter(
      (l) => l.id !== lotId
    );
    if (clonedHoldings[idx].lots.length === 0) {
      clonedHoldings.splice(idx, 1);
    }

    const clonedBuys = portfolio.buyRecords.filter((b) => b.lotId !== lotId);
    const isNowEmpty =
      clonedHoldings.length === 0 &&
      clonedBuys.length === 0 &&
      portfolio.realizedRecords.length === 0 &&
      portfolio.dividendRecords.length === 0;

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: clonedHoldings,
      buyRecords: clonedBuys,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false, isNowEmpty);
  };

  const handleDeleteEntireHolding = (code: string) => {
    const normCode = normalizeStockCode(code);
    const targetHolding = portfolio.holdings.find(
      (h) => normalizeStockCode(h.code) === normCode
    );
    if (!targetHolding) return;

    const lotIdsToRemove = new Set(targetHolding.lots.map((l) => l.id));
    const clonedHoldings = portfolio.holdings.filter(
      (h) => normalizeStockCode(h.code) !== normCode
    );
    const clonedBuys = portfolio.buyRecords.filter(
      (b) => !lotIdsToRemove.has(b.lotId) && normalizeStockCode(b.code) !== normCode
    );

    const isNowEmpty =
      clonedHoldings.length === 0 &&
      clonedBuys.length === 0 &&
      portfolio.realizedRecords.length === 0 &&
      portfolio.dividendRecords.length === 0;

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: clonedHoldings,
      buyRecords: clonedBuys,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false, isNowEmpty);
  };

  // 記錄賣出或編輯已實現損益紀錄
  const handleRecordOrEditSell = (data: {
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
  }) => {
    let baseHoldings = portfolio.holdings;
    let baseRealized = [...portfolio.realizedRecords];

    // 若為編輯既有已實現紀錄，先將原已實現紀錄扣除的批次還原回庫存，再重新執行沖銷！
    if (data.editingRecordId) {
      const oldRecord = baseRealized.find((r) => r.id === data.editingRecordId);
      if (oldRecord) {
        baseHoldings = restoreRealizedRecordToHoldings(baseHoldings, oldRecord);
        baseRealized = baseRealized.filter((r) => r.id !== data.editingRecordId);
      }
    }

    const { updatedHoldings, realizedRecord } = executeSellTransaction({
      holdings: baseHoldings,
      code: data.code,
      name: data.name,
      sellDate: data.sellDate,
      category: data.category,
      sellShares: data.sellShares,
      sellPrice: data.sellPrice,
      sellFee: data.sellFee,
      taxRateType: data.taxRateType,
      customTax: data.customTax,
      deductFromInventory: data.deductFromInventory,
      strategy: data.strategy,
      targetLotId: data.targetLotId,
      targetBuyPrice: data.targetBuyPrice,
      manualBuyFee: data.manualBuyFee,
      note: data.note,
    });

    if (data.editingRecordId) {
      realizedRecord.id = data.editingRecordId;
    }

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: updatedHoldings,
      realizedRecords: [realizedRecord, ...baseRealized],
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false);
  };

  // 刪除已實現損益紀錄（依據 deductedLots 將股數、成本與買進手續費精準還原回庫存批次）
  const handleDeleteRealizedRecord = (record: RealizedRecord) => {
    const restoredHoldings = restoreRealizedRecordToHoldings(
      portfolio.holdings,
      record
    );
    const updatedRealized = portfolio.realizedRecords.filter(
      (r) => r.id !== record.id
    );
    const nextState: PortfolioState = {
      ...portfolio,
      holdings: restoredHoldings,
      realizedRecords: updatedRealized,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false);
  };

  // 新增配息配股紀錄（若勾選配股計入庫存，自動新增買進價 0、成本 0 批次）
  const handleAddDividendRecord = (recordData: Omit<DividendRecord, 'id'>) => {
    const divId = `div_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const normCode = normalizeStockCode(recordData.code);
    const meta = lookupStockMeta(normCode);
    const clonedHoldings: StockHolding[] = JSON.parse(
      JSON.stringify(portfolio.holdings)
    );
    const clonedBuys: BuyRecord[] = JSON.parse(JSON.stringify(portfolio.buyRecords));

    let createdLotId: string | undefined = undefined;

    if (recordData.addedToInventory && recordData.stockSharesReceived > 0) {
      createdLotId = `lot_div_${divId}`;
      const divLot: StockLot = {
        id: createdLotId,
        date: recordData.payDate || recordData.exDate,
        category: '配股',
        shares: recordData.stockSharesReceived,
        originalShares: recordData.stockSharesReceived,
        price: 0,
        buyFee: 0,
        originalBuyFee: 0,
        note: recordData.note || '股票股利配股入庫',
        isDividendLot: true,
        dividendRecordId: divId,
      };

      let holding = clonedHoldings.find(
        (h) => normalizeStockCode(h.code) === normCode
      );
      if (!holding) {
        holding = {
          code: normCode,
          name: recordData.name || meta.name,
          category: meta.category,
          currentPrice: meta.refPrice || 0,
          industry: meta.industry,
          note: '',
          lots: [divLot],
        };
        clonedHoldings.push(holding);
      } else {
        holding.lots.push(divLot);
        holding.lots.sort((a, b) => a.date.localeCompare(b.date));
      }

      clonedBuys.push({
        id: `buy_${createdLotId}`,
        lotId: createdLotId,
        code: normCode,
        name: recordData.name || meta.name,
        date: recordData.payDate || recordData.exDate,
        category: '配股',
        shares: recordData.stockSharesReceived,
        price: 0,
        buyFee: 0,
        totalCost: 0,
        note: recordData.note || '股票股利配股入庫',
        isDividendLot: true,
        dividendRecordId: divId,
      });
    }

    const newDividend: DividendRecord = {
      ...recordData,
      id: divId,
      code: normCode,
      createdLotId,
    };

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: clonedHoldings,
      buyRecords: clonedBuys,
      dividendRecords: [newDividend, ...portfolio.dividendRecords],
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false);
  };

  // 刪除配息配股紀錄（同步移除對應配股批次）
  const handleDeleteDividendRecord = (div: DividendRecord) => {
    const clonedHoldings: StockHolding[] = JSON.parse(
      JSON.stringify(portfolio.holdings)
    );
    if (div.createdLotId) {
      for (let i = clonedHoldings.length - 1; i >= 0; i--) {
        clonedHoldings[i].lots = clonedHoldings[i].lots.filter(
          (l) => l.id !== div.createdLotId && l.dividendRecordId !== div.id
        );
        if (clonedHoldings[i].lots.length === 0) {
          clonedHoldings.splice(i, 1);
        }
      }
    }
    const updatedBuys = portfolio.buyRecords.filter(
      (b) => b.lotId !== div.createdLotId && b.dividendRecordId !== div.id
    );
    const updatedDividends = portfolio.dividendRecords.filter(
      (d) => d.id !== div.id
    );

    const nextState: PortfolioState = {
      ...portfolio,
      holdings: clonedHoldings,
      buyRecords: updatedBuys,
      dividendRecords: updatedDividends,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, false);
  };

  // 手動微調個股現價 (僅更新分頁 1 pricesOnly: true)
  const handleSaveInlinePrice = (code: string) => {
    const num = Number(editingPriceValue);
    setEditingPriceCode(null);
    if (!Number.isFinite(num) || num <= 0) return;

    const updatedHoldings = portfolio.holdings.map((h) =>
      normalizeStockCode(h.code) === normalizeStockCode(code)
        ? { ...h, currentPrice: num, lastUpdated: formatTaipeiDateTime(new Date()) }
        : h
    );
    const nextState: PortfolioState = {
      ...portfolio,
      holdings: updatedHoldings,
    };
    setPortfolio(nextState);
    executeQueuedSync(nextState, true);
  };

  // 本機 UTF-8 BOM CSV 檔案匯出
  const handleExportCsv = (
    tabType: 'overview' | 'transactions' | 'realized' | 'dividends'
  ) => {
    const built = buildAllSheetTabsData(portfolio, feeSettings);
    const map = {
      overview: { rows: built.overviewRows, name: '個股庫存統計總覽' },
      transactions: { rows: built.transactionRows, name: '分筆交易明細' },
      realized: { rows: built.realizedRows, name: '已實現損益紀錄' },
      dividends: { rows: built.dividendRows, name: '配息配股紀錄' },
    };
    const target = map[tabType];
    const csvContent = rowsToUtf8BomCsv(target.rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${target.name}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // =========================================================================
  // 9. 衍生報表與分析指標計算
  // =========================================================================
  const overview = useMemo(
    () => computePortfolioOverview(portfolio.holdings, feeSettings),
    [portfolio.holdings, feeSettings]
  );
  const realizedSummary = useMemo(
    () => computeRealizedOverview(portfolio.realizedRecords),
    [portfolio.realizedRecords]
  );
  const dividendSummary = useMemo(
    () => computeDividendOverview(portfolio.dividendRecords),
    [portfolio.dividendRecords]
  );
  const analytics = useMemo(
    () =>
      computePortfolioAnalytics(
        portfolio.holdings,
        portfolio.realizedRecords,
        portfolio.dividendRecords,
        feeSettings
      ),
    [
      portfolio.holdings,
      portfolio.realizedRecords,
      portfolio.dividendRecords,
      feeSettings,
    ]
  );
  const sheetTabsPreview = useMemo(
    () => buildAllSheetTabsData(portfolio, feeSettings),
    [portfolio, feeSettings]
  );

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // =========================================================================
  // 畫面狀態 A：未登入狀態（零資料庫隱私架構，記憶體與畫面庫存皆為空）
  // =========================================================================
  if (!authSession) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand-group">
            <div className="brand-logo">
              <TrendingUp size={20} />
            </div>
            <div>
              <h1 className="brand-title">
                個人股票庫存統計表（純 Google Sheet 雲端直連模式）
              </h1>
              <div className="brand-subtitle">
                <span>零後端資料庫儲存</span>
                <span>•</span>
                <span>100% 直連讀寫個人 Google 試算表</span>
                <span>•</span>
                <span>每 10 分鐘雙引擎自動刷新即時股價</span>
              </div>
            </div>
          </div>

          <div className="topbar-controls">
            <button
              id="open-cloudrun-guide-btn"
              className="btn btn-primary"
              onClick={() => setIsCloudRunModalOpen(true)}
            >
              <Cloud size={15} />
              10 分鐘自動刷新 ＆ Cloud Run 私人網站指南
            </button>
          </div>
        </header>

        <main className="auth-gate">
          <section className="hero-card">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
                marginBottom: '16px',
              }}
            >
              <div>
                <span className="badge-brand" style={{ marginBottom: '8px' }}>
                  <Shield size={13} /> 零資料庫隱私保護架構 (Single Source of Truth)
                </span>
                <h2 style={{ fontSize: '22px', fontWeight: 700, marginTop: '6px' }}>
                  請登入 Google 帳號以連線您的私人股票庫存試算表
                </h2>
                <p style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>
                  未登入狀態下，系統記憶體與畫面的庫存、交易紀錄皆為空，絕不預載或殘留任何資料。
                </p>
              </div>
            </div>

            {authError && (
              <div
                className="alert-banner"
                style={{
                  borderColor: 'var(--tw-up)',
                  background: 'var(--tw-up-bg)',
                  color: 'var(--tw-up)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <AlertTriangle size={16} />
                  <span>{authError}</span>
                </div>
              </div>
            )}

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                gap: '18px',
                marginTop: '18px',
              }}
            >
              {/* 方式 1：標準 Google OAuth 2.0 授權登入 */}
              <div className="feature-item" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontWeight: 700, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Lock size={16} color="var(--brand-primary)" />
                  方式一：Google OAuth 2.0 帳號授權登入
                </div>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  自動申請 <code>spreadsheets</code>、<code>drive.file</code>、<code>drive.readonly</code> 三項權限，並維持 24 小時（1 天）有效管理與 <code>login_hint</code> 快速續約。
                </p>
                <div className="form-group">
                  <label className="form-label">Google OAuth Client ID (GCP 憑證)</label>
                  <input
                    id="oauth-client-id-input"
                    className="form-input mono"
                    value={googleClientId}
                    onChange={(e) => setGoogleClientId(e.target.value)}
                    placeholder="xxxx.apps.googleusercontent.com"
                  />
                </div>
                <button
                  id="google-oauth-login-btn"
                  className="btn btn-primary"
                  style={{ width: '100%', padding: '10px' }}
                  onClick={() => requestGoogleOAuthPopup()}
                >
                  使用 Google 帳號登入並授權試算表
                </button>
              </div>

              {/* 方式 2：貼上 OAuth Access Token 或啟動雲端沙盒驗證 */}
              <div className="feature-item" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontWeight: 700, fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <FileSpreadsheet size={16} color="var(--brand-primary)" />
                  方式二：OAuth Access Token 直連 ／ 試算表體驗登入
                </div>
                <div className="form-group">
                  <label className="form-label">
                    Google OAuth Access Token (選填，可直接讀寫真實試算表)
                  </label>
                  <input
                    id="manual-access-token-input"
                    type="password"
                    className="form-input mono"
                    value={manualAccessToken}
                    onChange={(e) => setManualAccessToken(e.target.value)}
                    placeholder="ya29.a0AeDClZ... (若留空則進入沙盒驗證模式)"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">授權 Google 信箱</label>
                  <input
                    id="manual-email-input"
                    type="email"
                    className="form-input mono"
                    value={manualUserEmail}
                    onChange={(e) => setManualUserEmail(e.target.value)}
                    placeholder="your-email@gmail.com"
                  />
                </div>
                <button
                  id="quick-token-login-btn"
                  className="btn"
                  style={{ width: '100%', padding: '10px', borderColor: 'var(--brand-primary)' }}
                  onClick={async () => {
                    const email = manualUserEmail.trim() || 'owner@private.cloudrun';
                    const verifyRes = await fetch('/api/auth/verify-owner', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ email }),
                    }).catch(() => null);
                    if (verifyRes && verifyRes.ok) {
                      const vData = await verifyRes.json();
                      if (!vData.allowed) {
                        setAuthError(vData.reason || '非授權白名單帳號');
                        return;
                      }
                    }

                    const now = Date.now();
                    const token = manualAccessToken.trim() || `sandbox_${now}`;
                    const sess: AuthSession = {
                      accessToken: token,
                      email,
                      name: email.split('@')[0],
                      issuedAt: now,
                      sessionValidUntil: now + 24 * 60 * 60 * 1000,
                      tokenExpiresAt: now + 3600 * 1000,
                      mode: manualAccessToken.trim() ? 'manual_token' : 'google_oauth',
                    };
                    setAuthSession(sess);
                    localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, JSON.stringify(sess));
                    if (manualAccessToken.trim()) {
                      await fetch('/api/auto-sync/register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          accessToken: token,
                          expiresAt: sess.tokenExpiresAt,
                          ownerEmail: email,
                        }),
                      }).catch(() => {});
                    }
                  }}
                >
                  {manualAccessToken.trim()
                    ? '使用 Access Token 直連試算表'
                    : '登入並進入試算表綁定流程'}
                </button>
              </div>
            </div>

            <div className="feature-grid">
              <div className="feature-item">
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  1. 免開網頁・每 10 分鐘自動刷新
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  內建後端排程引擎 (<code>/api/cron/sync-prices</code>) 與 Google Apps Script 產生器，不開網站也能每 10 分鐘更新你的統計表最新股價。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  2. 標準四分頁雙向讀寫與防呆
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  自動修補 <code>0050</code> / <code>00878</code> 前導零、修正 100 倍百分比異常、空白誤覆蓋攔截保護與三方庫存精準校對。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  3. Google Cloud Run 私人網站鎖定
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  支援 <code>ALLOWED_OWNER_EMAILS</code> 白名單鎖定與 Cloud Run IAP 身分驗證，確保全世界只有你自己看得到。
                </div>
              </div>
            </div>
          </section>
        </main>

        <CloudRunAutomationModal
          isOpen={isCloudRunModalOpen}
          onClose={() => setIsCloudRunModalOpen(false)}
          spreadsheetId={DEFAULT_USER_SHEET_ID}
          serverStatus={serverAutoSyncStatus}
          isSyncingServer={isSyncingServerNow}
          onRefreshStatus={fetchServerStatus}
          onTriggerServerSync={async () => {
            setIsSyncingServerNow(true);
            await fetch('/api/cron/sync-prices', { method: 'POST' }).catch(() => {});
            await fetchServerStatus();
            setIsSyncingServerNow(false);
          }}
        />
      </div>
    );
  }

  // =========================================================================
  // 畫面狀態 B：已登入但尚未綁定試算表 (提供三種初始化方式)
  // =========================================================================
  if (!linkedSpreadsheet) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div className="brand-group">
            <div className="brand-logo">
              <FileSpreadsheet size={20} />
            </div>
            <div>
              <h1 className="brand-title">連結您的個人 Google 股票庫存試算表</h1>
              <div className="brand-subtitle">
                <span>已登入：{authSession.email}</span>
              </div>
            </div>
          </div>

          <div className="topbar-controls">
            <button
              className="btn"
              onClick={() => setIsCloudRunModalOpen(true)}
            >
              <Cloud size={15} /> 10 分鐘自動刷新 & Cloud Run 指南
            </button>
            <button id="logout-btn" className="btn btn-up" onClick={handleLogout}>
              <LogOut size={15} /> 登出並銷毀憑證
            </button>
          </div>
        </header>

        <main className="auth-gate">
          {authError && (
            <div
              className="alert-banner"
              style={{
                borderColor: 'var(--tw-up)',
                background: 'var(--tw-up-bg)',
                color: 'var(--tw-up)',
              }}
            >
              <span>{authError}</span>
            </div>
          )}

          <div className="hero-card">
            <h2 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px' }}>
              請選擇試算表初始化或綁定方式（三選一）
            </h2>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px' }}>
              綁定成功後將立即載入您的持股與交易紀錄，並自動觸發一次台股即時市價更新。
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* 初始化方式 (3)：輸入網址或 ID (預設帶入使用者的試算表) */}
              <div className="feature-item">
                <div style={{ fontWeight: 700, fontSize: '14.5px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Link2 size={16} color="var(--brand-primary)" />
                  方式一（推薦）：連結您現有的「我的股票庫存統計表」網址或 Spreadsheet ID
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <input
                    id="sheet-url-input"
                    className="form-input mono"
                    style={{ flex: 1, minWidth: '260px' }}
                    value={sheetInputUrl}
                    onChange={(e) => setSheetInputUrl(e.target.value)}
                    placeholder="貼上 Google 試算表網址或 Spreadsheet ID"
                  />
                  <select
                    className="form-select"
                    style={{ width: '170px' }}
                    value={importMode}
                    onChange={(e) => setImportMode(e.target.value as 'replace' | 'merge')}
                  >
                    <option value="replace">覆蓋匯入 (Replace)</option>
                    <option value="merge">合併匯入 (Merge)</option>
                  </select>
                  <button
                    id="bind-sheet-url-btn"
                    className="btn btn-primary"
                    disabled={isLoadingSheet}
                    onClick={() => handleLoadAndBindSpreadsheet(sheetInputUrl, importMode)}
                  >
                    {isLoadingSheet ? '讀取並校對中...' : '解析連結並綁定讀取'}
                  </button>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  已預設帶入您的試算表 ID：<code>{DEFAULT_USER_SHEET_ID}</code>
                </div>
              </div>

              {/* 初始化方式 (1)：一鍵在 Google Drive 建立全新標準格式試算表 */}
              <div className="feature-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14.5px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Plus size={16} color="var(--brand-primary)" />
                    方式二：一鍵在 Google Drive 建立全新標準 4 分頁格式試算表
                  </div>
                  <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    自動建立「個股庫存統計總覽」、「分筆交易明細」、「已實現損益紀錄」、「配息配股紀錄」四張標準分頁並綁定。
                  </div>
                </div>
                <button
                  id="create-new-sheet-btn"
                  className="btn"
                  disabled={isLoadingSheet}
                  onClick={async () => {
                    setIsLoadingSheet(true);
                    setAuthError(null);
                    try {
                      if (authSession.accessToken.startsWith('sandbox_')) {
                        const created: LinkedSpreadsheet = {
                          spreadsheetId: DEFAULT_USER_SHEET_ID,
                          title: '我的股票庫存統計表 (全新標準 4 分頁)',
                          url: DEFAULT_USER_SHEET_URL,
                          linkedAt: new Date().toISOString(),
                        };
                        setLinkedSpreadsheet(created);
                        localStorage.setItem(STORAGE_KEYS.LINKED_SHEET, JSON.stringify(created));
                      } else {
                        const created = await createStandardSpreadsheet(authSession.accessToken);
                        setLinkedSpreadsheet(created);
                        localStorage.setItem(STORAGE_KEYS.LINKED_SHEET, JSON.stringify(created));
                      }
                    } catch (err: any) {
                      setAuthError(err?.message || '建立新試算表失敗');
                    } finally {
                      setIsLoadingSheet(false);
                    }
                  }}
                >
                  一鍵建立全新標準試算表
                </button>
              </div>

              {/* 初始化方式 (2)：透過 Google Drive API 列出使用者近期試算表清單 */}
              <div className="feature-item">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '14.5px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <FolderOpen size={16} color="var(--brand-primary)" />
                      方式三：從 Google Drive 讀取近期試算表清單選擇綁定
                    </div>
                  </div>
                  <button
                    className="btn btn-sm"
                    disabled={isLoadingDrive}
                    onClick={async () => {
                      setIsLoadingDrive(true);
                      setAuthError(null);
                      try {
                        if (authSession.accessToken.startsWith('sandbox_')) {
                          setDriveFiles([
                            {
                              id: DEFAULT_USER_SHEET_ID,
                              name: '我的股票庫存統計表',
                              modifiedTime: new Date().toISOString(),
                              webViewLink: DEFAULT_USER_SHEET_URL,
                            },
                          ]);
                        } else {
                          const files = await listRecentDriveSpreadsheets(authSession.accessToken);
                          setDriveFiles(files);
                        }
                      } catch (err: any) {
                        setAuthError(err?.message || '無法讀取 Google Drive 清單');
                      } finally {
                        setIsLoadingDrive(false);
                      }
                    }}
                  >
                    <RefreshCw size={13} />
                    {isLoadingDrive ? '讀取雲端硬碟中...' : '列出雲端硬碟試算表'}
                  </button>
                </div>

                {driveFiles.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>試算表名稱</th>
                          <th>Spreadsheet ID</th>
                          <th>最後修改時間</th>
                          <th className="align-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {driveFiles.map((f) => (
                          <tr key={f.id}>
                            <td style={{ fontWeight: 600 }}>{f.name}</td>
                            <td className="mono text-secondary">{f.id}</td>
                            <td className="mono text-secondary">
                              {f.modifiedTime ? f.modifiedTime.slice(0, 10) : '-'}
                            </td>
                            <td className="align-right">
                              <button
                                className="btn btn-sm btn-primary"
                                onClick={() => handleLoadAndBindSpreadsheet(f.id, importMode)}
                              >
                                選擇並綁定
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // =========================================================================
  // 畫面狀態 C：主控台（已登入且已綁定 Google 試算表）
  // =========================================================================
  return (
    <div className="app-shell">
      {/* 頂部常駐導航與 10 分鐘自動報價同步狀態列 */}
      <header className="topbar">
        <div className="brand-group">
          <div className="brand-logo">
            <TrendingUp size={20} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1 className="brand-title">{linkedSpreadsheet.title}</h1>
              <a
                href={linkedSpreadsheet.url}
                target="_blank"
                rel="noreferrer"
                className="badge-brand"
                style={{ textDecoration: 'none' }}
              >
                開啟 Google 試算表 <ExternalLink size={11} />
              </a>
            </div>
            <div className="brand-subtitle">
              <span>{authSession.email}</span>
              <span>•</span>
              <span>
                {syncStatus === 'syncing'
                  ? syncMessage
                  : syncMessage || `最後更新：${overview.updatedAt}`}
              </span>
            </div>
          </div>
        </div>

        <div className="topbar-controls">
          {/* 10 分鐘自動報價倒數計時器 */}
          <div className="timer-box" title="每 10 分鐘自動抓取台股最新現價並以 pricesOnly: true 回寫試算表總覽">
            <span
              className={`status-dot ${
                isRefreshingPrices || syncStatus === 'syncing' ? 'syncing' : ''
              }`}
            />
            <span>自動刷價倒數：</span>
            <strong className="mono" style={{ color: 'var(--text-primary)' }}>
              {formatCountdown(secondsUntilNextRefresh)}
            </strong>
          </div>

          <button
            id="refresh-all-prices-btn"
            className="btn btn-primary"
            disabled={isRefreshingPrices || portfolio.holdings.length === 0}
            onClick={() => refreshAllPricesAndSync(true)}
          >
            <RefreshCw size={14} className={isRefreshingPrices ? 'spin' : ''} />
            {isRefreshingPrices ? '更新現價中...' : '立即更新全部現價'}
          </button>

          <button
            id="cloudrun-auto-modal-btn"
            className="btn"
            onClick={() => {
              fetchServerStatus();
              setIsCloudRunModalOpen(true);
            }}
          >
            <Cloud size={14} color="var(--brand-primary)" />
            免開網頁 10 分鐘排程 & Cloud Run
          </button>

          <button
            className="btn"
            onClick={() => setIsFeeSettingsOpen(!isFeeSettingsOpen)}
            title="交易手續費折數與自動刷新設定"
          >
            <Settings size={14} />
          </button>

          <button
            className="btn"
            title="解除綁定並切換其他試算表"
            onClick={() => {
              setLinkedSpreadsheet(null);
              localStorage.removeItem(STORAGE_KEYS.LINKED_SHEET);
            }}
          >
            <Unlink size={14} /> 切換試算表
          </button>

          <button id="logout-main-btn" className="btn btn-up" onClick={handleLogout}>
            <LogOut size={14} /> 登出
          </button>
        </div>
      </header>

      {/* 券商手續費折數與自動刷新頻率設定面板 */}
      {isFeeSettingsOpen && (
        <div className="panel" style={{ padding: '16px 20px', marginBottom: '18px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: '14px' }}>
              交易稅費折數與 10 分鐘自動報價同步設定
            </div>
            <button className="btn btn-sm" onClick={() => setIsFeeSettingsOpen(false)}>
              完成設定
            </button>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">券商手續費折數 (例如 0.6 = 6折, 0.28 = 2.8折)</label>
              <input
                type="number"
                step="0.01"
                min="0.05"
                max="1"
                className="form-input mono"
                value={feeSettings.brokerDiscount}
                onChange={(e) => {
                  const next = { ...feeSettings, brokerDiscount: Number(e.target.value) };
                  setFeeSettings(next);
                  localStorage.setItem(STORAGE_KEYS.FEE_SETTINGS, JSON.stringify(next));
                }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">自動刷新間隔 (分鐘，預設 10 分鐘)</label>
              <input
                type="number"
                min={1}
                max={60}
                className="form-input mono"
                value={feeSettings.autoRefreshIntervalMinutes}
                onChange={(e) => {
                  const mins = Math.max(1, Number(e.target.value) || 10);
                  const next = { ...feeSettings, autoRefreshIntervalMinutes: mins };
                  setFeeSettings(next);
                  setSecondsUntilNextRefresh(mins * 60);
                  localStorage.setItem(STORAGE_KEYS.FEE_SETTINGS, JSON.stringify(next));
                  fetch('/api/auto-sync/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ intervalMinutes: mins }),
                  }).catch(() => {});
                }}
              />
            </div>
            <div className="form-group" style={{ justifyContent: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '18px' }}>
                <input
                  type="checkbox"
                  checked={feeSettings.includeEstSellFeeInUnrealized}
                  onChange={(e) => {
                    const next = {
                      ...feeSettings,
                      includeEstSellFeeInUnrealized: e.target.checked,
                    };
                    setFeeSettings(next);
                    localStorage.setItem(STORAGE_KEYS.FEE_SETTINGS, JSON.stringify(next));
                  }}
                />
                <span>未實現損益加扣「預估賣出手續費」（預設僅扣預估賣出證交稅）</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* 頂部五大投資組合關鍵指標摘要卡 */}
      <section className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">
            <span>總持股市值 (NT$)</span>
            <Briefcase size={15} color="var(--brand-primary)" />
          </div>
          <div className="metric-value">
            ${overview.totalMarketValue.toLocaleString()}
          </div>
          <div className="metric-sub">
            總投入成本：<span className="mono">${overview.totalCost.toLocaleString()}</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>預估未實現淨損益</span>
            {overview.totalUnrealizedProfit >= 0 ? (
              <ArrowUpRight size={16} color="var(--tw-up)" />
            ) : (
              <ArrowDownRight size={16} color="var(--tw-down)" />
            )}
          </div>
          <div
            className={`metric-value ${
              overview.totalUnrealizedProfit > 0
                ? 'text-up'
                : overview.totalUnrealizedProfit < 0
                ? 'text-down'
                : ''
            }`}
          >
            {overview.totalUnrealizedProfit >= 0 ? '+' : ''}
            ${overview.totalUnrealizedProfit.toLocaleString()}
          </div>
          <div className="metric-sub">
            預估報酬率：
            <span
              className={
                overview.totalUnrealizedReturnRate >= 0 ? 'badge-up' : 'badge-down'
              }
            >
              {overview.totalUnrealizedReturnRate >= 0 ? '+' : ''}
              {overview.totalUnrealizedReturnRate.toFixed(2)}%
            </span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>持股檔數與勝率分佈</span>
            <Activity size={15} color="var(--brand-primary)" />
          </div>
          <div className="metric-value">{overview.holdingCount} 檔</div>
          <div className="metric-sub">
            <span className="text-up">{overview.profitableCount} 獲利</span>
            <span>/</span>
            <span className="text-down">{overview.losingCount} 虧損</span>
            <span>(預估證交稅 ${overview.totalEstTax.toLocaleString()})</span>
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>累積已實現損益</span>
            <History size={15} color="var(--brand-primary)" />
          </div>
          <div
            className={`metric-value ${
              realizedSummary.totalRealizedProfit > 0
                ? 'text-up'
                : realizedSummary.totalRealizedProfit < 0
                ? 'text-down'
                : ''
            }`}
          >
            {realizedSummary.totalRealizedProfit >= 0 ? '+' : ''}
            ${realizedSummary.totalRealizedProfit.toLocaleString()}
          </div>
          <div className="metric-sub">
            勝率：{realizedSummary.winRate.toFixed(1)}% ({realizedSummary.winCount}勝{' '}
            {realizedSummary.lossCount}敗)
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">
            <span>累計實收現金股利</span>
            <Coins size={15} color="var(--brand-primary)" />
          </div>
          <div className="metric-value text-up">
            +${dividendSummary.totalNetCash.toLocaleString()}
          </div>
          <div className="metric-sub">
            獲配股票：{dividendSummary.totalStockShares.toLocaleString()} 股 ｜ 本年股利 $
            {dividendSummary.currentYearNetCash.toLocaleString()}
          </div>
        </div>
      </section>

      {/* 主操作列與標準四分頁 + 投組分析切換 */}
      <div className="nav-tabs-bar">
        <div className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <Briefcase size={15} />
            分頁 1：個股庫存統計總覽 ({overview.holdingCount})
          </button>
          <button
            className={`nav-tab ${activeTab === 'transactions' ? 'active' : ''}`}
            onClick={() => setActiveTab('transactions')}
          >
            <History size={15} />
            分頁 2：分筆交易明細 ({portfolio.buyRecords.length + portfolio.realizedRecords.length})
          </button>
          <button
            className={`nav-tab ${activeTab === 'realized' ? 'active' : ''}`}
            onClick={() => setActiveTab('realized')}
          >
            <CheckCircle2 size={15} />
            分頁 3：已實現損益紀錄 ({portfolio.realizedRecords.length})
          </button>
          <button
            className={`nav-tab ${activeTab === 'dividends' ? 'active' : ''}`}
            onClick={() => setActiveTab('dividends')}
          >
            <Coins size={15} />
            分頁 4：配息配股紀錄 ({portfolio.dividendRecords.length})
          </button>
          <button
            className={`nav-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={15} />
            投組深度分析 ＆ CSV 匯出
          </button>
        </div>

        <div style={{ display: 'flex', gap: '8px', paddingBottom: '6px', flexWrap: 'wrap' }}>
          <button
            id="open-add-buy-btn"
            className="btn btn-primary"
            onClick={() => {
              setEditingLotContext(null);
              setPresetBuyCode(undefined);
              setIsBuyModalOpen(true);
            }}
          >
            <Plus size={14} /> 新增買進批次
          </button>
          <button
            id="open-record-sell-btn"
            className="btn"
            onClick={() => {
              setEditingRealized(null);
              setPresetSellHolding(portfolio.holdings[0] || null);
              setPresetSellLotId(undefined);
              setIsSellModalOpen(true);
            }}
          >
            記錄賣出沖銷
          </button>
          <button
            id="open-add-dividend-btn"
            className="btn"
            onClick={() => setIsDividendModalOpen(true)}
          >
            新增配息配股
          </button>
        </div>
      </div>

      {/* =====================================================================
          分頁 1：個股庫存統計總覽
      ===================================================================== */}
      {activeTab === 'overview' && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>分頁 1：個股庫存統計總覽</span>
              <span className="badge-neutral">點擊列左側箭頭可展開分筆買進批次</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn-sm"
                onClick={() =>
                  handleLoadAndBindSpreadsheet(linkedSpreadsheet.spreadsheetId, 'replace')
                }
              >
                <RefreshCw size={13} /> 從 Google Sheet 重新載入
              </button>
              <button
                className="btn btn-sm"
                onClick={() => handleExportCsv('overview')}
              >
                <Download size={13} /> 匯出總覽 CSV
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '36px' }}></th>
                  <th>股票代碼</th>
                  <th>股票名稱</th>
                  <th>類別</th>
                  <th className="align-right">持有股數</th>
                  <th className="align-right">平均成本價</th>
                  <th className="align-right">當前現價 (點擊可微調)</th>
                  <th className="align-right">總成本</th>
                  <th className="align-right">總市值</th>
                  <th className="align-right">預估證交稅</th>
                  <th className="align-right">預估淨損益</th>
                  <th className="align-right">預估報酬率</th>
                  <th className="align-right">投組比重</th>
                  <th>產業類別</th>
                  <th className="align-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {overview.items.length === 0 ? (
                  <tr>
                    <td
                      colSpan={15}
                      style={{ textAlign: 'center', padding: '42px 20px', color: 'var(--text-muted)' }}
                    >
                      目前試算表尚無庫存持股，請點擊右上角「新增買進批次」新增第一筆持股，系統將自動回寫至您的 Google 試算表。
                    </td>
                  </tr>
                ) : (
                  overview.items.map((item) => {
                    const rawHolding = portfolio.holdings.find(
                      (h) => normalizeStockCode(h.code) === item.code
                    );
                    const isExpanded = Boolean(expandedCodes[item.code]);

                    return (
                      <React.Fragment key={item.code}>
                        <tr>
                          <td>
                            <button
                              className="btn btn-sm"
                              style={{ padding: '3px 5px' }}
                              onClick={() =>
                                setExpandedCodes((prev) => ({
                                  ...prev,
                                  [item.code]: !prev[item.code],
                                }))
                              }
                            >
                              {isExpanded ? (
                                <ChevronDown size={14} />
                              ) : (
                                <ChevronRight size={14} />
                              )}
                            </button>
                          </td>
                          <td className="mono" style={{ fontWeight: 700, color: 'var(--brand-primary)' }}>
                            {item.code}
                          </td>
                          <td style={{ fontWeight: 600 }}>{item.name}</td>
                          <td>
                            <span className="badge-neutral">{item.category}</span>
                          </td>
                          <td className="align-right mono">
                            {item.totalShares.toLocaleString()}
                          </td>
                          <td className="align-right mono">
                            {item.avgCostPrice.toFixed(2)}
                          </td>
                          <td className="align-right mono">
                            {editingPriceCode === item.code ? (
                              <div style={{ display: 'inline-flex', gap: '4px', alignItems: 'center' }}>
                                <input
                                  type="number"
                                  step="0.01"
                                  className="form-input mono"
                                  style={{ width: '88px', padding: '3px 6px' }}
                                  value={editingPriceValue}
                                  onChange={(e) => setEditingPriceValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveInlinePrice(item.code);
                                    if (e.key === 'Escape') setEditingPriceCode(null);
                                  }}
                                  autoFocus
                                />
                                <button
                                  className="btn btn-sm btn-primary"
                                  onClick={() => handleSaveInlinePrice(item.code)}
                                >
                                  儲存
                                </button>
                              </div>
                            ) : (
                              <div
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                  cursor: 'pointer',
                                }}
                                onClick={() => {
                                  setEditingPriceCode(item.code);
                                  setEditingPriceValue(String(item.currentPrice));
                                }}
                                title="點擊可手動調整現價（僅更新總覽分頁 pricesOnly: true）"
                              >
                                <span style={{ fontWeight: 700 }}>
                                  {item.currentPrice.toFixed(2)}
                                </span>
                                <Edit3 size={12} color="var(--text-muted)" />
                              </div>
                            )}
                          </td>
                          <td className="align-right mono">
                            ${item.totalCost.toLocaleString()}
                          </td>
                          <td className="align-right mono" style={{ fontWeight: 600 }}>
                            ${item.marketValue.toLocaleString()}
                          </td>
                          <td className="align-right mono text-secondary">
                            ${item.estSellTax.toLocaleString()}
                            <span style={{ fontSize: '11px', marginLeft: '3px' }}>
                              ({item.isEtf ? '0.1%' : '0.3%'})
                            </span>
                          </td>
                          <td
                            className={`align-right mono ${
                              item.unrealizedProfit > 0
                                ? 'text-up'
                                : item.unrealizedProfit < 0
                                ? 'text-down'
                                : ''
                            }`}
                            style={{ fontWeight: 700 }}
                          >
                            {item.unrealizedProfit >= 0 ? '+' : ''}
                            ${item.unrealizedProfit.toLocaleString()}
                          </td>
                          <td className="align-right">
                            <span
                              className={
                                item.unrealizedReturnRate > 0
                                  ? 'badge-up'
                                  : item.unrealizedReturnRate < 0
                                  ? 'badge-down'
                                  : 'badge-neutral'
                              }
                            >
                              {item.unrealizedReturnRate >= 0 ? '+' : ''}
                              {item.unrealizedReturnRate.toFixed(2)}%
                            </span>
                          </td>
                          <td className="align-right mono">
                            {item.portfolioWeight.toFixed(2)}%
                          </td>
                          <td className="text-secondary">{item.industry}</td>
                          <td className="align-right">
                            <div style={{ display: 'inline-flex', gap: '5px' }}>
                              <button
                                className="btn btn-sm"
                                title="手動刷新此檔即時市價"
                                disabled={refreshingSingleCode === item.code}
                                onClick={() => refreshSingleStockPrice(item.code)}
                              >
                                <RefreshCw size={12} />
                              </button>
                              <button
                                className="btn btn-sm"
                                title="加碼買進此檔"
                                onClick={() => {
                                  setEditingLotContext(null);
                                  setPresetBuyCode(item.code);
                                  setIsBuyModalOpen(true);
                                }}
                              >
                                +買進
                              </button>
                              <button
                                className="btn btn-sm"
                                title="記錄賣出此檔"
                                onClick={() => {
                                  setEditingRealized(null);
                                  setPresetSellHolding(rawHolding || null);
                                  setPresetSellLotId(undefined);
                                  setIsSellModalOpen(true);
                                }}
                              >
                                賣出
                              </button>
                              <button
                                className="btn btn-sm"
                                title="刪除整檔持股"
                                onClick={() => handleDeleteEntireHolding(item.code)}
                              >
                                <Trash2 size={12} color="var(--tw-up)" />
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* 展開之分筆庫存批次明細列 */}
                        {isExpanded &&
                          rawHolding &&
                          rawHolding.lots.map((lot, lIdx) => {
                            const lotCost = calculateLotCost(
                              lot.shares,
                              lot.price,
                              lot.buyFee
                            );
                            const lotMv = Math.round(lot.shares * item.currentPrice);
                            const lotTax = Math.floor(
                              lotMv * (item.isEtf ? 0.001 : 0.003)
                            );
                            const lotPnl = lotMv - lotCost - lotTax;
                            const lotRoi = lotCost > 0 ? (lotPnl / lotCost) * 100 : 0;

                            return (
                              <tr key={lot.id} className="subrow">
                                <td></td>
                                <td className="mono text-secondary" style={{ paddingLeft: '24px' }}>
                                  └ 批次 #{lIdx + 1}
                                </td>
                                <td className="mono text-secondary">{lot.date}</td>
                                <td>
                                  <span className="badge-neutral">{lot.category}</span>
                                </td>
                                <td className="align-right mono">
                                  {lot.shares.toLocaleString()} 股
                                </td>
                                <td className="align-right mono">
                                  {lot.price.toFixed(2)}
                                </td>
                                <td className="align-right mono text-secondary">
                                  手續費 ${lot.buyFee}
                                </td>
                                <td className="align-right mono">
                                  ${lotCost.toLocaleString()}
                                </td>
                                <td className="align-right mono">
                                  ${lotMv.toLocaleString()}
                                </td>
                                <td className="align-right mono text-secondary">
                                  ${lotTax.toLocaleString()}
                                </td>
                                <td
                                  className={`align-right mono ${
                                    lotPnl >= 0 ? 'text-up' : 'text-down'
                                  }`}
                                >
                                  {lotPnl >= 0 ? '+' : ''}${lotPnl.toLocaleString()}
                                </td>
                                <td className="align-right mono">
                                  {lotRoi >= 0 ? '+' : ''}
                                  {lotRoi.toFixed(2)}%
                                </td>
                                <td colSpan={2} className="text-secondary">
                                  {lot.note || '-'}
                                </td>
                                <td className="align-right">
                                  <div style={{ display: 'inline-flex', gap: '4px' }}>
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => {
                                        setEditingLotContext({
                                          holding: rawHolding,
                                          lot,
                                        });
                                        setIsBuyModalOpen(true);
                                      }}
                                    >
                                      編輯
                                    </button>
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => {
                                        setEditingRealized(null);
                                        setPresetSellHolding(rawHolding);
                                        setPresetSellLotId(lot.id);
                                        setIsSellModalOpen(true);
                                      }}
                                    >
                                      指定賣出
                                    </button>
                                    <button
                                      className="btn btn-sm"
                                      onClick={() =>
                                        handleDeleteLot(rawHolding.code, lot.id)
                                      }
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =====================================================================
          分頁 2：分筆交易明細 (整合買進流水與賣出紀錄，依日期由新到舊排序)
      ===================================================================== */}
      {activeTab === 'transactions' && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>分頁 2：分筆交易明細（買進紀錄永遠保留原始買進股數與成交總額）</span>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => handleExportCsv('transactions')}
            >
              <Download size={13} /> 匯出分筆明細 CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>交易動作</th>
                  <th>股票代碼</th>
                  <th>股票名稱</th>
                  <th>交易日期 (由新到舊)</th>
                  <th>交易類別</th>
                  <th className="align-right">交易股數 (原始)</th>
                  <th className="align-right">成交單價</th>
                  <th className="align-right">交易總額</th>
                  <th className="align-right">成本均價</th>
                  <th className="align-right">投入成本</th>
                  <th className="align-right">損益</th>
                  <th className="align-right">報酬率 (%)</th>
                  <th>備註</th>
                </tr>
              </thead>
              <tbody>
                {sheetTabsPreview.transactionRows.slice(3).length === 0 ? (
                  <tr>
                    <td colSpan={13} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                      尚無分筆交易明細紀錄
                    </td>
                  </tr>
                ) : (
                  sheetTabsPreview.transactionRows.slice(3).map((row, idx) => {
                    const isSell = String(row[0]) === '賣出';
                    const pnl = Number(row[10]) || 0;
                    return (
                      <tr key={idx}>
                        <td>
                          <span className={isSell ? 'badge-down' : 'badge-up'}>
                            {row[0]}
                          </span>
                        </td>
                        <td className="mono" style={{ fontWeight: 700 }}>
                          {row[1]}
                        </td>
                        <td style={{ fontWeight: 600 }}>{row[2]}</td>
                        <td className="mono">{row[3]}</td>
                        <td>{row[4]}</td>
                        <td className="align-right mono">
                          {Number(row[5]).toLocaleString()}
                        </td>
                        <td className="align-right mono">{row[6]}</td>
                        <td className="align-right mono">
                          ${Number(row[7]).toLocaleString()}
                        </td>
                        <td className="align-right mono">{row[8]}</td>
                        <td className="align-right mono">
                          ${Number(row[9]).toLocaleString()}
                        </td>
                        <td
                          className={`align-right mono ${
                            pnl >= 0 ? 'text-up' : 'text-down'
                          }`}
                          style={{ fontWeight: 700 }}
                        >
                          {pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}
                        </td>
                        <td className="align-right mono">{row[11]}</td>
                        <td className="text-secondary">{String(row[12]).replace(/\s*\[#[^\]]+\]/g, '')}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =====================================================================
          分頁 3：已實現損益紀錄
      ===================================================================== */}
      {activeTab === 'realized' && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>
                分頁 3：已實現損益紀錄（刪除紀錄時自動將扣除股數與手續費精準還原回原庫存批次）
              </span>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => handleExportCsv('realized')}
            >
              <Download size={13} /> 匯出已實現損益 CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>股票代碼</th>
                  <th>股票名稱</th>
                  <th>賣出日期</th>
                  <th>交易類別</th>
                  <th className="align-right">賣出股數</th>
                  <th className="align-right">買進成本均價</th>
                  <th className="align-right">賣出成交單價</th>
                  <th className="align-right">投入成本 (含買進手續費)</th>
                  <th className="align-right">賣出金額</th>
                  <th className="align-right">稅費合計</th>
                  <th className="align-right">已實現淨損益</th>
                  <th className="align-right">報酬率 (%)</th>
                  <th>備註</th>
                  <th className="align-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.realizedRecords.length === 0 ? (
                  <tr>
                    <td colSpan={14} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                      尚無已實現賣出損益紀錄
                    </td>
                  </tr>
                ) : (
                  portfolio.realizedRecords.map((r) => (
                    <tr key={r.id}>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        {r.code}
                      </td>
                      <td style={{ fontWeight: 600 }}>{r.name}</td>
                      <td className="mono">{r.sellDate}</td>
                      <td>{r.category}</td>
                      <td className="align-right mono">
                        {r.shares.toLocaleString()}
                      </td>
                      <td className="align-right mono">
                        {r.avgBuyPrice.toFixed(2)}
                      </td>
                      <td className="align-right mono">
                        {r.sellPrice.toFixed(2)}
                      </td>
                      <td className="align-right mono">
                        ${r.totalBuyCost.toLocaleString()}
                      </td>
                      <td className="align-right mono">
                        ${r.grossSellAmount.toLocaleString()}
                      </td>
                      <td className="align-right mono text-secondary">
                        ${((r.sellFee || 0) + (r.sellTax || 0)).toLocaleString()}
                      </td>
                      <td
                        className={`align-right mono ${
                          r.netProfit >= 0 ? 'text-up' : 'text-down'
                        }`}
                        style={{ fontWeight: 700 }}
                      >
                        {r.netProfit >= 0 ? '+' : ''}${r.netProfit.toLocaleString()}
                      </td>
                      <td className="align-right">
                        <span
                          className={
                            r.returnRate >= 0 ? 'badge-up' : 'badge-down'
                          }
                        >
                          {r.returnRate >= 0 ? '+' : ''}
                          {r.returnRate.toFixed(2)}%
                        </span>
                      </td>
                      <td className="text-secondary">{r.note || '-'}</td>
                      <td className="align-right">
                        <div style={{ display: 'inline-flex', gap: '5px' }}>
                          <button
                            className="btn btn-sm"
                            onClick={() => {
                              setEditingRealized(r);
                              setIsSellModalOpen(true);
                            }}
                          >
                            編輯
                          </button>
                          <button
                            className="btn btn-sm"
                            title="刪除此筆賣出紀錄並將股數還原回原庫存批次"
                            onClick={() => handleDeleteRealizedRecord(r)}
                          >
                            <Trash2 size={12} color="var(--tw-up)" /> 還原庫存
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =====================================================================
          分頁 4：配息配股紀錄
      ===================================================================== */}
      {activeTab === 'dividends' && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <span>分頁 4：配息配股紀錄（支援 2.11% 二代健保補充保費與 0 成本配股入庫）</span>
            </div>
            <button
              className="btn btn-sm"
              onClick={() => handleExportCsv('dividends')}
            >
              <Download size={13} /> 匯出配息配股 CSV
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>股票代碼</th>
                  <th>股票名稱</th>
                  <th>股利類別</th>
                  <th>除權息日</th>
                  <th>發放日</th>
                  <th className="align-right">參與股數</th>
                  <th className="align-right">每股現金</th>
                  <th className="align-right">應發放現金</th>
                  <th className="align-right">健保/匯費</th>
                  <th className="align-right">實收現金</th>
                  <th className="align-right">每股配股</th>
                  <th className="align-right">獲配股數</th>
                  <th>計入庫存狀態</th>
                  <th>備註</th>
                  <th className="align-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.dividendRecords.length === 0 ? (
                  <tr>
                    <td colSpan={15} style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                      尚無配息配股紀錄
                    </td>
                  </tr>
                ) : (
                  portfolio.dividendRecords.map((d) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontWeight: 700 }}>
                        {d.code}
                      </td>
                      <td style={{ fontWeight: 600 }}>{d.name}</td>
                      <td>
                        <span className="badge-brand">{d.dividendType}</span>
                      </td>
                      <td className="mono">{d.exDate}</td>
                      <td className="mono">{d.payDate}</td>
                      <td className="align-right mono">
                        {d.participatingShares.toLocaleString()}
                      </td>
                      <td className="align-right mono">
                        {d.cashPerShare.toFixed(2)}
                      </td>
                      <td className="align-right mono">
                        ${d.grossCash.toLocaleString()}
                      </td>
                      <td className="align-right mono text-secondary">
                        ${d.healthAndBankFee.toLocaleString()}
                      </td>
                      <td className="align-right mono text-up" style={{ fontWeight: 700 }}>
                        +${d.netCash.toLocaleString()}
                      </td>
                      <td className="align-right mono">
                        {d.stockPerShare.toFixed(2)}
                      </td>
                      <td className="align-right mono text-up">
                        {d.stockSharesReceived > 0
                          ? `+${d.stockSharesReceived.toLocaleString()} 股`
                          : '0'}
                      </td>
                      <td>
                        <span className="badge-neutral">
                          {d.addedToInventory ? '已計入庫存' : '僅記錄'}
                        </span>
                      </td>
                      <td className="text-secondary">{d.note || '-'}</td>
                      <td className="align-right">
                        <button
                          className="btn btn-sm"
                          onClick={() => handleDeleteDividendRecord(d)}
                        >
                          <Trash2 size={12} color="var(--tw-up)" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =====================================================================
          分頁 5：投組深度分析 & 本機 CSV 備份匯出
      ===================================================================== */}
      {activeTab === 'analytics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* CSV 備份匯出中心 */}
          <section className="panel" style={{ padding: '18px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px',
              }}
            >
              <div>
                <h2 style={{ fontSize: '15px', fontWeight: 700 }}>
                  本機 UTF-8 BOM (.csv) 備份匯出中心
                </h2>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  支援將四大分頁分別匯出為 Excel 直接雙擊可正常顯示繁體中文之 UTF-8 BOM CSV 檔案。
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => handleExportCsv('overview')}>
                  <Download size={14} /> 匯出個股庫存統計總覽.csv
                </button>
                <button className="btn" onClick={() => handleExportCsv('transactions')}>
                  <Download size={14} /> 匯出分筆交易明細.csv
                </button>
                <button className="btn" onClick={() => handleExportCsv('realized')}>
                  <Download size={14} /> 匯出已實現損益紀錄.csv
                </button>
                <button className="btn" onClick={() => handleExportCsv('dividends')}>
                  <Download size={14} /> 匯出配息配股紀錄.csv
                </button>
              </div>
            </div>
          </section>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
              gap: '18px',
            }}
          >
            {/* 持股集中度與產業配置 */}
            <section className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-header">
                <div className="panel-title">持股集中度與產業配置比重</div>
              </div>
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {analytics.concentration.length === 0 ? (
                  <div className="text-muted">尚無持股資料</div>
                ) : (
                  analytics.concentration.map((c) => (
                    <div key={c.code} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                        <span>
                          <strong className="mono">{c.code}</strong> {c.name}
                        </span>
                        <span className="mono">
                          ${c.marketValue.toLocaleString()} ({c.weight.toFixed(2)}%)
                        </span>
                      </div>
                      <div className="progress-bar-track">
                        <div
                          className="progress-bar-fill"
                          style={{ width: `${Math.min(100, c.weight)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* 月度損益與勝率統計 */}
            <section className="panel" style={{ marginBottom: 0 }}>
              <div className="panel-header">
                <div className="panel-title">月度已實現損益與勝率統計</div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>月份</th>
                      <th className="align-right">交易筆數</th>
                      <th className="align-right">勝率</th>
                      <th className="align-right">賣出總額</th>
                      <th className="align-right">月度淨損益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.monthlyStats.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                          尚無已實現損益紀錄
                        </td>
                      </tr>
                    ) : (
                      analytics.monthlyStats.map((m) => (
                        <tr key={m.month}>
                          <td className="mono" style={{ fontWeight: 600 }}>
                            {m.month}
                          </td>
                          <td className="align-right mono">{m.totalCount} 筆</td>
                          <td className="align-right mono">
                            {m.winRate.toFixed(1)}%
                          </td>
                          <td className="align-right mono">
                            ${m.sellAmount.toLocaleString()}
                          </td>
                          <td
                            className={`align-right mono ${
                              m.netProfit >= 0 ? 'text-up' : 'text-down'
                            }`}
                            style={{ fontWeight: 700 }}
                          >
                            {m.netProfit >= 0 ? '+' : ''}${m.netProfit.toLocaleString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          {/* 各標的累計總貢獻排行 (已實現 + 股利 + 未實現) */}
          <section className="panel">
            <div className="panel-header">
              <div className="panel-title">
                各標的累計總貢獻排行（已實現損益 ＋ 實收現金股利 ＋ 未實現損益）
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>排名</th>
                    <th>股票代碼</th>
                    <th>股票名稱</th>
                    <th className="align-right">未實現損益</th>
                    <th className="align-right">累積已實現損益</th>
                    <th className="align-right">累積實收現金股利</th>
                    <th className="align-right">累計獲配股數</th>
                    <th className="align-right">總損益貢獻合計</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.totalContributionRanking.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                        尚無標的貢獻資料
                      </td>
                    </tr>
                  ) : (
                    analytics.totalContributionRanking.map((item, idx) => (
                      <tr key={item.code}>
                        <td className="mono">#{idx + 1}</td>
                        <td className="mono" style={{ fontWeight: 700 }}>
                          {item.code}
                        </td>
                        <td style={{ fontWeight: 600 }}>{item.name}</td>
                        <td
                          className={`align-right mono ${
                            item.unrealizedProfit >= 0 ? 'text-up' : 'text-down'
                          }`}
                        >
                          {item.unrealizedProfit >= 0 ? '+' : ''}$
                          {item.unrealizedProfit.toLocaleString()}
                        </td>
                        <td
                          className={`align-right mono ${
                            item.realizedProfit >= 0 ? 'text-up' : 'text-down'
                          }`}
                        >
                          {item.realizedProfit >= 0 ? '+' : ''}$
                          {item.realizedProfit.toLocaleString()}
                        </td>
                        <td className="align-right mono text-up">
                          +${item.dividendCash.toLocaleString()}
                        </td>
                        <td className="align-right mono">
                          {item.dividendStockShares.toLocaleString()} 股
                        </td>
                        <td
                          className={`align-right mono ${
                            item.totalContribution >= 0 ? 'text-up' : 'text-down'
                          }`}
                          style={{ fontWeight: 700, fontSize: '14px' }}
                        >
                          {item.totalContribution >= 0 ? '+' : ''}$
                          {item.totalContribution.toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* 交易與排程 Modals */}
      <BuyLotModal
        isOpen={isBuyModalOpen}
        onClose={() => setIsBuyModalOpen(false)}
        feeSettings={feeSettings}
        editingContext={editingLotContext}
        presetCode={presetBuyCode}
        onSubmit={handleAddOrEditBuyLot}
      />

      <SellModal
        isOpen={isSellModalOpen}
        onClose={() => setIsSellModalOpen(false)}
        holdings={portfolio.holdings}
        feeSettings={feeSettings}
        presetHolding={presetSellHolding}
        presetLotId={presetSellLotId}
        editingRealized={editingRealized}
        onSubmit={handleRecordOrEditSell}
      />

      <DividendModal
        isOpen={isDividendModalOpen}
        onClose={() => setIsDividendModalOpen(false)}
        holdings={portfolio.holdings}
        onSubmit={handleAddDividendRecord}
      />

      <CloudRunAutomationModal
        isOpen={isCloudRunModalOpen}
        onClose={() => setIsCloudRunModalOpen(false)}
        spreadsheetId={linkedSpreadsheet.spreadsheetId}
        serverStatus={serverAutoSyncStatus}
        isSyncingServer={isSyncingServerNow}
        onRefreshStatus={fetchServerStatus}
        onTriggerServerSync={async () => {
          setIsSyncingServerNow(true);
          await fetch('/api/cron/sync-prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              spreadsheetId: linkedSpreadsheet.spreadsheetId,
              accessToken: authSession.accessToken.startsWith('sandbox_')
                ? undefined
                : authSession.accessToken,
            }),
          }).catch(() => {});
          await fetchServerStatus();
          setIsSyncingServerNow(false);
        }}
      />
    </div>
  );
};
