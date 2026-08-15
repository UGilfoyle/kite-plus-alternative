// Runs in PAGE (MAIN) world — including chart iframes (all_frames).
// Reads ChartIQ / TradingView OHLC that live inside #chart-iframe on Kite.
(function () {
  if (window.__KP_CHART_BRIDGE__) return;
  window.__KP_CHART_BRIDGE__ = true;

  const TF_MS = {
    '1m': 60 * 1000, '2m': 2 * 60 * 1000, '3m': 3 * 60 * 1000, '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000, '45m': 45 * 60 * 1000, '4h': 4 * 60 * 60 * 1000,
    '1D': 24 * 60 * 60 * 1000, '1W': 7 * 24 * 60 * 60 * 1000,
    '1M': 30 * 24 * 60 * 60 * 1000
  };

  function normalizeTimeframe(raw) {
    const value = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    const map = {
      '1': '1m', '1m': '1m', '1min': '1m', '1minute': '1m',
      '2': '2m', '2m': '2m', '2min': '2m',
      '3': '3m', '3m': '3m', '3min': '3m',
      '5': '5m', '5m': '5m', '5min': '5m',
      '15': '15m', '15m': '15m', '15min': '15m',
      '30': '45m', '30m': '45m', '45': '45m', '45m': '45m',
      '60': '4h', '60m': '4h', '1h': '4h', '240': '4h', '4h': '4h',
      'd': '1D', '1d': '1D', 'day': '1D', 'daily': '1D',
      'w': '1W', '1w': '1W', 'week': '1W', 'weekly': '1W',
      'mo': '1M', '1mo': '1M', 'month': '1M', 'monthly': '1M', '1mth': '1M'
    };
    if (value === '1m' && /month/i.test(String(raw || ''))) return '1M';
    return map[value] || (String(raw || '').toUpperCase() === '1M' ? '1M' : null);
  }

  function toCandle(row) {
    if (!row || typeof row !== 'object') return null;
    const open = Number(row.Open ?? row.open ?? row.o);
    const high = Number(row.High ?? row.high ?? row.h);
    const low = Number(row.Low ?? row.low ?? row.l);
    const close = Number(row.Close ?? row.close ?? row.c ?? row.value ?? row.last);
    const volume = Number(row.Volume ?? row.volume ?? row.v ?? 0) || 0;
    let startTime = Number(row.DT ?? row.Date ?? row.date ?? row.time ?? row.t ?? row.timestamp);
    if (!Number.isFinite(startTime) && row.DT instanceof Date) startTime = row.DT.getTime();
    if (!Number.isFinite(startTime) && row.date instanceof Date) startTime = row.date.getTime();
    if (Number.isFinite(startTime) && startTime < 1e12) startTime *= 1000;
    if (![open, high, low, close].every(n => Number.isFinite(n) && n > 0)) return null;
    if (!Number.isFinite(startTime) || startTime <= 0) startTime = Date.now();
    return { startTime, open, high, low, close, volume, complete: true };
  }

  function dedupeSortCandles(candles) {
    const map = new Map();
    (candles || []).forEach(c => {
      if (!c || !Number.isFinite(c.startTime)) return;
      map.set(c.startTime, c);
    });
    return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
  }

  function parseLegendOhlc(doc) {
    const root = doc || document;
    const textBlob = [];
    const selectors = [
      '.pane-legend',
      '[class*="pane-legend"]',
      '[data-name="legend"]',
      '[data-name="legend-source-item"]',
      '.legend-source-item',
      '[class*="legendSource"]',
      '[class*="valueValue"]',
      '.chart-markup-table'
    ];
    selectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(node => {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 400) textBlob.push(t);
      });
    });
    const joined = textBlob.join(' | ');
    // "O 333.10 H 340.00 L 330.25 C 334.20"
    const m = joined.match(
      /O\s*([0-9]+(?:\.[0-9]+)?)\s*H\s*([0-9]+(?:\.[0-9]+)?)\s*L\s*([0-9]+(?:\.[0-9]+)?)\s*C\s*([0-9]+(?:\.[0-9]+)?)/i
    );
    if (!m) {
      // Sometimes values are separate spans after O/H/L/C labels
      const nums = [];
      root.querySelectorAll(
        '.pane-legend-item-value, .pane-legend-item-value__main, [class*="pane-legend-item-value"], [class*="valueValue"]'
      ).forEach(node => {
        const n = Number(String(node.textContent || '').replace(/,/g, '').trim());
        if (Number.isFinite(n) && n > 0) nums.push(n);
      });
      if (nums.length >= 4) {
        return {
          open: nums[0], high: nums[1], low: nums[2], close: nums[3],
          ltp: nums[3], source: 'TV legend values'
        };
      }
      return null;
    }
    return {
      open: Number(m[1]),
      high: Number(m[2]),
      low: Number(m[3]),
      close: Number(m[4]),
      ltp: Number(m[4]),
      source: 'TV legend OHLC'
    };
  }

  function detectEngine(doc) {
    const root = doc || document;
    const win = root.defaultView || window;
    if (win.stxx || win.CIQ || root.querySelector('cq-context, .ciq-chart, [class*="ciq-"]')) {
      return 'chartiq';
    }
    if (
      win.TradingView || win.tvWidget ||
      root.querySelector(
        '#tv_chart_container, .tv-chart-container, .chart-markup-table, ' +
        '[class*="chart-markup-table"], [class*="pane-legend"]'
      )
    ) {
      return 'tradingview';
    }
    return 'dom';
  }

  function findChartIqEngines(win) {
    const w = win || window;
    const engines = [];
    const push = (eng) => {
      if (eng && eng.chart && !engines.includes(eng)) engines.push(eng);
    };
    push(w.stxx);
    if (w.CIQ?.ChartEngine?.instances) {
      Object.values(w.CIQ.ChartEngine.instances).forEach(push);
    }
    try {
      (w.document || document).querySelectorAll('cq-context, .ciq-chart, [class*="chartContainer"]').forEach(node => {
        push(node.stxx || node.__stxx || node.CIQ?.stxx);
      });
    } catch (_) {}
    return engines;
  }

  function readChartIqSnapshot(win) {
    const engines = findChartIqEngines(win);
    for (const stxx of engines) {
      try {
        let symbolText = String(
          stxx.chart?.symbol ||
          stxx.chart?.symbolObject?.symbol ||
          stxx.chart?.symbolObject?.name ||
          ''
        ).trim();
        const desc = String(
          stxx.chart?.symbolObject?.description ||
          stxx.chart?.symbolObject?.name || ''
        );
        const optionFromDesc = desc.match(
          /((?:NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|[A-Z]{2,15})[A-Z0-9]*\d{4,6}(?:CE|PE))/i
        );
        if (optionFromDesc && !/\d{4,6}(CE|PE)$/i.test(symbolText.replace(/\s+/g, ''))) {
          symbolText = optionFromDesc[1];
        }

        const interval = stxx.layout?.interval;
        const timeUnit = stxx.layout?.timeUnit;
        let tfRaw = '';
        if (timeUnit && interval) {
          if (String(timeUnit).toLowerCase().startsWith('min')) tfRaw = `${interval}m`;
          else if (String(timeUnit).toLowerCase().startsWith('hour')) tfRaw = interval === 4 ? '4h' : `${interval}h`;
          else if (String(timeUnit).toLowerCase().startsWith('day')) tfRaw = '1D';
          else if (String(timeUnit).toLowerCase().startsWith('week')) tfRaw = '1W';
        }
        if (!tfRaw) tfRaw = String(stxx.layout?.periodicity || stxx.layout?.interval || '');

        const rawRows =
          stxx.chart?.scrubbed ||
          stxx.chart?.dataSet ||
          stxx.masterData ||
          stxx.chart?.dataSegment ||
          [];
        const candles = dedupeSortCandles(
          (Array.isArray(rawRows) ? rawRows : []).map(toCandle).filter(Boolean)
        ).slice(-500);
        const last = candles[candles.length - 1];
        let ltp = null;
        try {
          const q = typeof stxx.currentQuote === 'function' ? stxx.currentQuote() : stxx.currentQuote;
          ltp = Number(q?.Close ?? q?.close ?? q?.Last ?? q?.last ?? last?.close);
        } catch (_) {
          ltp = Number(last?.close);
        }
        if (!Number.isFinite(ltp) || ltp <= 0) {
          try {
            const hu = document.querySelector('cq-hu-price, .hu-price, [class*="hu-price"], .mSticky');
            const n = Number(String(hu?.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
            if (Number.isFinite(n) && n > 0) ltp = n;
          } catch (_) {}
        }
        return {
          engine: 'chartiq',
          symbol: symbolText,
          timeframe: normalizeTimeframe(tfRaw),
          ltp: Number.isFinite(ltp) && ltp > 0 ? ltp : null,
          candles,
          source: 'ChartIQ panel',
          candleCount: candles.length,
          frame: window === window.top ? 'top' : 'iframe'
        };
      } catch (_) {}
    }
    return null;
  }

  function readTradingViewSnapshot(win) {
    const w = win || window;
    const doc = w.document || document;
    const candidates = [];
    try {
      if (w.tvWidget && typeof w.tvWidget.activeChart === 'function') candidates.push(w.tvWidget);
    } catch (_) {}
    try {
      if (w.TradingView?.widget) candidates.push(w.TradingView.widget);
    } catch (_) {}

    for (const widget of candidates) {
      try {
        const chart = widget.activeChart?.() || widget.chart?.();
        if (!chart) continue;
        const symbol = chart.symbol?.() || chart.symbol || '';
        const resolution = chart.resolution?.() || chart.interval?.() || '';
        return {
          engine: 'tradingview',
          symbol: String(symbol || '').trim(),
          timeframe: normalizeTimeframe(resolution),
          ltp: null,
          candles: [],
          source: 'TradingView widget',
          candleCount: 0,
          frame: window === window.top ? 'top' : 'iframe'
        };
      } catch (_) {}
    }

    const legend = parseLegendOhlc(doc);
    let symbol = '';
    try {
      const titleNode = doc.querySelector(
        '.tv-symbol-header__short-name, .pane-legend-title__description, ' +
        '[data-name="legend-source-item"] [class*="title"], [class*="symbolTitle"]'
      );
      symbol = (titleNode?.textContent || '').trim();
    } catch (_) {}

    const candles = [];
    if (legend && legend.close > 0) {
      const now = Date.now();
      candles.push({
        startTime: now - 60 * 1000,
        open: legend.open,
        high: legend.high,
        low: legend.low,
        close: legend.close,
        volume: 0,
        complete: false
      });
    }

    if (!legend && !symbol) return null;
    return {
      engine: 'tradingview',
      symbol,
      timeframe: null,
      ltp: legend?.ltp || null,
      candles,
      source: legend?.source || 'TradingView DOM',
      candleCount: candles.length,
      frame: window === window.top ? 'top' : 'iframe'
    };
  }

  function scoreSnap(snap) {
    if (!snap) return -1;
    let score = 0;
    score += (snap.candles?.length || 0) * 10;
    if (snap.ltp) score += 50;
    if (snap.symbol) score += 5;
    if (snap.engine === 'chartiq') score += 20;
    if (snap.engine === 'tradingview') score += 10;
    if (/\d{4,6}(CE|PE)$/i.test(String(snap.symbol || '').replace(/\s+/g, ''))) score += 30;
    return score;
  }

  function readLocalSnapshot() {
    const engine = detectEngine(document);
    let snap = null;
    if (engine === 'chartiq') snap = readChartIqSnapshot(window);
    if (!snap || scoreSnap(snap) < 50) {
      const tv = readTradingViewSnapshot(window);
      if (scoreSnap(tv) > scoreSnap(snap)) snap = tv;
    }
    if (!snap) {
      snap = {
        engine: 'dom',
        symbol: '',
        timeframe: null,
        ltp: null,
        candles: [],
        source: 'DOM fallback',
        candleCount: 0,
        frame: window === window.top ? 'top' : 'iframe'
      };
    }
    snap.engine = snap.engine || engine;
    snap.detectedAt = Date.now();
    snap.tfMs = snap.timeframe && TF_MS[snap.timeframe] ? TF_MS[snap.timeframe] : null;
    snap.score = scoreSnap(snap);
    return snap;
  }

  /** Parent frame: also peek same-origin chart iframes (Kite #chart-iframe). */
  function readIncludingIframes() {
    let best = readLocalSnapshot();
    if (window !== window.top) return best;

    const frames = document.querySelectorAll(
      'iframe#chart-iframe, iframe[id*="chart"], iframe[name*="tradingview"], ' +
      'iframe[src*="chart"], iframe[src*="tradingview"], iframe'
    );
    frames.forEach(frame => {
      try {
        const win = frame.contentWindow;
        const doc = frame.contentDocument;
        if (!win || !doc) return;
        // Prefer engines on the iframe window
        let snap = readChartIqSnapshot(win) || readTradingViewSnapshot(win);
        if (!snap) {
          const legend = parseLegendOhlc(doc);
          if (legend) {
            snap = {
              engine: 'tradingview',
              symbol: '',
              timeframe: null,
              ltp: legend.ltp,
              candles: [{
                startTime: Date.now() - 60 * 1000,
                open: legend.open,
                high: legend.high,
                low: legend.low,
                close: legend.close,
                volume: 0,
                complete: false
              }],
              source: 'iframe · ' + legend.source,
              candleCount: 1,
              frame: 'iframe-dom'
            };
          }
        }
        if (scoreSnap(snap) > scoreSnap(best)) best = snap;
      } catch (_) {
        // cross-origin iframe — bridge injected via all_frames will answer instead
      }
    });
    if (best) {
      best.detectedAt = Date.now();
      best.score = scoreSnap(best);
    }
    return best;
  }

  function reply(id, snap) {
    const payload = { type: 'KP_CHART_RES', id, snap };
    try {
      window.postMessage(payload, '*');
    } catch (_) {}
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage(payload, '*');
      }
    } catch (_) {}
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'KP_CHART_REQ') return;
    try {
      const snap = readIncludingIframes();
      // Only reply if we have something useful, unless we're the top frame (always reply)
      if (window === window.top || scoreSnap(snap) > 0) {
        reply(data.id, snap);
      }
    } catch (err) {
      reply(data.id, {
        engine: 'dom',
        symbol: '',
        timeframe: null,
        ltp: null,
        candles: [],
        source: 'bridge error',
        candleCount: 0,
        error: String(err?.message || err)
      });
    }
  });

  // Push live quotes to top so LTP updates even without requests
  if (window !== window.top) {
    setInterval(() => {
      try {
        const snap = readLocalSnapshot();
        // LTP-only option snaps score ~50–75 — push those so premium updates without full OHLC.
        if (scoreSnap(snap) < 20) return;
        window.top.postMessage({ type: 'KP_CHART_PUSH', snap }, '*');
      } catch (_) {}
    }, 400);
  }
})();
