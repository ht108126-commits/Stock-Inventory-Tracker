import { StockCategory } from './types';

export interface StockMetaInfo {
  code: string;
  name: string;
  category: StockCategory;
  industry: string;
  refPrice?: number;
}

export const TW_STOCK_DICTIONARY: Record<string, StockMetaInfo> = {
  // 熱門台股 ETF (市值型 / 高股息 / 債券 / 主題 / 槓桿)
  '0050': { code: '0050', name: '元大台灣50', category: 'ETF', industry: 'ETF-市值型', refPrice: 192.5 },
  '0051': { code: '0051', name: '元大中型100', category: 'ETF', industry: 'ETF-市值型', refPrice: 82.4 },
  '0052': { code: '0052', name: '富邦科技', category: 'ETF', industry: 'ETF-科技型', refPrice: 195.0 },
  '0056': { code: '0056', name: '元大高股息', category: 'ETF', industry: 'ETF-高股息', refPrice: 37.8 },
  '006208': { code: '006208', name: '富邦台50', category: 'ETF', industry: 'ETF-市值型', refPrice: 114.5 },
  '00631L': { code: '00631L', name: '元大台灣50正2', category: 'ETF', industry: 'ETF-槓桿型', refPrice: 245.0 },
  '00632R': { code: '00632R', name: '元大台灣50反1', category: 'ETF', industry: 'ETF-反向型', refPrice: 3.45 },
  '00679B': { code: '00679B', name: '元大美債20年', category: 'ETF', industry: 'ETF-債券型', refPrice: 29.5 },
  '00687B': { code: '00687B', name: '國泰20年美債', category: 'ETF', industry: 'ETF-債券型', refPrice: 30.6 },
  '00692': { code: '00692', name: '富邦公司治理', category: 'ETF', industry: 'ETF-市值型', refPrice: 44.2 },
  '00713': { code: '00713', name: '元大台灣高息低波', category: 'ETF', industry: 'ETF-高股息', refPrice: 54.8 },
  '00720B': { code: '00720B', name: '元大投資級公司債', category: 'ETF', industry: 'ETF-債券型', refPrice: 34.9 },
  '00751B': { code: '00751B', name: '元大AAA至A公司債', category: 'ETF', industry: 'ETF-債券型', refPrice: 34.2 },
  '00757': { code: '00757', name: '統一FANG+', category: 'ETF', industry: 'ETF-海外科技', refPrice: 98.5 },
  '00830': { code: '00830', name: '國泰費城半導體', category: 'ETF', industry: 'ETF-海外科技', refPrice: 46.8 },
  '00850': { code: '00850', name: '元大臺灣ESG永續', category: 'ETF', industry: 'ETF-市值型', refPrice: 45.6 },
  '00878': { code: '00878', name: '國泰永續高股息', category: 'ETF', industry: 'ETF-高股息', refPrice: 22.8 },
  '00881': { code: '00881', name: '國泰台灣5G+', category: 'ETF', industry: 'ETF-科技型', refPrice: 24.5 },
  '00891': { code: '00891', name: '中信關鍵半導體', category: 'ETF', industry: 'ETF-科技型', refPrice: 18.9 },
  '00900': { code: '00900', name: '富邦特選高股息30', category: 'ETF', industry: 'ETF-高股息', refPrice: 15.2 },
  '00915': { code: '00915', name: '凱基優選高股息30', category: 'ETF', industry: 'ETF-高股息', refPrice: 25.4 },
  '00918': { code: '00918', name: '大華優利高填息30', category: 'ETF', industry: 'ETF-高股息', refPrice: 23.8 },
  '00919': { code: '00919', name: '群益台灣精選高息', category: 'ETF', industry: 'ETF-高股息', refPrice: 23.6 },
  '00922': { code: '00922', name: '國泰台灣領袖50', category: 'ETF', industry: 'ETF-市值型', refPrice: 21.8 },
  '00923': { code: '00923', name: '群益台ESG低碳50', category: 'ETF', industry: 'ETF-市值型', refPrice: 21.5 },
  '00929': { code: '00929', name: '復華台灣科技優息', category: 'ETF', industry: 'ETF-高股息', refPrice: 18.6 },
  '00934': { code: '00934', name: '中信成長高股息', category: 'ETF', industry: 'ETF-高股息', refPrice: 18.9 },
  '00935': { code: '00935', name: '野村臺灣新科技50', category: 'ETF', industry: 'ETF-科技型', refPrice: 22.4 },
  '00936': { code: '00936', name: '台新永續高息中小', category: 'ETF', industry: 'ETF-高股息', refPrice: 16.5 },
  '00937B': { code: '00937B', name: '群益ESG投等債20+', category: 'ETF', industry: 'ETF-債券型', refPrice: 15.8 },
  '00939': { code: '00939', name: '統一台灣高息動能', category: 'ETF', industry: 'ETF-高股息', refPrice: 14.3 },
  '00940': { code: '00940', name: '元大台灣價值高息', category: 'ETF', industry: 'ETF-高股息', refPrice: 9.65 },

  // 權值股與半導體
  '2330': { code: '2330', name: '台積電', category: '上市', industry: '半導體業', refPrice: 1050 },
  '2303': { code: '2303', name: '聯電', category: '上市', industry: '半導體業', refPrice: 48.5 },
  '2454': { code: '2454', name: '聯發科', category: '上市', industry: '半導體業', refPrice: 1320 },
  '3711': { code: '3711', name: '日月光投控', category: '上市', industry: '半導體業', refPrice: 162.5 },
  '3034': { code: '3034', name: '聯詠', category: '上市', industry: '半導體業', refPrice: 525 },
  '2379': { code: '2379', name: '瑞昱', category: '上市', industry: '半導體業', refPrice: 540 },
  '3443': { code: '3443', name: '創意', category: '上市', industry: '半導體業', refPrice: 1210 },
  '3661': { code: '3661', name: '世芯-KY', category: '上市', industry: '半導體業', refPrice: 2680 },
  '6488': { code: '6488', name: '環球晶', category: '上櫃', industry: '半導體業', refPrice: 430 },
  '5347': { code: '5347', name: '世界', category: '上櫃', industry: '半導體業', refPrice: 98.5 },
  '3105': { code: '3105', name: '穩懋', category: '上櫃', industry: '半導體業', refPrice: 118 },
  '8299': { code: '8299', name: '群聯', category: '上櫃', industry: '半導體業', refPrice: 515 },

  // AI 伺服器 / 電子代工 / 電腦週邊 / 電子零組件
  '2317': { code: '2317', name: '鴻海', category: '上市', industry: '其他電子業', refPrice: 208 },
  '2382': { code: '2382', name: '廣達', category: '上市', industry: '電腦及週邊設備業', refPrice: 295 },
  '3231': { code: '3231', name: '緯創', category: '上市', industry: '電腦及週邊設備業', refPrice: 115 },
  '6669': { code: '6669', name: '緯穎', category: '上市', industry: '電腦及週邊設備業', refPrice: 2150 },
  '2357': { code: '2357', name: '華碩', category: '上市', industry: '電腦及週邊設備業', refPrice: 605 },
  '2356': { code: '2356', name: '英業達', category: '上市', industry: '電腦及週邊設備業', refPrice: 50.2 },
  '2324': { code: '2324', name: '仁寶', category: '上市', industry: '電腦及週邊設備業', refPrice: 36.8 },
  '2301': { code: '2301', name: '光寶科', category: '上市', industry: '電腦及週邊設備業', refPrice: 105 },
  '2308': { code: '2308', name: '台達電', category: '上市', industry: '電子零組件業', refPrice: 395 },
  '2327': { code: '2327', name: '國巨', category: '上市', industry: '電子零組件業', refPrice: 560 },
  '3037': { code: '3037', name: '欣興', category: '上市', industry: '電子零組件業', refPrice: 158 },
  '2383': { code: '2383', name: '台光電', category: '上市', industry: '電子零組件業', refPrice: 485 },
  '3017': { code: '3017', name: '奇鋐', category: '上市', industry: '電腦及週邊設備業', refPrice: 625 },
  '3324': { code: '3324', name: '雙鴻', category: '上櫃', industry: '電子零組件業', refPrice: 670 },
  '2345': { code: '2345', name: '智邦', category: '上市', industry: '通信網路業', refPrice: 580 },
  '3008': { code: '3008', name: '大立光', category: '上市', industry: '光電業', refPrice: 2520 },
  '2409': { code: '2409', name: '友達', category: '上市', industry: '光電業', refPrice: 16.2 },
  '3481': { code: '3481', name: '群創', category: '上市', industry: '光電業', refPrice: 15.5 },

  // 金融控股與銀行保險
  '2881': { code: '2881', name: '富邦金', category: '上市', industry: '金融保險業', refPrice: 91.5 },
  '2882': { code: '2882', name: '國泰金', category: '上市', industry: '金融保險業', refPrice: 68.2 },
  '2891': { code: '2891', name: '中信金', category: '上市', industry: '金融保險業', refPrice: 37.5 },
  '2886': { code: '2886', name: '兆豐金', category: '上市', industry: '金融保險業', refPrice: 39.2 },
  '2884': { code: '2884', name: '玉山金', category: '上市', industry: '金融保險業', refPrice: 28.1 },
  '2892': { code: '2892', name: '第一金', category: '上市', industry: '金融保險業', refPrice: 27.6 },
  '2880': { code: '2880', name: '華南金', category: '上市', industry: '金融保險業', refPrice: 26.4 },
  '2885': { code: '2885', name: '元大金', category: '上市', industry: '金融保險業', refPrice: 33.8 },
  '2890': { code: '2890', name: '永豐金', category: '上市', industry: '金融保險業', refPrice: 23.4 },
  '2883': { code: '2883', name: '凱基金', category: '上市', industry: '金融保險業', refPrice: 17.5 },
  '2887': { code: '2887', name: '台新金', category: '上市', industry: '金融保險業', refPrice: 17.8 },
  '5880': { code: '5880', name: '合庫金', category: '上市', industry: '金融保險業', refPrice: 25.1 },
  '2834': { code: '2834', name: '臺企銀', category: '上市', industry: '金融保險業', refPrice: 15.6 },

  // 傳產 / 航運 / 電信 / 重電 / 鋼鐵 / 塑化
  '2603': { code: '2603', name: '長榮', category: '上市', industry: '航運業', refPrice: 225 },
  '2609': { code: '2609', name: '陽明', category: '上市', industry: '航運業', refPrice: 74.5 },
  '2615': { code: '2615', name: '萬海', category: '上市', industry: '航運業', refPrice: 88.0 },
  '2618': { code: '2618', name: '長榮航', category: '上市', industry: '航運業', refPrice: 41.5 },
  '2610': { code: '2610', name: '華航', category: '上市', industry: '航運業', refPrice: 24.8 },
  '2412': { code: '2412', name: '中華電', category: '上市', industry: '通信網路業', refPrice: 124.5 },
  '3045': { code: '3045', name: '台灣大', category: '上市', industry: '通信網路業', refPrice: 112.0 },
  '4904': { code: '4904', name: '遠傳', category: '上市', industry: '通信網路業', refPrice: 89.5 },
  '1519': { code: '1519', name: '華城', category: '上市', industry: '電機機械', refPrice: 615 },
  '1513': { code: '1513', name: '中興電', category: '上市', industry: '電機機械', refPrice: 158 },
  '1503': { code: '1503', name: '士電', category: '上市', industry: '電機機械', refPrice: 210 },
  '1504': { code: '1504', name: '東元', category: '上市', industry: '電機機械', refPrice: 51.5 },
  '1101': { code: '1101', name: '台泥', category: '上市', industry: '水泥工業', refPrice: 32.5 },
  '1102': { code: '1102', name: '亞泥', category: '上市', industry: '水泥工業', refPrice: 43.2 },
  '1216': { code: '1216', name: '統一', category: '上市', industry: '食品工業', refPrice: 86.5 },
  '1301': { code: '1301', name: '台塑', category: '上市', industry: '塑膠工業', refPrice: 44.5 },
  '1303': { code: '1303', name: '南亞', category: '上市', industry: '塑膠工業', refPrice: 41.2 },
  '1326': { code: '1326', name: '台化', category: '上市', industry: '塑膠工業', refPrice: 38.0 },
  '6505': { code: '6505', name: '台塑化', category: '上市', industry: '油電燃氣業', refPrice: 46.8 },
  '2002': { code: '2002', name: '中鋼', category: '上市', industry: '鋼鐵工業', refPrice: 21.8 },
  '2912': { code: '2912', name: '統一超', category: '上市', industry: '貿易百貨業', refPrice: 276 },
  '5871': { code: '5871', name: '中租-KY', category: '上市', industry: '其他業', refPrice: 145 },
  '9910': { code: '9910', name: '豐泰', category: '上市', industry: '其他業', refPrice: 142 },
};

