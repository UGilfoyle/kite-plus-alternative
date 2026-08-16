// Multi-broker chart adapter. Keeps broker DOM assumptions out of the engines.
(function () {
  const HOST = window.location.hostname.toLowerCase();

  function textOf(selectors) {
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (text) return text;
      }
    }
    return '';
  }

  function parsePrice(text) {
    if (!text) return null;
    const matches = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/g);
    if (!matches) return null;
    for (const token of matches) {
      const n = Number(token);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function normalizeTimeframe(raw) {
    const value = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
    const map = {
      '1': '1m', '1m': '1m', '1min': '1m', '1minute': '1m',
      '2': '2m', '2m': '2m', '2min': '2m',
      '3': '3m', '3m': '3m', '3min': '3m',
      '5': '5m', '5m': '5m', '5min': '5m',
      '15': '15m', '15m': '15m', '15min': '15m',
      '45': '45m', '45m': '45m', '45min': '45m',
      '240': '4h', '240m': '4h', '4h': '4h', '4hour': '4h',
      'd': '1D', '1d': '1D', 'day': '1D', 'daily': '1D',
      'w': '1W', '1w': '1W', 'week': '1W', 'weekly': '1W',
      'mo': '1M', '1mo': '1M', 'month': '1M', 'monthly': '1M', '1mth': '1M'
    };
    return map[value] || (String(raw || '').toUpperCase() === '1M' ? '1M' : null);
  }

  function cleanSymbol(raw) {
    let value = String(raw || '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
    value = value
      .replace(/\b(NSE-EQ|BSE-EQ|NFO-OPT|BFO-OPT|NSE|BSE|NFO|BFO)\s*[:|/-]\s*/g, '')
      .replace(/\s+(EQ|BE|BZ)$/g, '')
      .replace(/\s+(LTP|NSE|BSE)$/g, '')
      .trim();
    return value;
  }

  function inferExchange(raw, fallback) {
    const value = String(raw || '').toUpperCase();
    if (/\b(BSE|BFO)\b/.test(value)) return 'BSE';
    if (/\b(NSE|NFO)\b/.test(value)) return 'NSE';
    return fallback || 'NSE';
  }

  function titleSymbol() {
    const title = document.title || '';
    const first = title.split(/[|–—·]/)[0].trim();
    if (!first || /^(KITE|UPSTOX|CHART|POSITIONS|ORDERS|HOLDINGS)$/i.test(first)) return '';
    return first.replace(/\s+(SHARE PRICE|STOCK PRICE|CHART|BY ZERODHA).*$/i, '').trim();
  }

  function isOptionLike(raw) {
    const compact = String(raw || '').toUpperCase().replace(/\s+/g, '');
    return /\d{4,6}(CE|PE)$/.test(compact) ||
      /\d{4,6}(CE|PE)\b/.test(String(raw || '').toUpperCase()) ||
      /(CALL|PUT)$/.test(compact);
  }

  function isJunkSymbol(raw) {
    const value = String(raw || '').trim().toUpperCase();
    if (!value) return true;
    if (value.length > 48) return true;
    return /^(POSITIONS|ORDERS|HOLDINGS|FUNDS|MARKETWATCH|WATCHLIST|DASHBOARD|HOME|CHART|KITE|UPSTOX|ZERODHA|BY ZERODHA)\b/.test(value) ||
      /KITE BY ZERODHA|UPSTOX PRO|POSITIONS\s*\/|ORDERS\s*\//.test(value);
  }

  function acceptSymbol(raw) {
    const symbol = cleanSymbol(raw);
    if (!symbol || isJunkSymbol(symbol)) return '';
    if (!/[A-Z]/.test(symbol)) return '';
    if (/^\d+$/.test(symbol.replace(/\s+/g, ''))) return '';
    // Keep option names intact even when long (e.g. NIFTY25JUL24400PE).
    if (isOptionLike(symbol) && symbol.length <= 48) return symbol;
    if (symbol.length > 32 && !isOptionLike(symbol)) return '';
    return symbol;
  }

  function symbolFromUrl() {
    try {
      const decoded = decodeURIComponent(
        window.location.pathname + window.location.search + window.location.hash
      );
      const patterns = [
        // Kite ChartIQ: /chart/web/ciq/NFO-OPT/NIFTY25JUL24400PE
        /\/(?:NFO-OPT|BFO-OPT|NFO|BFO)\/([A-Z0-9&._-]{6,48})(?:\/|$|\?)/i,
        /\/chart\/[^?#]*\/(?:NFO-OPT|BFO-OPT|NFO|BFO)\/([A-Z0-9&._-]{6,48})/i,
        /(?:NFO-OPT|BFO-OPT|NFO|BFO)[:/|%-]+([A-Z0-9&._-]{6,48})/i,
        /\/(?:NSE-EQ|BSE-EQ|NSE|BSE)\/([A-Z0-9&._-]{1,32})(?:\/|$|\?)/i,
        /(?:NSE-EQ|BSE-EQ|NSE|BSE|NSE_EQ|BSE_EQ)[:/|%-]+([A-Z0-9&._-]{1,32})/i,
        /[?&#](?:symbol|tradingsymbol|ts)=([A-Z0-9&._%+-]{1,48})/i,
        /(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX)[A-Z0-9]*\d{4,6}(?:CE|PE)/i,
        /([A-Z]{2,15}\d{2}[A-Z]{3}\d{4,6}(?:CE|PE))/i
      ];
      const hits = [];
      for (const pattern of patterns) {
        const match = decoded.match(pattern);
        if (match) {
          const symbol = acceptSymbol((match[1] || match[0]).replace(/-/g, ' ').replace(/%20/g, ' '));
          if (symbol) hits.push(symbol);
        }
      }
      const optionHit = hits.find(isOptionLike);
      if (optionHit) return optionHit;
      return hits[0] || '';
    } catch (_) {}
    return '';
  }

  function collectDomSymbols(selectors) {
    const found = [];
    for (const selector of selectors) {
      const nodes = document.querySelectorAll(selector);
      for (const node of nodes) {
        const attr = node.getAttribute?.('data-symbol') ||
          node.getAttribute?.('data-tradingsymbol') ||
          node.getAttribute?.('title') || '';
        const fromAttr = acceptSymbol(attr);
        if (fromAttr) found.push({ symbol: fromAttr, source: selector, chartish: /chart|legend|instrument-select|tv-symbol/i.test(selector) });
        const text = acceptSymbol((node.textContent || '').split('\n')[0]);
        if (text) found.push({ symbol: text, source: selector, chartish: /chart|legend|instrument-select|tv-symbol/i.test(selector) });
      }
    }
    return found;
  }

  function pickBestSymbol(candidates) {
    if (!candidates.length) return '';
    const optionChart = candidates.find(c => c.chartish && isOptionLike(c.symbol));
    if (optionChart) return optionChart.symbol;
    const anyOption = candidates.find(c => isOptionLike(c.symbol));
    if (anyOption) return anyOption.symbol;
    const chartFirst = candidates.find(c => c.chartish);
    if (chartFirst) return chartFirst.symbol;
    return candidates[0].symbol;
  }

  function symbolFromDom(selectors) {
    return pickBestSymbol(collectDomSymbols(selectors));
  }

  /**
   * Instrument the open chart is showing.
   * Option on URL/header always beats watchlist equity or stale ChartIQ equity.
   */
  function resolveBestSymbol(adapter, chartSnap) {
    const candidates = [];
    const push = (raw, source, boost) => {
      const symbol = acceptSymbol(raw);
      if (!symbol) return;
      candidates.push({
        symbol,
        source,
        boost: boost + (isOptionLike(symbol) ? 100 : 0)
      });
    };

    push(symbolFromUrl(), 'url', 40);
    push(chartSnap?.symbol, 'chart-engine', 30);
    if (adapter?.scrapeSymbol) push(adapter.scrapeSymbol(), 'adapter-dom', 20);
    push(titleSymbol(), 'title', 10);
    push(symbolFromDom([
      '.chart-container .tradingsymbol',
      '.chart-header .tradingsymbol',
      '.chart-controls-bar .symbol',
      '.chart-controls-bar .tradingsymbol',
      '.instrument-select .tradingsymbol',
      '.instrument-select .nice-name',
      '.tv-symbol-header__short-name',
      '.pane-legend-title__description',
      '[class*="chart"] [class*="tradingsymbol"]',
      '[class*="chart"] [class*="symbol"]',
      'cq-context [class*="symbol"]'
    ]), 'chart-dom-scan', 25);

    if (!candidates.length) return '';
    // URL option tradingsymbol always wins over display "23rd JUL" names
    const urlOption = candidates.find(c => c.source === 'url' && isOptionLike(c.symbol));
    if (urlOption) return urlOption.symbol;
    candidates.sort((a, b) => b.boost - a.boost || b.symbol.length - a.symbol.length);
    const best = candidates[0];
    const option = candidates.find(c => isOptionLike(c.symbol));
    if (option && !isOptionLike(best.symbol)) return option.symbol;
    return best.symbol;
  }

  const commonPriceSelectors = [
    '.tv-symbol-price-quote__value',
    '.js-symbol-last',
    '[data-field="last_price"]',
    '[data-testid*="ltp"]',
    '[class*="lastPrice"]',
    '[class*="last-price"]'
  ];

  const kiteChartSymbolSelectors = [
    '.chart-container .tradingsymbol',
    '.chart-header .tradingsymbol',
    '.chart-controls-bar .symbol',
    '.chart-controls-bar .tradingsymbol',
    '.instrument-select .tradingsymbol',
    '.instrument-select .nice-name',
    '.exchange-symbol .tradingsymbol',
    '.pane-legend-title__description',
    '.pane-legend-line > .pane-legend-title__wrapper .pane-legend-title__description',
    '.tv-symbol-header__short-name',
    '.tv-symbol-header__first-line',
    '[data-name="legend-series-item"] .mainTitle-l31H9iuA',
    '[data-label="symbol"]',
    '[class*="chart"] [class*="tradingsymbol"]'
  ];

  const kiteWatchlistSymbolSelectors = [
    '.marketwatch-sidebar .instrument.selected .tradingsymbol',
    '.instruments .selected .tradingsymbol',
    '.instruments .instrument.selected .symbol',
    '.symbol-search .tradingsymbol'
  ];

  const kite = {
    id: 'kite',
    label: 'Kite',
    isChartPage() {
      return window.location.pathname.includes('/chart') ||
        !!document.querySelector('.chart-container, .chart-widget, .tv-chart, [class*="chart-container"]');
    },
    scrapeSymbol() {
      // Chart / URL first — never let a selected watchlist equity (e.g. LTM) override an open option chart.
      return symbolFromDom(kiteChartSymbolSelectors) ||
        symbolFromUrl() ||
        symbolFromDom(kiteWatchlistSymbolSelectors) ||
        (window.mockState?.symbol ? acceptSymbol(window.mockState.symbol) : '') ||
        acceptSymbol(titleSymbol());
    },
    scrapeExchange() {
      return inferExchange(
        textOf(['.instrument-select .exchange', '.chart-header .exchange', '[data-label="exchange"]']) ||
        window.location.pathname,
        'NSE'
      );
    },
    scrapeLTP() {
      return scrapeChartLTP(kiteChartSymbolSelectors) || window.mockState?.lastPrice || null;
    },
    scrapeTimeframe() {
      return scrapeActiveTimeframe();
    }
  };

  const upstox = {
    id: 'upstox',
    label: 'Upstox',
    isChartPage() {
      return HOST.includes('upstox.com') ||
        !!document.querySelector(
          '[data-testid*="chart"], [class*="chart-container"], [class*="ChartContainer"], ' +
          '.chart-markup-table, iframe[src*="chart"], iframe[src*="tradingview"], ' +
          '#tv_chart_container, .tv-chart-container, [id*="tradingview"]'
        );
    },
    scrapeSymbol() {
      return symbolFromDom([
        '[data-testid="instrument-name"]',
        '[data-testid*="symbol-name"]',
        '[data-testid*="instrument"] [class*="symbol"]',
        '[class*="InstrumentHeader"] [class*="symbol"]',
        '[class*="instrument-header"] [class*="name"]',
        '[class*="symbolName"]',
        '[class*="symbol-name"]',
        '[class*="scrip-name"]',
        '[class*="stock-name"]',
        '.tv-symbol-header__short-name',
        '.pane-legend-title__description',
        '[data-symbol]'
      ]) || symbolFromUrl() || acceptSymbol(titleSymbol());
    },
    scrapeExchange() {
      return inferExchange(
        textOf(['[data-testid*="exchange"]', '[class*="exchange"]']) ||
        window.location.href,
        'NSE'
      );
    },
    scrapeLTP() {
      return scrapeChartLTP([
        '[data-testid="instrument-name"]',
        '[data-testid*="symbol-name"]',
        '[class*="InstrumentHeader"] [class*="symbol"]',
        '[class*="instrument-header"] [class*="name"]',
        '[class*="symbolName"]',
        '[class*="symbol-name"]',
        '.tv-symbol-header__short-name',
        '.pane-legend-title__description'
      ]);
    },
    scrapeTimeframe() {
      return scrapeActiveTimeframe();
    }
  };

  function isGlobalIndexNoise(el) {
    if (!el || !el.closest) return true;
    return !!el.closest(
      'header, .app-header, .header, .navbar, .topbar, .market-status, ' +
      '.indices, [class*="index-bar"], [class*="IndexBar"], ' +
      '[class*="marketwatch"] .index, .omnibar'
    );
  }

  function scrapeLtpNearSymbol(symbolSelectors) {
    const wanted = acceptSymbol(
      symbolFromDom(symbolSelectors) || symbolFromUrl() || ''
    );
    if (!wanted) return null;
    const compactWanted = wanted.replace(/\s+/g, '');
    const labelNodes = document.querySelectorAll(symbolSelectors.join(', '));
    for (const label of labelNodes) {
      if (isGlobalIndexNoise(label)) continue;
      const labelSymbol = acceptSymbol((label.textContent || '').split('\n')[0]);
      if (!labelSymbol || labelSymbol.replace(/\s+/g, '') !== compactWanted) continue;
      const root = label.closest(
        '.instrument, .instrument-select, .chart-header, .chart-controls-bar, ' +
        '.chart-container, .tv-symbol-header, [class*="InstrumentHeader"], ' +
        '[class*="legend"], [class*="pane-legend"], tr, li, div'
      ) || label.parentElement;
      if (!root || isGlobalIndexNoise(root)) continue;
      const priceNodes = root.querySelectorAll(
        '.last-price, .chart-price, .ltp, .price, ' +
        '.tv-symbol-price-quote__value, .js-symbol-last, ' +
        '[data-testid*="ltp"], [class*="last-price"], [class*="lastPrice"]'
      );
      for (const node of priceNodes) {
        if (isGlobalIndexNoise(node)) continue;
        const price = parsePrice(node.textContent);
        if (price) return price;
      }
    }
    return null;
  }

  function scrapeLegendLtpFromDoc(doc) {
    if (!doc) return null;
    const textBlob = [];
    doc.querySelectorAll(
      '.pane-legend, [class*="pane-legend"], [data-name="legend"], [data-name="legend-source-item"]'
    ).forEach(node => {
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) textBlob.push(t);
    });
    const joined = textBlob.join(' | ');
    const m = joined.match(
      /O\s*([0-9]+(?:\.[0-9]+)?)\s*H\s*([0-9]+(?:\.[0-9]+)?)\s*L\s*([0-9]+(?:\.[0-9]+)?)\s*C\s*([0-9]+(?:\.[0-9]+)?)/i
    );
    if (m) {
      const close = Number(m[4]);
      if (Number.isFinite(close) && close > 0 && close < 15000) return close;
    }
    const vals = [];
    doc.querySelectorAll(
      '.pane-legend-item-value, .pane-legend-item-value__main, [class*="pane-legend-item-value"]'
    ).forEach(node => {
      const n = Number(String(node.textContent || '').replace(/,/g, '').trim());
      if (Number.isFinite(n) && n > 0) vals.push(n);
    });
    if (vals.length >= 4 && vals[3] < 15000) return vals[3];

    // BUY/SELL quote chips (Kite options chart)
    const body = (doc.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 6000);
    const quoteNums = [];
    const qRe = /([0-9]+(?:\.[0-9]+)?)\s*(?:BUY|SELL)\b|\b(?:BUY|SELL)\s*([0-9]+(?:\.[0-9]+)?)/gi;
    let qm;
    while ((qm = qRe.exec(body)) !== null) {
      const v = Number(qm[1] || qm[2]);
      if (Number.isFinite(v) && v >= 0.05 && v < 15000) quoteNums.push(v);
      if (quoteNums.length >= 4) break;
    }
    if (quoteNums.length >= 2) return (quoteNums[0] + quoteNums[1]) / 2;
    if (quoteNums.length === 1) return quoteNums[0];
    return null;
  }

  function scrapeChartIframeLtp() {
    const frames = document.querySelectorAll(
      'iframe#chart-iframe, iframe[id*="chart"], iframe[src*="chart"], iframe'
    );
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        const ltp = scrapeLegendLtpFromDoc(doc);
        if (ltp != null) return ltp;
      } catch (_) {}
    }
    return scrapeLegendLtpFromDoc(document);
  }

  function scrapeChartLTP(symbolSelectors) {
    const near = scrapeLtpNearSymbol(symbolSelectors);
    if (near) return near;

    const fromIframe = scrapeChartIframeLtp();
    if (fromIframe != null) return fromIframe;

    // Chart reader cache (bridge / iframe push)
    const snapLtp = window.KPChartReader?.readSnapshot?.()?.ltp;
    if (Number.isFinite(snapLtp) && snapLtp > 0) return snapLtp;

    const chartRoots = document.querySelectorAll(
      '.chart-container, .chart-wrapper, .chart-page, .chart-widget, ' +
      '.tv-chart-container, [class*="chart-container"], [class*="ChartContainer"], ' +
      '.instrument-select, [class*="InstrumentHeader"]'
    );
    const chartPriceSelectors = [
      '.chart-price', '.last-price', '.ltp', '#chart-ltp',
      '.tv-symbol-price-quote__value', '.js-symbol-last',
      '[data-field="last_price"]', '[data-testid*="ltp"]',
      '[class*="lastPrice"]', '[class*="last-price"]'
    ];
    for (const root of chartRoots) {
      if (isGlobalIndexNoise(root)) continue;
      for (const selector of chartPriceSelectors) {
        for (const node of root.querySelectorAll(selector)) {
          if (isGlobalIndexNoise(node)) continue;
          const price = parsePrice(node.textContent);
          if (price) return price;
        }
      }
    }
    return null;
  }

  function scrapeActiveTimeframe() {
    const selectors = [
      '[data-testid*="interval"][aria-selected="true"]',
      '[data-testid*="timeframe"][aria-selected="true"]',
      '[role="tab"][aria-selected="true"]',
      'button.active[data-interval]',
      'button.active[data-timeframe]',
      '[class*="interval"][class*="active"]',
      '[class*="timeframe"][class*="active"]'
    ];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const raw = node.dataset?.interval || node.dataset?.timeframe ||
          node.getAttribute('aria-label') || node.textContent;
        const timeframe = normalizeTimeframe(raw);
        if (timeframe) return timeframe;
      }
    }
    return null;
  }

  const dhan = {
    id: 'dhan',
    label: 'Dhan',
    isChartPage() {
      return /dhan\.co/i.test(HOST) ||
        !!document.querySelector(
          '[class*="chart"], cq-context, .ciq-chart, #tv_chart_container, .tv-chart-container'
        );
    },
    scrapeSymbol() {
      return symbolFromDom([
        '[class*="symbol"]',
        '[data-testid*="symbol"]',
        '.tv-symbol-header__short-name',
        '.pane-legend-title__description',
        '[class*="Instrument"] [class*="name"]',
        '.tradingsymbol'
      ]) || symbolFromUrl() || acceptSymbol(titleSymbol());
    },
    scrapeExchange() {
      return inferExchange(window.location.href + ' ' + textOf(['[class*="exchange"]']), 'NSE');
    },
    scrapeLTP() {
      return scrapeChartLTP([
        '.tv-symbol-header__short-name',
        '[class*="symbol"]',
        '[class*="Instrument"]'
      ]);
    },
    scrapeTimeframe() {
      return scrapeActiveTimeframe();
    }
  };

  function detectBroker() {
    if (HOST === 'kite.zerodha.com') return kite;
    if (HOST.includes('upstox.com')) {
      return upstox;
    }
    if (HOST.includes('dhan.co')) return dhan;
    return kite;
  }

  function getContext() {
    const adapter = detectBroker();
    const chartSnap = window.KPChartReader?.readSnapshot?.() || null;
    const rawSymbol = resolveBestSymbol(adapter, chartSnap);
    const exchange = adapter.scrapeExchange();
    // For options: chart legend C first (never a random watchlist LTP like 13 vs 354).
    let ltp = null;
    if (isOptionLike(rawSymbol)) {
      ltp = scrapeChartIframeLtp();
      if (ltp == null && chartSnap?.ltp != null && chartSnap.ltp > 0 && chartSnap.ltp < 15000) {
        ltp = chartSnap.ltp;
      }
      if (ltp == null) ltp = adapter.scrapeLTP();
      if (ltp != null && ltp > 15000) ltp = null;
    } else {
      ltp = (chartSnap?.ltp != null && chartSnap.ltp > 0)
        ? chartSnap.ltp
        : adapter.scrapeLTP();
      if (ltp == null) ltp = scrapeChartIframeLtp();
    }
    const timeframe = chartSnap?.timeframe || adapter.scrapeTimeframe();
    return {
      broker: adapter.id,
      brokerLabel: adapter.label,
      isChartPage: adapter.isChartPage(),
      symbol: cleanSymbol(rawSymbol),
      exchange: isOptionLike(rawSymbol)
        ? (exchange === 'BSE' || exchange === 'BFO' ? 'BFO' : 'NFO')
        : exchange,
      ltp,
      timeframe,
      chartEngine: chartSnap?.engine || window.KPChartReader?.detectEngine?.() || 'dom',
      chartSource: chartSnap?.source || null,
      chartCandles: Array.isArray(chartSnap?.candles) ? chartSnap.candles : [],
      yahooSymbol: rawSymbol && !isOptionLike(rawSymbol)
        ? `${cleanSymbol(rawSymbol).replace(/\s+/g, '-')}.${exchange === 'BSE' ? 'BO' : 'NS'}`
        : null
    };
  }

  window.KPBrokerAdapters = {
    detectBroker,
    getContext,
    normalizeTimeframe,
    normalizeSymbol: cleanSymbol,
    parsePrice,
    symbolFromUrl,
    isOptionLike,
    acceptSymbol
  };
})();
