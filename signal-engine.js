// KitePlus Signal Engine — Multi-Indicator Confluence System
// Computes RSI, MACD, EMA Crossover, Bollinger Bands, VWAP, Supertrend
// and combines them into directional Buy CE / Buy PE signals.

/* ==========================================
   CANDLE COLLECTOR
   Builds OHLC candles from tick-level price data
   ========================================== */
class CandleCollector {
  constructor(intervalMs = 5 * 60 * 1000) {
    this.intervalMs = intervalMs;  // default 5-minute candles
    this.candles = [];
    this.currentCandle = null;
    this.tickVolume = 0;  // simulated volume from tick count
  }

  addTick(price, timestamp = Date.now()) {
    if (isNaN(price) || price <= 0) return;

    const candleStart = Math.floor(timestamp / this.intervalMs) * this.intervalMs;

    if (!this.currentCandle || this.currentCandle.startTime !== candleStart) {
      // Close previous candle
      if (this.currentCandle) {
        this.currentCandle.complete = true;
        this.candles.push({ ...this.currentCandle });
      }

      // Start new candle
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

    // Update current candle
    this.currentCandle.high = Math.max(this.currentCandle.high, price);
    this.currentCandle.low = Math.min(this.currentCandle.low, price);
    this.currentCandle.close = price;
    this.tickVolume++;
    this.currentCandle.volume = this.tickVolume;
  }

  // Get all completed candles + the current in-progress candle
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

  // Keep memory bounded — retain last N candles
  trim(maxCandles = 500) {
    if (this.candles.length > maxCandles) {
      this.candles = this.candles.slice(-maxCandles);
    }
  }

  getCandleCount() {
    return this.candles.length + (this.currentCandle ? 1 : 0);
  }

  setInterval(intervalMs) {
    // Changing interval resets all collected data
    if (intervalMs !== this.intervalMs) {
      this.intervalMs = intervalMs;
      this.candles = [];
      this.currentCandle = null;
      this.tickVolume = 0;
    }
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
   SIGNAL GENERATOR — Confluence Engine
   ========================================== */
function generateSignals(candles) {
  if (candles.length < 35) {
    // Need at least ~35 candles for MACD(26+9) to produce valid values
    return {
      direction: null,
      strength: 0,
      indicators: {},
      message: `Collecting data... (${candles.length}/35 candles)`,
      timestamp: Date.now()
    };
  }

  const closes = candles.map(c => c.close);
  const lastIdx = closes.length - 1;
  const prevIdx = lastIdx - 1;

  // --- Compute all indicators ---
  const rsiValues = computeRSI(closes, 14);
  const macd = computeMACD(closes, 12, 26, 9);
  const ema9 = computeEMA(closes, 9);
  const ema21 = computeEMA(closes, 21);
  const bb = computeBollingerBands(closes, 20, 2);
  const vwap = computeVWAP(candles);
  const st = computeSupertrend(candles, 10, 3);

  // --- Evaluate each indicator ---
  const indicators = {};
  let bullishCount = 0;
  let bearishCount = 0;

  // 1. RSI
  const rsiCurrent = rsiValues[lastIdx];
  if (rsiCurrent !== null && rsiCurrent !== undefined) {
    if (rsiCurrent < 30) {
      indicators.rsi = { value: rsiCurrent.toFixed(1), signal: 'CE', label: 'Oversold (<30)' };
      bullishCount++;
    } else if (rsiCurrent > 70) {
      indicators.rsi = { value: rsiCurrent.toFixed(1), signal: 'PE', label: 'Overbought (>70)' };
      bearishCount++;
    } else if (rsiCurrent < 45) {
      // Near oversold zone — slight bullish lean
      indicators.rsi = { value: rsiCurrent.toFixed(1), signal: 'CE', label: 'Bullish zone (<45)' };
      bullishCount++;
    } else if (rsiCurrent > 55) {
      // Near overbought zone — slight bearish lean
      indicators.rsi = { value: rsiCurrent.toFixed(1), signal: 'PE', label: 'Bearish zone (>55)' };
      bearishCount++;
    } else {
      indicators.rsi = { value: rsiCurrent.toFixed(1), signal: 'NEUTRAL', label: 'Neutral (45-55)' };
    }
  } else {
    indicators.rsi = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // 2. MACD Crossover
  const macdCurr = macd.macdLine[lastIdx];
  const macdPrev = macd.macdLine[prevIdx];
  const sigCurr = macd.signalLine[lastIdx];
  const sigPrev = macd.signalLine[prevIdx];

  if (macdCurr !== null && sigCurr !== null && macdPrev !== null && sigPrev !== null) {
    const crossUp = macdPrev <= sigPrev && macdCurr > sigCurr;
    const crossDown = macdPrev >= sigPrev && macdCurr < sigCurr;
    const aboveSignal = macdCurr > sigCurr;
    const belowSignal = macdCurr < sigCurr;

    if (crossUp) {
      indicators.macd = { value: macdCurr.toFixed(2), signal: 'CE', label: 'Bullish crossover ↑' };
      bullishCount++;
    } else if (crossDown) {
      indicators.macd = { value: macdCurr.toFixed(2), signal: 'PE', label: 'Bearish crossover ↓' };
      bearishCount++;
    } else if (aboveSignal) {
      indicators.macd = { value: macdCurr.toFixed(2), signal: 'CE', label: 'Above signal line' };
      bullishCount++;
    } else if (belowSignal) {
      indicators.macd = { value: macdCurr.toFixed(2), signal: 'PE', label: 'Below signal line' };
      bearishCount++;
    } else {
      indicators.macd = { value: macdCurr.toFixed(2), signal: 'NEUTRAL', label: 'At signal line' };
    }
  } else {
    indicators.macd = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // 3. EMA 9/21 Crossover
  const ema9Curr = ema9[lastIdx];
  const ema9Prev = ema9[prevIdx];
  const ema21Curr = ema21[lastIdx];
  const ema21Prev = ema21[prevIdx];

  if (ema9Curr !== null && ema21Curr !== null && ema9Prev !== null && ema21Prev !== null) {
    const crossUp = ema9Prev <= ema21Prev && ema9Curr > ema21Curr;
    const crossDown = ema9Prev >= ema21Prev && ema9Curr < ema21Curr;
    const above = ema9Curr > ema21Curr;

    if (crossUp) {
      indicators.ema = { value: `${ema9Curr.toFixed(1)}/${ema21Curr.toFixed(1)}`, signal: 'CE', label: 'Golden cross ↑' };
      bullishCount++;
    } else if (crossDown) {
      indicators.ema = { value: `${ema9Curr.toFixed(1)}/${ema21Curr.toFixed(1)}`, signal: 'PE', label: 'Death cross ↓' };
      bearishCount++;
    } else if (above) {
      indicators.ema = { value: `${ema9Curr.toFixed(1)}/${ema21Curr.toFixed(1)}`, signal: 'CE', label: 'EMA9 > EMA21' };
      bullishCount++;
    } else {
      indicators.ema = { value: `${ema9Curr.toFixed(1)}/${ema21Curr.toFixed(1)}`, signal: 'PE', label: 'EMA9 < EMA21' };
      bearishCount++;
    }
  } else {
    indicators.ema = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // 4. Bollinger Bands
  const bbUpper = bb.upper[lastIdx];
  const bbLower = bb.lower[lastIdx];
  const bbMiddle = bb.middle[lastIdx];
  const currentClose = closes[lastIdx];
  const prevClose = closes[prevIdx];

  if (bbUpper !== null && bbLower !== null) {
    const bbWidth = bbUpper - bbLower;
    const positionInBand = bbWidth > 0 ? (currentClose - bbLower) / bbWidth : 0.5;

    if (currentClose <= bbLower && currentClose > prevClose) {
      // Touched lower band + reversal candle → bullish
      indicators.bb = { value: positionInBand.toFixed(2), signal: 'CE', label: 'Lower band bounce ↑' };
      bullishCount++;
    } else if (currentClose >= bbUpper && currentClose < prevClose) {
      // Touched upper band + reversal candle → bearish
      indicators.bb = { value: positionInBand.toFixed(2), signal: 'PE', label: 'Upper band rejection ↓' };
      bearishCount++;
    } else if (positionInBand < 0.3) {
      indicators.bb = { value: positionInBand.toFixed(2), signal: 'CE', label: 'Near lower band' };
      bullishCount++;
    } else if (positionInBand > 0.7) {
      indicators.bb = { value: positionInBand.toFixed(2), signal: 'PE', label: 'Near upper band' };
      bearishCount++;
    } else {
      indicators.bb = { value: positionInBand.toFixed(2), signal: 'NEUTRAL', label: 'Mid-band range' };
    }
  } else {
    indicators.bb = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // 5. VWAP
  const vwapCurrent = vwap[lastIdx];
  const vwapPrev = vwap[prevIdx];

  if (vwapCurrent !== undefined && vwapPrev !== undefined) {
    const crossAbove = prevClose <= vwapPrev && currentClose > vwapCurrent;
    const crossBelow = prevClose >= vwapPrev && currentClose < vwapCurrent;
    const aboveVwap = currentClose > vwapCurrent;

    if (crossAbove) {
      indicators.vwap = { value: vwapCurrent.toFixed(1), signal: 'CE', label: 'Crossed above VWAP ↑' };
      bullishCount++;
    } else if (crossBelow) {
      indicators.vwap = { value: vwapCurrent.toFixed(1), signal: 'PE', label: 'Crossed below VWAP ↓' };
      bearishCount++;
    } else if (aboveVwap) {
      indicators.vwap = { value: vwapCurrent.toFixed(1), signal: 'CE', label: 'Above VWAP' };
      bullishCount++;
    } else {
      indicators.vwap = { value: vwapCurrent.toFixed(1), signal: 'PE', label: 'Below VWAP' };
      bearishCount++;
    }
  } else {
    indicators.vwap = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // 6. Supertrend
  if (st.direction && st.direction.length > 0) {
    const stDir = st.direction[st.direction.length - 1];
    const stPrev = st.direction.length > 1 ? st.direction[st.direction.length - 2] : stDir;
    const stVal = st.values[st.values.length - 1];

    const flipBullish = stPrev === -1 && stDir === 1;
    const flipBearish = stPrev === 1 && stDir === -1;

    if (flipBullish) {
      indicators.supertrend = { value: stVal ? stVal.toFixed(1) : '—', signal: 'CE', label: 'Flipped BULLISH 🟢' };
      bullishCount++;
    } else if (flipBearish) {
      indicators.supertrend = { value: stVal ? stVal.toFixed(1) : '—', signal: 'PE', label: 'Flipped BEARISH 🔴' };
      bearishCount++;
    } else if (stDir === 1) {
      indicators.supertrend = { value: stVal ? stVal.toFixed(1) : '—', signal: 'CE', label: 'Bullish trend' };
      bullishCount++;
    } else if (stDir === -1) {
      indicators.supertrend = { value: stVal ? stVal.toFixed(1) : '—', signal: 'PE', label: 'Bearish trend' };
      bearishCount++;
    } else {
      indicators.supertrend = { value: '—', signal: 'NEUTRAL', label: 'Calculating...' };
    }
  } else {
    indicators.supertrend = { value: '—', signal: 'NEUTRAL', label: 'Insufficient data' };
  }

  // --- Confluence Score ---
  const totalIndicators = 6;
  const activeCount = bullishCount + bearishCount;
  let direction = null;
  let strength = 0;
  let message = '';

  if (bullishCount >= 5) {
    direction = 'CE';
    strength = Math.round((bullishCount / totalIndicators) * 100);
    message = bullishCount === 6 ? '🔥 STRONG BUY CE' : '⚡ BUY CE';
  } else if (bearishCount >= 5) {
    direction = 'PE';
    strength = Math.round((bearishCount / totalIndicators) * 100);
    message = bearishCount === 6 ? '🔥 STRONG BUY PE' : '⚡ BUY PE';
  } else if (bullishCount === 4) {
    direction = 'CE';
    strength = Math.round((bullishCount / totalIndicators) * 100);
    message = '⚠️ Weak CE bias';
  } else if (bearishCount === 4) {
    direction = 'PE';
    strength = Math.round((bearishCount / totalIndicators) * 100);
    message = '⚠️ Weak PE bias';
  } else {
    direction = null;
    strength = Math.round((Math.max(bullishCount, bearishCount) / totalIndicators) * 100);
    message = '— No clear signal';
  }

  return {
    direction,
    strength,
    bullishCount,
    bearishCount,
    indicators,
    message,
    currentPrice: closes[lastIdx],
    timestamp: Date.now()
  };
}

// Export for content script usage — attach to window for cross-file access
window.KPSignalEngine = {
  CandleCollector,
  computeRSI,
  computeMACD,
  computeEMA,
  computeBollingerBands,
  computeVWAP,
  computeSupertrend,
  generateSignals
};
