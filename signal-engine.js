// KitePlus Signal Engine — Multi-Indicator Confluence System
// Retail-buyer focused: index charts → Buy CE / Buy PE; option charts → Buy / Wait.
// Supports NIFTY, SENSEX, BANKNIFTY, FINNIFTY and their CE/PE contracts.

const TIMEFRAMES = [
  { id: '1m', label: '1m', ms: 60 * 1000 },
  { id: '2m', label: '2m', ms: 2 * 60 * 1000 },
  { id: '3m', label: '3m', ms: 3 * 60 * 1000 },
  { id: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { id: '15m', label: '15m', ms: 15 * 60 * 1000 },
  { id: '45m', label: '45m', ms: 45 * 60 * 1000 },
  { id: '4h', label: '4h', ms: 4 * 60 * 60 * 1000 },
  { id: '1D', label: '1D', ms: 24 * 60 * 60 * 1000 },
  { id: '1W', label: '1W', ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '1M', label: '1M', ms: 30 * 24 * 60 * 60 * 1000 }
];

/* ==========================================
   INSTRUMENT CLASSIFIER
   ========================================== */
function classifyInstrument(rawSymbol) {
  const raw = String(rawSymbol || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const exchange = /\b(BSE|BFO)\b/.test(raw) || /\.BO$/.test(raw) ? 'BSE' : 'NSE';
  const symbol = raw
    .replace(/\b(NSE_EQ|BSE_EQ|NSE|BSE|NFO|BFO)\s*[:|/-]\s*/g, '')
    .replace(/\.(NS|BO)$/g, '')
    .replace(/\s+(EQ|BE|BZ)$/g, '')
    .trim();
  const compact = symbol.replace(/\s+/g, '');

  let optionType = null;
  // Require a strike digit before CE/PE so names like RELIANCE / PIPE are not options.
  if (/\bCE\b/.test(symbol) || /\d{4,6}CE$/.test(compact) || compact.endsWith('CALL')) {
    optionType = 'CE';
  } else if (/\bPE\b/.test(symbol) || /\d{4,6}PE$/.test(compact) || compact.endsWith('PUT')) {
    optionType = 'PE';
  }

  let underlying = 'UNKNOWN';
  if (compact.includes('BANKNIFTY') || compact.includes('BANKNIF')) {
    underlying = 'BANKNIFTY';
  } else if (compact.includes('FINNIFTY') || compact.includes('FINNIF')) {
    underlying = 'FINNIFTY';
  } else if (compact.includes('SENSEX') || compact.includes('BSX')) {
    underlying = 'SENSEX';
  } else if (compact.includes('NIFTY') || compact === 'NIFTY50' || compact.includes('NSEI')) {
    underlying = 'NIFTY';
  }

  let strike = null;
  const spacedStrike = symbol.match(/\b(\d{4,6})\s*(?:CE|PE)\b/i);
  const compactStrike = compact.match(/(\d{5})(CE|PE)$/i) || compact.match(/(\d{4})(CE|PE)$/i) ||
    compact.match(/(\d{4,6})(CE|PE)$/i);
  if (spacedStrike) strike = parseInt(spacedStrike[1], 10);
  else if (compactStrike) strike = parseInt(compactStrike[1], 10);

  // Kite option names like NIFTY25JUL24400PE — treat as option even if strike parse is soft.
  if (!optionType && /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX).+\d{4,6}(CE|PE)$/.test(compact)) {
    optionType = compact.endsWith('CE') ? 'CE' : 'PE';
    const m = compact.match(/(\d{4,6})(CE|PE)$/);
    if (m) strike = parseInt(m[1], 10);
  }

  const looksLikeEquity = !optionType &&
    underlying === 'UNKNOWN' &&
    /^[A-Z0-9&._ -]{1,40}$/.test(symbol) &&
    /[A-Z]/.test(symbol);
  const finalKind = optionType
    ? 'option'
    : (['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY'].includes(underlying)
      ? 'index'
      : (looksLikeEquity ? 'equity' : 'other'));

  return {
    symbol: symbol || '—',
    underlying: underlying === 'UNKNOWN' && optionType ? 'INDEX' : underlying,
    optionType,
    strike,
    exchange: optionType ? (exchange === 'BSE' ? 'BFO' : 'NFO') : exchange,
    yahooSymbol: finalKind === 'equity'
      ? `${symbol.replace(/\s+/g, '-')}.${exchange === 'BSE' ? 'BO' : 'NS'}`
      : null,
    kind: finalKind,
    supported: ['index', 'option', 'equity'].includes(finalKind)
  };
}

/* ==========================================
   CANDLE COLLECTOR
   Builds OHLC candles from tick-level price data
   ========================================== */
class CandleCollector {
  constructor(intervalMs = 2 * 60 * 1000) {
    this.intervalMs = intervalMs;
    this.candles = [];
    this.currentCandle = null;
    this.tickVolume = 0;
    this.symbol = null;
  }

  addTick(price, timestamp = Date.now()) {
    if (isNaN(price) || price <= 0) return;

    const candleStart = Math.floor(timestamp / this.intervalMs) * this.intervalMs;

    if (!this.currentCandle || this.currentCandle.startTime !== candleStart) {
      if (this.currentCandle) {
        this.currentCandle.complete = true;
        this.candles.push({ ...this.currentCandle });
      }

      this.currentCandle = {
        startTime: candleStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        complete: false
      };
      this.tickVolume = 0;
    }

    this.currentCandle.high = Math.max(this.currentCandle.high, price);
    this.currentCandle.low = Math.min(this.currentCandle.low, price);
    this.currentCandle.close = price;
    this.tickVolume++;
    this.currentCandle.volume = this.tickVolume;
  }

  getAllCandles() {
    const all = [...this.candles];
    if (this.currentCandle) {
      all.push({ ...this.currentCandle });
    }
    return all;
  }

  getCompletedCandles() {
    return [...this.candles];
  }

  trim(maxCandles = 500) {
    if (this.candles.length > maxCandles) {
      this.candles = this.candles.slice(-maxCandles);
    }
  }

  getCandleCount() {
    return this.candles.length + (this.currentCandle ? 1 : 0);
  }

  reset() {
    this.candles = [];
    this.currentCandle = null;
    this.tickVolume = 0;
  }

  seedCandles(candles) {
    if (!Array.isArray(candles)) return;
    this.candles = candles
      .filter(c => c && Number(c.close) > 0)
      .map(c => ({ ...c, complete: true }))
      .slice(-500);
    this.currentCandle = null;
    this.tickVolume = 0;
  }

  setInterval(intervalMs) {
    if (intervalMs !== this.intervalMs) {
      this.intervalMs = intervalMs;
      this.reset();
    }
  }

  setSymbol(symbol) {
    if (this.symbol !== symbol) {
      this.symbol = symbol;
      this.reset();
      return true;
    }
    return false;
  }
}

/* ==========================================
   INDICATOR 1: RSI (Relative Strength Index)
   ========================================== */
function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];

  const rsiValues = [];
  let gains = 0;
  let losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Pad with nulls for alignment
  for (let i = 0; i < period; i++) {
    rsiValues.push(null);
  }

  // First RSI value
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsiValues.push(100 - (100 / (1 + rs)));

  // Subsequent RSI values using Wilder's smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsI = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiValues.push(100 - (100 / (1 + rsI)));
  }

  return rsiValues;
}

