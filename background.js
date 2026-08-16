// Background Service Worker for KitePlus Clone
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('preview.html')
    });
  }
});

const YAHOO_SYMBOLS = {
  NIFTY: '%5ENSEI',
  SENSEX: '%5EBSESN',
  BANKNIFTY: '%5ENSEBANK',
  FINNIFTY: 'NIFTY_FIN_SERVICE.NS'
};

const DHAN_KNOWN_IDS = {
  RELIANCE: '2885',
  HDFCBANK: '1333',
  TCS: '11536',
  INFY: '1594',
  ICICIBANK: '4963',
  SBIN: '3045',
  ITC: '1660',
  BHARTIARTL: '10604',
  AXISBANK: '5900',
  KOTAKBANK: '1922',
  LT: '11483',
  SBI: '3045'
};

function mapYahooInterval(tfId) {
  if (tfId === '1m' || tfId === '2m' || tfId === '3m') return '1m';
  if (tfId === '5m') return '5m';
  if (tfId === '15m' || tfId === '45m') return '15m';
  if (tfId === '4h') return '60m';
  if (tfId === '1D' || tfId === '1W' || tfId === '1M') return '1d';
  return '5m';
}

function mapYahooRange(interval) {
  if (interval === '1m') return '5d';
  if (interval === '5m') return '1mo';
  if (interval === '15m') return '60d';
  if (interval === '60m') return '2y';
  if (interval === '1d') return '5y';
  return '5d';
}

const historyCache = new Map();
let instrumentMaps = { NSE_EQ: null, BSE_EQ: null };
let instrumentMapsFetchedAt = { NSE_EQ: 0, BSE_EQ: 0 };

const INDIAN_EQUITY_MAP = {
  'MARUTI SUZUKI': 'MARUTI',
  'MARUTI': 'MARUTI',
  'RELIANCE INDUSTRIES': 'RELIANCE',
  'RELIANCE': 'RELIANCE',
  'TATA MOTORS': 'TATAMOTORS',
  'TATAMOTORS': 'TATAMOTORS',
  'TATA CONSULTANCY': 'TCS',
  'TCS': 'TCS',
  'TATA STEEL': 'TATASTEEL',
  'TATA POWER': 'TATAPOWER',
  'TATA CONSUMER': 'TATACONSUM',
  'STATE BANK OF INDIA': 'SBIN',
  'SBIN': 'SBIN',
  'INFOSYS': 'INFY',
  'INFY': 'INFY',
  'HDFC BANK': 'HDFCBANK',
  'HDFCBANK': 'HDFCBANK',
  'ICICI BANK': 'ICICIBANK',
  'ICICIBANK': 'ICICIBANK',
  'AXIS BANK': 'AXISBANK',
  'AXISBANK': 'AXISBANK',
  'KOTAK MAHINDRA': 'KOTAKBANK',
  'KOTAKBANK': 'KOTAKBANK',
  'BHARTI AIRTEL': 'BHARTIARTL',
  'BHARTIARTL': 'BHARTIARTL',
  'LARSEN & TOUBRO': 'LT',
  'LARSEN AND TOUBRO': 'LT',
  'LT': 'LT',
  'ITC': 'ITC',
  'SUN PHARMACEUTICAL': 'SUNPHARMA',
  'SUNPHARMA': 'SUNPHARMA',
  'BAJAJ FINANCE': 'BAJFINANCE',
  'BAJFINANCE': 'BAJFINANCE',
  'BAJAJ FINSERV': 'BAJAJFINSV',
  'BAJAJFINSV': 'BAJAJFINSV',
  'BAJAJ AUTO': 'BAJAJ-AUTO',
  'ASIAN PAINTS': 'ASIANPAINT',
  'ASIANPAINT': 'ASIANPAINT',
  'MAHINDRA & MAHINDRA': 'M&M',
  'MAHINDRA AND MAHINDRA': 'M&M',
  'M&M': 'M&M',
  'HINDUSTAN UNILEVER': 'HINDUNILVR',
  'HINDUNILVR': 'HINDUNILVR',
  'COAL INDIA': 'COALINDIA',
  'COALINDIA': 'COALINDIA',
  'ADANI ENTERPRISES': 'ADANIENT',
  'ADANIENT': 'ADANIENT',
  'ADANI PORTS': 'ADANIPORTS',
  'ADANIPORTS': 'ADANIPORTS',
  'ADANI POWER': 'ADANIPOWER',
  'ADANI GREEN': 'ADANIGREEN',
  'ULTRATECH CEMENT': 'ULTRACEMCO',
  'ULTRACEMCO': 'ULTRACEMCO',
  'NESTLE INDIA': 'NESTLEIND',
  'NESTLEIND': 'NESTLEIND',
  'JSW STEEL': 'JSWSTEEL',
  'JSWSTEEL': 'JSWSTEEL',
  'TECH MAHINDRA': 'TECHM',
  'TECHM': 'TECHM',
  'HCL TECHNOLOGIES': 'HCLTECH',
  'HCLTECH': 'HCLTECH',
  'INDUSIND BANK': 'INDUSINDBK',
  'INDUSINDBK': 'INDUSINDBK',
  'HINDALCO': 'HINDALCO',
  'EICHER MOTORS': 'EICHERMOT',
  'EICHERMOT': 'EICHERMOT',
  'DR. REDDY': 'DRREDDY',
  'DR REDDY': 'DRREDDY',
  'DRREDDY': 'DRREDDY',
  'APOLLO HOSPITALS': 'APOLLOHOSP',
  'APOLLOHOSP': 'APOLLOHOSP',
  'DIVIS LAB': 'DIVISLAB',
  'DIVISLAB': 'DIVISLAB',
  'HERO MOTOCORP': 'HEROMOTOCO',
  'HEROMOTOCO': 'HEROMOTOCO',
  'BHARAT PETROLEUM': 'BPCL',
  'BPCL': 'BPCL',
  'HINDUSTAN PETROLEUM': 'HINDPETRO',
  'BRITANNIA INDUSTRIES': 'BRITANNIA',
  'BRITANNIA': 'BRITANNIA',
  'SBI LIFE': 'SBILIFE',
  'SBILIFE': 'SBILIFE',
  'HDFC LIFE': 'HDFCLIFE',
  'HDFCLIFE': 'HDFCLIFE',
  'SHRIRAM FINANCE': 'SHRIRAMFIN',
  'SHRIRAMFIN': 'SHRIRAMFIN',
  'JIO FINANCIAL': 'JIOFIN',
  'JIOFIN': 'JIOFIN',
  'BHARAT ELECTRONICS': 'BEL',
  'BEL': 'BEL',
  'HINDUSTAN AERONAUTICS': 'HAL',
  'HAL': 'HAL',
  'PUNJAB NATIONAL BANK': 'PNB',
  'PNB': 'PNB',
  'BANK OF BARODA': 'BANKBARODA',
  'BANKBARODA': 'BANKBARODA',
  'CANARA BANK': 'CANBK',
  'UNION BANK': 'UNIONBANK',
  'INDIAN RAILWAY CATERING': 'IRCTC',
  'IRCTC': 'IRCTC',
  'POWER FINANCE': 'PFC',
  'PFC': 'PFC',
  'INDIAN OIL': 'IOC',
  'IOC': 'IOC',
  'GODREJ PROPERTIES': 'GODREJPROP',
  'VARUN BEVERAGES': 'VBL',
  'VBL': 'VBL',
  'TVS MOTOR': 'TVSMOTOR',
  'MUTHOOT FINANCE': 'MUTHOOTFIN',
  'PERSISTENT SYSTEMS': 'PERSISTENT',
  'ZOMATO': 'ZOMATO',
  'VEDANTA': 'VEDL',
  'VEDL': 'VEDL',
  'TRENT': 'TRENT',
  'LTIMINDTREE': 'LTIM',
  'LTIM': 'LTIM',
  'WIPRO': 'WIPRO',
  'NTPC': 'NTPC',
  'ONGC': 'ONGC',
  'POWER GRID': 'POWERGRID',
  'POWERGRID': 'POWERGRID'
};