// 常見 6 碼 ETF 被 Google Sheets 吃掉前導 00 後的對應表
const KNOWN_SIX_CHAR_ETF_MAP: Record<string, string> = {
  '6208': '006208',
  '6203': '006203',
  '6204': '006204',
  '6205': '006205',
  '6206': '006206',
  '6207': '006207',
  '6201': '006201',
};

/**
 * 正規化台股代碼：
 * 1. 移除前後綴 (TSE:, OTC:, TWSE:, TPEX:, .TW, .TWO, Excel ="..." 包裹)
 * 2. 修補被 Google Sheets 自動吃掉的前導零：
 *    - 例如 "50" -> "0050", "56" -> "0056"
 *    - 例如 "878" -> "00878", "919" -> "00919", "679B" -> "00679B", "6208" -> "006208"
 */
export function normalizeStockCode(rawInput: string | number | null | undefined): string {
  if (rawInput === null || rawInput === undefined) return '';
  let code = String(rawInput).trim().toUpperCase();
  if (!code) return '';

  // 移除 Excel 公式格式如 ="0050" 或 '0050
  code = code.replace(/^=?"?/, '').replace(/"?$/, '').replace(/^'+/, '');

  // 移除常見交易所前綴與後綴
  code = code
    .replace(/^(TSE|TWSE|OTC|TPEX|TW|TWO)\s*[:_-]\s*/i, '')
    .replace(/\.(TW|TWO|TWSE|TPEX)$/i, '')
    .trim();

  if (!code) return '';

  // 檢查是否為已知 6 碼 ETF 被吃掉 00 (例如 6208 -> 006208)
  if (KNOWN_SIX_CHAR_ETF_MAP[code]) {
    return KNOWN_SIX_CHAR_ETF_MAP[code];
  }

  // 若加上 '00' 後直接命中字典 (例如 878 -> 00878, 679B -> 00679B, 631L -> 00631L)
  if (!code.startsWith('0') && TW_STOCK_DICTIONARY[`00${code}`] && !TW_STOCK_DICTIONARY[code]) {
    return `00${code}`;
  }

  // 針對 3 碼數字或 3 碼數字+字母 (如 878, 919, 940, 713, 687B, 937B)
  // 台股一般上市櫃公司代碼皆從 1101 起跳，3 碼開頭為 6/7/8/9 之代碼皆為 00xxx 之 ETF
  if (/^[6789]\d{2}[A-Z]?$/.test(code)) {
    return `00${code}`;
  }

  // 針對純數字且長度不足 4 碼 (如 50 -> 0050, 56 -> 0056)
  if (/^\d{1,3}$/.test(code)) {
    return code.padStart(4, '0');
  }

  // 針對 1~2 碼數字加英文字母 (如 50 -> 0050)
  if (/^\d{1,2}[A-Z]$/.test(code)) {
    return code.padStart(4, '0');
  }

  return code;
}

/**
 * 判斷是否為台股 ETF（證交稅 0.1%）
 * 規則：代碼以 00 開頭，或名稱/類別/產業含 ETF
 */
export function isEtfStock(
  code: string,
  name?: string,
  category?: string,
  industry?: string
): boolean {
  const norm = normalizeStockCode(code);
  if (norm.startsWith('00')) return true;
  const combined = `${name || ''} ${category || ''} ${industry || ''}`.toUpperCase();
  if (combined.includes('ETF') || combined.includes('指數股票型') || combined.includes('受益憑證')) {
    return true;
  }
  const meta = TW_STOCK_DICTIONARY[norm];
  if (meta && meta.category === 'ETF') return true;
  return false;
}

/**
 * 查詢股票基本資訊（名稱、市場類別、產業分類）
 */
export function lookupStockMeta(code: string): StockMetaInfo {
  const norm = normalizeStockCode(code);
  if (TW_STOCK_DICTIONARY[norm]) {
    return TW_STOCK_DICTIONARY[norm];
  }
  if (norm.startsWith('00')) {
    return {
      code: norm,
      name: norm,
      category: 'ETF',
      industry: 'ETF',
    };
  }
  return {
    code: norm,
    name: norm,
    category: '上市',
    industry: '其他電子/一般產業',
  };
}