/* ==========================================
   INDICATOR 2: MACD (Moving Average Convergence Divergence)
   ========================================== */
function computeMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) {
    return { macdLine: [], signalLine: [], histogram: [] };
  }

  const fastEMA = computeEMA(closes, fastPeriod);
  const slowEMA = computeEMA(closes, slowPeriod);

  // MACD Line = Fast EMA - Slow EMA
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine.push(fastEMA[i] - slowEMA[i]);
    } else {
      macdLine.push(null);
    }
  }

  // Signal Line = EMA of MACD Line
  const nonNullMACD = macdLine.filter(v => v !== null);
  const signalRaw = computeEMA(nonNullMACD, signalPeriod);

  // Align signal line back to full array length
  const signalLine = [];
  const nullCount = macdLine.filter(v => v === null).length;
  for (let i = 0; i < nullCount; i++) signalLine.push(null);

  let sigIdx = 0;
  for (let i = nullCount; i < macdLine.length; i++) {
    signalLine.push(sigIdx < signalRaw.length ? signalRaw[sigIdx] : null);
    sigIdx++;
  }

  // Histogram = MACD - Signal
  const histogram = [];
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signalLine[i] !== null) {
      histogram.push(macdLine[i] - signalLine[i]);
    } else {
      histogram.push(null);
    }
  }

  return { macdLine, signalLine, histogram };
}

/* ==========================================
   INDICATOR 3: EMA (Exponential Moving Average)
   ========================================== */
function computeEMA(data, period) {
  if (data.length < period) return data.map(() => null);

  const emaValues = [];
  const multiplier = 2 / (period + 1);

  // SMA for the first EMA value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i];
    emaValues.push(null);
  }

  let ema = sum / period;
  emaValues[period - 1] = ema;

  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
    emaValues.push(ema);
  }

  return emaValues;
}

/* ==========================================
   INDICATOR 4: BOLLINGER BANDS
   ========================================== */
function computeBollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) {
    return { upper: [], middle: [], lower: [] };
  }

  const upper = [];
  const middle = [];
  const lower = [];

  for (let i = 0; i < period - 1; i++) {
    upper.push(null);
    middle.push(null);
    lower.push(null);
  }

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;

    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    middle.push(mean);
    upper.push(mean + stdDevMult * stdDev);
    lower.push(mean - stdDevMult * stdDev);
  }

  return { upper, middle, lower };
}