function cleanEquitySymbol(symbol) {
  let s = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\b(NSE_EQ|BSE_EQ|NSE|BSE)\s*[:|/-]\s*/g, '')
    .replace(/\.(NS|BO)$/g, '')
    .replace(/\b(LTD|LIMITED|CORP|CORPORATION|INC|HOLDINGS|CO)\b\.?/gi, '')
    .replace(/\s+(EQ|BE|BZ)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Match known company names
  for (const [k, v] of Object.entries(INDIAN_EQUITY_MAP)) {
    if (s === k || s.startsWith(k) || s.includes(k)) return v;
  }

  return s.replace(/\s+/g, '');
}

function normalizeYahooSymbol(symbol, exchange) {
  const clean = cleanEquitySymbol(symbol);
  if (YAHOO_SYMBOLS[clean]) return YAHOO_SYMBOLS[clean];
  if (/\.(NS|BO)$/.test(clean)) return encodeURIComponent(clean);
  return encodeURIComponent(`${clean}.${exchange === 'BSE' ? 'BO' : 'NS'}`);
}

function aggregateCandles(candles, tfId) {
  const minuteMap = { '2m': 2, '3m': 3, '5m': 5, '15m': 15, '45m': 45, '4h': 240 };
  if (!minuteMap[tfId] && tfId !== '1W' && tfId !== '1M') return candles;
  const buckets = new Map();

  for (const candle of candles) {
    const d = new Date(candle.startTime);
    let key;
    if (tfId === '1W') {
      const day = (d.getUTCDay() + 6) % 7;
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
      key = monday.getTime();
    } else if (tfId === '1M') {
      key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    } else {
      const minutes = Math.floor(candle.startTime / 60000);
      const sessionOffset = 3 * 60 + 45;
      const size = minuteMap[tfId];
      key = Math.floor((minutes - sessionOffset) / size) * size + sessionOffset;
      key *= 60000;
    }

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        startTime: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 1,
        complete: true
      });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume || 1;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.startTime - b.startTime);
}

function yahooChartToCandles(json) {
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const volumes = q.volume || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const open = opens[i];
    const high = highs[i];
    const low = lows[i];
    const close = closes[i];
    if ([open, high, low, close].some(v => v == null || isNaN(v) || v <= 0)) continue;
    candles.push({
      startTime: ts[i] * 1000,
      open,
      high,
      low,
      close,
      volume: Math.max(1, volumes[i] || 1),
      complete: true
    });
  }
  return candles;
}

