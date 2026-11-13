import { formatTaipeiDateTime, isTaiwanMarketOpen } from '../shared/calculations';
import { StockQuoteResult } from '../shared/types';
import {
  isEtfStock,
  lookupStockMeta,
  normalizeStockCode,
  TW_STOCK_DICTIONARY,
} from '../shared/twStockDictionary';

interface CachedQuote {
  data: StockQuoteResult;
  expiresAt: number;
}

const quoteCache = new Map<string, CachedQuote>();
const CACHE_TTL_MS = 15_000; // 15 秒快取，避免短時間重複請求被證交所阻擋

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * 從 TWSE/TPEx MIS 五檔字串 (例如 "1050.0000_1045.0000_...") 取出第一個有效價格
 */
function parseFirstOrderBookPrice(rawField: unknown): number {
  if (!rawField || typeof rawField !== 'string') return 0;
  const parts = rawField.split('_');
  for (const p of parts) {
    const num = Number(p.trim());
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

/**
 * 解析單筆 TWSE / TPEx MIS msgArray 物件
 * 重要修正：盤前試撮 (08:30-09:00) 或當盤無成交時 z 會是 "-"，
 * 必須自動依序退回 oz (零股價) -> 委買委賣價 -> y (昨收價)，絕不回傳 0 覆蓋有效股價！
 */
function parseMisItem(item: Record<string, any>, fallbackCode: string): StockQuoteResult | null {
  const code = normalizeStockCode(item.c || fallbackCode);
  const meta = lookupStockMeta(code);

  const zPrice = Number(item.z);
  const ozPrice = Number(item.oz);
  const prevClose = Number(item.y) || meta.refPrice || 0;
  const bestBid = parseFirstOrderBookPrice(item.b);
  const bestAsk = parseFirstOrderBookPrice(item.a);

  let price = 0;
  if (Number.isFinite(zPrice) && zPrice > 0) {
    price = zPrice;
  } else if (Number.isFinite(ozPrice) && ozPrice > 0) {
    price = ozPrice;
  } else if (bestBid > 0 && bestAsk > 0) {
    price = Number(((bestBid + bestAsk) / 2).toFixed(2));
  } else if (bestBid > 0) {
    price = bestBid;
  } else if (bestAsk > 0) {
    price = bestAsk;
  } else if (prevClose > 0) {
    price = prevClose;
  }

  if (price <= 0) return null;

  const y = prevClose > 0 ? prevClose : price;
  const change = Number((price - y).toFixed(2));
  const changePercent = y > 0 ? Number(((change / y) * 100).toFixed(2)) : 0;

  const rawName = String(item.n || item.nf || '').trim();
  const name = rawName || meta.name || code;
  const ex = String(item.ex || '').toLowerCase();
  const isEtf = isEtfStock(code, name);
  const category = isEtf ? 'ETF' : ex === 'otc' ? '上櫃' : meta.category || '上市';

  return {
    code,
    name,
    price,
    previousClose: y,
    change,
    changePercent,
    category,
    industry: meta.industry,
    source: ex === 'otc' ? 'TPEX_MIS' : 'TWSE_MIS',
    updatedAt: formatTaipeiDateTime(new Date()),
    marketOpen: isTaiwanMarketOpen(),
  };
}

/**
 * 優先來源 1：批次或單檔查詢 TWSE / TPEx MIS 即時報價 API
 */
async function fetchFromTwseMis(codes: string[]): Promise<Map<string, StockQuoteResult>> {
  const resultMap = new Map<string, StockQuoteResult>();
  if (codes.length === 0) return resultMap;

  // 每檔同時查詢 tse 與 otc 以確保上市/上櫃/ETF 皆能命中
  const channels: string[] = [];
  for (const c of codes) {
    const norm = normalizeStockCode(c);
    channels.push(`tse_${norm}.tw`);
    channels.push(`otc_${norm}.tw`);
  }

  // TWSE MIS 單次建議不超過 50 個 channel
  const chunkSize = 40;
  for (let i = 0; i < channels.length; i += chunkSize) {
    const chunk = channels.slice(i, i + chunkSize);
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(
      chunk.join('|')
    )}&json=1&delay=0&_=${Date.now()}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, {
        headers: {
          ...COMMON_HEADERS,
          Referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) continue;
      const data = (await res.json()) as { msgArray?: Record<string, any>[] };
      if (!data || !Array.isArray(data.msgArray)) continue;

      for (const item of data.msgArray) {
        const parsed = parseMisItem(item, item.c);
        if (parsed && parsed.price > 0) {
          const existing = resultMap.get(parsed.code);
          // 若已有有效成交價則不覆蓋
          if (!existing || (existing.price === existing.previousClose && parsed.price !== parsed.previousClose)) {
            resultMap.set(parsed.code, parsed);
          }
        }
      }
    } catch {
      // 忽略單批錯誤，交由後續 Yahoo Finance 備援
    }
  }

  return resultMap;
}

/**
 * 優先來源 2：並發備援查詢 Yahoo Finance Chart API (.TW 與 .TWO，並驗證幣別為 TWD)
 */
async function fetchFromYahooFinanceApi(code: string): Promise<StockQuoteResult | null> {
  const norm = normalizeStockCode(code);
  const meta = lookupStockMeta(norm);
  const suffixes = meta.category === '上櫃' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];

  const requests = suffixes.map(async (suffix) => {
    const symbol = `${norm}${suffix}`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=5d`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(url, {
        headers: COMMON_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const json = (await res.json()) as any;
      const result = json?.chart?.result?.[0];
      const chartMeta = result?.meta;
      if (!chartMeta) return null;

      // 驗證幣別為 TWD
      if (chartMeta.currency && String(chartMeta.currency).toUpperCase() !== 'TWD') {
        return null;
      }

      const regularPrice = Number(chartMeta.regularMarketPrice);
      const prevClose = Number(
        chartMeta.chartPreviousClose || chartMeta.previousClose || regularPrice
      );
      if (!Number.isFinite(regularPrice) || regularPrice <= 0) return null;

      const change = Number((regularPrice - prevClose).toFixed(2));
      const changePercent =
        prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;

      const isEtf = isEtfStock(norm, meta.name);
      const category = isEtf ? 'ETF' : suffix === '.TWO' ? '上櫃' : '上市';

      return {
        code: norm,
        name: meta.name !== norm ? meta.name : chartMeta.shortName || norm,
        price: regularPrice,
        previousClose: prevClose,
        change,
        changePercent,
        category,
        industry: meta.industry,
        source: 'YAHOO_API' as const,
        updatedAt: formatTaipeiDateTime(new Date()),
        marketOpen: isTaiwanMarketOpen(),
      };
    } catch {
      clearTimeout(timeout);
      return null;
    }
  });

  const results = await Promise.all(requests);
  return results.find((r) => r !== null) || null;
}

/**
 * 優先來源 3：爬取 Yahoo 奇摩股市網頁補齊現價、昨收、繁體中文股名與產業分類
 */
async function fetchFromYahooTwWeb(code: string): Promise<StockQuoteResult | null> {
  const norm = normalizeStockCode(code);
  const meta = lookupStockMeta(norm);
  const urls = [
    `https://tw.stock.yahoo.com/quote/${encodeURIComponent(norm)}.TW`,
    `https://tw.stock.yahoo.com/quote/${encodeURIComponent(norm)}.TWO`,
    `https://tw.stock.yahoo.com/quote/${encodeURIComponent(norm)}`,
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(url, {
        headers: COMMON_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const html = await res.text();

      // 解析標題中文股名，例如 <title>台積電(2330.TW) 即時股價...
      const titleMatch = html.match(/<title>([^<(]+)\(\s*[0-9A-Z]+/i);
      const scrapedName = titleMatch ? titleMatch[1].trim() : '';

      // 解析價格與昨收
      const priceMatch =
        html.match(/"regularMarketPrice"\s*:\s*\{\s*"raw"\s*:\s*([0-9.]+)/) ||
        html.match(/"price"\s*:\s*"([0-9.]+)"/);
      const prevMatch =
        html.match(/"regularMarketPreviousClose"\s*:\s*\{\s*"raw"\s*:\s*([0-9.]+)/) ||
        html.match(/昨收[\s\S]{1,120}?([0-9]+\.[0-9]+|[0-9]+)/);
      const industryMatch = html.match(/產業類別[\s\S]{1,150}?>([^<]{2,15})</);

      const price = priceMatch ? Number(priceMatch[1]) : 0;
      if (!Number.isFinite(price) || price <= 0) continue;

      const prevClose = prevMatch ? Number(prevMatch[1]) : price;
      const change = Number((price - prevClose).toFixed(2));
      const changePercent =
        prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;

      const name = scrapedName || meta.name || norm;
      const industry = industryMatch ? industryMatch[1].trim() : meta.industry;
      const isEtf = isEtfStock(norm, name, undefined, industry);

      return {
        code: norm,
        name,
        price,
        previousClose: prevClose,
        change,
        changePercent,
        category: isEtf ? 'ETF' : url.endsWith('.TWO') ? '上櫃' : '上市',
        industry,
        source: 'YAHOO_WEB',
        updatedAt: formatTaipeiDateTime(new Date()),
        marketOpen: isTaiwanMarketOpen(),
      };
    } catch {
      clearTimeout(timeout);
    }
  }

  return null;
}

/**
 * 查詢單檔股票即時報價（含快取、三層外部 API 備援、最終字典備援）
 */
export async function fetchSingleStockQuote(
  rawCode: string,
  bypassCache = false
): Promise<StockQuoteResult> {
  const code = normalizeStockCode(rawCode);
  if (!bypassCache) {
    const cached = quoteCache.get(code);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  // 1. 優先嘗試 TWSE / TPEx MIS
  const misMap = await fetchFromTwseMis([code]);
  let quote = misMap.get(code) || null;

  // 2. 備援查詢 Yahoo Finance API
  if (!quote) {
    quote = await fetchFromYahooFinanceApi(code);
  }

  // 3. 若仍缺漏或缺少中文股名，爬取 Yahoo 奇摩股市網頁
  if (!quote || quote.name === quote.code) {
    const webQuote = await fetchFromYahooTwWeb(code);
    if (webQuote) {
      quote = quote
        ? {
            ...quote,
            name: webQuote.name || quote.name,
            industry: webQuote.industry || quote.industry,
          }
        : webQuote;
    }
  }

  // 4. 若外部網路受限或休市查無報價，回傳內建字典安全參考價
  if (!quote) {
    const meta = lookupStockMeta(code);
    const dictEntry = TW_STOCK_DICTIONARY[code];
    const refPrice = dictEntry?.refPrice || 100;
    quote = {
      code,
      name: meta.name,
      price: refPrice,
      previousClose: refPrice,
      change: 0,
      changePercent: 0,
      category: meta.category,
      industry: meta.industry,
      source: 'FALLBACK_DICT',
      updatedAt: formatTaipeiDateTime(new Date()),
      marketOpen: isTaiwanMarketOpen(),
    };
  }

  quoteCache.set(code, {
    data: quote,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return quote;
}

/**
 * 批次查詢多檔台股即時報價
 */
export async function fetchBatchStockQuotes(
  rawCodes: string[],
  bypassCache = false
): Promise<Record<string, StockQuoteResult>> {
  const uniqueCodes = Array.from(
    new Set(rawCodes.map((c) => normalizeStockCode(c)).filter(Boolean))
  );
  const results: Record<string, StockQuoteResult> = {};
  const missingCodes: string[] = [];

  for (const code of uniqueCodes) {
    if (!bypassCache) {
      const cached = quoteCache.get(code);
      if (cached && cached.expiresAt > Date.now()) {
        results[code] = cached.data;
        continue;
      }
    }
    missingCodes.push(code);
  }

  if (missingCodes.length === 0) return results;

  // 第一階段：批次呼叫 TWSE / TPEx MIS
  const misResults = await fetchFromTwseMis(missingCodes);
  const stillMissing: string[] = [];

  for (const code of missingCodes) {
    const hit = misResults.get(code);
    if (hit && hit.price > 0) {
      results[code] = hit;
      quoteCache.set(code, { data: hit, expiresAt: Date.now() + CACHE_TTL_MS });
    } else {
      stillMissing.push(code);
    }
  }

  // 第二階段：針對 MIS 未命中的股票並發查詢 Yahoo Finance / Web / Fallback
  if (stillMissing.length > 0) {
    await Promise.all(
      stillMissing.map(async (code) => {
        const single = await fetchSingleStockQuote(code, true);
        results[code] = single;
      })
    );
  }

  return results;
}
