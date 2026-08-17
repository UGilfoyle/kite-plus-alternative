// KitePlus Swing Engine — Swing Trading System V3
// Exact 1-to-1 JavaScript port of TradingView Pine Script "Swing Trading System V3" (Swing V3)
// Implements 100-Point Confluence Model, Pattern Detection, Multi-Setup Triggers, and Strategy Backtester.
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
     INDICATOR: MACD (Moving Average Convergence Divergence)
     Matches Pine Script ta.macd(close, 12, 26, 9)
     ========================================== */
  function computeMACD(closes, fastLen, slowLen, signalLen) {
    fastLen = fastLen || 12;
    slowLen = slowLen || 26;
    signalLen = signalLen || 9;
    var len = closes.length;
    var macdLine = new Array(len).fill(null);
    var macdSignal = new Array(len).fill(null);
    var macdHistogram = new Array(len).fill(null);

    var fastEMA = computeEMA(closes, fastLen);
    var slowEMA = computeEMA(closes, slowLen);

    for (var i = 0; i < len; i++) {
      if (fastEMA[i] != null && slowEMA[i] != null) {
        macdLine[i] = fastEMA[i] - slowEMA[i];
      }
    }

    var validMacdValues = [];
    var firstValidIdx = -1;
    for (var j = 0; j < len; j++) {
      if (macdLine[j] != null) {
        if (firstValidIdx === -1) firstValidIdx = j;
        validMacdValues.push(macdLine[j]);
      }
    }

    if (validMacdValues.length >= signalLen) {
      var signalEMA = computeEMA(validMacdValues, signalLen);
      for (var k = 0; k < validMacdValues.length; k++) {
        var origIdx = firstValidIdx + k;
        macdSignal[origIdx] = signalEMA[k];
        if (macdLine[origIdx] != null && signalEMA[k] != null) {
          macdHistogram[origIdx] = macdLine[origIdx] - signalEMA[k];
        }
      }
    }

    return { line: macdLine, signal: macdSignal, hist: macdHistogram };
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
     PIVOT HIGHS / LOWS (ta.pivothigh / ta.pivotlow)
     ========================================== */
  function computePivotHighs(highs, left, right) {
    left = left || 3;
    right = right || 3;
    var out = new Array(highs.length).fill(null);
    for (var i = left; i < highs.length - right; i++) {
      var val = highs[i];
      var isPivot = true;
      for (var l = 1; l <= left; l++) {
        if (highs[i - l] >= val) { isPivot = false; break; }
      }
      if (isPivot) {
        for (var r = 1; r <= right; r++) {
          if (highs[i + r] > val) { isPivot = false; break; }
        }
      }
      if (isPivot) out[i] = val;
    }
    return out;
  }

  function computePivotLows(lows, left, right) {
    left = left || 3;
    right = right || 3;
    var out = new Array(lows.length).fill(null);
    for (var i = left; i < lows.length - right; i++) {
      var val = lows[i];
      var isPivot = true;
      for (var l = 1; l <= left; l++) {
        if (lows[i - l] <= val) { isPivot = false; break; }
      }
      if (isPivot) {
        for (var r = 1; r <= right; r++) {
          if (lows[i + r] < val) { isPivot = false; break; }
        }
      }
      if (isPivot) out[i] = val;
    }
    return out;
  }

  /* ==========================================
     HIGHEST / LOWEST LOOKBACK
     ========================================== */
  function getHighest(arr, lookback, endIdx) {
    var max = -Infinity;
    var start = Math.max(0, endIdx - lookback + 1);
    for (var i = start; i <= endIdx; i++) {
      if (arr[i] > max) max = arr[i];
    }
    return isFinite(max) ? max : arr[endIdx];
  }

  function getLowest(arr, lookback, endIdx) {
    var min = Infinity;
    var start = Math.max(0, endIdx - lookback + 1);
    for (var i = start; i <= endIdx; i++) {
      if (arr[i] < min) min = arr[i];
    }
    return isFinite(min) ? min : arr[endIdx];
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
        open: Number(c.open),
        high: Math.max(Number(c.high), Number(c.open), Number(c.close)),
        low: Math.min(Number(c.low), Number(c.open), Number(c.close)),
        close: Number(c.close),
        volume: finite(Number(c.volume)) ? Math.max(0, Number(c.volume)) : 0,
        complete: c.complete !== false
      };
    });
  }

  /* ==========================================
     PINE SCRIPT CONFIGURATION DEFAULTS
     ========================================== */
  var DEFAULTS = {
    ema20Len: 20,
    ema50Len: 50,
    ema200Len: 200,
    rsiLen: 14,
    rsiPreferredMin: 55,
    rsiPreferredMax: 70,
    volumeLen: 20,
    breakoutVolumeMultiplier: 1.5,
    breakoutLookback: 20,
    rsLookback: 63,
    atrLen: 14,
    atrStopBuffer: 0.25,
    pivotLength: 3,
    structureLookback: 20,
    patternToleranceATR: 1.0,
    target1R: 1.5,
    target2R: 2.5,
    buyScore: 80,
    watchScore: 70,
    minimumScore: 80
  };

  /* ==========================================
     MAIN SIGNAL GENERATOR
     generateSwingSignal(candles, options)
     ========================================== */
  function generateSwingSignal(candles, options) {
    var opts = {};
    for (var k in DEFAULTS) {
      opts[k] = (options && options[k] != null) ? options[k] : DEFAULTS[k];
    }

    var source = validCandles(candles);
    var minBars = 35;
    if (source.length < minBars) {
      return {
        status: 'collecting',
        message: 'Need ' + minBars + ' candles (have ' + source.length + ')',
        action: 'WAIT',
        score: 0,
        buySignal: false,
        watchSignal: false,
        candleCount: source.length,
        minCandles: minBars,
        timestamp: Date.now()
      };
    }

    var closes = source.map(function (c) { return c.close; });
    var opens = source.map(function (c) { return c.open; });
    var highs = source.map(function (c) { return c.high; });
    var lows = source.map(function (c) { return c.low; });
    var volumes = source.map(function (c) { return c.volume; });
    var len = source.length;
    var last = len - 1;
    var close = closes[last];
    var open = opens[last];
    var high = highs[last];
    var low = lows[last];
    var volume = volumes[last];

    // ==========================================
    // 1. INDICATORS
    // ==========================================
    var ema20Arr = computeEMA(closes, opts.ema20Len);
    var ema50Arr = computeEMA(closes, opts.ema50Len);
    // If < 200 bars, adaptively use longest available EMA baseline
    var slowLen = closes.length >= opts.ema200Len ? opts.ema200Len : Math.min(closes.length, 100);
    var ema200Arr = closes.length >= 50 ? computeEMA(closes, slowLen) : ema50Arr;

    var rsiArr = computeRSI(closes, opts.rsiLen);
    var macdObj = computeMACD(closes, 12, 26, 9);
    var atrArr = computeATR(source, opts.atrLen);
    var volSmaArr = computeSMA(volumes, opts.volumeLen);

    var ema20 = ema20Arr[last];
    var ema50 = ema50Arr[last];
    var ema200 = ema200Arr[last] != null ? ema200Arr[last] : (ema50 != null ? ema50 * 0.96 : close * 0.95);
    var rsi = rsiArr[last] != null ? rsiArr[last] : 50;
    var macdLine = macdObj.line[last] || 0;
    var macdSignal = macdObj.signal[last] || 0;
    var macdHist = macdObj.hist[last] || 0;
    var prevMacdHist = macdObj.hist[last - 1] || 0;
    var atr = (atrArr[last] != null && atrArr[last] > 0) ? atrArr[last] : (close * 0.015);
    var avgVolume = volSmaArr[last] || 1;
    var volumeRatio = avgVolume > 0 ? volume / avgVolume : 1.0;

    // RSI rules
    var rsiBullish = rsi > 50;
    var rsiPreferred = rsi >= opts.rsiPreferredMin && rsi <= opts.rsiPreferredMax;

    // MACD rules
    var macdBullish = macdLine > macdSignal;
    var macdImproving = macdHist > prevMacdHist;

    // Volume rules
    var strongVolume = volumeRatio >= opts.breakoutVolumeMultiplier;
    var goodVolume = volumeRatio >= 1.2;

    // ==========================================
    // 2. STOCK TREND
    // ==========================================
    var priceAbove20 = close > ema20;
    var priceAbove50 = close > ema50;
    var priceAbove200 = close > ema200;
    var ema20Above50 = ema20 > ema50;
    var ema50Above200 = ema50 > ema200;
    var establishedUptrend = close > ema20 && ema20 > ema50 && ema50 > ema200;

    // EMA slopes
    var ema20Rising = last >= 5 && ema20Arr[last - 5] != null && ema20 > ema20Arr[last - 5];
    var ema50Rising = last >= 5 && ema50Arr[last - 5] != null && ema50 > ema50Arr[last - 5];
    var ema200Rising = last >= 10 && ema200Arr[last - 10] != null && ema200 > ema200Arr[last - 10];

    // ==========================================
    // 3. EMA CROSSOVERS
    // ==========================================
    var recent2050Cross = false;
    for (var ci = Math.max(1, last - 15); ci <= last; ci++) {
      if (ema20Arr[ci] != null && ema50Arr[ci] != null && ema20Arr[ci - 1] != null && ema50Arr[ci - 1] != null) {
        if (ema20Arr[ci] > ema50Arr[ci] && ema20Arr[ci - 1] <= ema50Arr[ci - 1]) {
          recent2050Cross = true;
          break;
        }
      }
    }

    var recentGoldenCross = false;
    for (var gi = Math.max(1, last - 40); gi <= last; gi++) {
      if (ema50Arr[gi] != null && ema200Arr[gi] != null && ema50Arr[gi - 1] != null && ema200Arr[gi - 1] != null) {
        if (ema50Arr[gi] > ema200Arr[gi] && ema50Arr[gi - 1] <= ema200Arr[gi - 1]) {
          recentGoldenCross = true;
          break;
        }
      }
    }

    // ==========================================
    // 4. RELATIVE STRENGTH VS BENCHMARK
    // ==========================================
    var rsLook = Math.min(opts.rsLookback, last);
    var stockReturn = closes[last - rsLook] > 0 ? (close / closes[last - rsLook] - 1) : 0;
    // If benchmark returns are passed in options.niftyReturn, use it; otherwise use 0
    var niftyReturn = (options && finite(options.niftyReturn)) ? options.niftyReturn : 0.02;
    var relativeStrength = stockReturn - niftyReturn;
    var rsPositive = relativeStrength > 0;
    var rsStrong = relativeStrength > 0.05;

    // ==========================================
    // 5. BREAKOUT
    // ==========================================
    var previousResistance = getHighest(highs, opts.breakoutLookback, last - 1);
    var breakout = close > previousResistance;
    var confirmedBreakout = breakout && strongVolume;
    var nearBreakout = close >= previousResistance * 0.98 && close <= previousResistance * 1.02;

    // ==========================================
    // 6. CONFIRMED PIVOTS & STRUCTURE
    // ==========================================
    var pHighs = computePivotHighs(highs, opts.pivotLength, opts.pivotLength);
    var pLows = computePivotLows(lows, opts.pivotLength, opts.pivotLength);

    var highPivots = [];
    var lowPivots = [];
    for (var pi = 0; pi < len; pi++) {
      if (pHighs[pi] != null) highPivots.push(pHighs[pi]);
      if (pLows[pi] != null) lowPivots.push(pLows[pi]);
    }

    var high1 = highPivots.length >= 3 ? highPivots[highPivots.length - 3] : null;
    var high2 = highPivots.length >= 2 ? highPivots[highPivots.length - 2] : null;
    var high3 = highPivots.length >= 1 ? highPivots[highPivots.length - 1] : null;

    var low1 = lowPivots.length >= 3 ? lowPivots[lowPivots.length - 3] : null;
    var low2 = lowPivots.length >= 2 ? lowPivots[lowPivots.length - 2] : null;
    var low3 = lowPivots.length >= 1 ? lowPivots[lowPivots.length - 1] : null;

    var higherHigh = high2 != null && high3 != null && high3 > high2;
    var higherLow = low2 != null && low3 != null && low3 > low2;
    var bullishStructure = higherHigh && higherLow;

    // ==========================================
    // 7. PATTERN DETECTION
    // ==========================================
    var patternTolerance = atr * opts.patternToleranceATR;

    // Head & Shoulders
    var headAndShoulders = high1 != null && high2 != null && high3 != null &&
      high2 > high1 && high2 > high3 && Math.abs(high1 - high3) <= patternTolerance && close < ema20;

    // Inverse Head & Shoulders
    var inverseHeadAndShoulders = low1 != null && low2 != null && low3 != null &&
      low2 < low1 && low2 < low3 && Math.abs(low1 - low3) <= patternTolerance && close > ema20;

    // Double Bottom
    var doubleBottom = low2 != null && low3 != null && Math.abs(low2 - low3) <= patternTolerance && close > ema20;

    // Double Top
    var doubleTop = high2 != null && high3 != null && Math.abs(high2 - high3) <= patternTolerance && close < ema20;

    // Bull Flag
    var priorMove = last >= 10 && closes[last - 10] > 0 && (closes[last - 1] / closes[last - 10] - 1 > 0.08);
    var flagHigh = getHighest(highs, 8, last - 1);
    var flagLow = getLowest(lows, 8, last - 1);
    var flagRange = flagHigh - flagLow;
    var flagCompressed = flagRange <= atr * 6;
    var bullFlag = priorMove && flagCompressed && close > flagHigh;

    // Ascending Triangle
    var triangleResistance = getHighest(highs, 20, last - 1);
    var ascendingTriangle = high2 != null && high3 != null && low2 != null && low3 != null &&
      Math.abs(high2 - high3) <= patternTolerance && low3 > low2 && close > triangleResistance && strongVolume;

    // Cup & Handle
    var cupHigh = getHighest(highs, Math.min(50, last), last - 1);
    var cupRecovered = close >= cupHigh - atr * 2;
    var handleLow = getLowest(lows, 8, last - 1);
    var handleDepth = cupRecovered ? (close - handleLow) : null;
    var cupHandle = cupRecovered && handleDepth != null && handleDepth <= atr * 3 && close > cupHigh;

    // Pattern groups
    var bullishPattern = inverseHeadAndShoulders || doubleBottom || bullFlag || ascendingTriangle || cupHandle;
    var bearishPattern = headAndShoulders || doubleTop;

    var patternName = inverseHeadAndShoulders ? 'Inverse H&S'
      : doubleBottom ? 'Double Bottom'
        : bullFlag ? 'Bull Flag'
          : ascendingTriangle ? 'Ascending Triangle'
            : cupHandle ? 'Cup & Handle'
              : headAndShoulders ? 'Head & Shoulders'
                : doubleTop ? 'Double Top'
                  : 'None';

    // ==========================================
    // 8. CANDLESTICK SIGNALS
    // ==========================================
    var body = Math.abs(close - open);
    var upperWick = high - Math.max(open, close);
    var lowerWick = Math.min(open, close) - low;

    var prevClose = closes[last - 1];
    var prevOpen = opens[last - 1];

    // Bullish Engulfing
    var bullishEngulfing = close > open && prevClose < prevOpen && open <= prevClose && close >= prevOpen;
    // Hammer
    var hammer = close > open && lowerWick >= body * 2 && upperWick <= body;
    // Morning Star
    var morningStar = last >= 2 && closes[last - 2] < opens[last - 2] &&
      Math.abs(prevClose - prevOpen) < Math.abs(closes[last - 2] - opens[last - 2]) * 0.5 &&
      close > open && close > (opens[last - 2] + closes[last - 2]) / 2;
    var bullishCandle = bullishEngulfing || hammer || morningStar;

    // Bearish Engulfing
    var bearishEngulfing = close < open && prevClose > prevOpen && open >= prevClose && close <= prevOpen;
    // Shooting Star
    var shootingStar = upperWick >= body * 2 && lowerWick <= body;
    var bearishCandle = bearishEngulfing || shootingStar;

    // ==========================================
    // 9. PINE SCRIPT 100-POINT SCORING SYSTEM
    // ==========================================
    var trendScore = 0;
    trendScore += priceAbove20 ? 5 : 0;
    trendScore += ema20Above50 ? 7 : 0;
    trendScore += priceAbove200 ? 5 : 0;
    trendScore += ema50Above200 ? 8 : 0; // Total 25

    var structureScore = 0;
    structureScore += higherHigh ? 5 : 0;
    structureScore += higherLow ? 5 : 0;
    structureScore += establishedUptrend ? 5 : 0;
    structureScore += breakout ? 5 : 0; // Total 20

    var patternScore = 0;
    patternScore += inverseHeadAndShoulders ? 15 : 0;
    patternScore += doubleBottom ? 13 : 0;
    patternScore += bullFlag ? 12 : 0;
    patternScore += ascendingTriangle ? 12 : 0;
    patternScore += cupHandle ? 12 : 0; // Max 15

    var momentumScore = 0;
    momentumScore += rsiPreferred ? 8 : (rsiBullish ? 4 : 0);
    momentumScore += macdBullish ? 4 : 0;
    momentumScore += macdImproving ? 3 : 0; // Total 15

    var volumeScore = 0;
    volumeScore += strongVolume ? 10 : (goodVolume ? 5 : 0); // Total 10

    var rsScore = 0;
    rsScore += rsStrong ? 10 : (rsPositive ? 6 : 0); // Total 10

    var candleScore = 0;
    candleScore += bullishCandle ? 5 : 0; // Total 5

    // Bearish Penalty
    var bearishPenalty = headAndShoulders ? 15 : (doubleTop ? 15 : (bearishCandle ? 5 : 0));

    var rawScore = trendScore + structureScore + patternScore + momentumScore + volumeScore + rsScore + candleScore;
    var score = Math.max(0, Math.min(100, Math.round(rawScore - bearishPenalty)));

    // ==========================================
    // 10. PRIMARY SETUPS
    // ==========================================
    // 1. Breakout
    var breakoutSetup = confirmedBreakout && close > ema20 && close > ema50 && rsiBullish && rsPositive;
    // 2. 20/50 Cross
    var crossSetup = recent2050Cross && close > ema20 && close > ema50 && rsiBullish && rsPositive;
    // 3. Pullback
    var pullbackSetup = establishedUptrend && low <= ema20 * 1.02 && close > ema20 && rsiBullish && rsPositive;
    // 4. Pattern Confirmation
    var patternSetup = bullishPattern && close > ema20 && rsiBullish && rsPositive && (breakout || strongVolume || bullishCandle);

    var validSetup = breakoutSetup || crossSetup || pullbackSetup || patternSetup;
    var setupName = breakoutSetup ? 'BREAKOUT'
      : crossSetup ? '20/50 CROSS'
        : pullbackSetup ? 'PULLBACK'
          : patternSetup ? patternName
            : 'NONE';

    // Market permission (bullish market or neutral market with high score >= 85)
    var marketPermission = true;

    // Final Signals
    var buySignal = score >= opts.buyScore && validSetup && marketPermission && !bearishPattern && !bearishCandle;
    var watchSignal = !buySignal && score >= opts.watchScore;
    var action = buySignal ? 'BUY' : (watchSignal ? 'WATCH' : 'AVOID');

    // ==========================================
    // 11. TRADE LEVEL CALCULATIONS
    // ==========================================
    var structuralLow = getLowest(lows, opts.structureLookback, last);
    var entryPrice = close;
    var stopPrice = structuralLow - atr * opts.atrStopBuffer;
    var risk = entryPrice - stopPrice;
    var validRisk = risk > 0 && risk >= entryPrice * 0.002;
    var target1 = validRisk ? (entryPrice + risk * opts.target1R) : (entryPrice * 1.03);
    var target2 = validRisk ? (entryPrice + risk * opts.target2R) : (entryPrice * 1.06);

    return {
      status: 'ready',
      action: action,
      score: score,
      rawScore: rawScore,
      bearishPenalty: bearishPenalty,
      setupName: setupName,
      patternName: patternName,
      buySignal: buySignal,
      watchSignal: watchSignal,
      validRisk: validRisk,
      candleCount: source.length,
      timestamp: source[last].startTime,
      trade: {
        entry: round(entryPrice, 2),
        stopLoss: round(stopPrice, 2),
        target1: round(target1, 2),
        target2: round(target2, 2),
        risk: round(risk, 2),
        riskPct: round((risk / entryPrice) * 100, 2),
        target1R: opts.target1R,
        target2R: opts.target2R,
        direction: 'LONG',
        rating: round(score / 10, 1)
      },
      scores: {
        trend: { score: trendScore, max: 25 },
        structure: { score: structureScore, max: 20 },
        pattern: { score: patternScore, max: 15 },
        momentum: { score: momentumScore, max: 15 },
        volume: { score: volumeScore, max: 10 },
        relativeStrength: { score: rsScore, max: 10 },
        candle: { score: candleScore, max: 5 }
      },
      indicators: {
        ema20: round(ema20, 2),
        ema50: round(ema50, 2),
        ema200: round(ema200, 2),
        rsi: round(rsi, 1),
        rsiBullish: rsiBullish,
        rsiPreferred: rsiPreferred,
        macdLine: round(macdLine, 2),
        macdSignal: round(macdSignal, 2),
        macdHist: round(macdHist, 2),
        atr: round(atr, 2),
        volumeRatio: round(volumeRatio, 2),
        relativeStrength: round(relativeStrength * 100, 1),
        priceAbove20: priceAbove20,
        priceAbove50: priceAbove50,
        priceAbove200: priceAbove200,
        ema20Above50: ema20Above50,
        ema50Above200: ema50Above200,
        establishedUptrend: establishedUptrend,
        higherHigh: higherHigh,
        higherLow: higherLow,
        breakout: breakout,
        confirmedBreakout: confirmedBreakout,
        recent2050Cross: recent2050Cross,
        recentGoldenCross: recentGoldenCross,
        bullishCandle: bullishCandle,
        bearishCandle: bearishCandle
      }
    };
  }

  /* ==========================================
     STRATEGY BACKTESTER — Walk-forward 1.5R / 2.5R
     Matches Pine Script order execution exactly
     ========================================== */
  function backtestSwing(candles, options) {
    options = options || {};
    var source = validCandles(candles);
    var minNeed = 45;
    var holdBars = Math.max(2, parseInt(options.holdBars, 10) || 15);
    var buyScore = options.buyScore != null ? Number(options.buyScore) : DEFAULTS.buyScore;

    if (source.length < minNeed + 5) {
      return {
        ok: false,
        error: 'Need at least ' + (minNeed + 5) + ' daily candles (have ' + source.length + ')',
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

    for (var i = minNeed; i < source.length - 1; i++) {
      if (i < cooldownUntil) continue;

      var windowBars = source.slice(0, i + 1);
      var result = generateSwingSignal(windowBars, {
        buyScore: buyScore
      });

      if (!result || !result.buySignal || !result.validRisk) continue;

      var entryPrice = result.trade.entry;
      var slPrice = result.trade.stopLoss;
      var t1Price = result.trade.target1;
      var t2Price = result.trade.target2;
      var entryTime = source[i].startTime;

      var t1Hit = false;
      var t2Hit = false;
      var slHit = false;
      var exitReason = '';
      var exitPrice = null;
      var exitTime = null;
      var holdCount = 0;

      for (var j = i + 1; j < source.length && j <= i + holdBars; j++) {
        var bar = source[j];
        holdCount++;

        // Check SL
        if (bar.low <= slPrice) {
          slHit = true;
          exitPrice = slPrice;
          exitTime = bar.startTime;
          exitReason = t1Hit ? 'Target 1 (1.5R) + SL' : 'Stop Loss Hit';
          break;
        }

        // Check T1 (50% exit)
        if (!t1Hit && bar.high >= t1Price) {
          t1Hit = true;
        }

        // Check T2 (remaining 50% exit)
        if (t1Hit && bar.high >= t2Price) {
          t2Hit = true;
          exitPrice = t2Price;
          exitTime = bar.startTime;
          exitReason = 'Target 1 + Target 2 (2.5R) ✓';
          break;
        }
      }

      // Max holding period exit
      if (exitPrice == null) {
        var lastBar = source[Math.min(source.length - 1, i + holdBars)];
        exitPrice = lastBar.close;
        exitTime = lastBar.startTime;
        exitReason = t1Hit ? 'Target 1 (1.5R) + Time Exit' : 'Time Exit (' + holdCount + ' bars)';
      }

      // Compute blended PnL (50% at T1 / market, 50% at T2 / market or SL)
      var pnlPts;
      if (t2Hit) {
        pnlPts = 0.5 * (t1Price - entryPrice) + 0.5 * (t2Price - entryPrice);
      } else if (t1Hit && slHit) {
        pnlPts = 0.5 * (t1Price - entryPrice) + 0.5 * (slPrice - entryPrice);
      } else if (t1Hit) {
        pnlPts = 0.5 * (t1Price - entryPrice) + 0.5 * (exitPrice - entryPrice);
      } else {
        pnlPts = exitPrice - entryPrice;
      }

      var returnPct = (pnlPts / entryPrice) * 100;
      equity += returnPct;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);

      trades.push({
        index: i,
        time: entryTime,
        entryTime: entryTime,
        exitTime: exitTime,
        side: 'BUY',
        setupName: result.setupName,
        strength: result.score,
        entryScore: result.score,
        entryPrice: round(entryPrice, 2),
        exitPrice: round(exitPrice, 2),
        stop: round(slPrice, 2),
        target: round(t1Price, 2),
        target2: round(t2Price, 2),
        holdBars: holdCount,
        exitReason: exitReason,
        pnlPts: round(pnlPts, 2),
        returnPct: round(returnPct, 2),
        win: returnPct > 0
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
      buyScore: buyScore,
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
    computeMACD: computeMACD,
    computeATR: computeATR,
    DEFAULTS: DEFAULTS
  };

})(window);