async function fetchYahooCandles(underlying, tfId) {
  const symbol = YAHOO_SYMBOLS[underlying] || YAHOO_SYMBOLS.NIFTY;
  const interval = mapYahooInterval(tfId);
  const range = mapYahooRange(interval);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`Yahoo HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json?.chart?.error) {
    throw new Error(json.chart.error.description || 'Yahoo chart error');
  }
  const candles = yahooChartToCandles(json);
  if (!candles.length) throw new Error('No candles returned');
  return { candles, interval, range, symbol: underlying, source: 'Yahoo' };
}

async function fetchYahooStockCandles(symbol, exchange, tfId) {
  const yahooSymbol = normalizeYahooSymbol(symbol, exchange);
  const interval = mapYahooInterval(tfId);
  const range = mapYahooRange(interval);
  const cacheKey = `yahoo:${yahooSymbol}:${tfId}`;
  const cached = historyCache.get(cacheKey);
  const ttl = ['1D', '1W', '1M'].includes(tfId) ? 30 * 60 * 1000 : 2 * 60 * 1000;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return { ...cached.data, cached: true };
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}` +
    `?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplits`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  if (json?.chart?.error) {
    throw new Error(json.chart.error.description || 'Yahoo chart error');
  }

  let candles = yahooChartToCandles(json);
  candles = aggregateCandles(candles, tfId);
  if (!candles.length) throw new Error(`No history for ${symbol}`);
  const data = {
    candles,
    interval,
    requestedTimeframe: tfId,
    aggregated: interval.toLowerCase() !== String(tfId).toLowerCase() &&
      tfId !== '1W' && tfId !== '1M' && tfId !== '1D',
    range,
    symbol,
    exchange,
    yahooSymbol: decodeURIComponent(yahooSymbol),
    source: 'Yahoo',
    fetchedAt: Date.now(),
    firstTime: candles[0].startTime,
    lastTime: candles[candles.length - 1].startTime
  };
  historyCache.set(cacheKey, { fetchedAt: Date.now(), data });
  if (historyCache.size > 16) {
    historyCache.delete(historyCache.keys().next().value);
  }
  return { ...data, cached: false };
}

/* ===================== DhanHQ ===================== */

async function getDhanCreds() {
  const res = await chrome.storage.local.get(['dhanClientId', 'dhanAccessToken']);
  const clientId = String(res.dhanClientId || '').trim();
  const accessToken = String(res.dhanAccessToken || '').trim();
  if (!clientId || !accessToken) return null;
  return { clientId, accessToken };
}

function dhanHeaders(creds, withClientId) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'access-token': creds.accessToken
  };
  if (withClientId) headers['client-id'] = creds.clientId;
  return headers;
}

function formatISTDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function formatISTDateTime(date) {
  const d = formatISTDate(date);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${d} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function shiftDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseInstrumentCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return {};
  const headers = parseCsvLine(lines[0]).map(h => h.toUpperCase());
  const idIdx = headers.findIndex(h =>
    h.includes('SECURITY_ID') || h === 'SEM_SMST_SECURITY_ID' || h === 'SECURITYID'
  );
  const symIdx = headers.findIndex(h =>
    h === 'SEM_TRADING_SYMBOL' || h === 'TRADING_SYMBOL' || h === 'SYMBOL' || h === 'SEM_CUSTOM_SYMBOL'
  );
  const instIdx = headers.findIndex(h =>
    h === 'SEM_INSTRUMENT_NAME' || h === 'INSTRUMENT' || h === 'INSTRUMENT_TYPE'
  );
  if (idIdx < 0 || symIdx < 0) return {};

  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const symbol = cleanEquitySymbol(cols[symIdx]);
    const securityId = String(cols[idIdx] || '').trim();
    if (!symbol || !securityId) continue;
    const instrument = instIdx >= 0 ? String(cols[instIdx] || '').toUpperCase() : 'EQUITY';
    if (instrument && instrument !== 'EQUITY' && !instrument.includes('EQ')) continue;
    if (!map[symbol]) map[symbol] = securityId;
  }
  return map;
}

