// KitePlus cash-equity engine: long-only, deterministic and dependency-free.
(function (global) {
  'use strict';

  var IST_OFFSET_MS = 330 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var SESSION_OPEN_MINUTE = 9 * 60 + 15;
  var SESSION_CLOSE_MINUTE = 15 * 60 + 30;
  var TIMEFRAME_MINUTES = {
    '1m': 1, '2m': 2, '3m': 3, '5m': 5, '15m': 15,
    '45m': 45, '4h': 240
  };

  function finite(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function round(value, digits) {
    if (!finite(value)) return null;
    var factor = Math.pow(10, digits == null ? 2 : digits);
    return Math.round(value * factor) / factor;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function candleTime(candle) {
    if (!candle) return NaN;
    var raw = candle.startTime != null ? candle.startTime
      : candle.time != null ? candle.time
        : candle.timestamp != null ? candle.timestamp : candle.date;
    if (raw instanceof Date) return raw.getTime();
    if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
    if (raw != null && raw !== '' && finite(Number(raw))) {
      var numeric = Number(raw);
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    var parsed = Date.parse(raw);
    return isNaN(parsed) ? NaN : parsed;
  }

  function timestampValue(raw) {
    return candleTime({ startTime: raw });
  }

  function validCandles(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.map(function (c) {
      var time = candleTime(c);
      var open = Number(c.open);
      var high = Number(c.high);
      var low = Number(c.low);
      var close = Number(c.close);
      if (!finite(time) || !finite(open) || !finite(high) || !finite(low) ||
          !finite(close) || open <= 0 || high <= 0 || low <= 0 || close <= 0) {
        return null;
      }
      return {
        startTime: time,
        open: open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close: close,
        volume: finite(Number(c.volume)) ? Math.max(0, Number(c.volume)) : 0,
        complete: c.complete !== false
      };
    }).filter(Boolean).sort(function (a, b) { return a.startTime - b.startTime; });
  }

  function istParts(timestamp) {
    var shifted = new Date(timestamp + IST_OFFSET_MS);
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth(),
      date: shifted.getUTCDate(),
      day: shifted.getUTCDay(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes()
    };
  }

  function istEpoch(year, month, date, hour, minute) {
    return Date.UTC(year, month, date, hour || 0, minute || 0) - IST_OFFSET_MS;
  }

  function dayKey(parts) {
    return parts.year + '-' + String(parts.month + 1).padStart(2, '0') + '-' +
      String(parts.date).padStart(2, '0');
  }

  function mondayKey(timestamp) {
    var p = istParts(timestamp);
    var sessionOpen = istEpoch(p.year, p.month, p.date, 9, 15);
    var daysSinceMonday = (p.day + 6) % 7;
    return sessionOpen - daysSinceMonday * DAY_MS;
  }

  function mergeBucket(bucket, candle, startTime) {
    if (!bucket) {
      return {
        startTime: startTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        complete: candle.complete !== false
      };
    }
    bucket.high = Math.max(bucket.high, candle.high);
    bucket.low = Math.min(bucket.low, candle.low);
    bucket.close = candle.close;
    bucket.volume += candle.volume;
    bucket.complete = bucket.complete && candle.complete !== false;
    return bucket;
  }

  function resampleMonthly(daily) {
    var source = validCandles(daily);
    if (!source.length) return [];
    var groups = new Map();
    source.forEach(function (candle) {
      var p = istParts(candle.startTime);
      var key = p.year + '-' + String(p.month + 1).padStart(2, '0');
      var start = istEpoch(p.year, p.month, 1, 9, 15);
      groups.set(key, mergeBucket(groups.get(key), candle, start));
    });
    var months = Array.from(groups.values()).sort(function (a, b) {
      return a.startTime - b.startTime;
    });
    // Drop in-progress month
    if (months.length) months.pop();
    months.forEach(function (m) { m.complete = true; });
    return months;
  }

  function resampleCandles(candles, timeframe) {
    var source = validCandles(candles);
    if (!source.length) return [];
    if (timeframe === '1W') return resampleWeekly(source);
    if (timeframe === '1M') {
      var dailyForMonth = resampleCandles(source, '1D');
      return resampleMonthly(dailyForMonth.length ? dailyForMonth : source);
    }
    // Unknown TF: treat candles as already at that resolution (Yahoo/panel may deliver 1m/5m/15m).
    if (timeframe !== '1D' && !TIMEFRAME_MINUTES[timeframe]) {
      return source;
    }

    var buckets = new Map();
    source.forEach(function (candle) {
      var p = istParts(candle.startTime);
      var key;
      var start;
      if (timeframe === '1D') {
        key = dayKey(p);
        start = istEpoch(p.year, p.month, p.date, 9, 15);
      } else {
        var minuteOfDay = p.hour * 60 + p.minute;
        if (minuteOfDay < SESSION_OPEN_MINUTE || minuteOfDay >= SESSION_CLOSE_MINUTE) return;
        var width = TIMEFRAME_MINUTES[timeframe];
        var offset = minuteOfDay - SESSION_OPEN_MINUTE;
        var bucketOffset = Math.floor(offset / width) * width;
        key = dayKey(p) + ':' + bucketOffset;
        start = istEpoch(p.year, p.month, p.date, 9, 15) + bucketOffset * 60 * 1000;
      }
      buckets.set(key, mergeBucket(buckets.get(key), candle, start));
    });
    return Array.from(buckets.values()).sort(function (a, b) {
      return a.startTime - b.startTime;
    });
  }

  // The newest week is deliberately omitted; it cannot be confirmed without future bars.
  function resampleWeekly(daily) {
    var source = validCandles(daily);
    if (!source.length) return [];
    var groups = new Map();
    source.forEach(function (candle) {
      var weekStart = mondayKey(candle.startTime);
      groups.set(weekStart, mergeBucket(groups.get(weekStart), candle, weekStart));
    });
    var weeks = Array.from(groups.values()).sort(function (a, b) {
      return a.startTime - b.startTime;
    });
    if (weeks.length) weeks.pop();
    weeks.forEach(function (week) { week.complete = true; });
    return weeks;
  }

  function computeEMA(values, period) {
    var out = new Array(values.length).fill(null);
    if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += Number(values[i]);
    var ema = sum / period;
    out[period - 1] = ema;
    var multiplier = 2 / (period + 1);
    for (i = period; i < values.length; i++) {
      ema = (Number(values[i]) - ema) * multiplier + ema;
      out[i] = ema;
    }
    return out;
  }

  function computeRSI(values, period) {
    period = period || 14;
    var out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    var gains = 0;
    var losses = 0;
    for (var i = 1; i <= period; i++) {
      var change = values[i] - values[i - 1];
      gains += Math.max(0, change);
      losses += Math.max(0, -change);
    }
    var avgGain = gains / period;
    var avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (i = period + 1; i < values.length; i++) {
      change = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function computeMACD(values, fast, slow, signal) {
    fast = fast || 12;
    slow = slow || 26;
    signal = signal || 9;
    var fastEMA = computeEMA(values, fast);
    var slowEMA = computeEMA(values, slow);
    var line = values.map(function (_, i) {
      return fastEMA[i] == null || slowEMA[i] == null ? null : fastEMA[i] - slowEMA[i];
    });
    var first = line.findIndex(function (v) { return v != null; });
    var signalLine = new Array(values.length).fill(null);
    if (first >= 0) {
      var compact = line.slice(first);
      var compactSignal = computeEMA(compact, signal);
      compactSignal.forEach(function (value, i) { signalLine[first + i] = value; });
    }
    var histogram = line.map(function (value, i) {
      return value == null || signalLine[i] == null ? null : value - signalLine[i];
    });
    return { macdLine: line, signalLine: signalLine, histogram: histogram };
  }

  function computeATR(candles, period) {
    period = period || 14;
    var source = validCandles(candles);
    var out = new Array(source.length).fill(null);
    if (source.length < period) return out;
    var tr = source.map(function (candle, i) {
      if (!i) return candle.high - candle.low;
      return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - source[i - 1].close),
        Math.abs(candle.low - source[i - 1].close)
      );
    });
    var sum = 0;
    for (var i = 0; i < period; i++) sum += tr[i];
    out[period - 1] = sum / period;
    for (i = period; i < source.length; i++) {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
    return out;
  }

  function computeSupertrend(candles, period, multiplier) {
    period = period || 10;
    multiplier = multiplier || 3;
    var source = validCandles(candles);
    var atr = computeATR(source, period);
    var values = new Array(source.length).fill(null);
    var direction = new Array(source.length).fill(0);
    var finalUpper = new Array(source.length).fill(null);
    var finalLower = new Array(source.length).fill(null);
    for (var i = 0; i < source.length; i++) {
      if (atr[i] == null) continue;
      var midpoint = (source[i].high + source[i].low) / 2;
      var basicUpper = midpoint + multiplier * atr[i];
      var basicLower = midpoint - multiplier * atr[i];
      if (i === 0 || atr[i - 1] == null) {
        finalUpper[i] = basicUpper;
        finalLower[i] = basicLower;
        direction[i] = source[i].close >= midpoint ? 1 : -1;
      } else {
        finalUpper[i] = basicUpper < finalUpper[i - 1] ||
          source[i - 1].close > finalUpper[i - 1] ? basicUpper : finalUpper[i - 1];
        finalLower[i] = basicLower > finalLower[i - 1] ||
          source[i - 1].close < finalLower[i - 1] ? basicLower : finalLower[i - 1];
        if (direction[i - 1] === -1 && source[i].close > finalUpper[i - 1]) direction[i] = 1;
        else if (direction[i - 1] === 1 && source[i].close < finalLower[i - 1]) direction[i] = -1;
        else direction[i] = direction[i - 1];
      }
      values[i] = direction[i] === 1 ? finalLower[i] : finalUpper[i];
    }
    return { values: values, direction: direction };
  }

  function smaAt(values, period, index) {
    index = index == null ? values.length - 1 : index;
    if (index < period - 1) return null;
    var sum = 0;
    for (var i = index - period + 1; i <= index; i++) sum += values[i];
    return sum / period;
  }

  function lastValue(values) {
    for (var i = values.length - 1; i >= 0; i--) {
      if (finite(values[i])) return values[i];
    }
    return null;
  }

  function detectSupportResistance(candles, currentPrice, opts) {
    opts = opts || {};
    var source = validCandles(candles);
    var price = finite(Number(currentPrice)) ? Number(currentPrice)
      : source.length ? source[source.length - 1].close : null;
    var left = Math.max(1, Number(opts.leftBars) || 3);
    var right = Math.max(1, Number(opts.rightBars) || 3);
    var atrPeriod = Math.max(2, Number(opts.atrPeriod) || 14);
    var atr = computeATR(source, atrPeriod);
    var currentATR = lastValue(atr) || (price ? price * 0.01 : 1);
    var tolerance = finite(Number(opts.clusterTolerance))
      ? Number(opts.clusterTolerance)
      : Math.max(currentATR * (Number(opts.atrClusterMultiplier) || 0.5), (price || 1) * 0.002);
    var avgVolume = smaAt(source.map(function (c) { return c.volume; }), 20) || 1;
    var pivots = [];

    // A pivot at i is visible only after right bars have closed.
    for (var i = left; i < source.length - right; i++) {
      var highPivot = true;
      var lowPivot = true;
      for (var j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (source[j].high >= source[i].high) highPivot = false;
        if (source[j].low <= source[i].low) lowPivot = false;
      }
      var range = Math.max(source[i].high - source[i].low, atr[i] || currentATR, 1e-9);
      var volumeRatio = source[i].volume / Math.max(avgVolume, 1);
      if (highPivot) {
        pivots.push({
          price: source[i].high,
          index: i,
          kind: 'high',
          rejection: (source[i].high - Math.max(source[i].open, source[i].close)) / range,
          volumeRatio: volumeRatio
        });
      }
      if (lowPivot) {
        pivots.push({
          price: source[i].low,
          index: i,
          kind: 'low',
          rejection: (Math.min(source[i].open, source[i].close) - source[i].low) / range,
          volumeRatio: volumeRatio
        });
      }
    }

    var clusters = [];
    pivots.sort(function (a, b) { return a.price - b.price; }).forEach(function (pivot) {
      var cluster = null;
      var bestDistance = Infinity;
      clusters.forEach(function (candidate) {
        var distance = Math.abs(candidate.price - pivot.price);
        if (distance <= tolerance && distance < bestDistance) {
          cluster = candidate;
          bestDistance = distance;
        }
      });
      if (!cluster) {
        cluster = { price: pivot.price, pivots: [], weightedPrice: 0, weight: 0 };
        clusters.push(cluster);
      }
      var weight = 1 + Math.min(2, pivot.volumeRatio);
      cluster.pivots.push(pivot);
      cluster.weightedPrice += pivot.price * weight;
      cluster.weight += weight;
      cluster.price = cluster.weightedPrice / cluster.weight;
    });

    var levels = clusters.map(function (cluster) {
      var latest = cluster.pivots.reduce(function (max, p) { return Math.max(max, p.index); }, 0);
      var touches = cluster.pivots.length;
      var recency = source.length > 1 ? latest / (source.length - 1) : 0;
      var rejection = cluster.pivots.reduce(function (sum, p) { return sum + p.rejection; }, 0) / touches;
      var volume = cluster.pivots.reduce(function (sum, p) { return sum + p.volumeRatio; }, 0) / touches;
      var score = 35 * Math.min(1, touches / 4) + 25 * recency +
        20 * Math.min(1, rejection) + 20 * Math.min(1, volume / 2);
      return {
        price: round(cluster.price, 2),
        type: cluster.price <= price ? 'support' : 'resistance',
        touches: touches,
        recency: round(recency, 3),
        rejection: round(rejection, 3),
        volumeRatio: round(volume, 2),
        score: round(score, 1),
        distancePct: round(Math.abs(cluster.price - price) / price * 100, 2),
        lastConfirmedIndex: latest
      };
    });

    var supports = levels.filter(function (level) { return level.price < price; })
      .sort(function (a, b) { return b.price - a.price || b.score - a.score; }).slice(0, 3);
    var resistances = levels.filter(function (level) { return level.price > price; })
      .sort(function (a, b) { return a.price - b.price || b.score - a.score; }).slice(0, 3);
    return {
      supports: supports,
      resistances: resistances,
      atr: round(currentATR, 2),
      clusterTolerance: round(tolerance, 2),
      confirmedPivots: pivots.length
    };
  }

  var MODE_PROFILES = {
    scalp: {
      minCandles: 36, emaFast: 9, emaMid: 21, emaSlow: 50,
      buyAt: 58, expectedHold: 'minutes · same session', maxHorizonDays: 1,
      confirmationTimeframe: '5m', minRR: 1.0
    },
    intraday: {
      minCandles: 50, emaFast: 9, emaMid: 21, emaSlow: 50,
      buyAt: 60, expectedHold: 'same day · hours', maxHorizonDays: 1,
      confirmationTimeframe: '15m', minRR: 1.1
    },
    positional: {
      minCandles: 120, emaFast: 50, emaMid: 100, emaSlow: 200,
      buyAt: 62, expectedHold: '5-30 trading days', maxHorizonDays: 45,
      confirmationTimeframe: '1W', minRR: 1.35
    }
  };

  function buildIndicatorSnapshot(analysis, mode, timeframe) {
    if (!analysis || !analysis.length) {
      return {
        ema50: null, ema100: null, ema200: null,
        emaFast: null, emaMid: null, emaSlow: null,
        rsi14: null, macd: null, macdSignal: null, macdHistogram: null,
        supertrend: null, supertrendDirection: 'neutral',
        atr14: null, volumeRatio: null, structure: 'neutral',
        weeklyFilter: 'unavailable', timeframe: timeframe || null
      };
    }
    var closes = analysis.map(function (c) { return c.close; });
    var volumes = analysis.map(function (c) { return c.volume; });
    var last = analysis.length - 1;
    var profile = MODE_PROFILES[mode] || MODE_PROFILES.positional;
    var emaFast = computeEMA(closes, profile.emaFast);
    var emaMid = computeEMA(closes, profile.emaMid);
    var emaSlow = computeEMA(closes, profile.emaSlow);
    var ema50 = computeEMA(closes, 50);
    var ema100 = computeEMA(closes, 100);
    var ema200 = computeEMA(closes, 200);
    var rsi = computeRSI(closes, 14);
    var macd = computeMACD(closes, 12, 26, 9);
    var supertrend = computeSupertrend(analysis, 10, 3);
    var atrValues = computeATR(analysis, 14);
    var volumeSMA20 = smaAt(volumes, 20);
    var volumeRatio = volumeSMA20 > 0 ? volumes[last] / volumeSMA20 : null;
    var stDirection = supertrend.direction[last];
    var price = analysis[last].close;
    var structure = 'neutral';
    if (finite(ema50[last]) && finite(ema100[last]) && finite(ema200[last])) {
      if (price > ema50[last] && ema50[last] > ema100[last] && ema100[last] > ema200[last]) structure = 'bullish';
      else if (price < ema50[last] && ema50[last] < ema100[last] && ema100[last] < ema200[last]) structure = 'bearish';
    }
    var weeklyFilter = 'unavailable';
    if (mode === 'positional') {
      var daily = timeframe === '1D' ? analysis : resampleCandles(analysis, '1D');
      var weekly = resampleWeekly(daily);
      if (weekly.length >= 20) {
        var weeklyCloses = weekly.map(function (c) { return c.close; });
        var wEma20 = computeEMA(weeklyCloses, 20);
        var wEma50 = computeEMA(weeklyCloses, 50);
        var wi = weekly.length - 1;
        weeklyFilter = weekly[wi].close > wEma20[wi] &&
          (wEma50[wi] == null || wEma20[wi] > wEma50[wi]) ? 'bullish' : 'bearish';
      }
    }
    return {
      ema50: round(ema50[last], 2),
      ema100: round(ema100[last], 2),
      ema200: round(ema200[last], 2),
      emaFast: round(emaFast[last], 2),
      emaMid: round(emaMid[last], 2),
      emaSlow: round(emaSlow[last], 2),
      rsi14: round(rsi[last], 2),
      macd: round(macd.macdLine[last], 4),
      macdSignal: round(macd.signalLine[last], 4),
      macdHistogram: round(macd.histogram[last], 4),
      supertrend: round(supertrend.values[last], 2),
      supertrendDirection: stDirection === 1 ? 'bullish' : stDirection === -1 ? 'bearish' : 'neutral',
      atr14: round(atrValues[last], 2),
      volumeRatio: round(volumeRatio, 2),
      structure: structure,
      weeklyFilter: weeklyFilter,
      timeframe: timeframe || null
    };
  }

  function insufficientSignal(mode, timeframe, available, required, price, position, analysis) {
    var horizonExceeded = false;
    var entryTime = position ? timestampValue(position.entryTime) : NaN;
    if (position && finite(entryTime)) {
      horizonExceeded = (Date.now() - entryTime) / DAY_MS >
        (Number(position.horizonDays) || MODE_PROFILES[mode].maxHorizonDays);
    }
    return {
      action: horizonExceeded ? 'EXIT' : (position ? 'HOLD' : 'WAIT'),
      score: 0,
      buyAt: MODE_PROFILES[mode].buyAt,
      reasons: ['Insufficient history: need ' + required + ' completed ' + timeframe + ' candles (have ' + available + ')'],
      lessons: [],
      topDrivers: [],
      coachTip: 'Load more ' + timeframe + ' history before trusting a pick. Patience is part of the skill.',
      decisionWhy: 'Not enough candles yet to score this stock.',
      checklist: [
        { id: 'history', label: 'Enough history', pass: false, detail: available + ' / ' + required }
      ],
      pickVerdict: 'NO',
      weeklyBias: mode === 'positional' ? 'unknown' : 'n/a',
      invalidationLevel: null,
      targetLevel: null,
      targetLevels: { t1: null, t2: null, t3: null },
      riskReward: null,
      riskRewards: { t1: null, t2: null, t3: null },
      expectedHold: MODE_PROFILES[mode].expectedHold,
      confirmationTimeframe: MODE_PROFILES[mode].confirmationTimeframe,
      indicators: buildIndicatorSnapshot(analysis || [], mode, timeframe),
      supportResistance: { supports: [], resistances: [], atr: null, confirmedPivots: 0 },
      dataSufficiency: {
        sufficient: false,
        available: available,
        required: required,
        weeklyAvailable: 0,
        weeklyRequired: mode === 'positional' ? 20 : 0
      },
      mode: mode,
      timeframe: timeframe,
      currentPrice: finite(price) ? price : null,
      timestamp: Date.now()
    };
  }

  function detectEquityPatterns(candles, ctx) {
    ctx = ctx || {};
    var out = {
      goldenCross: false,
      deathCross: false,
      hhhl: false,
      breakoutVolume: false,
      freshBars: null,
      labels: []
    };
    if (!candles || candles.length < 3) return out;
    var last = candles.length - 1;
    var ema50 = ctx.ema50 || [];
    var ema200 = ctx.ema200 || [];
    var lookback = Math.min(12, last);
    var crossAt = -1;
    var crossKind = null;
    for (var i = last; i >= last - lookback + 1; i--) {
      if (i < 1) break;
      var a0 = ema50[i - 1];
      var b0 = ema200[i - 1];
      var a1 = ema50[i];
      var b1 = ema200[i];
      if (a0 == null || b0 == null || a1 == null || b1 == null) continue;
      if (a0 <= b0 && a1 > b1) { crossAt = i; crossKind = 'golden'; break; }
      if (a0 >= b0 && a1 < b1) { crossAt = i; crossKind = 'death'; break; }
    }
    var price = candles[last].close;
    var e200 = ema200[last];
    if (crossKind === 'golden' && e200 != null && price > e200) {
      out.goldenCross = true;
      out.freshBars = last - crossAt;
      out.labels.push(out.freshBars <= 5 ? 'Golden cross fresh' : 'Golden cross');
    } else if (crossKind === 'death') {
      out.deathCross = true;
      out.freshBars = last - crossAt;
      out.labels.push('Death cross');
    } else if (ema50[last] != null && ema200[last] != null && ema50[last] > ema200[last] && price > ema200[last]) {
      out.labels.push('Above EMA200 stack');
    }
    // Higher-high / higher-low over last ~10 bars vs prior 10
    if (last >= 20) {
      var recent = candles.slice(last - 9, last + 1);
      var prior = candles.slice(last - 19, last - 9);
      var rh = Math.max.apply(null, recent.map(function (c) { return c.high; }));
      var rl = Math.min.apply(null, recent.map(function (c) { return c.low; }));
      var ph = Math.max.apply(null, prior.map(function (c) { return c.high; }));
      var pl = Math.min.apply(null, prior.map(function (c) { return c.low; }));
      if (rh > ph && rl > pl) {
        out.hhhl = true;
        out.labels.push('HH/HL structure');
      }
    } else if (ctx.higherLow && ctx.structureScore >= 65) {
      out.hhhl = true;
      out.labels.push('Higher low');
    }
    if (ctx.volumeRatio != null && ctx.volumeRatio >= 1.2 && price > ctx.priorHigh) {
      out.breakoutVolume = true;
      out.labels.push('Breakout + volume');
    }
    return out;
  }

  function generateEquitySignal(candles, options) {
    options = options || {};
    var mode = MODE_PROFILES[options.mode] ? options.mode : 'positional';
    var profile = MODE_PROFILES[mode];
    var timeframe = options.timeframe || (mode === 'positional' ? '1D' : mode === 'scalp' ? '3m' : '45m');
    var raw = validCandles(candles);
    var analysis = resampleCandles(raw, timeframe);
    var currentPrice = analysis.length ? analysis[analysis.length - 1].close : null;
    var minCandles = profile.minCandles;
    if (timeframe === '1M') minCandles = Math.min(minCandles, 24);
    else if (timeframe === '1W') minCandles = Math.min(minCandles, 52);
    if (analysis.length < minCandles) {
      return insufficientSignal(mode, timeframe, analysis.length, minCandles, currentPrice, options.position, analysis);
    }

    var closes = analysis.map(function (c) { return c.close; });
    var volumes = analysis.map(function (c) { return c.volume; });
    var last = analysis.length - 1;
    var emaFast = computeEMA(closes, profile.emaFast);
    var emaMid = computeEMA(closes, profile.emaMid);
    var emaSlow = computeEMA(closes, profile.emaSlow);
    var rsi = computeRSI(closes, 14);
    var macd = computeMACD(closes, 12, 26, 9);
    var supertrend = computeSupertrend(analysis, 10, 3);
    var atrValues = computeATR(analysis, 14);
    var atr = atrValues[last];
    var volumeSMA20 = smaAt(volumes, 20);
    var sr = detectSupportResistance(analysis, currentPrice, options.supportResistance);
    var reasons = [];
    var lessons = [];
    var weighted = 0;
    var availableWeight = 0;

    function component(id, value, weight, plainWhyBull, plainWhyBear, tipBull, tipBear) {
      if (!finite(value)) return;
      weighted += clamp(value, 0, 100) * weight;
      availableWeight += weight;
      var bullish = value >= 65;
      var bearish = value <= 35;
      var plainWhy = bullish ? plainWhyBull : bearish ? plainWhyBear : (plainWhyBull + ' (mixed)');
      var tip = bullish ? tipBull : bearish ? tipBear : 'Watch this factor — it is not decisive yet.';
      lessons.push({
        id: id,
        score: round(clamp(value, 0, 100), 1),
        weight: weight,
        bias: bullish ? 'bull' : bearish ? 'bear' : 'neutral',
        plainWhy: plainWhy,
        tip: tip
      });
      if (bullish && plainWhyBull) reasons.push(plainWhyBull);
      else if (bearish && plainWhyBear) reasons.push(plainWhyBear);
    }

    var fast = emaFast[last];
    var mid = emaMid[last];
    var slow = emaSlow[last];
    var trendScore = 50;
    if (currentPrice > fast) trendScore += 15; else trendScore -= 15;
    if (fast > mid) trendScore += 15; else trendScore -= 15;
    if (mid > slow) trendScore += 20; else trendScore -= 20;
    component('trend', trendScore, 30,
      'Price and EMAs (' + profile.emaFast + '/' + profile.emaMid + '/' + profile.emaSlow + ') are stacked bullish',
      'Price or EMA stack is bearish — trend is against longs',
      'Enter on pullbacks into the fast EMA while the stack holds',
      'Do not buy dips until price reclaims the mid EMA');

    var rsiNow = rsi[last];
    var rsiScore = rsiNow == null ? null
      : rsiNow >= 50 && rsiNow <= 68 ? 85
        : rsiNow > 68 && rsiNow <= 75 ? 60
          : rsiNow > 75 ? 25
            : rsiNow >= 40 ? 45 : 20;
    component('rsi', rsiScore, 12,
      'RSI14 is in a healthy bullish zone',
      'RSI14 is weak or overextended',
      'Momentum supports holding through normal noise',
      rsiNow != null && rsiNow > 75
        ? 'RSI is hot — wait for a pullback toward the EMA before buying'
        : 'Wait for RSI to reclaim 50 with price confirmation');

    var macdLine = macd.macdLine[last];
    var macdSignal = macd.signalLine[last];
    var histogram = macd.histogram[last];
    var previousHistogram = last > 0 ? macd.histogram[last - 1] : null;
    var macdScore = macdLine == null || macdSignal == null ? null
      : macdLine > macdSignal && histogram >= (previousHistogram == null ? histogram : previousHistogram) ? 90
        : macdLine > macdSignal ? 72
          : histogram > (previousHistogram == null ? histogram : previousHistogram) ? 45 : 20;
    component('macd', macdScore, 14,
      'MACD is bullish (line above signal)',
      'MACD is bearish (line below signal)',
      'Momentum impulse favors continuation',
      'Wait for MACD line to cross back above signal');

    var stDirection = supertrend.direction[last];
    component('supertrend', stDirection === 1 ? 90 : stDirection === -1 ? 10 : null, 14,
      'Supertrend is bullish — trail sits below price',
      'Supertrend is bearish — trail sits above price',
      'Use Supertrend as a trailing invalidation guide',
      'No long until Supertrend flips bullish again');

    var volumeRatio = volumeSMA20 > 0 ? volumes[last] / volumeSMA20 : null;
    var volumeScore = volumeRatio == null ? null
      : volumeRatio >= 1.2 && analysis[last].close > analysis[last].open ? 90
        : volumeRatio >= 0.8 ? 60 : 40;
    component('volume', volumeScore, 8,
      'Volume is participating above its 20-bar average',
      'Participation is light versus the 20-bar average',
      'Strong volume on up bars confirms interest',
      'Thin volume moves fail more often — size down or wait');

    var lookback = Math.min(20, last);
    var prior = analysis.slice(last - lookback, last);
    var priorHigh = Math.max.apply(null, prior.map(function (c) { return c.high; }));
    var priorLow = Math.min.apply(null, prior.map(function (c) { return c.low; }));
    var higherLow = analysis[last].low > Math.min.apply(null, analysis.slice(last - 5, last).map(function (c) { return c.low; }));
    var structureScore = currentPrice > priorHigh ? 95 : currentPrice < priorLow ? 10 : higherLow ? 68 : 45;
    component('structure', structureScore, 10,
      currentPrice > priorHigh ? 'Price confirmed a 20-bar breakout' : 'Recent structure shows a higher low',
      'Recent market structure is weak or breaking down',
      'Breakouts work best with volume and Supertrend agreement',
      'Avoid catching knives — wait for a higher low first');

    // Classic EMA50/200 golden·death cross + Indian pattern labels (boost only — not auto-buy)
    var ema50Series = computeEMA(closes, 50);
    var ema200Series = computeEMA(closes, 200);
    var patterns = detectEquityPatterns(analysis, {
      ema50: ema50Series,
      ema200: ema200Series,
      volumeRatio: volumeRatio,
      priorHigh: priorHigh,
      higherLow: higherLow,
      structureScore: structureScore
    });
    if (patterns.goldenCross) {
      component('golden', 92, 10,
        'Golden crossover — EMA50 crossed above EMA200 with price above EMA200',
        'No golden crossover',
        'Classic long-term bullish shift — still wait for confluence gates',
        'Death/no cross — do not force a long');
      reasons.unshift('Pattern: Golden crossover (EMA50×200)');
    } else if (patterns.deathCross) {
      component('golden', 15, 10,
        'No death cross',
        'Death crossover — EMA50 crossed below EMA200',
        'Stay selective',
        'Death cross — prefer WAIT on new longs');
      reasons.unshift('Pattern: Death crossover — avoid fresh longs');
    } else if (patterns.hhhl) {
      component('golden', 78, 6,
        'Higher-high / higher-low structure intact',
        'Structure not HH/HL',
        'Trend structure supports pullback buys',
        'Wait for structure repair');
    }
    if (patterns.breakoutVolume) {
      reasons.unshift('Pattern: Breakout above resistance with volume');
    }

    var weekly = [];
    var weeklyScore = null;
    var weeklyBias = 'unknown';
    var monthlyBias = 'n/a';
    if (mode === 'positional') {
      var daily = timeframe === '1D' ? analysis : resampleCandles(raw, '1D');
      weekly = resampleWeekly(daily);
      var monthly = resampleMonthly(daily);
      if (monthly.length >= 12) {
        var mCloses = monthly.map(function (c) { return c.close; });
        var mEma10 = computeEMA(mCloses, 10);
        var mi = monthly.length - 1;
        monthlyBias = monthly[mi].close > mEma10[mi] ? 'supportive' : 'against';
        if (monthlyBias === 'supportive' && patterns.goldenCross) {
          patterns.labels.push('Monthly aligned');
        }
      }
      if (weekly.length >= 20) {
        var weeklyCloses = weekly.map(function (c) { return c.close; });
        var weeklyEMA20 = computeEMA(weeklyCloses, 20);
        var weeklyEMA50 = computeEMA(weeklyCloses, 50);
        var wi = weekly.length - 1;
        weeklyScore = weekly[wi].close > weeklyEMA20[wi] ? 75 : 25;
        if (weeklyEMA50[wi] != null) weeklyScore += weeklyEMA20[wi] > weeklyEMA50[wi] ? 15 : -15;
        weeklyBias = weeklyScore >= 65 ? 'supportive' : weeklyScore <= 40 ? 'against' : 'mixed';
        if (weeklyBias === 'supportive' && (patterns.goldenCross || patterns.hhhl)) {
          patterns.labels.push('Weekly aligned');
        }
        component('weekly', weeklyScore, 12,
          'Last completed week confirms the uptrend',
          'Last completed week does not confirm the uptrend',
          'Weekly tailwind — positional holds are easier',
          'Weekly headwind — prefer WAIT or smaller size');
      }
    } else {
      weeklyBias = 'n/a';
    }

    var patternLabel = patterns.labels.length ? patterns.labels.slice(0, 3).join(' · ') : '';
    var score = availableWeight ? Math.round(weighted / availableWeight) : 0;
    var nearestSupport = sr.supports.length ? sr.supports[0].price : null;
    var nearestResistance = sr.resistances.length ? sr.resistances[0].price : null;
    var stValue = supertrend.values[last];
    var fallbackATR = atr || currentPrice * 0.02;
    var invalidation = nearestSupport && nearestSupport < currentPrice
      ? nearestSupport - fallbackATR * 0.2 : currentPrice - fallbackATR * 2;
    if (stDirection === 1 && stValue < currentPrice) invalidation = Math.max(invalidation, stValue);
    invalidation = Math.min(invalidation, currentPrice - fallbackATR * 0.25);

    var resistAbove = (sr.resistances || []).map(function (r) { return r.price; })
      .filter(function (p) { return p > currentPrice + fallbackATR * 0.25; })
      .sort(function (a, b) { return a - b; });
    var t1 = resistAbove[0] || currentPrice + fallbackATR * 1.5;
    var t2 = resistAbove[1] || currentPrice + fallbackATR * 2.5;
    var t3 = resistAbove[2] || currentPrice + fallbackATR * 4;
    if (t2 <= t1) t2 = t1 + fallbackATR;
    if (t3 <= t2) t3 = t2 + fallbackATR * 1.2;
    var target = t2;
    var position = options.position;
    var positionEntry = position ? Number(position.entryPrice) : NaN;
    if (position && finite(positionEntry)) {
      var suppliedStop = Number(position.invalidationLevel);
      var suppliedTarget = Number(position.targetLevel);
      invalidation = finite(suppliedStop)
        ? suppliedStop : Math.max(invalidation, positionEntry - fallbackATR * 2);
      target = finite(suppliedTarget) ? suppliedTarget : positionEntry + fallbackATR * 3;
      t1 = Math.min(t1, target);
      t2 = target;
      t3 = Math.max(t3, target + fallbackATR);
    }
    var risk = currentPrice - invalidation;
    var reward = target - currentPrice;
    var riskReward = risk > 0 ? reward / risk : null;
    var rewardT1 = risk > 0 ? (t1 - currentPrice) / risk : null;
    var rewardT2 = risk > 0 ? (t2 - currentPrice) / risk : null;
    var rewardT3 = risk > 0 ? (t3 - currentPrice) / risk : null;
    var weeklyReady = mode !== 'positional' || weekly.length >= 20;
    var buyAt = finite(Number(options.buyScore)) ? Number(options.buyScore) : profile.buyAt;
    var minRR = finite(profile.minRR) ? profile.minRR : 1.35;
    var trendGate = mode === 'positional'
      ? (currentPrice > mid && fast > mid && stDirection === 1)
      : (currentPrice > mid && (fast > mid || stDirection === 1));
    var confluenceGate = score >= buyAt;
    var rrGate = riskReward != null && riskReward >= minRR;
    var action;
    // Scalp/intraday: score + trend drive BUY; R:R is soft (warn, don't hard-block).
    // Positional: keep weekly + trend + R:R gates.
    var buyReady;
    if (mode === 'positional') {
      buyReady = weeklyReady && confluenceGate && trendGate && rrGate;
    } else {
      buyReady = confluenceGate && trendGate;
      if (!buyReady && confluenceGate && score >= buyAt + 6) {
        buyReady = true; // strong score can clear a soft trend miss
      }
    }

    var checklist = [
      { id: 'confluence', label: 'Confluence ≥ Buy bar', pass: confluenceGate, detail: score + ' / ' + buyAt },
      { id: 'trend', label: 'Trend alignment', pass: !!trendGate, detail: trendGate ? 'aligned' : 'not aligned' },
      { id: 'rr', label: 'R:R ≥ ' + minRR, pass: !!rrGate, detail: riskReward != null ? String(round(riskReward, 2)) : 'n/a' },
      { id: 'weekly', label: 'Weekly bias', pass: mode !== 'positional' || (weeklyReady && weeklyBias !== 'against'), detail: weeklyBias }
    ];

    if (position) {
      var entryPrice = positionEntry;
      var entryTime = timestampValue(position.entryTime);
      var horizon = Number(position.horizonDays) || Number(options.maxHorizonDays) || profile.maxHorizonDays;
      var ageDays = finite(entryTime) ? (analysis[last].startTime - entryTime) / DAY_MS : 0;
      var reachedTarget = finite(entryPrice) && currentPrice >= target;
      var hardLoss = finite(entryPrice) && currentPrice <= entryPrice - fallbackATR * 2;
      var trendExit = currentPrice < mid && stDirection === -1 && score < 45;
      if (ageDays >= horizon) {
        action = 'EXIT';
        reasons.unshift('Maximum holding horizon of ' + horizon + ' days reached');
      } else if (reachedTarget) {
        action = 'EXIT';
        reasons.unshift('Target zone reached');
      } else if (currentPrice <= invalidation || hardLoss || trendExit) {
        action = 'EXIT';
        reasons.unshift('Position invalidation or bearish trend exit triggered');
      } else {
        action = 'HOLD';
        reasons.unshift('Hold — still above stop · trail toward T2/T3');
      }
    } else if (buyReady) {
      action = 'BUY';
      if (mode !== 'positional' && !rrGate) {
        reasons.unshift('YES BUY · R:R soft (' + (riskReward != null ? round(riskReward, 2) : 'n/a') + ') — size smaller');
      } else {
        reasons.unshift('YES — clear to buy · scale out T1 then T2/T3');
      }
    } else {
      action = 'WAIT';
      if (mode === 'positional' && !weeklyReady) reasons.unshift('Waiting for enough completed weekly history');
      else if (!trendGate) reasons.unshift('Waiting for price / EMA / Supertrend alignment');
      else if (mode === 'positional' && !rrGate) reasons.unshift('Reward vs risk still too tight (need R:R ≥ ' + minRR + ')');
      else reasons.unshift('Confluence score is below the ' + buyAt + ' buy bar');
    }

    var pickVerdict = action === 'BUY' ? 'YES' : action === 'HOLD' ? 'HOLD' : action === 'EXIT' ? 'EXIT' : 'NO';
    var decisionWhy = reasons[0] || 'No clear decision yet';
    var sortedLessons = lessons.slice().sort(function (a, b) {
      return Math.abs(b.score - 50) - Math.abs(a.score - 50);
    });
    var topDrivers = sortedLessons.slice(0, 3);
    var coachTip = '';
    if (action === 'BUY') {
      coachTip = 'Scale out at T1, trail stop under structure toward T2/T3. Invalidation = thesis broken.';
    } else if (action === 'HOLD') {
      coachTip = 'Do nothing fancy — hold above stop and let targets work.';
    } else if (action === 'EXIT') {
      coachTip = 'Respect the exit. Journal why, then wait for a fresh setup.';
    } else {
      var blocker = checklist.filter(function (c) { return !c.pass; })[0];
      var weak = sortedLessons.filter(function (l) { return l.bias === 'bear'; })[0];
      coachTip = (weak && weak.tip) || (blocker ? ('Fix: ' + blocker.label + ' (' + blocker.detail + ')') : 'Patience is a position — wait for gates to clear.');
    }

    return {
      action: action,
      score: clamp(score, 0, 100),
      buyAt: buyAt,
      reasons: reasons.slice(0, 8),
      lessons: lessons,
      topDrivers: topDrivers,
      coachTip: coachTip,
      decisionWhy: decisionWhy,
      checklist: checklist,
      pickVerdict: pickVerdict,
      weeklyBias: weeklyBias,
      monthlyBias: monthlyBias,
      patterns: patterns,
      patternLabel: patternLabel,
      invalidationLevel: round(invalidation, 2),
      targetLevel: round(target, 2),
      targetLevels: {
        t1: round(t1, 2),
        t2: round(t2, 2),
        t3: round(t3, 2)
      },
      riskReward: round(riskReward, 2),
      riskRewards: {
        t1: round(rewardT1, 2),
        t2: round(rewardT2, 2),
        t3: round(rewardT3, 2)
      },
      expectedHold: profile.expectedHold,
      confirmationTimeframe: profile.confirmationTimeframe,
      indicators: (function () {
        var snap = buildIndicatorSnapshot(analysis, mode, timeframe);
        snap.ema20 = round(mode === 'positional' ? null : lastValue(computeEMA(closes, 20)), 2);
        if (mode === 'positional') {
          snap.emaFast = snap.ema50;
          snap.emaMid = snap.ema100;
          snap.emaSlow = snap.ema200;
        } else {
          snap.emaFast = round(fast, 2);
          snap.emaMid = round(mid, 2);
          snap.emaSlow = round(slow, 2);
        }
        snap.patternLabel = patternLabel;
        return snap;
      })(),
      supportResistance: sr,
      dataSufficiency: {
        sufficient: true,
        available: analysis.length,
        required: minCandles,
        weeklyAvailable: weekly.length,
        weeklyRequired: mode === 'positional' ? 20 : 0,
        weeklySufficient: weeklyReady
      },
      mode: mode,
      timeframe: timeframe,
      currentPrice: round(currentPrice, 2),
      timestamp: analysis[last].startTime
    };
  }

  function emptyBacktest(error, mode, timeframe) {
    return {
      ok: false,
      error: error,
      mode: mode,
      timeframe: timeframe,
      trades: [],
      stats: {
        trades: 0, winRate: 0, profitFactor: 0, expectancy: 0,
        maxDrawdown: 0, totalReturn: 0
      }
    };
  }

  function backtestEquity(candles, options) {
    options = options || {};
    var mode = MODE_PROFILES[options.mode] ? options.mode : 'positional';
    var timeframe = options.timeframe || (mode === 'positional' ? '1D' : mode === 'scalp' ? '3m' : '45m');
    var source = resampleCandles(validCandles(candles), timeframe);
    var minNeed = MODE_PROFILES[mode].minCandles;
    if (source.length <= minNeed) {
      return emptyBacktest('Need more than ' + minNeed + ' completed candles', mode, timeframe);
    }
    var costPct = finite(Number(options.costPct)) ? Math.max(0, Number(options.costPct)) : 0.1;
    var horizon = Math.max(1, Number(options.maxHorizonDays) || MODE_PROFILES[mode].maxHorizonDays);
    var trades = [];
    var position = null;

    for (var i = minNeed - 1; i < source.length; i++) {
      var prefix = source.slice(0, i + 1);
      if (!position) {
        var entrySignal = generateEquitySignal(prefix, {
          mode: mode,
          timeframe: timeframe,
          buyScore: options.buyScore,
          maxHorizonDays: horizon,
          supportResistance: options.supportResistance
        });
        if (entrySignal.action === 'BUY' && i + 1 < source.length) {
          position = {
            entryIndex: i,
            entryTime: source[i].startTime,
            entryPrice: source[i].close,
            stop: entrySignal.invalidationLevel,
            target: entrySignal.targetLevel,
            score: entrySignal.score
          };
        }
        continue;
      }

      if (i <= position.entryIndex) continue;
      var bar = source[i];
      var ageDays = (bar.startTime - position.entryTime) / DAY_MS;
      var exitPrice = null;
      var exitReason = null;
      // Conservative ordering when stop and target are both touched in one OHLC bar.
      if (finite(position.stop) && bar.low <= position.stop) {
        exitPrice = position.stop;
        exitReason = 'stop';
      } else if (finite(position.target) && bar.high >= position.target) {
        exitPrice = position.target;
        exitReason = 'target';
      } else if (ageDays >= horizon) {
        exitPrice = bar.close;
        exitReason = 'horizon';
      } else {
        var liveSignal = generateEquitySignal(prefix, {
          mode: mode,
          timeframe: timeframe,
          maxHorizonDays: horizon,
          position: {
            entryPrice: position.entryPrice,
            entryTime: position.entryTime,
            horizonDays: horizon
          },
          supportResistance: options.supportResistance
        });
        if (liveSignal.action === 'EXIT') {
          exitPrice = bar.close;
          exitReason = 'signal';
        }
      }

      if (exitPrice != null) {
        var grossReturn = (exitPrice / position.entryPrice - 1) * 100;
        var netReturn = grossReturn - costPct;
        trades.push({
          entryIndex: position.entryIndex,
          exitIndex: i,
          entryTime: position.entryTime,
          exitTime: bar.startTime,
          entryPrice: round(position.entryPrice, 2),
          exitPrice: round(exitPrice, 2),
          stop: round(position.stop, 2),
          target: round(position.target, 2),
          entryScore: position.score,
          exitReason: exitReason,
          holdingDays: round(ageDays, 2),
          grossReturnPct: round(grossReturn, 3),
          costPct: round(costPct, 3),
          returnPct: round(netReturn, 3),
          win: netReturn > 0
        });
        position = null;
      }
    }

    if (position) {
      var finalBar = source[source.length - 1];
      var finalGross = (finalBar.close / position.entryPrice - 1) * 100;
      var finalNet = finalGross - costPct;
      trades.push({
        entryIndex: position.entryIndex,
        exitIndex: source.length - 1,
        entryTime: position.entryTime,
        exitTime: finalBar.startTime,
        entryPrice: round(position.entryPrice, 2),
        exitPrice: round(finalBar.close, 2),
        stop: round(position.stop, 2),
        target: round(position.target, 2),
        entryScore: position.score,
        exitReason: 'end-of-data',
        holdingDays: round((finalBar.startTime - position.entryTime) / DAY_MS, 2),
        grossReturnPct: round(finalGross, 3),
        costPct: round(costPct, 3),
        returnPct: round(finalNet, 3),
        win: finalNet > 0
      });
    }

    var wins = trades.filter(function (trade) { return trade.returnPct > 0; });
    var losses = trades.filter(function (trade) { return trade.returnPct <= 0; });
    var grossProfit = wins.reduce(function (sum, trade) { return sum + trade.returnPct; }, 0);
    var grossLoss = Math.abs(losses.reduce(function (sum, trade) { return sum + trade.returnPct; }, 0));
    var compounded = 1;
    var peak = 1;
    var maxDrawdown = 0;
    trades.forEach(function (trade) {
      compounded *= 1 + trade.returnPct / 100;
      peak = Math.max(peak, compounded);
      maxDrawdown = Math.max(maxDrawdown, (peak - compounded) / peak * 100);
    });
    var totalReturn = (compounded - 1) * 100;
    var expectancy = trades.length
      ? trades.reduce(function (sum, trade) { return sum + trade.returnPct; }, 0) / trades.length : 0;
    var profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    return {
      ok: true,
      error: null,
      mode: mode,
      timeframe: timeframe,
      costPct: costPct,
      candlesUsed: source.length,
      trades: trades,
      stats: {
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: round(trades.length ? wins.length / trades.length * 100 : 0, 2),
        profitFactor: profitFactor === Infinity ? Infinity : round(profitFactor, 3),
        expectancy: round(expectancy, 3),
        maxDrawdown: round(maxDrawdown, 3),
        totalReturn: round(totalReturn, 3)
      }
    };
  }

  global.KPPositionalEngine = {
    resampleCandles: resampleCandles,
    resampleWeekly: resampleWeekly,
    computeATR: computeATR,
    detectSupportResistance: detectSupportResistance,
    generateEquitySignal: generateEquitySignal,
    backtestEquity: backtestEquity,
    backtestPositional: backtestEquity,
    MODE_PROFILES: MODE_PROFILES,
    getModeProfile: function (modeId) {
      return MODE_PROFILES[modeId] || MODE_PROFILES.positional;
    }
  };
})(window);
