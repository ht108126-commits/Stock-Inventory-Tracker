import React, { useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  Lock,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { DEFAULT_USER_SHEET_ID } from '../services/googleSheetsClient';

interface CloudRunAutomationModalProps {
  isOpen: boolean;
  onClose: () => void;
  spreadsheetId: string;
  serverStatus: any;
  onTriggerServerSync: () => Promise<void>;
  onRefreshStatus: () => Promise<void>;
  isSyncingServer: boolean;
}

export const CloudRunAutomationModal: React.FC<CloudRunAutomationModalProps> = ({
  isOpen,
  onClose,
  spreadsheetId,
  serverStatus,
  onTriggerServerSync,
  onRefreshStatus,
  isSyncingServer,
}) => {
  const [activeTab, setActiveTab] = useState<'autosync' | 'private_cloudrun' | 'apps_script' | 'optimizations'>('autosync');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!isOpen) return null;

  const targetSheetId = spreadsheetId || DEFAULT_USER_SHEET_ID;
  const originUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-service-url.run.app';

  const copyText = (key: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const appsScriptCode = `/**
 * 【免開網站・Google 試算表內建每 10 分鐘自動刷新即時股價腳本】
 * 綁定試算表 ID: ${targetSheetId}
 * 使用方式：
 * 1. 打開你的 Google 試算表 -> 點選上方選單「擴充功能」>「Apps Script」
 * 2. 貼上本段程式碼並按 Ctrl+S 儲存
 * 3. 點選左側鬧鐘圖示「觸發條件 (Triggers)」>「新增觸發條件」
 *    - 選擇執行函式：autoRefreshTaiwanStockPrices
 *    - 活動來源：時間驅動 -> 分鐘計時器 -> 每 10 分鐘
 */
const SPREADSHEET_ID = '${targetSheetId}';
const OVERVIEW_TAB_NAME = '個股庫存統計總覽';

function autoRefreshTaiwanStockPrices() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(OVERVIEW_TAB_NAME) || ss.getSheets()[0];
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 5) return;

  // 讀取第 5 列起的股票代碼 (A欄)、持有股數 (D欄)、總成本 (G欄)、類別 (C欄)
  const dataRange = sheet.getRange(5, 1, lastRow - 4, 13);
  const rows = dataRange.getValues();

  const codes = [];
  for (let i = 0; i < rows.length; i++) {
    let rawCode = String(rows[i][0] || '').trim();
    if (!rawCode) continue;
    if (/^\\d{2}$/.test(rawCode)) rawCode = '00' + rawCode;
    else if (/^[6789]\\d{2}[A-Z]?$/.test(rawCode)) rawCode = '00' + rawCode;
    codes.push(rawCode);
  }
  if (codes.length === 0) return;

  // 呼叫 TWSE / TPEx MIS 即時報價 API
  const channels = [];
  codes.forEach(c => {
    channels.push('tse_' + c + '.tw');
    channels.push('otc_' + c + '.tw');
  });

  const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(channels.join('|')) + '&json=1&delay=0';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText() || '{}');
  const msgArray = json.msgArray || [];

  const priceMap = {};
  msgArray.forEach(item => {
    const c = item.c;
    let p = parseFloat(item.z);
    if (!p || isNaN(p)) p = parseFloat(item.oz);
    if (!p || isNaN(p)) {
      const b = item.b ? parseFloat(String(item.b).split('_')[0]) : 0;
      const a = item.a ? parseFloat(String(item.a).split('_')[0]) : 0;
      p = b > 0 && a > 0 ? Number(((b + a) / 2).toFixed(2)) : (b || a || parseFloat(item.y));
    }
    if (p && p > 0) priceMap[c] = p;
  });

  let totalCostSum = 0;
  let totalMarketValSum = 0;
  let totalPnlSum = 0;
  let winCount = 0;
  let lossCount = 0;

  // 第一輪：更新各檔現價、總市值、預估損益、報酬率
  for (let i = 0; i < rows.length; i++) {
    let code = String(rows[i][0] || '').trim();
    if (!code) continue;
    if (/^\\d{2}$/.test(code)) code = '00' + code;
    else if (/^[6789]\\d{2}[A-Z]?$/.test(code)) code = '00' + code;

    const shares = Number(rows[i][3]) || 0;
    const totalCost = Number(rows[i][6]) || 0;
    const currentPrice = priceMap[code] || Number(rows[i][5]) || 0;
    const marketValue = Math.round(shares * currentPrice);
    const isEtf = code.startsWith('00') || String(rows[i][2]).includes('ETF');
    const estTax = Math.floor(marketValue * (isEtf ? 0.001 : 0.003));
    const estPnl = marketValue - totalCost - estTax;
    const roi = totalCost > 0 ? (estPnl / totalCost) * 100 : 0;

    rows[i][0] = code;
    rows[i][5] = Number(currentPrice.toFixed(2));
    rows[i][7] = marketValue;
    rows[i][8] = estPnl;
    rows[i][9] = (roi >= 0 ? '+' : '') + roi.toFixed(2) + '%';

    totalCostSum += totalCost;
    totalMarketValSum += marketValue;
    totalPnlSum += estPnl;
    if (estPnl > 0) winCount++;
    else if (estPnl < 0) lossCount++;
  }

  // 第二輪：更新投資組合比重 (%)
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    const mv = Number(rows[i][7]) || 0;
    const weight = totalMarketValSum > 0 ? (mv / totalMarketValSum) * 100 : 0;
    rows[i][10] = weight.toFixed(2) + '%';
  }

  dataRange.setValues(rows);

  // 更新頂部摘要列與最後更新時間
  const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy/MM/dd HH:mm:ss');
  const totalRoi = totalCostSum > 0 ? (totalPnlSum / totalCostSum) * 100 : 0;
  sheet.getRange('D1').setValue(nowStr);
  sheet.getRange('B2').setValue(totalCostSum);
  sheet.getRange('D2').setValue(totalMarketValSum);
  sheet.getRange('F2').setValue(totalPnlSum);
  sheet.getRange('H2').setValue((totalRoi >= 0 ? '+' : '') + totalRoi.toFixed(2) + '%');
  sheet.getRange('L2').setValue(winCount + ' 獲利 / ' + lossCount + ' 虧損');
}`;

  const cloudRunDeployCmd = `# 1. 設定 GCP 專案與區域 (例如台灣彰濱 asia-east1)
gcloud config set project YOUR_GCP_PROJECT_ID
gcloud config set run/region asia-east1

# 2. 一鍵建置並部署至 Google Cloud Run
#    同時設定你的專屬 Google 信箱白名單 (ALLOWED_OWNER_EMAILS) 與預設試算表 ID
gcloud run deploy stock-inventory-tracker \\
  --source . \\
  --region asia-east1 \\
  --allow-unauthenticated \\
  --set-env-vars="DEFAULT_SPREADSHEET_ID=${targetSheetId},ALLOWED_OWNER_EMAILS=你的Google信箱@gmail.com,CRON_SECRET=my_private_cron_secret_888" \\
  --min-instances=0 \\
  --max-instances=2 \\
  --memory=512Mi`;

  const cloudSchedulerCmd = `# 建立每 10 分鐘自動觸發後端刷新的 Cloud Scheduler 排程 (週一至週五 09:00~14:00 台北時間)
gcloud scheduler jobs create http sync-tw-stock-prices-10m \\
  --location=asia-east1 \\
  --schedule="*/10 9-14 * * 1-5" \\
  --time-zone="Asia/Taipei" \\
  --uri="${originUrl}/api/cron/sync-prices?source=cloud_scheduler" \\
  --http-method=POST \\
  --headers="x-cron-secret=my_private_cron_secret_888"`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: '860px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Cloud size={20} color="var(--brand-primary)" />
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 700 }}>
                10 分鐘自動刷新引擎 ＆ Google Cloud Run 私人網站部署指南
              </h2>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                徹底解決「每次都要打開網站才能刷新 Google Sheet 即時價格」的問題
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: '6px',
            padding: '10px 20px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-canvas)',
            overflowX: 'auto',
          }}
        >
          <button
            className={`btn btn-sm ${activeTab === 'autosync' ? 'btn-primary' : ''}`}
            onClick={() => setActiveTab('autosync')}
          >
            <RefreshCw size={13} /> 1. 後端 10 分鐘自動刷新狀態
          </button>
          <button
            className={`btn btn-sm ${activeTab === 'apps_script' ? 'btn-primary' : ''}`}
            onClick={() => setActiveTab('apps_script')}
          >
            <Terminal size={13} /> 2. 免開網頁 Apps Script 排程器
          </button>
          <button
            className={`btn btn-sm ${activeTab === 'private_cloudrun' ? 'btn-primary' : ''}`}
            onClick={() => setActiveTab('private_cloudrun')}
          >
            <Lock size={13} /> 3. Cloud Run 私人專屬權限設定
          </button>
          <button
            className={`btn btn-sm ${activeTab === 'optimizations' ? 'btn-primary' : ''}`}
            onClick={() => setActiveTab('optimizations')}
          >
            <Sparkles size={13} /> 4. 原版架構優化與修正報告
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {activeTab === 'autosync' && (
            <>
              <div className="feature-item">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '10px',
                    flexWrap: 'wrap',
                    gap: '8px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>
                      雙引擎 10 分鐘自動報價同步架構（前端倒數 ＋ 後端無頭背景同步）
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      目標試算表 ID：<span className="mono">{targetSheetId}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn btn-sm"
                      onClick={onRefreshStatus}
                      disabled={isSyncingServer}
                    >
                      <RefreshCw size={13} /> 重新整理狀態
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={onTriggerServerSync}
                      disabled={isSyncingServer}
                    >
                      <Play size={13} />
                      {isSyncingServer ? '後端刷新中...' : '立即觸發後端刷新試算表'}
                    </button>
                  </div>
                </div>

                <div className="metrics-grid" style={{ marginBottom: 0 }}>
                  <div className="metric-card" style={{ padding: '12px' }}>
                    <div className="metric-label">後端排程器狀態</div>
                    <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--tw-down)' }}>
                      {serverStatus?.enabled ? `運作中 (每 ${serverStatus.intervalMinutes || 10} 分鐘)` : '已暫停'}
                    </div>
                    <div className="metric-sub">
                      下次排程：{serverStatus?.nextSyncAt || '計算中'}
                    </div>
                  </div>
                  <div className="metric-card" style={{ padding: '12px' }}>
                    <div className="metric-label">台股開盤狀態</div>
                    <div style={{ fontWeight: 700, fontSize: '15px' }}>
                      {serverStatus?.marketOpenNow ? '盤中交易時段' : '非盤中 / 休市時段'}
                    </div>
                    <div className="metric-sub">
                      上次後端同步：{serverStatus?.lastSyncAt || '尚無紀錄'}
                    </div>
                  </div>
                  <div className="metric-card" style={{ padding: '12px' }}>
                    <div className="metric-label">背景授權模式</div>
                    <div style={{ fontWeight: 700, fontSize: '14px' }}>
                      {serverStatus?.hasServiceAccountEnv
                        ? 'Google 服務帳號 (24/7 常駐)'
                        : serverStatus?.hasRefreshTokenEnv
                        ? 'OAuth Refresh Token (24/7 常駐)'
                        : serverStatus?.hasSessionToken
                        ? '已綁定登入憑證 (記憶體)'
                        : 'Cloud Run ADC / 待登入授權'}
                    </div>
                    <div className="metric-sub">零資料庫儲存・純記憶體安全授權</div>
                  </div>
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: '13.5px', fontWeight: 600, marginBottom: '8px' }}>
                  為什麼以前你必須「打開網站」才會刷新 Google 試算表？我們如何徹底解決？
                </h3>
                <div
                  style={{
                    fontSize: '13px',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.65,
                    background: 'var(--bg-elevated)',
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  1. <strong>原本設計的限制</strong>：原本只有瀏覽器前端有 <code>setInterval</code> 定時器與試算表寫入邏輯，只要關閉分頁或手機鎖屏，定時器就停止；且瀏覽器 OAuth Token 1 小時就會過期。<br />
                  2. <strong>新設計方案 A（Cloud Run 後端自動排程）</strong>：我們在 Express 後端內建了無頭試算表同步引擎（<code>/api/cron/sync-prices</code>）。部署到 Cloud Run 後，只要把你的試算表共用給 Cloud Run 服務帳號（編輯者），搭配 Cloud Scheduler 每 10 分鐘呼叫一次，就算你整個月不開網站，Google Sheet 也會每 10 分鐘自動更新最新股價！<br />
                  3. <strong>新設計方案 B（Google 試算表內建 Apps Script 零成本排程）</strong>：點選上方「2. 免開網頁 Apps Script 排程器」分頁，複製腳本貼入你的 Google Sheet，試算表本身就會每 10 分鐘直連台灣證交所更新現價，完全免費且不依賴瀏覽器！
                </div>
              </div>

              <div>
                <h3 style={{ fontSize: '13.5px', fontWeight: 600, marginBottom: '8px' }}>
                  近期後端自動刷新紀錄 (最近 10 筆)
                </h3>
                {serverStatus?.recentLogs && serverStatus.recentLogs.length > 0 ? (
                  <div className="table-wrap" style={{ maxHeight: '210px', overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>時間 (台北)</th>
                          <th>觸發來源</th>
                          <th>狀態</th>
                          <th>更新檔數</th>
                          <th>說明</th>
                        </tr>
                      </thead>
                      <tbody>
                        {serverStatus.recentLogs.map((log: any) => (
                          <tr key={log.id}>
                            <td className="mono">{log.timestamp}</td>
                            <td>{log.trigger}</td>
                            <td>
                              <span
                                className={
                                  log.status === 'success'
                                    ? 'badge-down'
                                    : log.status === 'error'
                                    ? 'badge-up'
                                    : 'badge-neutral'
                                }
                              >
                                {log.status === 'success'
                                  ? '成功'
                                  : log.status === 'error'
                                  ? '失敗'
                                  : '略過'}
                              </span>
                            </td>
                            <td className="mono">{log.updatedCount} 檔</td>
                            <td style={{ whiteSpace: 'normal', maxWidth: '340px' }}>
                              {log.message}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '16px',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      background: 'var(--bg-elevated)',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    目前尚無後端背景同步紀錄，可點選右上角「立即觸發後端刷新試算表」測試。
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'apps_script' && (
            <>
              <div className="feature-item">
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '8px',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '14px' }}>
                      Google 試算表內建 Apps Script 10 分鐘自動更新腳本（已預填你的試算表 ID）
                    </div>
                    <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                      直接貼入 Google Sheet 的「擴充功能 &gt; Apps Script」，不開網站、甚至 Cloud Run 休眠時也能每 10 分鐘自動更新現價與損益！
                    </div>
                  </div>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => copyText('gas', appsScriptCode)}
                  >
                    {copiedKey === 'gas' ? <Check size={14} /> : <Copy size={14} />}
                    {copiedKey === 'gas' ? '已複製腳本' : '一鍵複製 Apps Script'}
                  </button>
                </div>
                <pre className="code-block" style={{ maxHeight: '340px', overflowY: 'auto' }}>
                  {appsScriptCode}
                </pre>
              </div>
            </>
          )}

          {activeTab === 'private_cloudrun' && (
            <>
              <div className="feature-item">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <ShieldCheck size={18} color="var(--brand-primary)" />
                  <h3 style={{ fontSize: '14.5px', fontWeight: 700 }}>
                    如何部署到 Google Cloud Run 並確保「只有你自己能看到這個網站」？
                  </h3>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  本專案已內建生產環境專用的 <code>Dockerfile</code> 與三層隱私防護機制。你可以選擇以下任一種（或同時啟用）方式鎖定只有你本人可以存取：
                </p>
              </div>

              <div className="feature-item">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                    第一層（最推薦）：設定環境變數 <code>ALLOWED_OWNER_EMAILS</code>（網站內建信箱白名單鎖）
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => copyText('deploy', cloudRunDeployCmd)}
                  >
                    {copiedKey === 'deploy' ? <Check size={13} /> : <Copy size={13} />}
                    {copiedKey === 'deploy' ? '已複製指令' : '複製部署指令'}
                  </button>
                </div>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  部署時帶入你的 Gmail 信箱，任何非你本人的 Google 帳號登入會被前端與後端 API 雙重攔截，且未登入時畫面 100% 空白無任何資料。同時將你的 Google Sheet 共用給 Cloud Run 預設服務帳號（編輯者），即可啟用後端免開網頁自動更新：
                </p>
                <pre className="code-block">{cloudRunDeployCmd}</pre>
              </div>

              <div className="feature-item">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '8px',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '13.5px' }}>
                    第二層：設定 Cloud Scheduler 每 10 分鐘自動喚醒後端刷新試算表
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => copyText('cron', cloudSchedulerCmd)}
                  >
                    {copiedKey === 'cron' ? <Check size={13} /> : <Copy size={13} />}
                    {copiedKey === 'cron' ? '已複製指令' : '複製排程指令'}
                  </button>
                </div>
                <pre className="code-block">{cloudSchedulerCmd}</pre>
              </div>

              <div className="feature-item">
                <div style={{ fontWeight: 600, fontSize: '13.5px', marginBottom: '6px' }}>
                  第三層（最高機密級）：啟用 Google Cloud IAP (Identity-Aware Proxy) 閘道驗證
                </div>
                <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  若連網站首頁都不希望外人看見，可在 Google Cloud Console &gt; <strong>Security &gt; Identity-Aware Proxy (IAP)</strong> 將此 Cloud Run 服務開啟 IAP 保護，並僅將你的 Google 帳號加入 <code>IAP-secured Web App User</code> 角色。如此一來，未授權者在進入網站容器前就會被 Google 官方登入牆直接擋下。
                </p>
              </div>
            </>
          )}

          {activeTab === 'optimizations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div className="feature-item">
                <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: '4px' }}>
                  優化 1：解決「不開網頁就不會更新試算表」與「OAuth Token 1 小時過期斷線」
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  原設計僅依賴前端 <code>setInterval</code>，且忽略了 Google Access Token 實際只有 3600 秒效期。新架構加入後端無頭同步引擎（支援 Cloud Run ADC 服務帳號、Refresh Token 與 Cloud Scheduler）＋ Google Apps Script 試算表內建觸發器，並於前端實作 50 分鐘靜默續約。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: '4px' }}>
                  優化 2：修正台股盤前試撮 (08:30–09:00) 與冷門股無成交時現價變成 0 的重大 Bug
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  TWSE MIS 在開盤前或當盤無成交時 <code>z</code> 欄位會回傳 <code>"-"</code>。新報價引擎會依序推導：當盤成交價 <code>z</code> → 零股成交價 <code>oz</code> → 五檔最佳委買委賣中間價 <code>b/a</code> → 昨收價 <code>y</code>，絕不以 0 覆寫試算表導致市值暴跌。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: '4px' }}>
                  優化 3：修正 3 碼 ETF 代碼前導零修補邏輯（如 878 → 00878、679B → 00679B）
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  原規格提到「將純數字不足 4 碼之代碼正規化補零」，若單純補滿 4 碼會把 <code>878</code> 誤補為 <code>0878</code> 而非 <code>00878</code>！新正規化引擎針對台股編碼規則（一般公司自 1101 起跳）智慧識別 5 碼/6 碼 ETF（如 00878、00919、00929、006208、00679B）。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: '4px' }}>
                  優化 4：新增券商手續費折數設定、最低手續費門檻與預估賣出手續費切換
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  新增買進/賣出時自動依成交額與券商折數（如 6 折、2.8 折）試算手續費；未實現損益支援一鍵切換「原版公式（僅扣預估證交稅）」與「精準淨值公式（扣預估證交稅＋預估賣出手續費）」。
                </div>
              </div>
              <div className="feature-item">
                <div style={{ fontWeight: 600, color: 'var(--brand-primary)', marginBottom: '4px' }}>
                  優化 5：ETF 配息支援「54C 應稅股利比例」，避免收益平準金被誤扣 2.11% 二代健保
                </div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                  台股 ETF（如 00878、00919、0056）配息含高比例收益平準金與資本利得，依法免扣二代健保。新配息表單支援設定 54C 應稅比例與單筆 1,000 萬課稅上限，亦可手動微調健保費與匯費。
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>
            關閉視窗
          </button>
        </div>
      </div>
    </div>
  );
};