async function loadInstrumentMap(segment, creds) {
  const ttl = 24 * 60 * 60 * 1000;
  if (instrumentMaps[segment] && Date.now() - instrumentMapsFetchedAt[segment] < ttl) {
    return instrumentMaps[segment];
  }

  async function tryFetch(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  let text = '';
  try {
    text = await tryFetch(`https://api.dhan.co/v2/instrument/${segment}`, {
      Accept: 'text/csv, application/json, */*',
      'access-token': creds.accessToken,
      'client-id': creds.clientId
    });
  } catch (_) {
    // Public compact master (fallback)
    text = await tryFetch('https://images.dhan.co/api-data/api-scrip-master.csv', {
      Accept: 'text/csv, */*'
    });
  }

  const map = parseInstrumentCsv(text);
  if (!Object.keys(map).length) {
    try {
      const json = JSON.parse(text);
      const rows = Array.isArray(json) ? json : (json?.data || []);
      for (const row of rows) {
        const symbol = cleanEquitySymbol(
          row.SEM_TRADING_SYMBOL || row.tradingSymbol || row.symbol || row.SYMBOL
        );
        const securityId = String(
          row.SEM_SMST_SECURITY_ID || row.securityId || row.SECURITY_ID || ''
        ).trim();
        const instrument = String(
          row.SEM_INSTRUMENT_NAME || row.instrument || row.INSTRUMENT || 'EQUITY'
        ).toUpperCase();
        if (!symbol || !securityId) continue;
        if (instrument && instrument !== 'EQUITY' && !instrument.includes('EQ')) continue;
        // Prefer NSE_EQ when using compact master: filter by exchange column if present
        const exch = String(row.SEM_EXM_EXCH_ID || row.EXCH_ID || row.exchange || '').toUpperCase();
        const want = segment.startsWith('BSE') ? 'BSE' : 'NSE';
        if (exch && exch !== want) continue;
        map[symbol] = securityId;
      }
    } catch (_) {}
  }
  instrumentMaps[segment] = map;
  instrumentMapsFetchedAt[segment] = Date.now();
  return map;
}

async function resolveSecurityId(symbol, exchange, creds) {
  const clean = cleanEquitySymbol(symbol);
  if (!clean) throw new Error('Empty symbol');
  const segment = exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
  let map = {};
  try {
    map = await loadInstrumentMap(segment, creds);
  } catch (_) {
    map = {};
  }
  const securityId = map[clean] || DHAN_KNOWN_IDS[clean];
  if (!securityId) {
    throw new Error(`No Dhan securityId for ${clean} (${segment})`);
  }
  return {
    securityId: String(securityId),
    exchangeSegment: segment,
    instrument: 'EQUITY',
    symbol: clean
  };
}

function dhanArraysToCandles(payload) {
  const opens = payload?.open || [];
  const highs = payload?.high || [];
  const lows = payload?.low || [];
  const closes = payload?.close || [];
  const volumes = payload?.volume || [];
  const timestamps = payload?.timestamp || [];
  const candles = [];
  const n = Math.min(opens.length, highs.length, lows.length, closes.length, timestamps.length);
  for (let i = 0; i < n; i++) {
    const open = Number(opens[i]);
    const high = Number(highs[i]);
    const low = Number(lows[i]);
    const close = Number(closes[i]);
    let ts = Number(timestamps[i]);
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) ||
        !Number.isFinite(close) || open <= 0 || close <= 0 || !Number.isFinite(ts)) {
      continue;
    }
    if (ts < 1e12) ts *= 1000;
    candles.push({
      startTime: ts,
      open,
      high,
      low,
      close,
      volume: Math.max(1, Number(volumes[i]) || 1),
      complete: true
    });
  }
  return candles.sort((a, b) => a.startTime - b.startTime);
}

function mapDhanIntradayInterval(tfId) {
  if (tfId === '1m' || tfId === '2m' || tfId === '3m') return { interval: '1', aggregateTo: tfId === '1m' ? null : tfId };
  if (tfId === '5m') return { interval: '5', aggregateTo: null };
  if (tfId === '15m') return { interval: '15', aggregateTo: null };
  if (tfId === '45m') return { interval: '15', aggregateTo: '45m' };
  if (tfId === '4h') return { interval: '60', aggregateTo: '4h' };
  return { interval: '5', aggregateTo: null };
}