/* ==========================================
   INDICATOR 5: VWAP (Volume Weighted Average Price)
   ========================================== */
function computeVWAP(candles) {
  if (candles.length === 0) return [];

  const vwapValues = [];
  let cumulativeTPV = 0;  // Typical Price × Volume
  let cumulativeVolume = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const volume = Math.max(1, c.volume);  // Avoid division by zero

    cumulativeTPV += typicalPrice * volume;
    cumulativeVolume += volume;

    vwapValues.push(cumulativeTPV / cumulativeVolume);
  }

  return vwapValues;
}

/* ==========================================
   INDICATOR 6: SUPERTREND
   ========================================== */
function computeSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period) return [];

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  // Compute ATR (Average True Range)
  const trueRanges = [highs[0] - lows[0]];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }

  // ATR using Wilder's smoothing
  const atr = [];
  let atrSum = 0;
  for (let i = 0; i < period; i++) {
    atrSum += trueRanges[i];
    atr.push(null);
  }
  atr[period - 1] = atrSum / period;

  for (let i = period; i < candles.length; i++) {
    const prevATR = atr[i - 1] || (atrSum / period);
    atr.push((prevATR * (period - 1) + trueRanges[i]) / period);
  }

  // Supertrend calculation
  const supertrend = [];
  const direction = []; // 1 = bullish (up), -1 = bearish (down)

  for (let i = 0; i < candles.length; i++) {
    if (atr[i] === null) {
      supertrend.push(null);
      direction.push(0);
      continue;
    }

    const hl2 = (highs[i] + lows[i]) / 2;
    let upperBand = hl2 + multiplier * atr[i];
    let lowerBand = hl2 - multiplier * atr[i];

    // Adjust bands based on previous values
    if (i > 0 && supertrend[i - 1] !== null) {
      const prevUpper = supertrend[i - 1];
      const prevLower = supertrend[i - 1];

      if (direction[i - 1] === 1) {
        // Was bullish — lowerBand is the supertrend
        lowerBand = Math.max(lowerBand, supertrend[i - 1]);
        if (closes[i] > lowerBand) {
          supertrend.push(lowerBand);
          direction.push(1); // Still bullish
        } else {
          supertrend.push(upperBand);
          direction.push(-1); // Flip to bearish
        }
      } else {
        // Was bearish — upperBand is the supertrend
        upperBand = Math.min(upperBand, supertrend[i - 1]);
        if (closes[i] < upperBand) {
          supertrend.push(upperBand);
          direction.push(-1); // Still bearish
        } else {
          supertrend.push(lowerBand);
          direction.push(1); // Flip to bullish
        }
      }
    } else {
      // Initial: determine direction from close vs HL2
      if (closes[i] > hl2) {
        supertrend.push(lowerBand);
        direction.push(1);
      } else {
        supertrend.push(upperBand);
        direction.push(-1);
      }
    }
  }

  return { values: supertrend, direction };
}

/* ==========================================
   TRADE MODES — Scalp vs Intraday
   ========================================== */
const TRADE_MODES = {
  scalp: {
    id: 'scalp',
    label: 'Scalp',
    minCandles: 6,
    rsiPeriod: 5,
    macdFast: 3, macdSlow: 8, macdSignal: 3,
    emaFast: 2, emaSlow: 5,
    bbPeriod: 8,
    stPeriod: 4, stMult: 1.5,
    momBars: 2,
    bodyBars: 2,
    structureBars: 4,
    strongAt: 70,
    actionableAt: 58,
    leanAt: 46,
    biasMin: 46,
    edgeMin: 0.35,
    chopEdge: 0.35,
    preferredTf: '1m',
    momBoost: 1.4
  },
  microScalp: {
    id: 'microScalp',
    label: 'Micro',
    minCandles: 4,
    rsiPeriod: 3,
    macdFast: 2, macdSlow: 5, macdSignal: 2,
    emaFast: 2, emaSlow: 4,
    bbPeriod: 6,
    stPeriod: 3, stMult: 1.2,
    momBars: 2,
    bodyBars: 2,
    structureBars: 3,
    strongAt: 68,
    actionableAt: 55,
    leanAt: 44,
    biasMin: 44,
    edgeMin: 0.30,
    chopEdge: 0.30,
    preferredTf: '1m',
    momBoost: 1.6
  },
  intraday: {
    id: 'intraday',
    label: 'Intraday',
    minCandles: 12,
    rsiPeriod: 10,
    macdFast: 6, macdSlow: 13, macdSignal: 5,
    emaFast: 5, emaSlow: 13,
    bbPeriod: 20,
    stPeriod: 7, stMult: 2.5,
    momBars: 5,
    bodyBars: 5,
    structureBars: 8,
    strongAt: 78,
    actionableAt: 65,
    leanAt: 52,
    biasMin: 52,
    edgeMin: 0.50,
    chopEdge: 0.55,
    preferredTf: '15m',
    momBoost: 1.0
  }
};

