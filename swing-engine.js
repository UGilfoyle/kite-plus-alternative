// KitePlus Swing Engine — Structure-Based Swing Trading System
// Port of TradingView Pine Script "Stock Swing Pro - Structure + 1:2 RR"
// Supports LONG and SHORT signals with structural stop-loss and exact R:R targets.
// Works across Kite, Upstox, and Dhan via the KitePlus extension pipeline.
(function (global) {
  'use strict';

  /* ==========================================
     UTILITIES
     ========================================== */

  function finite(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function round(v, d) {
    if (!finite(v)) return null;
    var f = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * f) / f;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ==========================================
     INDICATOR: EMA (Exponential Moving Average)
     ========================================== */
  function computeEMA(values, period) {
    var out = new Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += Number(values[i]);
    var ema = sum / period;
    out[period - 1] = ema;
    var k = 2 / (period + 1);
    for (var j = period; j < values.length; j++) {
      ema = (Number(values[j]) - ema) * k + ema;
      out[j] = ema;
    }
    return out;
  }

  /* ==========================================
     INDICATOR: SMA (Simple Moving Average)
     ========================================== */
  function computeSMA(values, period) {
    var out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += Number(values[i]);
    out[period - 1] = sum / period;
    for (var j = period; j < values.length; j++) {
      sum += Number(values[j]) - Number(values[j - period]);
      out[j] = sum / period;
    }
    return out;
  }

  /* ==========================================
     INDICATOR: RSI (Relative Strength Index)
     Wilder's smoothing — matches Pine Script ta.rsi
     ========================================== */
  function computeRSI(closes, period) {
    period = period || 14;
    var out = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return out;
    var gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var ch = closes[i] - closes[i - 1];
      if (ch >= 0) gains += ch; else losses += Math.abs(ch);
    }
    var avgGain = gains / period;
    var avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (var j = period + 1; j < closes.length; j++) {
      var c = closes[j] - closes[j - 1];
      avgGain = (avgGain * (period - 1) + Math.max(0, c)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -c)) / period;
      out[j] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /* ==========================================
     INDICATOR: ATR (Average True Range)
     Wilder's smoothing — matches Pine Script ta.atr
     ========================================== */
  function computeATR(candles, period) {
    period = period || 14;
    var out = new Array(candles.length).fill(null);
    if (candles.length < period) return out;
    var tr = candles.map(function (c, i) {
      if (i === 0) return c.high - c.low;
      return Math.max(
        c.high - c.low,
        Math.abs(c.high - candles[i - 1].close),
        Math.abs(c.low - candles[i - 1].close)
      );
    });
    var sum = 0;
    for (var i = 0; i < period; i++) sum += tr[i];
    out[period - 1] = sum / period;
    for (var j = period; j < candles.length; j++) {
      out[j] = (out[j - 1] * (period - 1) + tr[j]) / period;
    }
    return out;
  }

  /* ==========================================
     INDICATOR: ADX / DI+ / DI-
     Matches Pine Script ta.dmi(len, len)
     ========================================== */
  function computeADX(candles, period) {
    period = period || 14;
    var len = candles.length;
    var diPlus = new Array(len).fill(null);
    var diMinus = new Array(len).fill(null);
    var adx = new Array(len).fill(null);

    if (len < period + 1) return { diPlus: diPlus, diMinus: diMinus, adx: adx };

    // True Range, +DM, -DM series
    var tr = new Array(len).fill(0);
    var dmPlus = new Array(len).fill(0);
    var dmMinus = new Array(len).fill(0);

    for (var i = 1; i < len; i++) {
      var hi = candles[i].high;
      var lo = candles[i].low;
      var prevHi = candles[i - 1].high;
      var prevLo = candles[i - 1].low;
      var prevCl = candles[i - 1].close;

      tr[i] = Math.max(hi - lo, Math.abs(hi - prevCl), Math.abs(lo - prevCl));

      var upMove = hi - prevHi;
      var downMove = prevLo - lo;

      dmPlus[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
      dmMinus[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
    }

    // Wilder's smoothing for TR, +DM, -DM
    var smoothTR = 0, smoothDMPlus = 0, smoothDMMinus = 0;
    for (var k = 1; k <= period; k++) {
      smoothTR += tr[k];
      smoothDMPlus += dmPlus[k];
      smoothDMMinus += dmMinus[k];
    }

    // First DI values at index = period
    if (smoothTR > 0) {
      diPlus[period] = (smoothDMPlus / smoothTR) * 100;
      diMinus[period] = (smoothDMMinus / smoothTR) * 100;
    } else {
      diPlus[period] = 0;
      diMinus[period] = 0;
    }

    // Smoothed DI values
    for (var m = period + 1; m < len; m++) {
      smoothTR = smoothTR - (smoothTR / period) + tr[m];
      smoothDMPlus = smoothDMPlus - (smoothDMPlus / period) + dmPlus[m];
      smoothDMMinus = smoothDMMinus - (smoothDMMinus / period) + dmMinus[m];

      diPlus[m] = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
      diMinus[m] = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;
    }

    // DX and ADX
    var dx = new Array(len).fill(null);
    for (var n = period; n < len; n++) {
      if (diPlus[n] != null && diMinus[n] != null) {
        var diSum = diPlus[n] + diMinus[n];
        dx[n] = diSum > 0 ? (Math.abs(diPlus[n] - diMinus[n]) / diSum) * 100 : 0;
      }
    }

    // First ADX = SMA of first `period` DX values
    var dxStart = period;
    var dxCount = 0, dxSum = 0;
    for (var p = dxStart; p < len && dxCount < period; p++) {
      if (dx[p] != null) {
        dxSum += dx[p];
        dxCount++;
      }
    }
    var adxFirstIdx = dxStart + dxCount - 1;
    if (dxCount === period && adxFirstIdx < len) {
      adx[adxFirstIdx] = dxSum / period;
      // Wilder's smoothed ADX
      for (var q = adxFirstIdx + 1; q < len; q++) {
        if (dx[q] != null && adx[q - 1] != null) {
          adx[q] = (adx[q - 1] * (period - 1) + dx[q]) / period;
        }
      }
    }

    return { diPlus: diPlus, diMinus: diMinus, adx: adx };
  }

  /* ==========================================
     CANDLE VALIDATION
     ========================================== */
  function validCandles(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.filter(function (c) {
      return c && finite(c.open) && finite(c.high) && finite(c.low) && finite(c.close) &&
        c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0;
    }).map(function (c) {
      return {
        startTime: c.startTime || c.time || c.timestamp || Date.now(),
        open: c.open,
        high: Math.max(c.high, c.open, c.close),
        low: Math.min(c.low, c.open, c.close),
        close: c.close,
        volume: finite(c.volume) ? Math.max(0, c.volume) : 0,
        complete: c.complete !== false
      };
    });
  }

  /* ==========================================
     SWING SIGNAL DEFAULTS
     ========================================== */
  var DEFAULTS = {
    emaFastLen: 20,
    emaMidLen: 50,
    emaSlowLen: 200,
    rsiLen: 14,
    rsiLongMin: 50,
    rsiLongMax: 68,
    rsiShortMin: 32,
    rsiShortMax: 50,
    volLen: 20,
    volMinRatio: 1.10,
    structureLen: 20,
    swingLen: 10,
    atrLen: 14,
    atrBuffer: 0.25,
    minRR: 2.0,
    maxRiskATR: 3.5,
    minimumScore: 8.0,
    adxLen: 14,
    adxMin: 16.0,
    roomLookback: 60
  };

  /* ==========================================
     MAIN SIGNAL GENERATOR
     generateSwingSignal(candles, options)
     ========================================== */
  function generateSwingSignal(candles, options) {
    var opts = {};
    var d = DEFAULTS;
    if (options) {
      for (var key in DEFAULTS) {
        opts[key] = options[key] != null ? options[key] : d[key];
      }
    } else {
      for (var k2 in DEFAULTS) opts[k2] = d[k2];
    }

    var source = validCandles(candles);

    // Adaptive minimum bars: can run with >= 45 bars (full EMA20/50, RSI, ADX, ATR, Structure)
    // and seamlessly scales to 200+ bars when deep history is present.
    var minBars = 45;
    if (source.length < minBars) {
      return {
        status: 'collecting',
        message: 'Need ' + minBars + ' candles (have ' + source.length + ')',
        longSignal: false,
        shortSignal: false,
        longScore: 0,
        shortScore: 0,
        dashboard: null,
        trade: null,
        candleCount: source.length,
        minCandles: minBars,
        timestamp: Date.now()
      };
    }

    var closes = source.map(function (c) { return c.close; });
    var highs = source.map(function (c) { return c.high; });
    var lows = source.map(function (c) { return c.low; });
    var volumes = source.map(function (c) { return c.volume; });
    var last = source.length - 1;
    var price = closes[last];

    // ==========================================
    // INDICATORS
    // ==========================================

    var ema20 = computeEMA(closes, opts.emaFastLen);
    var ema50 = computeEMA(closes, opts.emaMidLen);
    // Adaptive EMA200: if < 200 bars available, compute EMA over the longest available baseline
    var slowPeriod = Math.min(opts.emaSlowLen, closes.length >= 100 ? closes.length : opts.emaSlowLen);
    var ema200 = closes.length >= 60 ? computeEMA(closes, slowPeriod) : ema50;
    var rsiValues = computeRSI(closes, opts.rsiLen);
    var volSMA = computeSMA(volumes, opts.volLen);
    var atrValues = computeATR(source, opts.atrLen);
    var adxResult = computeADX(source, opts.adxLen);

    var e20 = ema20[last];
    var e50 = ema50[last];
    var e200 = ema200[last];
    var rsi = rsiValues[last];
    var atr = atrValues[last];
    var vol = volumes[last];
    var volAvg = volSMA[last];
    var adxVal = adxResult.adx[last];
    var diP = adxResult.diPlus[last];
    var diM = adxResult.diMinus[last];

    // Volume ratio (if volume feed is missing/zero, treat as normal 1.0x)
    var volRatio = volAvg && volAvg > 0 ? vol / volAvg : 1.0;
    var volumeConfirmed = volRatio >= opts.volMinRatio;

    // ==========================================
    // TREND CONDITIONS
    // ==========================================

    var strongBullTrend = e20 != null && e50 != null && (e200 == null || (e20 > e50 && e50 > e200));
    var bullTrend = e20 != null && e50 != null && e20 > e50;
    var strongBearTrend = e20 != null && e50 != null && (e200 == null || (e20 < e50 && e50 < e200));
    var bearTrend = e20 != null && e50 != null && e20 < e50;
    var priceAbove200 = e200 != null ? price > e200 : (e50 != null && price > e50);
    var priceBelow200 = e200 != null ? price < e200 : (e50 != null && price < e50);

    // ==========================================
    // STRUCTURE
    // ==========================================

    // Previous resistance/support — lookback excluding current bar
    var structLen = Math.min(opts.structureLen, last);
    var structStart = Math.max(0, last - structLen);
    var prevResistance = -Infinity;
    var prevSupport = Infinity;
    for (var si = structStart; si < last; si++) {
      if (highs[si] > prevResistance) prevResistance = highs[si];
      if (lows[si] < prevSupport) prevSupport = lows[si];
    }

    // Recent swing levels for stops — lookback excluding current bar
    var swingLen = Math.min(opts.swingLen, last);
    var swingStart = Math.max(0, last - swingLen);
    var recentSwingLow = Infinity;
    var recentSwingHigh = -Infinity;
    for (var swi = swingStart; swi < last; swi++) {
      if (lows[swi] < recentSwingLow) recentSwingLow = lows[swi];
      if (highs[swi] > recentSwingHigh) recentSwingHigh = highs[swi];
    }
    if (!isFinite(recentSwingLow)) recentSwingLow = lows[last] * 0.98;
    if (!isFinite(recentSwingHigh)) recentSwingHigh = highs[last] * 1.02;

    // Breakouts
    var bullBreakout = price >= prevResistance * 0.998 && (closes[last - 1] <= prevResistance * 1.002 || highs[last] >= prevResistance);
    var bearBreakdown = price <= prevSupport * 1.002 && (closes[last - 1] >= prevSupport * 0.998 || lows[last] <= prevSupport);

    // Pullback / reclaim: price touched or dipped near EMA20 in last 2 bars and closed above EMA20 with green candle
    var touchedEma20Long = e20 != null && (lows[last] <= e20 * 1.012 || lows[Math.max(0, last - 1)] <= e20 * 1.012);
    var bullPullback = touchedEma20Long && price >= e20 && closes[last] >= source[last].open * 0.998;

    var touchedEma20Short = e20 != null && (highs[last] >= e20 * 0.988 || highs[Math.max(0, last - 1)] >= e20 * 0.988);
    var bearPullback = touchedEma20Short && price <= e20 && closes[last] <= source[last].open * 1.002;

    // Price structure confirmation
    var bullStructure = e50 != null && price > e50;
    var bearStructure = e50 != null && price < e50;

    // ==========================================
    // MOMENTUM
    // ==========================================

    var bullMomentumPower = rsi != null && rsi >= opts.rsiLongMin && rsi <= opts.rsiLongMax;
    var bullMomentumAccept = rsi != null && rsi >= 48 && rsi <= 74;
    var bearMomentumPower = rsi != null && rsi >= opts.rsiShortMin && rsi <= opts.rsiShortMax;
    var bearMomentumAccept = rsi != null && rsi >= 26 && rsi <= 52;

    var bullADXPower = adxVal != null && diP != null && diM != null && adxVal >= 20 && diP > diM;
    var bullADXAccept = adxVal != null && diP != null && diM != null && (adxVal >= opts.adxMin || diP > diM);
    var bearADXPower = adxVal != null && diP != null && diM != null && adxVal >= 20 && diM > diP;
    var bearADXAccept = adxVal != null && diP != null && diM != null && (adxVal >= opts.adxMin || diM > diP);

    // ==========================================
    // SETUP QUALITY
    // ==========================================

    var longSetup = bullBreakout || bullPullback;
    var shortSetup = bearBreakdown || bearPullback;

    // ==========================================
    // OPTIMIZED 10-POINT SCORE ENGINE
    // Breakdown (sums to 10.0):
    // - Trend EMA Stack: 2.5 pts
    // - Macro Baseline (Price vs EMA200): 1.5 pts
    // - Momentum Sweet Spot (RSI 14): 1.5 pts
    // - Volume Expansion: 1.5 pts
    // - ADX Power & Direction: 1.5 pts
    // - Structure Position (Above EMA50 & EMA20): 0.5 pt
    // - Setup / Trigger (Breakout / Pullback): 1.0 pt
    // ==========================================

    var longScore = 0;
    // 1. Trend (max 2.5)
    longScore += strongBullTrend ? 2.5 : bullTrend ? 1.5 : 0;
    // 2. Macro (max 1.5)
    longScore += priceAbove200 ? 1.5 : 0;
    // 3. Momentum (max 1.5)
    longScore += bullMomentumPower ? 1.5 : bullMomentumAccept ? 1.0 : 0;
    // 4. Volume (max 1.5)
    longScore += volRatio >= 1.4 ? 1.5 : volRatio >= 1.05 ? 1.0 : volRatio >= 0.85 ? 0.5 : 0;
    // 5. ADX / Direction (max 1.5)
    longScore += bullADXPower ? 1.5 : bullADXAccept ? 1.0 : (diP != null && diM != null && diP > diM ? 0.5 : 0);
    // 6. Structure Position (max 0.5)
    longScore += (bullStructure && e20 != null && price > e20) ? 0.5 : 0;
    // 7. Trigger Setup (max 1.0)
    longScore += bullBreakout ? 1.0 : bullPullback ? 1.0 : 0;

    var shortScore = 0;
    // 1. Trend (max 2.5)
    shortScore += strongBearTrend ? 2.5 : bearTrend ? 1.5 : 0;
    // 2. Macro (max 1.5)
    shortScore += priceBelow200 ? 1.5 : 0;
    // 3. Momentum (max 1.5)
    shortScore += bearMomentumPower ? 1.5 : bearMomentumAccept ? 1.0 : 0;
    // 4. Volume (max 1.5)
    shortScore += volRatio >= 1.4 ? 1.5 : volRatio >= 1.05 ? 1.0 : volRatio >= 0.85 ? 0.5 : 0;
    // 5. ADX / Direction (max 1.5)
    shortScore += bearADXPower ? 1.5 : bearADXAccept ? 1.0 : (diM != null && diP != null && diM > diP ? 0.5 : 0);
    // 6. Structure Position (max 0.5)
    shortScore += (bearStructure && e20 != null && price < e20) ? 0.5 : 0;
    // 7. Trigger Setup (max 1.0)
    shortScore += bearBreakdown ? 1.0 : bearPullback ? 1.0 : 0;

    longScore = clamp(round(longScore, 1), 0, 10.0);
    shortScore = clamp(round(shortScore, 1), 0, 10.0);

    // ==========================================
    // ENTRY + STRUCTURAL STOP (Bounded for optimal 1:2 R:R)
    // ==========================================

    var safeAtr = (atr && atr > 0) ? atr : (price * 0.015);
    // Structural stop: place below recent swing low or EMA20 buffer, bounded by max ATR risk
    var rawLongSL = Math.min(recentSwingLow - safeAtr * opts.atrBuffer, (e20 != null ? e20 - safeAtr * opts.atrBuffer : recentSwingLow));
    var longSL = Math.max(rawLongSL, price - safeAtr * opts.maxRiskATR);
    var longRisk = price - longSL;

    var rawShortSL = Math.max(recentSwingHigh + safeAtr * opts.atrBuffer, (e20 != null ? e20 + safeAtr * opts.atrBuffer : recentSwingHigh));
    var shortSL = Math.min(rawShortSL, price + safeAtr * opts.maxRiskATR);
    var shortRisk = shortSL - price;

    var validLongRisk = longRisk > 0 && longRisk >= price * 0.002;
    var validShortRisk = shortRisk > 0 && shortRisk >= price * 0.002;
    var longRiskOK = validLongRisk && longRisk <= safeAtr * (opts.maxRiskATR + 0.5);
    var shortRiskOK = validShortRisk && shortRisk <= safeAtr * (opts.maxRiskATR + 0.5);

    // ==========================================
    // 1:2 TARGETS
    // ==========================================

    var longT1 = validLongRisk ? price + longRisk * opts.minRR : null;
    var shortT1 = validShortRisk ? price - shortRisk * opts.minRR : null;

    // ==========================================
    // ROOM CHECK
    // ==========================================

    var roomLen = Math.min(opts.roomLookback, last);
    var roomStart = Math.max(0, last - roomLen);
    var longResistance = -Infinity;
    var shortSupportLevel = Infinity;
    for (var ri = roomStart; ri < last; ri++) {
      if (highs[ri] > longResistance) longResistance = highs[ri];
      if (lows[ri] < shortSupportLevel) shortSupportLevel = lows[ri];
    }

    var longRoomOK = longResistance <= price * 1.002 || (longT1 != null && longT1 < longResistance * 1.05);
    var shortRoomOK = shortSupportLevel >= price * 0.998 || (shortT1 != null && shortT1 > shortSupportLevel * 0.95);

    // ==========================================
    // SETUP VALIDATION (Score >= 8.0 required)
    // ==========================================

    var longValid = longScore >= opts.minimumScore &&
      longSetup && validLongRisk && longRiskOK && longRoomOK &&
      bullTrend && priceAbove200;

    var shortValid = shortScore >= opts.minimumScore &&
      shortSetup && validShortRisk && shortRiskOK && shortRoomOK &&
      bearTrend && priceBelow200;

    // ==========================================
    // TRADE STATE — avoid repeated signals
    // Use persistent state stored externally via options.tradeState
    // ==========================================

    var state = (options && options.tradeState) || { direction: 0 };
    // 0 = neutral, 1 = long, -1 = short

    var newLong = longValid && state.direction !== 1;
    var newShort = shortValid && state.direction !== -1;

    var activeEntry = state.activeEntry || null;
    var activeSL = state.activeSL || null;
    var activeT1 = state.activeT1 || null;
    var activeScore = state.activeScore || null;
    var activeDirection = state.activeDirection || 'NONE';

    if (newLong) {
      state.direction = 1;
      activeEntry = price;
      activeSL = longSL;
      activeT1 = longT1;
      activeScore = longScore;
      activeDirection = 'LONG';
    } else if (newShort) {
      state.direction = -1;
      activeEntry = price;
      activeSL = shortSL;
      activeT1 = shortT1;
      activeScore = shortScore;
      activeDirection = 'SHORT';
    }

    // Exit / invalidation
    var slHit = false;
    var t1Hit = false;
    if (state.direction === 1 && activeSL != null) {
      if (lows[last] <= activeSL) { slHit = true; state.direction = 0; }
      else if (activeT1 != null && highs[last] >= activeT1) { t1Hit = true; state.direction = 0; }
    }
    if (state.direction === -1 && activeSL != null) {
      if (highs[last] >= activeSL) { slHit = true; state.direction = 0; }
      else if (activeT1 != null && lows[last] <= activeT1) { t1Hit = true; state.direction = 0; }
    }

    // Store active levels back into state
    state.activeEntry = state.direction !== 0 ? activeEntry : null;
    state.activeSL = state.direction !== 0 ? activeSL : null;
    state.activeT1 = state.direction !== 0 ? activeT1 : null;
    state.activeScore = state.direction !== 0 ? activeScore : null;
    state.activeDirection = state.direction !== 0 ? activeDirection : 'NONE';

    // ==========================================
    // TREND LABEL
    // ==========================================
    var trendLabel = strongBullTrend ? 'STRONG BULL'
      : bullTrend ? 'BULL'
        : strongBearTrend ? 'STRONG BEAR'
          : bearTrend ? 'BEAR' : 'NEUTRAL';

    var trendBias = (strongBullTrend || bullTrend) ? 'bullish'
      : (strongBearTrend || bearTrend) ? 'bearish' : 'neutral';

    // ==========================================
    // STATUS
    // ==========================================
    var statusText, action;
    if (newLong) {
      statusText = 'BUY / LONG';
      action = 'LONG';
    } else if (newShort) {
      statusText = 'SELL / SHORT';
      action = 'SHORT';
    } else if (state.direction === 1) {
      statusText = 'LONG ACTIVE';
      action = 'HOLD_LONG';
    } else if (state.direction === -1) {
      statusText = 'SHORT ACTIVE';
      action = 'HOLD_SHORT';
    } else if (slHit) {
      statusText = 'SL HIT — WAIT';
      action = 'WAIT';
    } else if (t1Hit) {
      statusText = 'TARGET HIT ✓';
      action = 'WAIT';
    } else {
      statusText = 'WAIT';
      action = 'WAIT';
    }

    // ==========================================
    // SCORE BREAKDOWN (for dashboard, max 10.0)
    // ==========================================
    var longBreakdown = [
      { label: 'EMA Stack', score: strongBullTrend ? 2.5 : bullTrend ? 1.5 : 0, max: 2.5 },
      { label: 'Price > EMA200', score: priceAbove200 ? 1.5 : 0, max: 1.5 },
      { label: 'RSI Zone', score: bullMomentumPower ? 1.5 : bullMomentumAccept ? 1.0 : 0, max: 1.5 },
      { label: 'Volume', score: volRatio >= 1.4 ? 1.5 : volRatio >= 1.05 ? 1.0 : volRatio >= 0.85 ? 0.5 : 0, max: 1.5 },
      { label: 'ADX+DI', score: bullADXPower ? 1.5 : bullADXAccept ? 1.0 : (diP != null && diM != null && diP > diM ? 0.5 : 0), max: 1.5 },
      { label: 'Structure', score: (bullStructure && e20 != null && price > e20) ? 0.5 : 0, max: 0.5 },
      { label: 'Breakout/Pullback', score: bullBreakout ? 1.0 : bullPullback ? 1.0 : 0, max: 1.0 }
    ];

    var shortBreakdown = [
      { label: 'EMA Stack', score: strongBearTrend ? 2.5 : bearTrend ? 1.5 : 0, max: 2.5 },
      { label: 'Price < EMA200', score: priceBelow200 ? 1.5 : 0, max: 1.5 },
      { label: 'RSI Zone', score: bearMomentumPower ? 1.5 : bearMomentumAccept ? 1.0 : 0, max: 1.5 },
      { label: 'Volume', score: volRatio >= 1.4 ? 1.5 : volRatio >= 1.05 ? 1.0 : volRatio >= 0.85 ? 0.5 : 0, max: 1.5 },
      { label: 'ADX+DI', score: bearADXPower ? 1.5 : bearADXAccept ? 1.0 : (diM != null && diP != null && diM > diP ? 0.5 : 0), max: 1.5 },
      { label: 'Structure', score: (bearStructure && e20 != null && price < e20) ? 0.5 : 0, max: 0.5 },
      { label: 'Breakdown/Pullback', score: bearBreakdown ? 1.0 : bearPullback ? 1.0 : 0, max: 1.0 }
    ];

    // ==========================================
    // CHECKLIST (validation gates)
    // ==========================================
    var dominantSide = longScore >= shortScore ? 'long' : 'short';
    var dScore = dominantSide === 'long' ? longScore : shortScore;
    var dSetup = dominantSide === 'long' ? longSetup : shortSetup;
    var dRiskOK = dominantSide === 'long' ? longRiskOK : shortRiskOK;
    var dRoomOK = dominantSide === 'long' ? longRoomOK : shortRoomOK;
    var dTrend = dominantSide === 'long' ? (bullTrend && priceAbove200) : (bearTrend && priceBelow200);

    var checklist = [
      { id: 'score', label: 'Rating ≥ ' + opts.minimumScore, pass: dScore >= opts.minimumScore, detail: round(dScore, 1) + ' / ' + opts.minimumScore },
      { id: 'setup', label: 'Breakout or Pullback', pass: !!dSetup, detail: dSetup ? 'YES' : 'NO' },
      { id: 'risk', label: 'Stop within ' + opts.maxRiskATR + 'x ATR', pass: !!dRiskOK, detail: dRiskOK ? 'OK' : 'TOO WIDE' },
      { id: 'room', label: 'Target has room', pass: !!dRoomOK, detail: dRoomOK ? 'CLEAR' : 'BLOCKED' },
      { id: 'trend', label: 'Trend alignment', pass: !!dTrend, detail: dTrend ? 'ALIGNED' : 'NOT ALIGNED' }
    ];

    // ==========================================
    // DASHBOARD DATA
    // ==========================================
    var dashboard = {
      trend: trendLabel,
      trendBias: trendBias,
      ema20: round(e20, 2),
      ema50: round(e50, 2),
      ema200: round(e200, 2),
      emaStack: e20 != null && e50 != null ? (e20 > e50 ? '20 > 50' : '20 < 50') : '—',
      rsi: round(rsi, 1),
      volumeRatio: round(volRatio, 2),
      adx: round(adxVal, 1),
      diPlus: round(diP, 1),
      diMinus: round(diM, 1),
      atr: round(atr, 2),
      longScore: round(longScore, 1),
      shortScore: round(shortScore, 1),
      longBreakdown: longBreakdown,
      shortBreakdown: shortBreakdown,
      minimumScore: opts.minimumScore
    };

    // ==========================================
    // TRADE (active levels)
    // ==========================================
    var trade = null;
    if (state.direction !== 0 && state.activeEntry != null) {
      var risk = state.activeDirection === 'LONG'
        ? state.activeEntry - state.activeSL
        : state.activeSL - state.activeEntry;
      trade = {
        direction: state.activeDirection,
        entry: round(state.activeEntry, 2),
        stopLoss: round(state.activeSL, 2),
        target1: round(state.activeT1, 2),
        rating: round(state.activeScore, 1),
        risk: round(risk, 2),
        reward: round(risk * opts.minRR, 2),
        rr: '1:' + opts.minRR
      };
    }

    // Fresh signal trade card (for new signals)
    var signalTrade = null;
    if (newLong) {
      signalTrade = {
        direction: 'LONG',
        entry: round(price, 2),
        stopLoss: round(longSL, 2),
        target1: round(longT1, 2),
        rating: round(longScore, 1),
        risk: round(longRisk, 2),
        reward: round(longRisk * opts.minRR, 2),
        rr: '1:' + opts.minRR
      };
    } else if (newShort) {
      signalTrade = {
        direction: 'SHORT',
        entry: round(price, 2),
        stopLoss: round(shortSL, 2),
        target1: round(shortT1, 2),
        rating: round(shortScore, 1),
        risk: round(shortRisk, 2),
        reward: round(shortRisk * opts.minRR, 2),
        rr: '1:' + opts.minRR
      };
    }

    // ==========================================
    // COACH TIP
    // ==========================================
    var coachTip = '';
    if (newLong) {
      coachTip = 'LONG triggered — enter at ' + round(price, 2) + ', SL at ' + round(longSL, 2) + ', Target ' + round(longT1, 2) + '. Trail stop after 1:1.';
    } else if (newShort) {
      coachTip = 'SHORT triggered — enter at ' + round(price, 2) + ', SL at ' + round(shortSL, 2) + ', Target ' + round(shortT1, 2) + '. Trail stop after 1:1.';
    } else if (state.direction === 1) {
      coachTip = 'LONG active — hold above ' + round(activeSL, 2) + '. Move SL to breakeven after 1:1.';
    } else if (state.direction === -1) {
      coachTip = 'SHORT active — hold below ' + round(activeSL, 2) + '. Move SL to breakeven after 1:1.';
    } else if (slHit) {
      coachTip = 'Stop-loss hit. Journal the trade and wait for next clean setup.';
    } else if (t1Hit) {
      coachTip = 'Target reached! Book profits. Wait for fresh structure setup.';
    } else {
      var gatesFailing = checklist.filter(function (c) { return !c.pass; });
      if (gatesFailing.length) {
        coachTip = 'Waiting — ' + gatesFailing.map(function (g) { return g.label + ' (' + g.detail + ')'; }).join(', ');
      } else {
        coachTip = 'All gates passed but no breakout/pullback yet. Watch for entry trigger.';
      }
    }

    return {
      status: statusText,
      action: action,
      message: statusText,
      longSignal: newLong,
      shortSignal: newShort,
      longScore: round(longScore, 1),
      shortScore: round(shortScore, 1),
      longValid: longValid,
      shortValid: shortValid,
      dashboard: dashboard,
      trade: trade || signalTrade,
      signalTrade: signalTrade,
      checklist: checklist,
      coachTip: coachTip,
      tradeState: state,
      slHit: slHit,
      t1Hit: t1Hit,
      currentPrice: round(price, 2),
      candleCount: source.length,
      minCandles: minBars,
      timestamp: Date.now(),
      // Indicator snapshot for display
      indicators: {
        ema20: round(e20, 2),
        ema50: round(e50, 2),
        ema200: round(e200, 2),
        rsi14: round(rsi, 1),
        atr14: round(atr, 2),
        adx: round(adxVal, 1),
        diPlus: round(diP, 1),
        diMinus: round(diM, 1),
        volumeRatio: round(volRatio, 2),
        structure: bullStructure ? 'bullish' : bearStructure ? 'bearish' : 'neutral',
        supertrendDirection: trendBias
      }
    };
  }

  /* ==========================================
     BACKTEST SWING ENGINE — Walk-forward 1:2 R:R
     ========================================== */
  function backtestSwing(candles, options) {
    options = options || {};
    var source = validCandles(candles);
    var minNeed = 45;
    var holdBars = Math.max(2, parseInt(options.holdBars, 10) || 12);
    var minScore = options.minimumScore != null ? Number(options.minimumScore) : DEFAULTS.minimumScore;

    if (source.length < minNeed + 5) {
      return {
        ok: false,
        error: 'Need at least ' + (minNeed + 5) + ' candles (have ' + source.length + ')',
        mode: 'swing',
        trades: [],
        stats: null
      };
    }

    var trades = [];
    var equity = 0;
    var peak = 0;
    var maxDD = 0;
    var cooldownUntil = -1;
    var tradeState = { direction: 0 };

    for (var i = minNeed; i < source.length - 1; i++) {
      if (i < cooldownUntil) continue;

      var windowBars = source.slice(0, i + 1);
      var result = generateSwingSignal(windowBars, {
        minimumScore: minScore,
        tradeState: tradeState
      });

      if (!result || (!result.longSignal && !result.shortSignal)) continue;
      var isLong = result.longSignal;
      var trade = result.signalTrade || result.trade;
      if (!trade || !trade.entry || !trade.stopLoss || !trade.target1) continue;

      var entryPrice = trade.entry;
      var slPrice = trade.stopLoss;
      var t1Price = trade.target1;
      var direction = trade.direction;
      var entryTime = source[i].startTime;
      var exitPrice = null;
      var exitTime = null;
      var exitReason = null;
      var holdCount = 0;

      for (var j = i + 1; j < source.length && j <= i + holdBars; j++) {
        var bar = source[j];
        holdCount++;
        if (isLong) {
          if (bar.low <= slPrice) {
            exitPrice = slPrice;
            exitTime = bar.startTime;
            exitReason = 'Stop Loss';
            break;
          } else if (bar.high >= t1Price) {
            exitPrice = t1Price;
            exitTime = bar.startTime;
            exitReason = 'Target 1:2 ✓';
            break;
          }
        } else {
          if (bar.high >= slPrice) {
            exitPrice = slPrice;
            exitTime = bar.startTime;
            exitReason = 'Stop Loss';
            break;
          } else if (bar.low <= t1Price) {
            exitPrice = t1Price;
            exitTime = bar.startTime;
            exitReason = 'Target 1:2 ✓';
            break;
          }
        }
      }

      // Max holding period exit
      if (exitPrice == null) {
        var lastBar = source[Math.min(source.length - 1, i + holdBars)];
        exitPrice = lastBar.close;
        exitTime = lastBar.startTime;
        exitReason = 'Time Exit (' + holdCount + ' bars)';
      }

      var pnlPts = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
      var returnPct = (pnlPts / entryPrice) * 100;
      equity += returnPct;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);

      trades.push({
        index: i,
        time: entryTime,
        entryTime: entryTime,
        exitTime: exitTime,
        side: direction,
        direction: direction,
        strength: Math.round(trade.rating * 10),
        entryScore: trade.rating,
        entryPrice: round(entryPrice, 2),
        exitPrice: round(exitPrice, 2),
        stop: round(slPrice, 2),
        target: round(t1Price, 2),
        holdBars: holdCount,
        exitReason: exitReason,
        pnlPts: round(pnlPts, 2),
        returnPct: round(returnPct, 2),
        win: pnlPts > 0
      });

      cooldownUntil = i + holdCount;
    }

    var wins = trades.filter(function (t) { return t.win; });
    var losses = trades.filter(function (t) { return !t.win; });
    var grossWin = wins.reduce(function (s, t) { return s + t.returnPct; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (s, t) { return s + t.returnPct; }, 0));
    var totalReturn = trades.reduce(function (s, t) { return s + t.returnPct; }, 0);
    var winRate = trades.length ? (wins.length / trades.length) * 100 : 0;
    var avgWin = wins.length ? grossWin / wins.length : 0;
    var avgLoss = losses.length ? grossLoss / losses.length : 0;
    var profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
    var expectancy = trades.length ? totalReturn / trades.length : 0;

    return {
      ok: true,
      error: null,
      mode: 'swing',
      holdBars: holdBars,
      minScore: minScore,
      candlesUsed: source.length,
      trades: trades,
      stats: {
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: round(winRate, 1),
        avgWin: round(avgWin, 2),
        avgLoss: round(avgLoss, 2),
        profitFactor: profitFactor === 999 ? 999 : round(profitFactor, 2),
        expectancy: round(expectancy, 2),
        totalPnl: round(totalReturn, 2),
        totalReturn: round(totalReturn, 2),
        maxDD: round(maxDD, 2)
      }
    };
  }

  /* ==========================================
     EXPORT
     ========================================== */
  global.KPSwingEngine = {
    generateSwingSignal: generateSwingSignal,
    backtestSwing: backtestSwing,
    computeEMA: computeEMA,
    computeSMA: computeSMA,
    computeRSI: computeRSI,
    computeATR: computeATR,
    computeADX: computeADX,
    DEFAULTS: DEFAULTS
  };

})(window);