async function fetchDhanDaily(creds, security, fromDate, toDate) {
  const res = await fetch('https://api.dhan.co/v2/charts/historical', {
    method: 'POST',
    headers: dhanHeaders(creds, true),
    body: JSON.stringify({
      securityId: security.securityId,
      exchangeSegment: security.exchangeSegment,
      instrument: security.instrument,
      expiryCode: 0,
      oi: false,
      fromDate,
      toDate
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Dhan daily HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  return dhanArraysToCandles(json);
}

async function fetchDhanIntraday(creds, security, interval, fromDateTime, toDateTime) {
  const res = await fetch('https://api.dhan.co/v2/charts/intraday', {
    method: 'POST',
    headers: dhanHeaders(creds, true),
    body: JSON.stringify({
      securityId: security.securityId,
      exchangeSegment: security.exchangeSegment,
      instrument: security.instrument,
      interval: String(interval),
      oi: false,
      fromDate: fromDateTime,
      toDate: toDateTime
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Dhan intraday HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  return dhanArraysToCandles(json);
}

async function fetchDhanLtp(creds, security) {
  const body = {};
  body[security.exchangeSegment] = [Number(security.securityId) || security.securityId];
  const res = await fetch('https://api.dhan.co/v2/marketfeed/ltp', {
    method: 'POST',
    headers: dhanHeaders(creds, true),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dhan LTP HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  const data = json?.data?.[security.exchangeSegment] || json?.[security.exchangeSegment] || {};
  const row = data[security.securityId] || data[String(security.securityId)] || data[Number(security.securityId)];
  const ltp = Number(row?.last_price ?? row?.lastPrice ?? row?.LTP);
  if (!Number.isFinite(ltp) || ltp <= 0) {
    throw new Error('Dhan LTP missing in response');
  }
  return ltp;
}

async function fetchDhanStockCandles(symbol, exchange, tfId) {
  const creds = await getDhanCreds();
  if (!creds) throw new Error('Dhan credentials missing');

  const cacheKey = `dhan:${exchange || 'NSE'}:${cleanEquitySymbol(symbol)}:${tfId}`;
  const cached = historyCache.get(cacheKey);
  const ttl = ['1D', '1W', '1M'].includes(tfId) ? 15 * 60 * 1000 : 90 * 1000;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return { ...cached.data, cached: true };
  }

  const security = await resolveSecurityId(symbol, exchange || 'NSE', creds);
  const now = new Date();
  let candles;
  let interval = tfId;
  let aggregated = false;

  if (tfId === '1D' || tfId === '1W' || tfId === '1M') {
    const fromDate = formatISTDate(shiftDays(now, tfId === '1M' ? -2200 : -800));
    const toDate = formatISTDate(shiftDays(now, 1));
    candles = await fetchDhanDaily(creds, security, fromDate, toDate);
    if (tfId === '1W' || tfId === '1M') {
      candles = aggregateCandles(candles, tfId);
      aggregated = true;
    }
    interval = '1D';
  } else {
    const mapped = mapDhanIntradayInterval(tfId);
    const fromDateTime = formatISTDateTime(shiftDays(now, -80));
    const toDateTime = formatISTDateTime(now);
    candles = await fetchDhanIntraday(creds, security, mapped.interval, fromDateTime, toDateTime);
    interval = `${mapped.interval}m`;
    if (mapped.aggregateTo) {
      candles = aggregateCandles(candles, mapped.aggregateTo);
      aggregated = true;
    }
  }

  if (!candles.length) throw new Error(`Dhan returned no candles for ${security.symbol}`);

  const data = {
    candles,
    interval,
    requestedTimeframe: tfId,
    aggregated,
    symbol: security.symbol,
    exchange: exchange || 'NSE',
    source: 'Dhan',
    securityId: security.securityId,
    exchangeSegment: security.exchangeSegment,
    fetchedAt: Date.now(),
    firstTime: candles[0].startTime,
    lastTime: candles[candles.length - 1].startTime
  };
  historyCache.set(cacheKey, { fetchedAt: Date.now(), data });
  if (historyCache.size > 16) {
    historyCache.delete(historyCache.keys().next().value);
  }
  return { ...data, cached: false };
}

/* ===================== Upstox ===================== */

const UPSTOX_KNOWN_KEYS = {
  RELIANCE: 'NSE_EQ|INE002A01018',
  HDFCBANK: 'NSE_EQ|INE040A01034',
  TCS: 'NSE_EQ|INE467B01029',
  INFY: 'NSE_EQ|INE009A01021',
  ICICIBANK: 'NSE_EQ|INE090A01021',
  SBIN: 'NSE_EQ|INE062A01020',
  ITC: 'NSE_EQ|INE154A01025',
  BHARTIARTL: 'NSE_EQ|INE397D01024',
  AXISBANK: 'NSE_EQ|INE238A01034',
  KOTAKBANK: 'NSE_EQ|INE237A01028',
  LT: 'NSE_EQ|INE018A01030',
  MARUTI: 'NSE_EQ|INE585B01010',
  TATAMOTORS: 'NSE_EQ|INE155A01022',
  TATASTEEL: 'NSE_EQ|INE081A01020',
  BAJFINANCE: 'NSE_EQ|INE296A01024',
  BAJAJFINSV: 'NSE_EQ|INE918I01018',
  SUNPHARMA: 'NSE_EQ|INE044A01036',
  ASIANPAINT: 'NSE_EQ|INE021A01026',
  HINDUNILVR: 'NSE_EQ|INE030A01027',
  NTPC: 'NSE_EQ|INE733E01010',
  ONGC: 'NSE_EQ|INE213A01029',
  COALINDIA: 'NSE_EQ|INE522F01014',
  WIPRO: 'NSE_EQ|INE075A01034',
  ULTRACEMCO: 'NSE_EQ|INE481G01011',
  TITAN: 'NSE_EQ|INE280A01028',
  JSWSTEEL: 'NSE_EQ|INE019A01038',
  ADANIENT: 'NSE_EQ|INE423A01024',
  ADANIPORTS: 'NSE_EQ|INE742F01042',
  POWERGRID: 'NSE_EQ|INE752E01010',
  HCLTECH: 'NSE_EQ|INE860A01027',
  TECHM: 'NSE_EQ|INE669C01036',
  INDUSINDBK: 'NSE_EQ|INE095A01012',
  NESTLEIND: 'NSE_EQ|INE239A01016',
  GRASIM: 'NSE_EQ|INE047A01021',
  HINDALCO: 'NSE_EQ|INE038A01020',
  EICHERMOT: 'NSE_EQ|INE066A01013',
  DRREDDY: 'NSE_EQ|INE089A01023',
  CIPLA: 'NSE_EQ|INE059A01026',
  APOLLOHOSP: 'NSE_EQ|INE437A01024',
  DIVISLAB: 'NSE_EQ|INE361B01024',
  HEROMOTOCO: 'NSE_EQ|INE158A01026',
  BPCL: 'NSE_EQ|INE029A01011',
  BRITANNIA: 'NSE_EQ|INE216A01030',
  SBILIFE: 'NSE_EQ|INE123W01016',
  HDFCLIFE: 'NSE_EQ|INE795G01014',
  LTIM: 'NSE_EQ|INE214T01019',
  SHRIRAMFIN: 'NSE_EQ|INE721A01013',
  JIOFIN: 'NSE_EQ|INE758E01017',
  TRENT: 'NSE_EQ|INE849A01020',
  BEL: 'NSE_EQ|INE263A01024',
  HAL: 'NSE_EQ|INE066F01012',
  ZOMATO: 'NSE_EQ|INE758T01015',
  VEDL: 'NSE_EQ|INE205A01025'
};

async function getUpstoxCreds() {
  const res = await chrome.storage.local.get(['upstoxApiKey', 'upstoxAccessToken']);
  const accessToken = String(res.upstoxAccessToken || '').trim();
  if (!accessToken) return null;
  return {
    apiKey: String(res.upstoxApiKey || '').trim(),
    accessToken
  };
}

function upstoxHeaders(creds) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${creds.accessToken}`
  };
}

function mapUpstoxInterval(tfId) {
  if (tfId === '45m' || tfId === '1m' || tfId === '2m' || tfId === '3m' || tfId === '5m' || tfId === '15m') {
    return { interval: '1minute', aggregateTo: tfId === '1m' ? null : (tfId === '45m' || tfId === '2m' || tfId === '3m' || tfId === '5m' || tfId === '15m' ? tfId : null) };
  }
  if (tfId === '4h') return { interval: '30minute', aggregateTo: '4h' };
  if (tfId === '1D') return { interval: 'day', aggregateTo: null };
  if (tfId === '1W') return { interval: 'week', aggregateTo: null };
  if (tfId === '1M') return { interval: 'month', aggregateTo: null };
  return { interval: 'day', aggregateTo: null };
}

function upstoxDateRange(tfId) {
  const now = new Date();
  const toDate = formatISTDate(shiftDays(now, 1));
  let fromDays = 400;
  if (tfId === '45m' || tfId === '1m' || tfId === '2m' || tfId === '3m' || tfId === '5m' || tfId === '15m') {
    fromDays = 28; // Upstox 1minute ~1 month
  } else if (tfId === '4h') {
    fromDays = 360;
  } else if (tfId === '1D') {
    fromDays = 400;
  } else if (tfId === '1W') {
    fromDays = 2000;
  } else if (tfId === '1M') {
    fromDays = 3650;
  }
  return { fromDate: formatISTDate(shiftDays(now, -fromDays)), toDate };
}

function upstoxCandlesToRows(raw) {
  // Upstox: [[ts, open, high, low, close, volume, oi?], ...]
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length < 5) return null;
    let startTime = Date.parse(row[0]);
    if (!Number.isFinite(startTime)) {
      const n = Number(row[0]);
      startTime = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : NaN;
    }
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]) || 0;
    if (!Number.isFinite(startTime) || ![open, high, low, close].every(v => Number.isFinite(v) && v > 0)) {
      return null;
    }
    return {
      startTime,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume: Math.max(0, volume),
      complete: true
    };
  }).filter(Boolean).sort((a, b) => a.startTime - b.startTime);
}

async function loadUpstoxInstrumentCache() {
  const res = await chrome.storage.local.get(['upstoxInstrumentCache']);
  const cache = res.upstoxInstrumentCache;
  if (cache?.map && cache.fetchedAt && Date.now() - cache.fetchedAt < 24 * 60 * 60 * 1000) {
    return cache.map;
  }
  // Compact NSE equity JSON from Upstox assets (fallback: known keys only)
  try {
    const url = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
    // gz may not decompress in SW — try uncompressed JSON endpoints
    const alt = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';
    void alt;
    void url;
  } catch (_) {}
  return cache?.map || {};
}

async function saveUpstoxInstrumentEntry(symbol, instrumentKey) {
  const clean = cleanEquitySymbol(symbol);
  if (!clean || !instrumentKey) return;
  const res = await chrome.storage.local.get(['upstoxInstrumentCache']);
  const map = { ...(res.upstoxInstrumentCache?.map || {}) };
  map[clean] = instrumentKey;
  await chrome.storage.local.set({
    upstoxInstrumentCache: { map, fetchedAt: Date.now() }
  });
}

async function resolveUpstoxInstrumentKey(symbol, exchange) {
  const clean = cleanEquitySymbol(symbol);
  if (!clean) throw new Error('Empty symbol');
  if (UPSTOX_KNOWN_KEYS[clean]) return UPSTOX_KNOWN_KEYS[clean];

  const cached = await loadUpstoxInstrumentCache();
  if (cached[clean]) return cached[clean];

  // Search API (needs token)
  const creds = await getUpstoxCreds();
  if (creds) {
    try {
      const q = encodeURIComponent(clean);
      const res = await fetch(`https://api.upstox.com/v2/search/instruments?query=${q}`, {
        headers: upstoxHeaders(creds)
      });
      if (res.ok) {
        const json = await res.json();
        const rows = json?.data || [];
        const wantEx = (exchange || 'NSE').toUpperCase() === 'BSE' ? 'BSE' : 'NSE';
        const hit = rows.find((r) => {
          const sym = cleanEquitySymbol(r.trading_symbol || r.tradingsymbol || r.symbol);
          const seg = String(r.segment || r.exchange || '').toUpperCase();
          const itype = String(r.instrument_type || r.instrument_key || '').toUpperCase();
          return sym === clean &&
            (seg.includes(wantEx) || String(r.instrument_key || '').startsWith(`${wantEx}_EQ`)) &&
            (itype.includes('EQ') || String(r.instrument_key || '').includes('_EQ|'));
        }) || rows.find((r) => cleanEquitySymbol(r.trading_symbol || r.tradingsymbol) === clean);
        const key = hit?.instrument_key || hit?.instrumentKey;
        if (key) {
          await saveUpstoxInstrumentEntry(clean, key);
          return key;
        }
      }
    } catch (_) {}
  }

  // Last resort: NSE_EQ|SYMBOL style (works for some equities on Upstox)
  const prefix = (exchange || 'NSE').toUpperCase() === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
  return `${prefix}|${clean}`;
}

async function fetchUpstoxHistoricalCandles(instrumentKey, interval, fromDate, toDate, creds) {
  const path =
    `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}` +
    `/${interval}/${toDate}/${fromDate}`;
  const res = await fetch(path, { headers: upstoxHeaders(creds) });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Upstox token expired — paste a new Access Token (expires ~3:30 AM IST)');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstox HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
  }
  const json = await res.json();
  if (json?.status === 'error') {
    throw new Error(json?.errors?.[0]?.message || json?.message || 'Upstox API error');
  }
  const candles = upstoxCandlesToRows(json?.data?.candles || json?.data || []);
  return candles;
}

async function fetchUpstoxIntradayCandles(instrumentKey, interval, creds) {
  const path =
    `https://api.upstox.com/v2/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${interval}`;
  const res = await fetch(path, { headers: upstoxHeaders(creds) });
  if (res.status === 401 || res.status === 403) {
    throw new Error('Upstox token expired — paste a new Access Token (expires ~3:30 AM IST)');
  }
  if (!res.ok) throw new Error(`Upstox intraday HTTP ${res.status}`);
  const json = await res.json();
  return upstoxCandlesToRows(json?.data?.candles || []);
}

async function fetchUpstoxStockCandles(symbol, exchange, tfId) {
  const creds = await getUpstoxCreds();
  if (!creds) throw new Error('Upstox Access Token missing');

  const cacheKey = `upstox:${exchange || 'NSE'}:${cleanEquitySymbol(symbol)}:${tfId}`;
  const cached = historyCache.get(cacheKey);
  const ttl = ['1D', '1W', '1M'].includes(tfId) ? 15 * 60 * 1000 : 90 * 1000;
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    return { ...cached.data, cached: true };
  }

  const instrumentKey = await resolveUpstoxInstrumentKey(symbol, exchange || 'NSE');
  const mapped = mapUpstoxInterval(tfId);
  const range = upstoxDateRange(tfId);
  let candles = await fetchUpstoxHistoricalCandles(
    instrumentKey,
    mapped.interval,
    range.fromDate,
    range.toDate,
    creds
  );

  // Intraday today may need intraday endpoint merge for latest bars
  if (mapped.interval === '1minute' || mapped.interval === '30minute') {
    try {
      const today = await fetchUpstoxIntradayCandles(instrumentKey, mapped.interval, creds);
      if (today.length) {
        const byT = new Map(candles.map(c => [c.startTime, c]));
        today.forEach(c => byT.set(c.startTime, c));
        candles = Array.from(byT.values()).sort((a, b) => a.startTime - b.startTime);
      }
    } catch (_) {}
  }

  let aggregated = false;
  if (mapped.aggregateTo) {
    // Only aggregate when source interval is finer
    if (mapped.interval === '1minute' && ['2m', '3m', '5m', '15m', '45m'].includes(mapped.aggregateTo)) {
      candles = aggregateCandles(candles, mapped.aggregateTo);
      aggregated = true;
    } else if (mapped.interval === '30minute' && mapped.aggregateTo === '4h') {
      candles = aggregateCandles(candles, '4h');
      aggregated = true;
    }
  }

  if (!candles.length) {
    throw new Error(`Upstox returned no candles for ${cleanEquitySymbol(symbol)} (${instrumentKey})`);
  }

  const data = {
    candles,
    interval: mapped.interval,
    requestedTimeframe: tfId,
    aggregated,
    symbol: cleanEquitySymbol(symbol),
    exchange: exchange || 'NSE',
    source: 'Upstox',
    instrumentKey,
    fetchedAt: Date.now(),
    firstTime: candles[0].startTime,
    lastTime: candles[candles.length - 1].startTime
  };
  historyCache.set(cacheKey, { fetchedAt: Date.now(), data });
  if (historyCache.size > 16) {
    historyCache.delete(historyCache.keys().next().value);
  }
  return { ...data, cached: false };
}

async function testUpstoxConnection() {
  const creds = await getUpstoxCreds();
  if (!creds) throw new Error('Save Upstox Access Token first');
  const instrumentKey = await resolveUpstoxInstrumentKey('SBIN', 'NSE');
  const range = upstoxDateRange('1D');
  const candles = await fetchUpstoxHistoricalCandles(
    instrumentKey,
    'day',
    range.fromDate,
    range.toDate,
    creds
  );
  if (!candles.length) throw new Error('No daily candles for SBIN');
  const last = candles[candles.length - 1];
  return {
    ok: true,
    message: `SBIN last ₹${last.close} · ${candles.length} daily bars (${instrumentKey})`
  };
}

async function fetchTradingViewTechnicalScan(symbol, exchange) {
  const clean = cleanEquitySymbol(symbol);
  if (!clean) return null;
  const isBse = (exchange || '').toUpperCase() === 'BSE';
  const prefix = isBse ? 'BSE:' : 'NSE:';
  const ticker = prefix + clean.replace(/\s+/g, '');
  const body = {
    symbols: { tickers: [ticker] },
    columns: [
      'Recommend.All', 'Recommend.MA', 'Recommend.Other',
      'RSI', 'RSI[1]', 'Stoch.K', 'Stoch.D',
      'SMA20', 'SMA50', 'SMA100', 'SMA200',
      'EMA20', 'EMA50', 'EMA100', 'EMA200',
      'MACD.macd', 'MACD.signal', 'close', 'change', 'volume',
      'Pivot.M.Classic.Middle', 'Pivot.M.Classic.R1', 'Pivot.M.Classic.S1',
      'Pivot.M.Classic.R2', 'Pivot.M.Classic.S2'
    ]
  };

  try {
    const res = await fetch('https://scanner.tradingview.com/india/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    const json = await res.json();
    const row = json?.data?.[0]?.d;
    if (!row || !Array.isArray(row) || row.length < 18) return null;
    return {
      symbol: clean,
      overallScore: row[0],
      maScore: row[1],
      oscillatorScore: row[2],
      rsi: row[3],
      rsiPrev: row[4],
      stochK: row[5],
      stochD: row[6],
      sma20: row[7],
      sma50: row[8],
      sma100: row[9],
      sma200: row[10],
      ema20: row[11],
      ema50: row[12],
      ema100: row[13],
      ema200: row[14],
      macd: row[15],
      macdSignal: row[16],
      close: row[17],
      change: row[18],
      volume: row[19],
      pivot: row[20],
      r1: row[21],
      s1: row[22],
      r2: row[23],
      s2: row[24],
      fetchedAt: Date.now()
    };
  } catch (_) {
    return null;
  }
}

/** Priority: Upstox (if token) → Dhan (if token) → Yahoo + TradingView Scanner */
async function fetchStockCandlesPreferBroker(symbol, exchange, tfId) {
  const tvScanPromise = fetchTradingViewTechnicalScan(symbol, exchange).catch(() => null);

  const upstoxCreds = await getUpstoxCreds();
  if (upstoxCreds) {
    try {
      const data = await fetchUpstoxStockCandles(symbol, exchange, tfId);
      const tvScan = await tvScanPromise;
      return { ...data, tvScan, upstoxStatus: 'ok', dhanStatus: 'skipped' };
    } catch (err) {
      const upstoxError = err.message || String(err);
      // fall through to Dhan/Yahoo
      const dhanCreds = await getDhanCreds();
      if (dhanCreds) {
        try {
          const data = await fetchDhanStockCandles(symbol, exchange, tfId);
          const tvScan = await tvScanPromise;
          return {
            ...data,
            tvScan,
            upstoxError,
            upstoxStatus: 'error',
            dhanStatus: 'ok',
            fallback: true
          };
        } catch (dhanErr) {
          const yahoo = await fetchYahooStockCandles(symbol, exchange, tfId);
          const tvScan = await tvScanPromise;
          return {
            ...yahoo,
            tvScan,
            source: tvScan ? 'TradingView + Yahoo' : 'Yahoo',
            upstoxError,
            dhanError: dhanErr.message || String(dhanErr),
            fallback: true,
            upstoxStatus: 'error',
            dhanStatus: 'error'
          };
        }
      }
      const yahoo = await fetchYahooStockCandles(symbol, exchange, tfId);
      const tvScan = await tvScanPromise;
      return {
        ...yahoo,
        tvScan,
        source: tvScan ? 'TradingView + Yahoo' : 'Yahoo',
        upstoxError,
        fallback: true,
        upstoxStatus: 'error',
        dhanStatus: 'skipped_free'
      };
    }
  }

  const dhanCreds = await getDhanCreds();
  if (!dhanCreds) {
    const yahoo = await fetchYahooStockCandles(symbol, exchange, tfId);
    const tvScan = await tvScanPromise;
    return {
      ...yahoo,
      tvScan,
      source: tvScan ? 'TradingView + Yahoo' : 'Yahoo',
      upstoxStatus: 'skipped',
      dhanStatus: 'skipped_free'
    };
  }
  try {
    const data = await fetchDhanStockCandles(symbol, exchange, tfId);
    const tvScan = await tvScanPromise;
    return { ...data, tvScan, upstoxStatus: 'skipped', dhanStatus: 'ok' };
  } catch (err) {
    const yahoo = await fetchYahooStockCandles(symbol, exchange, tfId);
    const tvScan = await tvScanPromise;
    let dhanError = err.message || String(err);
    if (/806|not subscribed|Data APIs not Subscribed/i.test(dhanError)) {
      dhanError = 'Dhan Data API not subscribed (₹499/mo required)';
    }
    return {
      ...yahoo,
      tvScan,
      source: tvScan ? 'TradingView + Yahoo' : 'Yahoo',
      dhanError,
      fallback: true,
      upstoxStatus: 'skipped',
      dhanStatus: 'error'
    };
  }
}

async function fetchStockCandlesPreferDhan(symbol, exchange, tfId) {
  return fetchStockCandlesPreferBroker(symbol, exchange, tfId);
}

async function testDhanConnection() {
  const creds = await getDhanCreds();
  if (!creds) throw new Error('Save Client ID and Access Token first');
  const security = await resolveSecurityId('SBIN', 'NSE', creds);
  const ltp = await fetchDhanLtp(creds, security);
  return {
    ok: true,
    message: `SBIN LTP ₹${ltp} (id ${security.securityId})`
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'KP_SR_ALERT') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: msg.title || 'KitePlus Alert',
      message: msg.message || '',
      priority: 2
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'KP_ANALYSIS_ALERT') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: msg.title || 'Megamind Analysis',
      message: msg.message || '',
      priority: 2
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'KP_YAHOO_CANDLES') {
    fetchYahooCandles(msg.underlying || 'NIFTY', msg.tfId || '5m')
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'KP_STOCK_CANDLES') {
    fetchStockCandlesPreferDhan(
      msg.symbol,
      msg.exchange || 'NSE',
      msg.tfId || '1D'
    )
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'KP_DHAN_LTP') {
    (async () => {
      const creds = await getDhanCreds();
      if (!creds) throw new Error('Dhan credentials missing');
      const security = await resolveSecurityId(msg.symbol, msg.exchange || 'NSE', creds);
      const ltp = await fetchDhanLtp(creds, security);
      return {
        ok: true,
        ltp,
        symbol: security.symbol,
        securityId: security.securityId,
        exchangeSegment: security.exchangeSegment,
        source: 'Dhan'
      };
    })()
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'KP_DHAN_TEST') {
    testDhanConnection()
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'KP_UPSTOX_TEST') {
    testUpstoxConnection()
      .then((data) => sendResponse(data))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
});