const MIN_CANDLES = TRADE_MODES.intraday.minCandles;

function getModeProfile(modeId) {
  return TRADE_MODES[modeId] || TRADE_MODES.intraday;
}

function lastValid(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== null && arr[i] !== undefined && !isNaN(arr[i])) return { value: arr[i], index: i };
  }
  return null;
}

function slope(values, lookback = 3) {
  const pts = [];
  for (let i = values.length - 1; i >= 0 && pts.length < lookback + 1; i--) {
    if (values[i] !== null && values[i] !== undefined) pts.unshift(values[i]);
  }
  if (pts.length < 2) return 0;
  return (pts[pts.length - 1] - pts[0]) / (pts.length - 1);
}

function momentumPct(closes, bars = 5) {
  if (closes.length <= bars) return 0;
  const a = closes[closes.length - 1];
  const b = closes[closes.length - 1 - bars];
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

function candleBodyBias(candles, n = 5) {
  const slice = candles.slice(-n);
  let up = 0, down = 0;
  slice.forEach(c => {
    if (c.close >= c.open) up++;
    else down++;
  });
  return { up, down, score: (up - down) / Math.max(1, slice.length) };
}

/* ==========================================
   SIGNAL GENERATOR — Weighted AI Confluence
   Modes: scalp (12 bars, faster) | intraday (20 bars)
   ========================================== */
function generateSignals(candles, context = {}) {
  const instrument = context.kind
    ? context
    : classifyInstrument(context.symbol || '');
  const mode = getModeProfile(context.mode || 'intraday');
  const minNeed = Math.max(4, Number(context.minCandles) || mode.minCandles);

  if (candles.length < minNeed) {
    return {
      direction: null,
      action: 'WAIT',
      strength: 0,
      indicators: {},
      message: `Collecting… (${candles.length}/${minNeed})`,
      instrument,
      mode: mode.id,
      thresholds: {
        strongAt: mode.strongAt,
        actionableAt: mode.actionableAt,
        leanAt: mode.leanAt,
        minCandles: minNeed
      },
      brain: null,
      timestamp: Date.now(),
      candleCount: candles.length
    };
  }

  const closes = candles.map(c => c.close);
  const lastIdx = closes.length - 1;
  const prevIdx = lastIdx - 1;
  const currentClose = closes[lastIdx];
  const prevClose = closes[prevIdx];

  const rsiPeriod = mode.rsiPeriod;
  const macdFast = mode.macdFast, macdSlow = mode.macdSlow, macdSignal = mode.macdSignal;
  const emaFastP = mode.emaFast, emaSlowP = mode.emaSlow;
  const bbPeriod = Math.min(mode.bbPeriod, candles.length);
  const stPeriod = mode.stPeriod;

  const rsiValues = computeRSI(closes, rsiPeriod);
  const macd = computeMACD(closes, macdFast, macdSlow, macdSignal);
  const emaFast = computeEMA(closes, emaFastP);
  const emaSlow = computeEMA(closes, emaSlowP);
  const bb = computeBollingerBands(closes, bbPeriod, 2);
  const vwap = computeVWAP(candles);
  const st = computeSupertrend(candles, stPeriod, mode.stMult);

  const indicators = {};
  let bullScore = 0;
  let bearScore = 0;
  let maxScore = 0;

  function vote(key, signal, weight, value, label) {
    maxScore += weight;
    indicators[key] = { value, signal, label, weight };
    if (signal === 'CE') bullScore += weight;
    else if (signal === 'PE') bearScore += weight;
  }

  const rsiCur = rsiValues[lastIdx];
  const rsiSlope = slope(rsiValues, mode.id === 'scalp' ? 2 : 3);
  if (rsiCur != null) {
    if (rsiCur < 28) vote('rsi', 'CE', 1.4, rsiCur.toFixed(1), 'Oversold bounce zone');
    else if (rsiCur > 72) vote('rsi', 'PE', 1.4, rsiCur.toFixed(1), 'Overbought fade zone');
    else if (rsiCur < 45 && rsiSlope > 0) vote('rsi', 'CE', 1.1, rsiCur.toFixed(1), 'Rising from weak zone');
    else if (rsiCur > 55 && rsiSlope < 0) vote('rsi', 'PE', 1.1, rsiCur.toFixed(1), 'Falling from strong zone');
    else if (rsiCur < 45) vote('rsi', 'CE', 0.7, rsiCur.toFixed(1), 'Bullish lean');
    else if (rsiCur > 55) vote('rsi', 'PE', 0.7, rsiCur.toFixed(1), 'Bearish lean');
    else vote('rsi', 'NEUTRAL', 0.5, rsiCur.toFixed(1), 'Mid-range');
  } else {
    vote('rsi', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  const macdCurr = macd.macdLine[lastIdx];
  const macdPrev = macd.macdLine[prevIdx];
  const sigCurr = macd.signalLine[lastIdx];
  const sigPrev = macd.signalLine[prevIdx];
  if (macdCurr != null && sigCurr != null && macdPrev != null && sigPrev != null) {
    const crossUp = macdPrev <= sigPrev && macdCurr > sigCurr;
    const crossDown = macdPrev >= sigPrev && macdCurr < sigCurr;
    const crossW = mode.id === 'scalp' ? 1.9 : 1.6;
    if (crossUp) vote('macd', 'CE', crossW, macdCurr.toFixed(2), 'Bullish cross');
    else if (crossDown) vote('macd', 'PE', crossW, macdCurr.toFixed(2), 'Bearish cross');
    else if (macdCurr > sigCurr && macdCurr > macdPrev) vote('macd', 'CE', 1.1, macdCurr.toFixed(2), 'Expanding bull');
    else if (macdCurr < sigCurr && macdCurr < macdPrev) vote('macd', 'PE', 1.1, macdCurr.toFixed(2), 'Expanding bear');
    else if (macdCurr > sigCurr) vote('macd', 'CE', 0.8, macdCurr.toFixed(2), 'Above signal');
    else if (macdCurr < sigCurr) vote('macd', 'PE', 0.8, macdCurr.toFixed(2), 'Below signal');
    else vote('macd', 'NEUTRAL', 0.4, macdCurr.toFixed(2), 'Flat');
  } else {
    vote('macd', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  const eF = emaFast[lastIdx], eFp = emaFast[prevIdx];
  const eS = emaSlow[lastIdx], eSp = emaSlow[prevIdx];
  if (eF != null && eS != null && eFp != null && eSp != null) {
    const crossUp = eFp <= eSp && eF > eS;
    const crossDown = eFp >= eSp && eF < eS;
    const sep = Math.abs(eF - eS) / currentClose * 100;
    const emaLabel = `EMA${emaFastP}/${emaSlowP}`;
    if (crossUp) vote('ema', 'CE', 1.5, `${eF.toFixed(1)}/${eS.toFixed(1)}`, `${emaLabel} golden`);
    else if (crossDown) vote('ema', 'PE', 1.5, `${eF.toFixed(1)}/${eS.toFixed(1)}`, `${emaLabel} death`);
    else if (eF > eS && slope(emaFast, 3) > 0) vote('ema', 'CE', 1.0 + Math.min(0.4, sep * 0.2), `${eF.toFixed(1)}/${eS.toFixed(1)}`, 'Uptrend stack');
    else if (eF < eS && slope(emaFast, 3) < 0) vote('ema', 'PE', 1.0 + Math.min(0.4, sep * 0.2), `${eF.toFixed(1)}/${eS.toFixed(1)}`, 'Downtrend stack');
    else if (eF > eS) vote('ema', 'CE', 0.7, `${eF.toFixed(1)}/${eS.toFixed(1)}`, `${emaLabel} bull`);
    else vote('ema', 'PE', 0.7, `${eF.toFixed(1)}/${eS.toFixed(1)}`, `${emaLabel} bear`);
  } else {
    vote('ema', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  const bbU = bb.upper[lastIdx], bbL = bb.lower[lastIdx], bbM = bb.middle[lastIdx];
  if (bbU != null && bbL != null) {
    const width = bbU - bbL;
    const pos = width > 0 ? (currentClose - bbL) / width : 0.5;
    const squeeze = bbM ? width / bbM : 0;
    if (currentClose <= bbL && currentClose > prevClose) vote('bb', 'CE', 1.5, pos.toFixed(2), 'Lower band bounce');
    else if (currentClose >= bbU && currentClose < prevClose) vote('bb', 'PE', 1.5, pos.toFixed(2), 'Upper band reject');
    else if (pos < 0.25) vote('bb', 'CE', 1.0, pos.toFixed(2), 'Near lower band');
    else if (pos > 0.75) vote('bb', 'PE', 1.0, pos.toFixed(2), 'Near upper band');
    else if (squeeze < 0.01 && currentClose > bbM) vote('bb', 'CE', 0.9, pos.toFixed(2), 'Squeeze break up');
    else if (squeeze < 0.01 && currentClose < bbM) vote('bb', 'PE', 0.9, pos.toFixed(2), 'Squeeze break down');
    else vote('bb', 'NEUTRAL', 0.4, pos.toFixed(2), 'Mid-band');
  } else {
    vote('bb', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  const vwapCur = vwap[lastIdx], vwapPrev = vwap[prevIdx];
  if (vwapCur != null && vwapPrev != null) {
    const dist = ((currentClose - vwapCur) / vwapCur) * 100;
    const firmDist = mode.id === 'scalp' ? 0.08 : 0.15;
    if (prevClose <= vwapPrev && currentClose > vwapCur) vote('vwap', 'CE', 1.4, vwapCur.toFixed(1), 'VWAP reclaim');
    else if (prevClose >= vwapPrev && currentClose < vwapCur) vote('vwap', 'PE', 1.4, vwapCur.toFixed(1), 'VWAP lost');
    else if (currentClose > vwapCur && dist > firmDist) vote('vwap', 'CE', 1.0, vwapCur.toFixed(1), 'Firmly above VWAP');
    else if (currentClose < vwapCur && dist < -firmDist) vote('vwap', 'PE', 1.0, vwapCur.toFixed(1), 'Firmly below VWAP');
    else if (currentClose > vwapCur) vote('vwap', 'CE', 0.7, vwapCur.toFixed(1), 'Above VWAP');
    else vote('vwap', 'PE', 0.7, vwapCur.toFixed(1), 'Below VWAP');
  } else {
    vote('vwap', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  if (st.direction && st.direction.length > 0) {
    const stDir = st.direction[st.direction.length - 1];
    const stPrev = st.direction.length > 1 ? st.direction[st.direction.length - 2] : stDir;
    const stVal = st.values[st.values.length - 1];
    const v = stVal != null ? stVal.toFixed(1) : '—';
    const flipW = mode.id === 'scalp' ? 2.0 : 1.7;
    if (stPrev === -1 && stDir === 1) vote('supertrend', 'CE', flipW, v, 'Flip bullish');
    else if (stPrev === 1 && stDir === -1) vote('supertrend', 'PE', flipW, v, 'Flip bearish');
    else if (stDir === 1) vote('supertrend', 'CE', 1.0, v, 'Bullish trend');
    else if (stDir === -1) vote('supertrend', 'PE', 1.0, v, 'Bearish trend');
    else vote('supertrend', 'NEUTRAL', 0.3, '—', 'Flat');
  } else {
    vote('supertrend', 'NEUTRAL', 0.3, '—', 'Warming up');
  }

  const mom = momentumPct(closes, mode.momBars);
  const bodies = candleBodyBias(candles, mode.bodyBars);
  let brainBull = 0;
  let brainBear = 0;
  const momGate = mode.id === 'scalp' ? 0.06 : 0.12;

  if (mom > momGate) brainBull += Math.min(1.4, mom * 4) * mode.momBoost;
  else if (mom < -momGate) brainBear += Math.min(1.4, Math.abs(mom) * 4) * mode.momBoost;

  if (bodies.score > 0.15) brainBull += bodies.score * (mode.id === 'scalp' ? 1.2 : 1);
  else if (bodies.score < -0.15) brainBear += Math.abs(bodies.score) * (mode.id === 'scalp' ? 1.2 : 1);

  const recent = closes.slice(-mode.structureBars);
  if (recent.length >= Math.min(4, mode.structureBars - 1)) {
    const hh = recent[recent.length - 1] > Math.max(...recent.slice(0, -1));
    const ll = recent[recent.length - 1] < Math.min(...recent.slice(0, -1));
    if (hh) brainBull += mode.id === 'scalp' ? 0.8 : 0.6;
    if (ll) brainBear += mode.id === 'scalp' ? 0.8 : 0.6;
  }

  bullScore += brainBull;
  bearScore += brainBear;
  maxScore += 2.5;

  const totalSide = bullScore + bearScore;
  const agreement = totalSide > 0 ? Math.max(bullScore, bearScore) / totalSide : 0.5;
  const dominance = maxScore > 0 ? Math.max(bullScore, bearScore) / maxScore : 0;

  let strength = Math.round(Math.min(100, (dominance * 0.65 + agreement * 0.35) * 100));
  const edge = Math.abs(bullScore - bearScore);
  if (edge < mode.chopEdge) strength = Math.min(strength, mode.leanAt);

  // Real technical bias only — no soft fake lean that fired BUY on noise
  let bias = null;
  if (bullScore > bearScore && strength >= mode.biasMin && edge >= mode.edgeMin) bias = 'bullish';
  else if (bearScore > bullScore && strength >= mode.biasMin && edge >= mode.edgeMin) bias = 'bearish';

  // Flat / synthetic bars (near-zero range) → never BUY
  const closeMin = Math.min(...closes);
  const closeMax = Math.max(...closes);
  const rangePct = closeMin > 0 ? ((closeMax - closeMin) / closeMin) * 100 : 0;
  const dataQuality = rangePct >= (mode.id === 'scalp' ? 0.15 : 0.25);
  if (!dataQuality) {
    bias = null;
    strength = Math.min(strength, mode.leanAt - 1);
  }

  const bullishCount = Math.round((bullScore / Math.max(maxScore, 1)) * 6);
  const bearishCount = Math.round((bearScore / Math.max(maxScore, 1)) * 6);

  const isStrong = strength >= mode.strongAt;
  const isActionable = strength >= mode.actionableAt;
  const isWeak = strength >= mode.leanAt && strength < mode.actionableAt;

  let direction = null;
  let action = null;
  let message = '';

  const brain = {
    momentum: Number(mom.toFixed(3)),
    candleBias: Number(bodies.score.toFixed(2)),
    bullScore: Number(bullScore.toFixed(2)),
    bearScore: Number(bearScore.toFixed(2)),
    agreement: Number(agreement.toFixed(2)),
    edge: Number(edge.toFixed(2)),
    rangePct: Number(rangePct.toFixed(3)),
    dataQuality,
    minCandles: minNeed,
    mode: mode.id
  };

  const thresholds = {
    strongAt: mode.strongAt,
    actionableAt: mode.actionableAt,
    leanAt: mode.leanAt,
    minCandles: minNeed
  };

  if (instrument.kind === 'option' && instrument.optionType) {
    const opt = instrument.optionType;
    const strikeBit = instrument.strike ? ` ${instrument.strike}` : '';
    const name = `${instrument.underlying && instrument.underlying !== 'UNKNOWN' && instrument.underlying !== 'INDEX' ? instrument.underlying + ' ' : ''}${opt}${strikeBit}`.trim();
    if (bias === 'bullish' && isActionable && dataQuality) {
      direction = opt;
      action = 'BUY';
      message = isStrong ? `STRONG BUY ${name}` : `BUY ${name}`;
    } else if (bias === 'bullish' && isWeak && dataQuality) {
      direction = opt;
      action = 'WAIT';
      message = `Lean bullish ${name} — wait ≥${mode.actionableAt}%`;
    } else if (bias === 'bearish') {
      direction = opt;
      action = 'WAIT';
      message = `WAIT — ${name} premium soft`;
    } else if (!dataQuality) {
      direction = null;
      action = 'WAIT';
      message = 'WAIT — need real price movement';
    } else {
      direction = null;
      action = 'WAIT';
      message = 'WAIT — no clear edge';
    }
  } else {
    const und = instrument.underlying && instrument.underlying !== 'UNKNOWN'
      ? instrument.underlying
      : 'INDEX';
    if (bias === 'bullish' && isActionable && dataQuality) {
      direction = 'CE';
      action = 'BUY';
      message = isStrong ? `STRONG BUY ${und} CE` : `BUY ${und} CE`;
    } else if (bias === 'bearish' && isActionable && dataQuality) {
      direction = 'PE';
      action = 'BUY';
      message = isStrong ? `STRONG BUY ${und} PE` : `BUY ${und} PE`;
    } else if (bias === 'bullish' && isWeak && dataQuality) {
      direction = 'CE';
      action = 'WAIT';
      message = `Lean CE — wait ≥${mode.actionableAt}%`;
    } else if (bias === 'bearish' && isWeak && dataQuality) {
      direction = 'PE';
      action = 'WAIT';
      message = `Lean PE — wait ≥${mode.actionableAt}%`;
    } else if (!dataQuality) {
      direction = null;
      action = 'WAIT';
      message = 'WAIT — need real price movement';
    } else {
      direction = null;
      action = 'WAIT';
      message = 'WAIT — no clear edge';
    }
  }

  return {
    direction,
    action,
    bias,
    strength,
    bullishCount,
    bearishCount,
    indicators,
    message,
    instrument,
    mode: mode.id,
    thresholds,
    brain,
    currentPrice: currentClose,
    timestamp: Date.now(),
    candleCount: candles.length
  };
}

/* ==========================================
   CSV PARSER — time,open,high,low,close[,volume]
   ========================================== */
function parseCandleCSV(text) {
  if (!text || typeof text !== 'string') {
    return { candles: [], error: 'Empty CSV' };
  }
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return { candles: [], error: 'Need header + at least one row' };
  }

  const split = (line) => {
    // handle simple commas / tabs / semicolons
    if (line.includes('\t')) return line.split('\t');
    if (line.includes(';')) return line.split(';');
    return line.split(',');
  };

  const header = split(lines[0]).map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const idx = {
    time: header.findIndex(h => /^(time|date|datetime|timestamp)$/.test(h)),
    open: header.findIndex(h => h === 'open' || h === 'o'),
    high: header.findIndex(h => h === 'high' || h === 'h'),
    low: header.findIndex(h => h === 'low' || h === 'l'),
    close: header.findIndex(h => h === 'close' || h === 'c' || h === 'ltp'),
    volume: header.findIndex(h => h === 'volume' || h === 'vol' || h === 'v')
  };

  // Headerless fallback: time,open,high,low,close[,volume]
  let startRow = 1;
  const headerless = idx.open < 0 || idx.high < 0 || idx.low < 0 || idx.close < 0;
  if (headerless) {
    const sample = split(lines[0]).map(x => x.trim());
    if (sample.length >= 5 && !isNaN(parseFloat(sample[1]))) {
      idx.time = 0;
      idx.open = 1;
      idx.high = 2;
      idx.low = 3;
      idx.close = 4;
      idx.volume = sample.length > 5 ? 5 : -1;
      startRow = 0;
    } else {
      return { candles: [], error: 'CSV needs columns: time,open,high,low,close' };
    }
  }

  const candles = [];
  for (let i = startRow; i < lines.length; i++) {
    const cols = split(lines[i]).map(c => c.trim().replace(/['"]/g, ''));
    const open = parseFloat(cols[idx.open]);
    const high = parseFloat(cols[idx.high]);
    const low = parseFloat(cols[idx.low]);
    const close = parseFloat(cols[idx.close]);
    if ([open, high, low, close].some(v => isNaN(v) || v <= 0)) continue;
    let startTime = Date.now();
    if (idx.time >= 0 && cols[idx.time]) {
      const raw = cols[idx.time];
      const asNum = Number(raw);
      if (!isNaN(asNum) && asNum > 1e9) {
        startTime = asNum < 1e12 ? asNum * 1000 : asNum;
      } else {
        const parsed = Date.parse(raw);
        if (!isNaN(parsed)) startTime = parsed;
      }
    }
    const volume = idx.volume >= 0 ? Math.max(1, parseFloat(cols[idx.volume]) || 1) : 1;
    candles.push({
      startTime,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
      complete: true
    });
  }

  candles.sort((a, b) => a.startTime - b.startTime);
  if (candles.length < 12) {
    return { candles, error: `Only ${candles.length} valid rows — need more history` };
  }
  return { candles, error: null };
}

/* ==========================================
   BACKTEST — walk-forward same generateSignals
   ========================================== */
function backtestSignals(candles, options = {}) {
  const modeId = options.mode || 'intraday';
  const mode = getModeProfile(modeId);
  const instrument = options.instrument || classifyInstrument(options.symbol || 'NIFTY');
  const holdBars = Math.max(1, parseInt(options.holdBars, 10) || (modeId === 'scalp' ? 3 : 5));
  const minNeed = mode.minCandles;
  const buyFloor = mode.actionableAt;

  if (!Array.isArray(candles) || candles.length < minNeed + holdBars + 1) {
    return {
      ok: false,
      error: `Need at least ${minNeed + holdBars + 1} candles (have ${candles ? candles.length : 0})`,
      mode: modeId,
      trades: [],
      stats: null
    };
  }

  const trades = [];
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let cooldownUntil = -1;

  for (let i = minNeed; i < candles.length - holdBars; i++) {
    if (i < cooldownUntil) continue;

    const window = candles.slice(0, i + 1);
    const result = generateSignals(window, { ...instrument, mode: modeId });
    if (!result || result.action !== 'BUY' || result.strength < buyFloor) continue;
    if (!result.direction || result.direction === 'WAIT') continue;

    const entry = candles[i].close;
    const exit = candles[i + holdBars].close;
    const move = exit - entry;

    // Index: CE profits if up, PE if down. Option BUY: premium up.
    let pnlPts;
    let side;
    if (instrument.kind === 'option') {
      side = 'BUY';
      pnlPts = move;
    } else if (result.direction === 'CE') {
      side = 'CE';
      pnlPts = move;
    } else if (result.direction === 'PE') {
      side = 'PE';
      pnlPts = -move;
    } else if (result.direction === 'BUY') {
      side = 'BUY';
      pnlPts = move;
    } else {
      continue;
    }

    equity += pnlPts;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);

    trades.push({
      index: i,
      time: candles[i].startTime,
      side,
      direction: result.direction,
      strength: result.strength,
      message: result.message,
      entry,
      exit,
      holdBars,
      pnlPts: Number(pnlPts.toFixed(2)),
      win: pnlPts > 0
    });

    // Avoid overlapping entries for cleaner stats
    cooldownUntil = i + holdBars;
  }

  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const grossWin = wins.reduce((s, t) => s + t.pnlPts, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPts, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnlPts, 0);
  const winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = trades.length ? totalPnl / trades.length : 0;

  return {
    ok: true,
    error: null,
    mode: modeId,
    instrument,
    holdBars,
    buyFloor,
    candlesUsed: candles.length,
    trades,
    stats: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: Number(winRate.toFixed(1)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      profitFactor: profitFactor === Infinity ? 999 : Number(profitFactor.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      maxDD: Number(maxDD.toFixed(2))
    }
  };
}

window.KPSignalEngine = {
  CandleCollector,
  TIMEFRAMES,
  TRADE_MODES,
  MIN_CANDLES,
  getModeProfile,
  classifyInstrument,
  computeRSI,
  computeMACD,
  computeEMA,
  computeBollingerBands,
  computeVWAP,
  computeSupertrend,
  generateSignals,
  parseCandleCSV,
  backtestSignals
};
