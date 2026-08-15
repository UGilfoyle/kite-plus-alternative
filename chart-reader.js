// Isolated-world chart reader. Talks to chart-bridge.js in this frame + chart iframes.
(function () {
  const TF_MS = {
    '1m': 60 * 1000, '2m': 2 * 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000, '45m': 45 * 60 * 1000, '4h': 4 * 60 * 60 * 1000,
    '1D': 24 * 60 * 60 * 1000, '1W': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000
  };

  let cachedSnap = {
    engine: 'dom',
    symbol: '',
    timeframe: null,
    ltp: null,
    candles: [],
    source: 'waiting',
    candleCount: 0,
    detectedAt: 0,
    score: -1
  };
  let reqSeq = 0;
  let refreshTimer = null;
  const pending = new Map();

  function normalizeTimeframe(raw) {
    const value = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    const map = {
      '1': '1m', '1m': '1m', '1min': '1m',
      '2': '2m', '2m': '2m', '3': '3m', '3m': '3m',
      '5': '5m', '5m': '5m', '15': '15m', '15m': '15m',
      '30': '45m', '45': '45m', '45m': '45m',
      '60': '4h', '1h': '4h', '4h': '4h',
      'd': '1D', '1d': '1D', 'w': '1W', '1w': '1W',
      'mo': '1M', '1mo': '1M', 'month': '1M', 'monthly': '1M'
    };
    return map[value] || (String(raw || '').toUpperCase() === '1M' ? '1M' : null);
  }

  function scoreSnap(snap) {
    if (!snap) return -1;
    let score = Number(snap.score);
    if (Number.isFinite(score)) return score;
    score = 0;
    score += (snap.candles?.length || 0) * 10;
    if (snap.ltp) score += 50;
    if (snap.symbol) score += 5;
    if (snap.engine === 'chartiq') score += 20;
    if (snap.engine === 'tradingview') score += 10;
    return score;
  }

  function detectEngine() {
    if (cachedSnap.engine && cachedSnap.engine !== 'dom') return cachedSnap.engine;
    if (document.querySelector('cq-context, .ciq-chart, #chart-iframe')) {
      return document.querySelector('#chart-iframe, [class*="pane-legend"]') ? 'tradingview' : 'chartiq';
    }
    return 'dom';
  }

  function acceptSnap(snap) {
    if (!snap || typeof snap !== 'object') return;
    const newScore = scoreSnap(snap);
    const oldScore = scoreSnap(cachedSnap);
    const newLtp = Number(snap.ltp);
    const oldLtp = Number(cachedSnap.ltp);
    const fresherLtp = Number.isFinite(newLtp) && newLtp > 0 &&
      (!Number.isFinite(oldLtp) || Math.abs(newLtp - oldLtp) > 1e-6) &&
      newScore >= 20;
    if (newScore >= oldScore || fresherLtp) {
      const keepCandles = fresherLtp && newScore < oldScore &&
        (snap.candles?.length || 0) < (cachedSnap.candles?.length || 0);
      const candles = keepCandles
        ? cachedSnap.candles
        : (Array.isArray(snap.candles) ? snap.candles : []);
      cachedSnap = {
        ...snap,
        candles,
        candleCount: candles.length,
        detectedAt: Date.now(),
        score: keepCandles ? Math.max(newScore, oldScore) : newScore
      };
    }
  }

  function broadcastRequest(id) {
    window.postMessage({ type: 'KP_CHART_REQ', id }, '*');
    document.querySelectorAll('iframe').forEach(frame => {
      try {
        frame.contentWindow?.postMessage({ type: 'KP_CHART_REQ', id }, '*');
      } catch (_) {}
    });
  }

  function requestSnapshot(timeoutMs = 900) {
    const id = `kp_${Date.now()}_${++reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(cachedSnap);
      }, timeoutMs);
      pending.set(id, { resolve, timer, best: cachedSnap });
      broadcastRequest(id);
    });
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;

    if (data.type === 'KP_CHART_PUSH' && data.snap) {
      acceptSnap(data.snap);
      return;
    }

    if (data.type !== 'KP_CHART_RES') return;
    acceptSnap(data.snap);
    const waiter = pending.get(data.id);
    if (!waiter) return;
    // Keep gathering briefly for iframe replies; resolve early if we have LTP+candles
    if (scoreSnap(cachedSnap) >= 60) {
      clearTimeout(waiter.timer);
      pending.delete(data.id);
      waiter.resolve(cachedSnap);
    }
  });

  function readSnapshot() {
    return cachedSnap;
  }

  async function refreshSnapshot() {
    return requestSnapshot();
  }

  async function seedCollectorFromChart(collector) {
    if (!collector || typeof collector.seedCandles !== 'function') return 0;
    const snap = await requestSnapshot(1400);
    if (!snap.candles?.length) return 0;
    const use = snap.candles.slice(-500);
    collector.seedCandles(use);
    return use.length;
  }

  function clearCache() {
    cachedSnap = {
      engine: 'dom',
      symbol: '',
      timeframe: null,
      ltp: null,
      candles: [],
      source: 'cleared',
      candleCount: 0,
      detectedAt: 0,
      score: -1
    };
  }

  function startAutoRefresh(ms = 500) {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      requestSnapshot(700).catch(() => {});
    }, ms);
    requestSnapshot(900).catch(() => {});
  }

  startAutoRefresh(500);

  window.KPChartReader = {
    detectEngine,
    readSnapshot,
    refreshSnapshot,
    seedCollectorFromChart,
    clearCache,
    normalizeTimeframe,
    TF_MS
  };
})();
