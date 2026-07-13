// KitePlus Extension Content Script
const DEBUG = true;

let settings = {
  grouping: true,
  basket: true,
  optionchain: true,
  charges: true,
  signals: true
};

// Global state
let currentMargin = 500000.00;
let usedMargin = 0.00;
let basketOrders = [];
let activeBasketTab = 1;
let cachedNetPnL = 0.00;
let mtmHistory = [];

// Initialize
async function init() {
  await loadSettings();
  await loadMtmHistory();
  await loadExecutedCharges();
  await updateMarginsFromAPI();
  setupMutationObserver();
  setupSettingsListener();
  
  // Initial run
  runModules();
  
  // Start dynamic updates for metrics (every 200ms)
  setInterval(updateDynamicValues, 200);
}

// Load settings from storage
async function loadSettings() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get(['settings', 'cachedMargin', 'cachedUsedMargin']);
      if (res.settings) {
        settings = { ...settings, ...res.settings };
      }
      if (res.cachedMargin !== undefined) {
        currentMargin = res.cachedMargin;
      }
      if (res.cachedUsedMargin !== undefined) {
        usedMargin = res.cachedUsedMargin;
      }
    }
  } catch (err) {
    console.error('Error loading settings:', err);
  }
}

// Listen for settings changes from popup
function setupSettingsListener() {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'SETTINGS_CHANGED') {
        settings = message.settings;
        runModules();
      }
    });
  }
}

let isApplyingChanges = false;

// Watch DOM changes to inject widgets dynamically
function setupMutationObserver() {
  const observer = new MutationObserver((mutations) => {
    if (isApplyingChanges) return;
    // Prevent infinite loops by ignoring mutations caused by our own widgets
    const hasExternalMutation = Array.from(mutations).some(m => {
      const target = m.target;
      return target && 
             typeof target.closest === 'function' &&
             !target.closest('.kp-status-bar') && 
             !target.closest('.kp-basket-sidebar') && 
             !target.closest('.kp-modal-backdrop') && 
             !target.closest('.kp-group-controls') &&
             !target.closest('.kp-watchlist-inline-oc') &&
             !target.closest('.kp-charges-box') &&
             !target.closest('.kp-signal-panel') &&
             !target.closest('.kp-signal-toast');
    });
    if (hasExternalMutation) {
      runModules();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// Run all enabled modules
function runModules() {
  if (isApplyingChanges) return;
  isApplyingChanges = true;
  requestAnimationFrame(() => {
    try {
      // Ensure status bar is removed
      let statusBar = document.querySelector('.kp-status-bar');
      if (statusBar) {
        statusBar.remove();
      }
      document.body.style.paddingBottom = '0px';

      handlePositionsGrouping();
      handleWatchlistOptionChain();
      handleOrderWindowCharges();
      handleExpressBasketDrawer();
      handleSignalPanel();
    } finally {
      setTimeout(() => {
        isApplyingChanges = false;
      }, 0);
    }
  });
}

// Helper to read cookie value
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return null;
}

// Session token helper (checks cookies, localStorage, sessionStorage)
function getSessionToken() {
  let token = getCookie('enctoken');
  if (token) return token;
  
  try {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      if (user && user.enctoken) return user.enctoken;
    }
  } catch (e) {}
  
  try {
    const userStr = sessionStorage.getItem('user');
    if (userStr) {
      const user = JSON.parse(userStr);
      if (user && user.enctoken) return user.enctoken;
    }
  } catch (e) {}
  
  return null;
}

let totalExecutedCharges = 0;
let executedChargesDate = '';

// Load executed charges from storage on startup
async function loadExecutedCharges() {
  const todayStr = new Date().toDateString();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get(['totalExecutedCharges', 'executedChargesDate']);
      if (res.executedChargesDate === todayStr) {
        totalExecutedCharges = res.totalExecutedCharges || 0;
        executedChargesDate = res.executedChargesDate;
        if (DEBUG) console.log(`[KitePlus Debug] Loaded executed charges from storage: ₹${totalExecutedCharges}`);
      } else {
        totalExecutedCharges = 0;
        executedChargesDate = todayStr;
        await chrome.storage.local.set({ totalExecutedCharges: 0, executedChargesDate: todayStr });
      }
    } else {
      const cachedDate = localStorage.getItem('kp_executed_charges_date');
      if (cachedDate === todayStr) {
        totalExecutedCharges = parseFloat(localStorage.getItem('kp_executed_charges')) || 0;
        executedChargesDate = cachedDate;
      } else {
        totalExecutedCharges = 0;
        executedChargesDate = todayStr;
      }
    }
  } catch (err) {
    if (DEBUG) console.error('[KitePlus Debug] Error loading executed charges:', err);
  }
}

function saveExecutedCharges(val) {
  totalExecutedCharges = val;
  const todayStr = new Date().toDateString();
  executedChargesDate = todayStr;
  
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ 
      totalExecutedCharges: val, 
      executedChargesDate: todayStr 
    });
  } else {
    try {
      localStorage.setItem('kp_executed_charges', val);
      localStorage.setItem('kp_executed_charges_date', todayStr);
    } catch (e) {}
  }
}

// Backup DOM Scraper for Virtual Contract Note
function scrapeContractNoteFromDOM() {
  const allElements = document.querySelectorAll('h3, h4, .title, div, span');
  let headerEl = null;
  for (const el of allElements) {
    if (el.innerText && el.innerText.trim() === 'Virtual contract note') {
      headerEl = el;
      break;
    }
  }
  if (!headerEl) {
    for (const el of allElements) {
      if (el.innerText && el.innerText.includes('Virtual contract note')) {
        headerEl = el;
        break;
      }
    }
  }
  
  if (!headerEl) return false;

  let container = headerEl.parentElement;
  while (container && container !== document.body) {
    if (container.classList.contains('modal-wrapper') || 
        container.classList.contains('modal') || 
        container.classList.contains('modal-dialog') || 
        container.classList.contains('modal-content') ||
        container.querySelector('table') ||
        container.querySelector('.table')) {
      break;
    }
    container = container.parentElement;
  }
  if (!container) container = document.body;

  const cells = Array.from(container.querySelectorAll('td, span, div, p, th'));
  for (let i = 0; i < cells.length; i++) {
    const text = cells[i].innerText ? cells[i].innerText.trim() : '';
    if (text === 'Total') {
      const row = cells[i].closest('tr, .row, div');
      if (row && row !== container) {
        const rowCells = Array.from(row.querySelectorAll('td, span, div'));
        for (let j = rowCells.length - 1; j >= 0; j--) {
          const valText = rowCells[j].innerText ? rowCells[j].innerText.trim() : '';
          const val = parseFloat(valText.replace(/[^0-9.-]/g, ''));
          if (!isNaN(val) && val > 0) {
            saveExecutedCharges(val);
            if (DEBUG) console.log(`[KitePlus Debug] Scraped Contract Note Total from DOM: ₹${totalExecutedCharges}`);
            return true;
          }
        }
      }
      
      let sibling = cells[i].nextElementSibling;
      while (sibling) {
        const valText = sibling.innerText ? sibling.innerText.trim() : '';
        const val = parseFloat(valText.replace(/[^0-9.-]/g, ''));
        if (!isNaN(val) && val > 0) {
          saveExecutedCharges(val);
          if (DEBUG) console.log(`[KitePlus Debug] Scraped Contract Note Total from DOM Sibling: ₹${totalExecutedCharges}`);
          return true;
        }
        sibling = sibling.nextElementSibling;
      }
    }
  }
  return false;
}

// Dynamic executed charges tracking
let lastApiOrdersFetch = 0;

async function updateExecutedCharges() {
  if (scrapeContractNoteFromDOM()) {
    return;
  }

  const isMock = window.location.href.includes('mock-kite.html') || document.getElementById('mock-kite-dashboard') !== null;
  
  if (isMock) {
    if (window.mockState && window.mockState.orders) {
      let sumCharges = 0;
      window.mockState.orders.forEach(order => {
        if (order.status === 'EXECUTED') {
          const qty = order.qty || 1;
          const price = order.price || 0;
          const isSell = order.action === 'SELL';
          const symbol = order.symbol || '';
          
          const isFO = symbol.includes('NIFTY') || symbol.includes('BANK') || symbol.includes('FINNIFTY') || symbol.includes('-FUT') || symbol.includes('-CE') || symbol.includes('-PE');
          const isOption = symbol.includes('CE') || symbol.includes('PE');
          
          const chg = calculateSingleLegCharges(qty, price, isSell, isFO, isOption);
          sumCharges += chg.total;
        }
      });
      saveExecutedCharges(sumCharges);
    }
    return;
  }
  
  const now = Date.now();
  if (now - lastApiOrdersFetch < 5000) {
    return;
  }
  
  try {
    const headers = {};
    const token = getSessionToken();
    if (token) {
      headers['Authorization'] = `enctoken ${token}`;
    }
    
    const response = await fetch('/oms/orders', { headers });
    if (response.ok) {
      const json = await response.json();
      if (json && json.status === 'success' && Array.isArray(json.data)) {
        let sumCharges = 0;
        json.data.forEach(order => {
          if (order.status === 'COMPLETE') {
            const qty = parseInt(order.quantity) || 0;
            const price = parseFloat(order.average_price) || 0;
            const isSell = order.transaction_type === 'SELL';
            const symbol = order.tradingsymbol || '';
            const exchange = order.exchange || '';
            
            const isFO = exchange === 'NFO' || exchange === 'BFO' || exchange === 'MCX' || exchange === 'CDS' || exchange.includes('FO') ||
                         symbol.includes('-FUT') || symbol.includes('-CE') || symbol.includes('-PE');
            const isOption = symbol.endsWith('CE') || symbol.endsWith('PE') || 
                             symbol.includes('-CE') || symbol.includes('-PE') ||
                             (isFO && (symbol.includes('CE') || symbol.includes('PE')));
            
            const chg = calculateSingleLegCharges(qty, price, isSell, isFO, isOption);
            sumCharges += chg.total;
          }
        });
        saveExecutedCharges(sumCharges);
        lastApiOrdersFetch = now;
        if (DEBUG) console.log(`[KitePlus Debug] API Orders fetch charges sum: ₹${totalExecutedCharges}`);
      }
    }
  } catch (err) {
    if (DEBUG) console.error(`[KitePlus Debug] Error fetching orders:`, err);
  }
}

// Update the numerical values inside the MTM Chart header
function updateChartHeaderMetrics() {
  const margin = getAvailableMargin();
  const used = getUsedMargin();
  const pnl = getNetPnL();
  
  const totalCapital = (margin + used) > 0 ? (margin + used) : 500000.00;
  const pnlPercent = (pnl / totalCapital) * 100;
  
  const pnlClass = pnl >= 0 ? 'profit' : 'loss';
  const pnlSign = pnl >= 0 ? '+' : '-';
  
  const netPnl = pnl - totalExecutedCharges;
  const netPnlPercent = (netPnl / totalCapital) * 100;
  const netPnlClass = netPnl >= 0 ? 'profit' : 'loss';
  const netPnlSign = netPnl >= 0 ? '+' : '-';
  
  if (DEBUG) {
    console.log(`[KitePlus Debug] updateChartHeaderMetrics: margin=${margin}, used=${used}, pnl=${pnl}, netPnl=${netPnl}`);
  }
  
  const pnlEl = document.getElementById('kp-chart-pnl');
  if (pnlEl) {
    pnlEl.innerHTML = `
      <span style="margin-right: 8px;">Gross MTM: <span class="${pnlClass}">${pnlSign}₹${formatCurrency(Math.abs(pnl))}</span></span>
      <span style="margin-right: 8px;">Net MTM: <span class="${netPnlClass}">${netPnlSign}₹${formatCurrency(Math.abs(netPnl))} (${netPnlSign}${Math.abs(netPnlPercent).toFixed(2)}%)</span></span>
      <span style="color:#64748b; font-size:10.5px;">(Charges: ₹${formatCurrency(totalExecutedCharges)})</span>
    `;
    pnlEl.className = '';
  }
}

// Real-time Dynamic updates loop
function updateDynamicValues() {
  // Trigger async update of executed charges
  updateExecutedCharges();
  
  // Always update metrics in the chart header
  updateChartHeaderMetrics();
  
  if (settings.grouping) {
    const table = document.querySelector('.positions table, .positions-container table');
    if (table) {
      updatePositionsGroupingValues(table);
    }
  }
  
  // Track and render MTM chart
  const isPositionsPage = window.location.pathname.includes('/positions') || 
                          window.location.href.includes('mock-kite.html') ||
                          document.getElementById('mock-kite-dashboard') !== null;
  if (isPositionsPage) {
    recordMtmDataPoint();
    handleMtmChartInjection();
  }
  
  // Signal Engine: collect price ticks and update signals
  if (settings.signals) {
    updateSignalEngine();
  }
}

// Scrape Net P&L from page
function getNetPnL() {
  // Only scrape if we are on the positions page or the mock simulator
  const isPositionsPage = window.location.pathname.includes('/positions') || 
                          window.location.href.includes('mock-kite.html') ||
                          document.getElementById('mock-kite-dashboard') !== null;
                          
  if (!isPositionsPage) {
    if (DEBUG) console.log(`[KitePlus Debug] Not on positions page. Returning cached MTM: ${cachedNetPnL}`);
    return cachedNetPnL;
  }

  // 1. Try to sum P&L of all rows in the positions table
  const rows = document.querySelectorAll(
    '.positions tbody tr, ' +
    '.positions-container tbody tr, ' +
    '#positions-tbody tr, ' +
    '.data-table tbody tr, ' +
    '.positions-table tbody tr'
  );
  
  if (DEBUG) {
    console.log(`[KitePlus Debug] getNetPnL rows found:`, rows.length);
  }
  
  if (rows.length > 0) {
    let sumPnL = 0;
    let foundAny = false;
    
    rows.forEach(row => {
      // Skip group headers, empty states, or footer/total rows
      if (row.classList.contains('kp-group-header-row') || 
          row.classList.contains('empty-state') || 
          row.classList.contains('total') || 
          row.classList.contains('total-row') || 
          row.querySelector('td.empty-state') !== null ||
          row.querySelector('td.total') !== null ||
          row.querySelector('td[colspan]') !== null) return;
      
      const data = parsePositionRow(row);
      if (data.symbol) {
        sumPnL += data.pnl;
        foundAny = true;
      }
    });
    
    if (foundAny) {
      if (DEBUG) console.log(`[KitePlus Debug] Sum of individual position rows P&L: ${sumPnL}`);
      cachedNetPnL = sumPnL;
      return sumPnL;
    }
  }
  
  // 2. Try to find P&L value in Kite positions table footer directly
  const pnlEl = document.querySelector('.positions .total-pnl, .positions-table .total .pnl, #total-pnl, .positions table tfoot td.pnl, .positions table tfoot tr td:last-child, tfoot tr td.pnl, .positions-container tfoot td.pnl');
  if (pnlEl) {
    const txt = pnlEl.textContent.replace(/[^0-9.-]/g, '');
    const val = parseFloat(txt);
    if (!isNaN(val)) {
      if (DEBUG) console.log(`[KitePlus Debug] Found direct footer P&L: ${val}`);
      cachedNetPnL = val;
      return val;
    }
  }
  
  // 3. Search for label "Total P&L" or "Total PnL" in table footers
  const tds = Array.from(document.querySelectorAll('td, span, div'));
  for (const el of tds) {
    if (el.innerText && (el.innerText.trim().toLowerCase() === 'total p&l' || el.innerText.trim().toLowerCase() === 'total pnl')) {
      const parent = el.parentElement;
      if (parent) {
        const valEl = parent.querySelector('td:last-child, span.val, .value, .total-pnl, .pnl');
        if (valEl) {
          const val = parseFloat(valEl.innerText.replace(/[^0-9.-]/g, ''));
          if (!isNaN(val)) {
            if (DEBUG) console.log(`[KitePlus Debug] Found footer label "Total P&L" with value: ${val}`);
            cachedNetPnL = val;
            return val;
          }
        }
      }
    }
  }
  
  // Fallback for mock simulator
  if (window.mockState && window.mockState.netPnL !== undefined) {
    if (DEBUG) console.log(`[KitePlus Debug] Using mockState netPnL: ${window.mockState.netPnL}`);
    return window.mockState.netPnL;
  }
  
  return cachedNetPnL;
}

// Scrape Available Margin from page
function getAvailableMargin() {
  // Asynchronously trigger live API margin fetch
  updateMarginsFromAPI();

  // If we have a valid margin fetched from API, prefer it
  if (currentMargin > 10) {
    return currentMargin;
  }

  // 1. Try to find by ID/class first
  const marginEl = document.querySelector('.funds .margin-available, .funds-table .available, #available-margin, td.available-margin, .funds .margin-available');
  if (marginEl) {
    const txt = marginEl.textContent.replace(/[^0-9.-]/g, '');
    const val = parseFloat(txt);
    if (!isNaN(val) && val > 10) { // Require val > 10 to avoid decimal-only fragments
      if (DEBUG) console.log(`[KitePlus Debug] Scraped Available Margin via selector: ${val}`);
      currentMargin = val;
      // Cache in local storage
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ cachedMargin: val });
      }
      return val;
    }
  }
  
  // 2. Scrape by searching for label text (e.g. in tables or divs)
  const tds = Array.from(document.querySelectorAll('td, span, div'));
  for (const el of tds) {
    if (el.innerText && el.innerText.trim().toLowerCase() === 'available margin') {
      const parent = el.parentElement;
      if (parent) {
        const valEl = parent.querySelector('td.bold, td:last-child, span.val, .value');
        if (valEl) {
          const val = parseFloat(valEl.innerText.replace(/[^0-9.-]/g, ''));
          if (!isNaN(val) && val > 10) { // Require val > 10 to avoid decimal-only fragments
            if (DEBUG) console.log(`[KitePlus Debug] Scraped Available Margin via label search: ${val}`);
            currentMargin = val;
            // Cache in local storage
            if (typeof chrome !== 'undefined' && chrome.storage) {
              chrome.storage.local.set({ cachedMargin: val });
            }
            return val;
          }
        }
      }
    }
  }
  
  // Fallback for mock simulator
  if (window.mockState && window.mockState.availableMargin !== undefined) {
    if (DEBUG) console.log(`[KitePlus Debug] Using mockState Available Margin: ${window.mockState.availableMargin}`);
    currentMargin = window.mockState.availableMargin;
  }
  return currentMargin > 10 ? currentMargin : 500000.00;
}

// Scrape Used Margin from page
function getUsedMargin() {
  // 1. Try to find by ID/class first
  const usedEl = document.querySelector('.funds .margin-used, .funds-table .used, #used-margin, td.margin-used, .funds .margin-used');
  if (usedEl) {
    const txt = usedEl.textContent.replace(/[^0-9.-]/g, '');
    const val = parseFloat(txt);
    if (!isNaN(val) && val >= 0) {
      if (DEBUG) console.log(`[KitePlus Debug] Scraped Used Margin via selector: ${val}`);
      usedMargin = val;
      // Cache in local storage
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({ cachedUsedMargin: val });
      }
      return val;
    }
  }
  
  // 2. Scrape by searching for label text
  const tds = Array.from(document.querySelectorAll('td, span, div'));
  for (const el of tds) {
    if (el.innerText && el.innerText.trim().toLowerCase() === 'used margin') {
      const parent = el.parentElement;
      if (parent) {
        const valEl = parent.querySelector('td:last-child, span.val, .value');
        if (valEl) {
          const val = parseFloat(valEl.innerText.replace(/[^0-9.-]/g, ''));
          if (!isNaN(val) && val >= 0) {
            if (DEBUG) console.log(`[KitePlus Debug] Scraped Used Margin via label search: ${val}`);
            usedMargin = val;
            // Cache in local storage
            if (typeof chrome !== 'undefined' && chrome.storage) {
              chrome.storage.local.set({ cachedUsedMargin: val });
            }
            return val;
          }
        }
      }
    }
  }
  
  // Fallback for mock simulator
  if (window.mockState && window.mockState.usedMargin !== undefined) {
    if (DEBUG) console.log(`[KitePlus Debug] Using mockState Used Margin: ${window.mockState.usedMargin}`);
    usedMargin = window.mockState.usedMargin;
  }
  return usedMargin >= 0 ? usedMargin : 0.00;
}

// Scrape Trades Count
function getTradesCount() {
  // Count executed orders
  const rows = document.querySelectorAll('.orders table tbody tr.executed, .orders-table tbody tr.executed');
  if (rows.length > 0) return rows.length;
  
  if (window.mockState && window.mockState.executedTradesCount !== undefined) {
    return window.mockState.executedTradesCount;
  }
  return 0;
}

/* ==========================================
   MODULE 2: POSITIONS GROUPING
   ========================================== */
let groupingMode = 'default'; // 'default', 'instrument', 'expiry'
let collapsedGroups = {};

// Cache table column mapping to improve performance and robustness
const tableColumnMaps = new WeakMap();

function getTableColumnMap(table) {
  if (!table) return {};
  if (tableColumnMaps.has(table)) {
    return tableColumnMaps.get(table);
  }
  
  const headers = Array.from(table.querySelectorAll('thead th, thead td, tr:first-child th, tr:first-child td'));
  const colMap = {};
  headers.forEach((th, idx) => {
    const text = th.innerText.trim().toLowerCase();
    if (text.includes('product')) colMap.product = idx;
    else if (text.includes('instrument')) colMap.instrument = idx;
    else if (text.includes('qty') || text.includes('quantity')) colMap.qty = idx;
    else if (text.includes('avg') || text.includes('average')) colMap.avg = idx;
    else if (text.includes('ltp') || text.includes('last price')) colMap.ltp = idx;
    else if (text.includes('p&l') || text.includes('pnl') || text.includes('profit')) colMap.pnl = idx;
    else if (text.includes('chg') || text.includes('change')) colMap.chg = idx;
  });
  
  if (DEBUG) {
    console.log(`[KitePlus Debug] getTableColumnMap. headers:`, headers.map(h => h.innerText.trim()), `Resolved Map:`, colMap);
  }
  
  tableColumnMaps.set(table, colMap);
  return colMap;
}

// Robust row parsing for Zerodha Kite and the mock simulator
function parsePositionRow(row) {
  const table = row.closest('table');
  const colMap = getTableColumnMap(table);
  const tds = Array.from(row.querySelectorAll('td'));
  
  let symbol = "";
  let qty = 0;
  let pnl = 0.00;
  
  let symbolFound = false;
  let qtyFound = false;
  let pnlFound = false;
  
  // 1. Try to parse using header-based dynamic mapping first
  if (table && Object.keys(colMap).length > 0) {
    if (colMap.instrument !== undefined && colMap.instrument < tds.length) {
      const instTd = tds[colMap.instrument];
      const symbolSpan = instTd.querySelector('span.tradingsymbol');
      symbol = symbolSpan ? symbolSpan.innerText.trim() : instTd.innerText.trim();
      if (symbol !== '') symbolFound = true;
    }
    if (colMap.qty !== undefined && colMap.qty < tds.length) {
      const txt = tds[colMap.qty].innerText.replace(/[^0-9-]/g, '');
      if (txt !== '') {
        qty = parseInt(txt) || 0;
        qtyFound = true;
      }
    }
    if (colMap.pnl !== undefined && colMap.pnl < tds.length) {
      const txt = tds[colMap.pnl].innerText.replace(/[^0-9.-]/g, '');
      if (txt !== '') {
        pnl = parseFloat(txt) || 0.00;
        pnlFound = true;
      }
    }
  }
  
  // 2. Fallbacks if header mapping was missing or returned partials
  if (!symbolFound) {
    const instrumentEl = row.querySelector('td.instrument span.tradingsymbol, td.instrument, .instrument');
    if (instrumentEl) {
      symbol = instrumentEl.innerText.trim();
      if (symbol !== '') symbolFound = true;
    }
  }
  
  if (!qtyFound) {
    const qtyEl = row.querySelector('td.quantity, .quantity');
    if (qtyEl) {
      const txt = qtyEl.innerText.replace(/[^0-9-]/g, '');
      if (txt !== '') {
        qty = parseInt(txt) || 0;
        qtyFound = true;
      }
    }
  }
  
  if (!pnlFound) {
    const pnlEl = row.querySelector('td.pnl, td.profit, td.loss, .pnl, .profit, .loss');
    if (pnlEl) {
      const txt = pnlEl.innerText.replace(/[^0-9.-]/g, '');
      if (txt !== '') {
        pnl = parseFloat(txt) || 0.00;
        pnlFound = true;
      }
    }
  }
  
  // 3. Absolute index-based fallback ONLY if the columns were not found at all
  if (!symbolFound || !qtyFound || !pnlFound) {
    if (tds.length >= 4) {
      let instIdx = -1;
      for (let i = 0; i < tds.length; i++) {
        if (tds[i].querySelector('span.tradingsymbol') || tds[i].classList.contains('instrument')) {
          instIdx = i;
          break;
        }
      }
      
      if (instIdx !== -1) {
        if (!symbolFound) {
          symbol = tds[instIdx].innerText.trim();
          symbolFound = true;
        }
        const qtyIdx = instIdx + 1;
        if (!qtyFound && qtyIdx < tds.length) {
          qty = parseInt(tds[qtyIdx].innerText.replace(/[^0-9-]/g, '')) || 0;
          qtyFound = true;
        }
        const pnlIdx = instIdx + 4;
        if (!pnlFound && pnlIdx < tds.length) {
          pnl = parseFloat(tds[pnlIdx].innerText.replace(/[^0-9.-]/g, '')) || 0;
          pnlFound = true;
        }
        const fallbackPnlIdx = tds.length - 2;
        if (!pnlFound && fallbackPnlIdx >= 0 && fallbackPnlIdx < tds.length) {
          pnl = parseFloat(tds[fallbackPnlIdx].innerText.replace(/[^0-9.-]/g, '')) || 0;
          pnlFound = true;
        }
      } else {
        const hasCheckbox = tds[0].querySelector('input[type="checkbox"]') !== null || tds[0].classList.contains('selection');
        const shift = hasCheckbox ? 1 : 0;
        
        if (!symbolFound && tds.length > (1 + shift)) {
          symbol = tds[1 + shift].innerText.trim();
          symbolFound = true;
        }
        if (!qtyFound && tds.length > (2 + shift)) {
          qty = parseInt(tds[2 + shift].innerText.replace(/[^0-9-]/g, '')) || 0;
          qtyFound = true;
        }
        if (!pnlFound && tds.length > (5 + shift)) {
          pnl = parseFloat(tds[5 + shift].innerText.replace(/[^0-9.-]/g, '')) || 0;
          pnlFound = true;
        }
      }
    }
  }
  
  if (DEBUG) {
    console.log(`[KitePlus Debug] parsePositionRow result: symbol="${symbol}", qty=${qty}, pnl=${pnl}`);
  }
  
  return { symbol, qty, pnl };
}

function handlePositionsGrouping() {
  const positionsContainer = document.querySelector('.positions, .positions-container');
  if (!positionsContainer) return;
  
  const table = positionsContainer.querySelector('table');
  if (!table) return;
  
  if (!settings.grouping) {
    // Restore default view
    removePositionsGrouping(table);
    return;
  }
  
  // Inject grouping controls if not present
  let controls = positionsContainer.querySelector('.kp-group-controls');
  if (!controls) {
    controls = document.createElement('div');
    controls.className = 'kp-group-controls';
    positionsContainer.insertBefore(controls, table);
    
    controls.innerHTML = `
      <span class="kp-group-title">KitePlus Positions Grouping</span>
      <div class="kp-group-btn-container">
        <button class="kp-group-btn ${groupingMode === 'default' ? 'active' : ''}" data-mode="default">Default</button>
        <button class="kp-group-btn ${groupingMode === 'instrument' ? 'active' : ''}" data-mode="instrument">Group by Symbol</button>
        <button class="kp-group-btn ${groupingMode === 'expiry' ? 'active' : ''}" data-mode="expiry">Group by Expiry</button>
      </div>
    `;
    
    controls.querySelectorAll('.kp-group-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        controls.querySelectorAll('.kp-group-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        groupingMode = btn.getAttribute('data-mode');
        applyPositionsGrouping(table);
      });
    });
  }
  
  // Apply the grouping
  applyPositionsGrouping(table);
}

function removePositionsGrouping(table) {
  const controls = table.parentElement.querySelector('.kp-group-controls');
  if (controls) controls.remove();
  
  const groupRows = table.querySelectorAll('.kp-group-header-row');
  groupRows.forEach(r => r.remove());
  
  const trs = table.querySelectorAll('tbody tr');
  trs.forEach(tr => {
    tr.style.display = '';
    tr.classList.remove('kp-nested-row');
  });
}

function applyPositionsGrouping(table) {
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  
  // Remove existing injected group headers
  const existingHeaders = tbody.querySelectorAll('.kp-group-header-row');
  existingHeaders.forEach(r => r.remove());
  
  const rows = Array.from(tbody.querySelectorAll('tr:not(.kp-group-header-row)'));
  if (rows.length === 0) return;

  // Store original index for sorting back
  rows.forEach((row, idx) => {
    if (!row.hasAttribute('data-original-index')) {
      row.setAttribute('data-original-index', idx);
    }
  });
  
  if (groupingMode === 'default') {
    const sortedRows = rows.sort((a, b) => {
      const idxA = parseInt(a.getAttribute('data-original-index') || 0);
      const idxB = parseInt(b.getAttribute('data-original-index') || 0);
      return idxA - idxB;
    });
    sortedRows.forEach(r => {
      tbody.appendChild(r);
      r.style.display = '';
      r.classList.remove('kp-nested-row');
    });
    return;
  }
  
  const groups = {};
  
  rows.forEach(row => {
    const data = parsePositionRow(row);
    if (!data.symbol) return;
    
    const name = data.symbol;
    let groupKey = 'Other';
    
    if (groupingMode === 'instrument') {
      // Group by underlying: extract prefix e.g., NIFTY26JUN18000CE -> NIFTY
      const match = name.match(/^([A-Z\s]+)(?:\d{2}|[A-Z]{3})/);
      groupKey = match ? match[1].trim() : name.split(' ')[0];
    } else if (groupingMode === 'expiry') {
      // Group by expiry date in F&O instrument e.g. NIFTY 26 JUN 18000 CE -> 26 JUN
      const match = name.match(/(\d{2}\s*[A-Z]{3}(?:\s*\d{2})?)/i);
      groupKey = match ? match[0].toUpperCase() : 'Equity / Long Term';
    }
    
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push({ row, name, qty: data.qty, pnl: data.pnl });
  });
  
  // Hide all original rows first
  rows.forEach(r => r.style.display = 'none');
  
  // Re-insert grouped headers and show rows grouped
  Object.keys(groups).forEach(key => {
    const groupRowsInfo = groups[key];
    
    // Calculate grouped P&L and metrics
    let totalQty = 0;
    let totalPnL = 0;
    
    groupRowsInfo.forEach(item => {
      totalQty += item.qty;
      totalPnL += item.pnl;
    });
    
    // Create Group Header Row
    const headerRow = document.createElement('tr');
    headerRow.className = 'kp-group-header-row';
    
    const pnlClass = totalPnL >= 0 ? 'kp-badge-profit' : 'kp-badge-loss';
    const pnlSign = totalPnL >= 0 ? '+' : '-';
    
    // Span across all columns in table
    const colCount = table.rows[0].cells.length;
    
    headerRow.innerHTML = `
      <td colspan="${colCount}">
        <div style="display:flex; justify-content:space-between; align-items:center; width:100%; padding: 4px 8px;">
          <div class="kp-group-name">
            <span class="kp-group-toggle-icon">▼</span>
            <span>${key} (${groupRowsInfo.length} Legs)</span>
          </div>
          <div style="display:flex; gap: 20px; align-items:center;">
            <span style="color:#9ca3af">Total Qty: <b>${totalQty}</b></span>
            <span class="kp-group-pnl-badge ${pnlClass}">P&L: ${pnlSign}₹${formatCurrency(Math.abs(totalPnL))}</span>
          </div>
        </div>
      </td>
    `;
    
    // Append Header Row
    tbody.appendChild(headerRow);

    const stateKey = `${groupingMode}-${key}`;
    let isCollapsed = !!collapsedGroups[stateKey];
    
    const icon = headerRow.querySelector('.kp-group-toggle-icon');
    if (isCollapsed) {
      icon.classList.add('collapsed');
      groupRowsInfo.forEach(item => {
        tbody.appendChild(item.row);
        item.row.classList.add('kp-nested-row');
        item.row.style.display = 'none';
      });
    } else {
      icon.classList.remove('collapsed');
      groupRowsInfo.forEach(item => {
        tbody.appendChild(item.row);
        item.row.classList.add('kp-nested-row');
        item.row.style.display = '';
      });
    }
    
    // Toggle functionality
    headerRow.addEventListener('click', () => {
      isCollapsed = !isCollapsed;
      collapsedGroups[stateKey] = isCollapsed;
      const icon = headerRow.querySelector('.kp-group-toggle-icon');
      if (isCollapsed) {
        icon.classList.add('collapsed');
        groupRowsInfo.forEach(item => item.row.style.display = 'none');
      } else {
        icon.classList.remove('collapsed');
        groupRowsInfo.forEach(item => item.row.style.display = '');
      }
    });
  });
}

function updatePositionsGroupingValues(table) {
  if (groupingMode === 'default') return;
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  
  const headerRows = tbody.querySelectorAll('.kp-group-header-row');
  const rows = Array.from(tbody.querySelectorAll('tr:not(.kp-group-header-row)'));
  
  const groupPnLs = {};
  const groupQtys = {};
  
  rows.forEach(row => {
    const data = parsePositionRow(row);
    if (!data.symbol) return;
    
    const name = data.symbol;
    let groupKey = 'Other';
    
    if (groupingMode === 'instrument') {
      const match = name.match(/^([A-Z\s]+)(?:\d{2}|[A-Z]{3})/);
      groupKey = match ? match[1].trim() : name.split(' ')[0];
    } else if (groupingMode === 'expiry') {
      const match = name.match(/(\d{2}\s*[A-Z]{3}(?:\s*\d{2})?)/i);
      groupKey = match ? match[0].toUpperCase() : 'Equity / Long Term';
    }
    
    groupPnLs[groupKey] = (groupPnLs[groupKey] || 0) + data.pnl;
    groupQtys[groupKey] = (groupQtys[groupKey] || 0) + data.qty;
  });
  
  headerRows.forEach(headerRow => {
    const nameSpan = headerRow.querySelector('.kp-group-name span:last-child');
    if (!nameSpan) return;
    
    const matchKey = nameSpan.innerText.match(/^([^\(]+)/);
    if (!matchKey) return;
    const groupKey = matchKey[1].trim();
    
    const totalPnL = groupPnLs[groupKey] || 0;
    const totalQty = groupQtys[groupKey] || 0;
    
    const pnlBadge = headerRow.querySelector('.kp-group-pnl-badge');
    if (pnlBadge) {
      const pnlClass = totalPnL >= 0 ? 'kp-badge-profit' : 'kp-badge-loss';
      const pnlSign = totalPnL >= 0 ? '+' : '-';
      pnlBadge.innerText = `P&L: ${pnlSign}₹${formatCurrency(Math.abs(totalPnL))}`;
      pnlBadge.className = `kp-group-pnl-badge ${pnlClass}`;
    }
    
    const qtySpan = headerRow.querySelector('td > div > div:last-child > span:first-child');
    if (qtySpan) {
      qtySpan.innerHTML = `Total Qty: <b>${totalQty}</b>`;
    }
  });
}

function handleWatchlistOptionChain() {
  const watchlistItems = document.querySelectorAll(
    '.marketwatch-sidebar .instruments > div, ' +
    '.watchlist-container .instruments > div, ' +
    '.marketwatch-sidebar .instruments .item, ' +
    '.instruments > div, ' +
    'div.vddl-draggable.instrument'
  );
  if (watchlistItems.length === 0) return;
  
  watchlistItems.forEach(item => {
    // Check if it's an F&O instrument or index
    const nameEl = item.querySelector('.symbol, .nice-name, .name, div.symbol > span.name, span.tradingsymbol');
    if (!nameEl) return;
    
    const name = nameEl.innerText.trim();
    const isFnO = name.includes('NIFTY') || name.includes('BANK') || name.includes('FINNIFTY') || name.includes('-FUT') || name.includes('-PE') || name.includes('-CE') || name.includes('SENSEX');
    if (!isFnO) return;
    
    // Find action buttons container
    const actions = item.querySelector('.actions');
    if (actions && !actions.querySelector('.kp-watchlist-oc-btn')) {
      const ocBtn = document.createElement('button');
      ocBtn.className = 'button button-outline kp-watchlist-oc-btn';
      ocBtn.innerText = 'Option Chain';
      ocBtn.title = 'Toggle Watchlist Option Chain';
      
      // Prevent default watchlist clicks
      ocBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleInlineOptionChain(item, name);
      });
      
      actions.appendChild(ocBtn);
    }
  });
}

function toggleInlineOptionChain(item, name) {
  let inlineOc = item.querySelector('.kp-watchlist-inline-oc');
  if (inlineOc) {
    inlineOc.remove();
    item.classList.remove('kp-has-inline-oc');
    const topWrap = item.querySelector('.kp-watchlist-item-top');
    if (topWrap) {
      while (topWrap.firstChild) {
        item.insertBefore(topWrap.firstChild, topWrap);
      }
      topWrap.remove();
    }
  } else {
    item.classList.add('kp-has-inline-oc');
    const topWrap = document.createElement('div');
    topWrap.className = 'kp-watchlist-item-top';
    while (item.firstChild) {
      topWrap.appendChild(item.firstChild);
    }
    item.appendChild(topWrap);
    
    inlineOc = document.createElement('div');
    inlineOc.className = 'kp-watchlist-inline-oc';
    item.appendChild(inlineOc);
    
    populateInlineOptionChain(inlineOc, name);
  }
}

function populateInlineOptionChain(container, symbol) {
  let spotPrice = 22000;
  let strikeGap = 100;
  if (symbol.includes('BANKNIFTY')) {
    spotPrice = 48000;
    strikeGap = 100;
  } else if (symbol.includes('FINNIFTY')) {
    spotPrice = 21500;
    strikeGap = 50;
  } else if (symbol.includes('NIFTY')) {
    spotPrice = 22400;
    strikeGap = 50;
  }
  
  const strikes = [];
  const atmStrike = Math.round(spotPrice / strikeGap) * strikeGap;
  for (let i = -2; i <= 2; i++) {
    strikes.push(atmStrike + (i * strikeGap));
  }
  
  container.innerHTML = `
    <div class="kp-inline-oc-header">
      <span>Call (CE)</span>
      <span class="strike-title">Strike</span>
      <span>Put (PE)</span>
    </div>
    <div class="kp-inline-oc-rows"></div>
    <div class="kp-inline-oc-footer">
      <button class="kp-inline-oc-full-btn">Open Full Option Chain</button>
    </div>
  `;
  
  const rowsContainer = container.querySelector('.kp-inline-oc-rows');
  
  strikes.forEach(strike => {
    const isITM_CE = strike < spotPrice;
    const isITM_PE = strike > spotPrice;
    
    const distance = Math.abs(strike - spotPrice);
    let ceLTP = Math.max(5.00, (300 - (strike - spotPrice) * 0.6) + Math.random() * 5);
    let peLTP = Math.max(5.00, (300 + (strike - spotPrice) * 0.6) + Math.random() * 5);
    
    if (strike > spotPrice) {
      ceLTP = Math.max(2.00, 200 * Math.exp(-distance/200) + Math.random() * 3);
    } else {
      peLTP = Math.max(2.00, 200 * Math.exp(-distance/200) + Math.random() * 3);
    }
    
    const ceClass = isITM_CE ? 'kp-itm-ce' : '';
    const peClass = isITM_PE ? 'kp-itm-pe' : '';
    
    const rowEl = document.createElement('div');
    rowEl.className = 'kp-inline-oc-row';
    
    rowEl.innerHTML = `
      <div class="kp-inline-oc-col ce ${ceClass}">
        <span class="kp-inline-oc-ltp">₹${ceLTP.toFixed(2)}</span>
        <div class="kp-inline-oc-actions">
          <button class="kp-inline-btn buy-btn" data-action="BUY" data-type="CE" data-price="${ceLTP.toFixed(2)}">B</button>
          <button class="kp-inline-btn sell-btn" data-action="SELL" data-type="CE" data-price="${ceLTP.toFixed(2)}">S</button>
        </div>
      </div>
      <div class="kp-inline-oc-col strike">${strike}</div>
      <div class="kp-inline-oc-col pe ${peClass}">
        <span class="kp-inline-oc-ltp">₹${peLTP.toFixed(2)}</span>
        <div class="kp-inline-oc-actions">
          <button class="kp-inline-btn buy-btn" data-action="BUY" data-type="PE" data-price="${peLTP.toFixed(2)}">B</button>
          <button class="kp-inline-btn sell-btn" data-action="SELL" data-type="PE" data-price="${peLTP.toFixed(2)}">S</button>
        </div>
      </div>
    `;
    
    rowsContainer.appendChild(rowEl);
  });
  
  container.querySelectorAll('.kp-inline-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const type = btn.getAttribute('data-type');
      const action = btn.getAttribute('data-action');
      const strikeVal = btn.parentElement.parentElement.parentElement.querySelector('.strike').innerText;
      const price = parseFloat(btn.getAttribute('data-price'));
      
      const legName = `${symbol} ${strikeVal} ${type}`;
      addLegToBasket(legName, action, price);
      openBasketSidebar();
    });
  });
  
  container.querySelector('.kp-inline-oc-full-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openOptionChainModal(symbol);
  });
}

// Option Chain Overlay Modal Creator
function openOptionChainModal(symbol) {
  if (!settings.optionchain) return;
  
  // Close any existing modal
  const existing = document.querySelector('.kp-modal-backdrop');
  if (existing) existing.remove();
  
  const backdrop = document.createElement('div');
  backdrop.className = 'kp-modal-backdrop';
  document.body.appendChild(backdrop);
  
  backdrop.innerHTML = `
    <div class="kp-modal-container">
      <div class="kp-modal-header">
        <h3>Option Chain: <span>${symbol}</span></h3>
        <button class="kp-modal-close">&times;</button>
      </div>
      <div class="kp-modal-body">
        <table class="kp-oc-table">
          <thead>
            <tr>
              <th colspan="4" style="background-color: rgba(59, 130, 246, 0.1)">CALLS (CE)</th>
              <th style="background-color: #111827">STRIKE</th>
              <th colspan="4" style="background-color: rgba(139, 92, 246, 0.1)">PUTS (PE)</th>
            </tr>
            <tr>
              <th>IV</th>
              <th>LTP</th>
              <th>Chg%</th>
              <th>Actions</th>
              <th class="kp-strike-col">Strike Price</th>
              <th>Actions</th>
              <th>Chg%</th>
              <th>LTP</th>
              <th>IV</th>
            </tr>
          </thead>
          <tbody id="kp-oc-tbody">
            <!-- Dynamically populated -->
          </tbody>
        </table>
      </div>
    </div>
  `;
  
  // Close buttons
  const closeBtn = backdrop.querySelector('.kp-modal-close');
  closeBtn.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  
  // Generate option chain data based on symbol
  populateOptionChainData(symbol);
}

function populateOptionChainData(symbol) {
  const tbody = document.getElementById('kp-oc-tbody');
  if (!tbody) return;
  
  // Guess spot price
  let spotPrice = 22000;
  let strikeGap = 100;
  if (symbol.includes('BANKNIFTY')) {
    spotPrice = 48000;
    strikeGap = 100;
  } else if (symbol.includes('FINNIFTY')) {
    spotPrice = 21500;
    strikeGap = 50;
  } else if (symbol.includes('NIFTY')) {
    spotPrice = 22400;
    strikeGap = 50;
  }
  
  // Generate 7 strikes (3 ITM, 1 ATM, 3 OTM)
  const strikes = [];
  const atmStrike = Math.round(spotPrice / strikeGap) * strikeGap;
  for (let i = -4; i <= 4; i++) {
    strikes.push(atmStrike + (i * strikeGap));
  }
  
  strikes.forEach(strike => {
    const isITM_CE = strike < spotPrice;
    const isITM_PE = strike > spotPrice;
    
    // Mock LTP & IV calculations
    const ceIV = (12.5 + Math.random() * 2).toFixed(2);
    const peIV = (13.0 + Math.random() * 2).toFixed(2);
    
    const distance = Math.abs(strike - spotPrice);
    let ceLTP = Math.max(5.00, (300 - (strike - spotPrice) * 0.6) + Math.random() * 5);
    let peLTP = Math.max(5.00, (300 + (strike - spotPrice) * 0.6) + Math.random() * 5);
    
    if (strike > spotPrice) {
      // CE OTM
      ceLTP = Math.max(2.00, 200 * Math.exp(-distance/200) + Math.random() * 3);
    } else {
      // PE OTM
      peLTP = Math.max(2.00, 200 * Math.exp(-distance/200) + Math.random() * 3);
    }
    
    const ceChg = ((Math.random() * 20) - 10).toFixed(2);
    const peChg = ((Math.random() * 20) - 10).toFixed(2);
    
    const ceClass = isITM_CE ? 'kp-itm-ce' : '';
    const peClass = isITM_PE ? 'kp-itm-pe' : '';
    
    const ceChgClass = ceChg >= 0 ? 'profit' : 'loss';
    const peChgClass = peChg >= 0 ? 'profit' : 'loss';
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <!-- CALLS -->
      <td class="${ceClass}">${ceIV}</td>
      <td class="${ceClass}" style="font-weight:600">₹${ceLTP.toFixed(2)}</td>
      <td class="${ceClass} ${ceChgClass}">${ceChg}%</td>
      <td class="${ceClass}">
        <button class="kp-oc-buy-btn" data-type="CE" data-action="BUY" data-strike="${strike}" data-price="${ceLTP.toFixed(2)}">B</button>
        <button class="kp-oc-sell-btn" data-type="CE" data-action="SELL" data-strike="${strike}" data-price="${ceLTP.toFixed(2)}">S</button>
      </td>
      
      <!-- STRIKE -->
      <td class="kp-strike-col">${strike}</td>
      
      <!-- PUTS -->
      <td class="${peClass}">
        <button class="kp-oc-buy-btn" data-type="PE" data-action="BUY" data-strike="${strike}" data-price="${peLTP.toFixed(2)}">B</button>
        <button class="kp-oc-sell-btn" data-type="PE" data-action="SELL" data-strike="${strike}" data-price="${peLTP.toFixed(2)}">S</button>
      </td>
      <td class="${peClass} ${peChgClass}">${peChg}%</td>
      <td class="${peClass}" style="font-weight:600">₹${peLTP.toFixed(2)}</td>
      <td class="${peClass}">${peIV}</td>
    `;
    
    tbody.appendChild(tr);
  });
  
  // Bind order buttons to Express Basket
  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const type = btn.getAttribute('data-type');
      const action = btn.getAttribute('data-action');
      const strike = btn.getAttribute('data-strike');
      const price = parseFloat(btn.getAttribute('data-price'));
      
      const legName = `${symbol} ${strike} ${type}`;
      addLegToBasket(legName, action, price);
      
      // Show sidebar
      openBasketSidebar();
      
      // Close option chain modal
      const modal = document.querySelector('.kp-modal-backdrop');
      if (modal) modal.remove();
    });
  });
}

/* ==========================================
   MODULE 4: REAL-TIME CHARGES CALCULATOR
   ========================================== */
function calculateSingleLegCharges(qty, price, isSell, isFO, isOption) {
  const txnVal = qty * price;
  
  let brokerage = 0;
  let stt = 0;
  let exchangeTxn = 0;
  let gst = 0;
  let sebi = 0;
  let stamp = 0;
  
  if (isFO) {
    if (isOption) {
      brokerage = 20; // flat
      stt = isSell ? (txnVal * 0.0015) : 0; // 0.15% on option sell (April 1, 2026 update)
      exchangeTxn = txnVal * 0.0003503; // 0.03503% NSE option transaction charge
    } else {
      // Future
      brokerage = Math.min(20, txnVal * 0.0003);
      stt = isSell ? (txnVal * 0.0005) : 0; // 0.05% on futures sell (April 1, 2026 update)
      exchangeTxn = txnVal * 0.0000173; // 0.00173% NSE futures transaction charge
    }
  } else {
    // Equity Intraday
    brokerage = Math.min(20, txnVal * 0.0003);
    stt = isSell ? (txnVal * 0.00025) : 0; // 0.025% on intraday sell
    exchangeTxn = txnVal * 0.0000297; // 0.00297% NSE intraday transaction charge
  }
  
  sebi = txnVal * 0.000001; // 0.0001% (₹10 / crore)
  gst = (brokerage + exchangeTxn + sebi) * 0.18; // GST on brokerage + exchange txn fee + sebi charges
  
  // Stamp duty (only on BUY)
  if (!isSell) {
    if (isFO) {
      if (isOption) {
        stamp = txnVal * 0.00003; // 0.003% options
      } else {
        stamp = txnVal * 0.00002; // 0.002% futures
      }
    } else {
      stamp = txnVal * 0.00003; // 0.003% intraday
    }
  }
  
  const total = brokerage + stt + exchangeTxn + gst + sebi + stamp;
  return { brokerage, stt, exchangeTxn, gst, sebi, stamp, total };
}

function getDefaultTargets(price, isSell, isFO, isOption) {
  let targetPct = 0.02; // 2% default
  let slPct = 0.01;     // 1% default
  
  if (isFO && isOption) {
    targetPct = 0.20; // 20% default for options
    slPct = 0.10;     // 10% default for options
  }
  
  let targetPrice, slPrice;
  if (!isSell) {
    // BUY order: target is higher, stop loss is lower
    targetPrice = price * (1 + targetPct);
    slPrice = price * (1 - slPct);
  } else {
    // SELL order: target is lower (buy back cheaper), stop loss is higher (buy back more expensive)
    targetPrice = price * (1 - targetPct);
    slPrice = price * (1 + slPct);
  }
  
  return {
    targetPrice: parseFloat(targetPrice.toFixed(2)),
    slPrice: parseFloat(slPrice.toFixed(2))
  };
}

function handleOrderWindowCharges() {
  const orderWindow = document.querySelector('.order-window, .modal-wrapper.order, .modal-wrapper .order-window-container');
  if (!orderWindow) return;
  
  if (!settings.charges) {
    const existing = orderWindow.querySelector('.kp-charges-box');
    if (existing) existing.remove();
    return;
  }
  
  // Find injection target (usually above footer/buttons)
  const footer = orderWindow.querySelector('.footer, .actions, .actions-row');
  if (!footer) return;
  
  let chargesBox = orderWindow.querySelector('.kp-charges-box');
  if (!chargesBox) {
    chargesBox = document.createElement('div');
    chargesBox.className = 'kp-charges-box';
    footer.parentElement.insertBefore(chargesBox, footer);
  }
  
  // Read order parameters from order window DOM
  const qtyInput = orderWindow.querySelector('input[type="number"][name="quantity"], input[label="Qty"], .quantity input');
  const priceInput = orderWindow.querySelector('input[type="number"][name="price"], input[label="Price"], .price input');
  const isSell = orderWindow.classList.contains('sell') || orderWindow.querySelector('.btn-red, .sell-btn') !== null;
  
  // Bind live inputs listeners for quantity and price if not already bound
  if (qtyInput && !qtyInput.dataset.kpListener) {
    qtyInput.dataset.kpListener = 'true';
    qtyInput.addEventListener('input', () => handleOrderWindowCharges());
  }
  if (priceInput && !priceInput.dataset.kpListener) {
    priceInput.dataset.kpListener = 'true';
    priceInput.addEventListener('input', () => handleOrderWindowCharges());
  }
  
  // Identify instrument type (Equity delivery, intraday, F&O)
  const titleEl = orderWindow.querySelector('.instrument-name, .title span');
  const symbol = titleEl ? titleEl.innerText : 'NIFTY';
  const isFO = symbol.includes('-FUT') || symbol.includes('-CE') || symbol.includes('-PE') || symbol.includes('NIFTY') || symbol.includes('BANKNIFTY');
  const isOption = symbol.includes('-CE') || symbol.includes('-PE') || symbol.includes('CE') || symbol.includes('PE');
  
  let qty = qtyInput ? parseInt(qtyInput.value) : 1;
  let price = priceInput ? parseFloat(priceInput.value) : 100;
  
  if (isNaN(qty) || qty <= 0) qty = 1;
  if (isNaN(price) || price <= 0) price = 100;
  
  // Check if we need to initialize or re-initialize the structure
  const lastSymbol = chargesBox.getAttribute('data-symbol');
  const lastIsSell = chargesBox.getAttribute('data-is-sell');
  const lastPriceStr = chargesBox.getAttribute('data-price');
  
  const needsInit = !chargesBox.querySelector('.kp-charges-grid') || 
                    lastSymbol !== symbol ||
                    lastIsSell !== String(isSell);
                    
  const priceChanged = lastPriceStr !== String(price);

  // Let's get the target and stop loss values
  let targetPrice = 0;
  let slPrice = 0;

  if (needsInit || priceChanged) {
    const defaults = getDefaultTargets(price, isSell, isFO, isOption);
    targetPrice = defaults.targetPrice;
    slPrice = defaults.slPrice;
  } else {
    const targetInput = chargesBox.querySelector('.kp-projection-input.target-price');
    const slInput = chargesBox.querySelector('.kp-projection-input.stoploss-price');
    targetPrice = targetInput ? parseFloat(targetInput.value) : 0;
    slPrice = slInput ? parseFloat(slInput.value) : 0;
    if (isNaN(targetPrice)) targetPrice = price;
    if (isNaN(slPrice)) slPrice = price;
  }

  // Calculate charges for entry and projected exit prices
  const entryCharges = calculateSingleLegCharges(qty, price, isSell, isFO, isOption);
  const targetCharges = calculateSingleLegCharges(qty, targetPrice, !isSell, isFO, isOption);
  const slCharges = calculateSingleLegCharges(qty, slPrice, !isSell, isFO, isOption);

  const breakEvenDiff = (entryCharges.total / qty).toFixed(2);

  // If we need initialization, build the HTML structure
  if (needsInit) {
    chargesBox.innerHTML = `
      <div class="kp-charges-title">
        <span>KitePlus Real-Time Charges</span>
        <span style="color:#f43f5e" class="kp-breakeven-pts">Breakeven: +₹${breakEvenDiff} pts</span>
      </div>
      <div class="kp-charges-grid">
        <div class="kp-charge-row">
          <span class="kp-charge-label">Brokerage:</span>
          <span class="kp-charge-value kp-brokerage-val">₹${entryCharges.brokerage.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row">
          <span class="kp-charge-label">STT (Tax):</span>
          <span class="kp-charge-value kp-stt-val">₹${entryCharges.stt.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row">
          <span class="kp-charge-label">NSE Txn Fee:</span>
          <span class="kp-charge-value kp-txn-val">₹${entryCharges.exchangeTxn.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row">
          <span class="kp-charge-label">GST (18%):</span>
          <span class="kp-charge-value kp-gst-val">₹${entryCharges.gst.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row">
          <span class="kp-charge-label">SEBI Fee:</span>
          <span class="kp-charge-value kp-sebi-val">₹${entryCharges.sebi.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row">
          <span class="kp-charge-label">Stamp Duty:</span>
          <span class="kp-charge-value kp-stamp-val">₹${entryCharges.stamp.toFixed(2)}</span>
        </div>
        <div class="kp-charge-row total">
          <span>Total Est. Charges:</span>
          <span class="kp-total-charges-val">₹${entryCharges.total.toFixed(2)}</span>
        </div>
      </div>
      
      <div class="kp-projection-section">
        <div class="kp-projection-title">P&L Projection (Round-trip)</div>
        <div class="kp-projection-inputs">
          <div class="kp-projection-field">
            <label>Target Price</label>
            <input type="number" step="0.05" class="kp-projection-input target-price" value="${targetPrice.toFixed(2)}" />
          </div>
          <div class="kp-projection-field">
            <label>Stop Loss Price</label>
            <input type="number" step="0.05" class="kp-projection-input stoploss-price" value="${slPrice.toFixed(2)}" />
          </div>
        </div>
        <div class="kp-projection-results">
          <div class="kp-projection-row profit">
            <span>Net Profit (Target Hit):</span>
            <span class="kp-net-profit-val">₹0.00</span>
          </div>
          <div class="kp-projection-row loss">
            <span>Net Loss (SL Hit):</span>
            <span class="kp-net-loss-val">₹0.00</span>
          </div>
        </div>
      </div>
    `;

    // Save attributes to track state changes
    chargesBox.setAttribute('data-symbol', symbol);
    chargesBox.setAttribute('data-is-sell', isSell);
    chargesBox.setAttribute('data-price', price);

    // Bind event listeners to new inputs
    const targetInput = chargesBox.querySelector('.kp-projection-input.target-price');
    const slInput = chargesBox.querySelector('.kp-projection-input.stoploss-price');
    
    if (targetInput) targetInput.addEventListener('input', () => handleOrderWindowCharges());
    if (slInput) slInput.addEventListener('input', () => handleOrderWindowCharges());
  } else {
    // If we didn't do full init, but price changed, update the inputs' values
    const targetInput = chargesBox.querySelector('.kp-projection-input.target-price');
    const slInput = chargesBox.querySelector('.kp-projection-input.stoploss-price');
    if (priceChanged) {
      if (targetInput && document.activeElement !== targetInput) targetInput.value = targetPrice.toFixed(2);
      if (slInput && document.activeElement !== slInput) slInput.value = slPrice.toFixed(2);
      chargesBox.setAttribute('data-price', price);
    }
    
    // Update simple charge labels
    chargesBox.querySelector('.kp-breakeven-pts').innerText = `Breakeven: +₹${breakEvenDiff} pts`;
    chargesBox.querySelector('.kp-brokerage-val').innerText = `₹${entryCharges.brokerage.toFixed(2)}`;
    chargesBox.querySelector('.kp-stt-val').innerText = `₹${entryCharges.stt.toFixed(2)}`;
    chargesBox.querySelector('.kp-txn-val').innerText = `₹${entryCharges.exchangeTxn.toFixed(2)}`;
    chargesBox.querySelector('.kp-gst-val').innerText = `₹${entryCharges.gst.toFixed(2)}`;
    chargesBox.querySelector('.kp-sebi-val').innerText = `₹${entryCharges.sebi.toFixed(2)}`;
    chargesBox.querySelector('.kp-stamp-val').innerText = `₹${entryCharges.stamp.toFixed(2)}`;
    chargesBox.querySelector('.kp-total-charges-val').innerText = `₹${entryCharges.total.toFixed(2)}`;
  }

  // Recalculate target and stop loss net outcomes
  const targetGross = !isSell ? (targetPrice - price) * qty : (price - targetPrice) * qty;
  const targetNet = targetGross - (entryCharges.total + targetCharges.total);

  const slGross = !isSell ? (slPrice - price) * qty : (price - slPrice) * qty;
  const slNet = slGross - (entryCharges.total + slCharges.total);

  // Render P&L output text
  const netProfitEl = chargesBox.querySelector('.kp-net-profit-val');
  const netLossEl = chargesBox.querySelector('.kp-net-loss-val');

  if (netProfitEl) {
    const totalRtCharges = entryCharges.total + targetCharges.total;
    const sign = targetNet >= 0 ? '+' : '-';
    netProfitEl.innerHTML = `
      <span style="color: ${targetNet >= 0 ? '#10b981' : '#f43f5e'}">
        ${sign}₹${Math.abs(targetNet).toFixed(2)}
      </span>
      <span class="kp-projection-detail">(Charges: ₹${totalRtCharges.toFixed(2)})</span>
    `;
    const rowEl = netProfitEl.closest('.kp-projection-row');
    if (rowEl) {
      rowEl.style.color = targetNet >= 0 ? '#10b981' : '#f43f5e';
    }
  }

  if (netLossEl) {
    const totalRtCharges = entryCharges.total + slCharges.total;
    const sign = slNet >= 0 ? '+' : '-';
    netLossEl.innerHTML = `
      <span style="color: ${slNet >= 0 ? '#10b981' : '#f43f5e'}">
        ${sign}₹${Math.abs(slNet).toFixed(2)}
      </span>
      <span class="kp-projection-detail">(Charges: ₹${totalRtCharges.toFixed(2)})</span>
    `;
    const rowEl = netLossEl.closest('.kp-projection-row');
    if (rowEl) {
      rowEl.style.color = slNet >= 0 ? '#10b981' : '#f43f5e';
    }
  }
}

/* ==========================================
   MODULE 5: EXPRESS BASKET ORDER DRAWER
   ========================================== */
function handleExpressBasketDrawer() {
  if (!settings.basket) {
    const existing = document.querySelector('.kp-basket-sidebar');
    if (existing) existing.remove();
    return;
  }
  
  let sidebar = document.querySelector('.kp-basket-sidebar');
  if (!sidebar) {
    sidebar = document.createElement('div');
    sidebar.className = 'kp-basket-sidebar';
    document.body.appendChild(sidebar);
    
    // Draw initial sidebar structure
    renderBasketSidebar(sidebar);
  }
}

function renderBasketSidebar(sidebar) {
  sidebar.innerHTML = `
    <div class="kp-basket-header">
      <h3>KitePlus Express Baskets</h3>
      <button class="kp-modal-close" id="kp-close-basket">&times;</button>
    </div>
    <div class="kp-basket-tabs">
      <button class="kp-basket-tab ${activeBasketTab === 1 ? 'active' : ''}" data-tab="1">Basket 1</button>
      <button class="kp-basket-tab ${activeBasketTab === 2 ? 'active' : ''}" data-tab="2">Basket 2</button>
      <button class="kp-basket-tab ${activeBasketTab === 3 ? 'active' : ''}" data-tab="3">Basket 3</button>
      <button class="kp-basket-tab ${activeBasketTab === 4 ? 'active' : ''}" data-tab="4">Basket 4</button>
      <button class="kp-basket-tab ${activeBasketTab === 5 ? 'active' : ''}" data-tab="5">Basket 5</button>
      <button class="kp-basket-tab ${activeBasketTab === 6 ? 'active' : ''}" data-tab="6">Basket 6</button>
      <button class="kp-basket-tab ${activeBasketTab === 7 ? 'active' : ''}" data-tab="7">Basket 7</button>
      <button class="kp-basket-tab ${activeBasketTab === 8 ? 'active' : ''}" data-tab="8">Basket 8</button>
    </div>
    <div class="kp-basket-body" id="kp-basket-legs-container">
      <!-- Legs list -->
    </div>
    <div class="kp-basket-footer">
      <div class="kp-basket-margin-details">
        <span style="color:#94a3b8">Extra Margin Needed:</span>
        <span style="font-weight:700; color:#e2e8f0" id="kp-basket-extra-margin">₹0.00</span>
      </div>
      <div class="kp-basket-margin-details">
        <span style="color:#94a3b8">Final Margin Released:</span>
        <span style="font-weight:700; color:#10b981" id="kp-basket-released-margin">₹0.00</span>
      </div>
      <button class="kp-basket-execute-btn" id="kp-basket-execute-btn">Execute Basket</button>
    </div>
  `;
  
  // Bind close
  sidebar.querySelector('#kp-close-basket').addEventListener('click', closeBasketSidebar);
  
  // Bind tabs
  sidebar.querySelectorAll('.kp-basket-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      sidebar.querySelectorAll('.kp-basket-tab').forEach(b => b.classList.remove('active'));
      tabBtn.classList.add('active');
      activeBasketTab = parseInt(tabBtn.getAttribute('data-tab'));
      updateBasketLegsList();
    });
  });
  
  // Bind execute
  sidebar.querySelector('#kp-basket-execute-btn').addEventListener('click', executeActiveBasket);
  
  updateBasketLegsList();
}

function updateBasketLegsList() {
  const container = document.getElementById('kp-basket-legs-container');
  if (!container) return;
  
  // Filter legs for the active basket
  const legs = basketOrders.filter(leg => leg.basketId === activeBasketTab);
  
  if (legs.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 40px 20px; color:#64748b; font-size:12px;">
        <p>No orders in this basket.</p>
        <p style="margin-top:8px; font-size:11px;">Add legs directly from the Option Chain overlay in your watchlist!</p>
      </div>
    `;
    updateBasketMargin(0, 0);
    return;
  }
  
  container.innerHTML = '';
  legs.forEach((leg, index) => {
    const card = document.createElement('div');
    card.className = 'kp-basket-leg';
    
    const actionClass = leg.action.toLowerCase() === 'buy' ? 'buy' : 'sell';
    
    card.innerHTML = `
      <div class="kp-leg-header">
        <span class="kp-leg-name">${leg.symbol}</span>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="kp-leg-action ${actionClass}">${leg.action}</span>
          <button style="background:none; border:none; color:#f43f5e; cursor:pointer; font-size:14px;" class="kp-remove-leg" data-id="${leg.id}">&times;</button>
        </div>
      </div>
      <div class="kp-leg-inputs">
        <div class="kp-leg-input-group">
          <label>Qty</label>
          <input type="number" class="kp-leg-qty" data-id="${leg.id}" value="${leg.qty}">
        </div>
        <div class="kp-leg-input-group">
          <label>Price</label>
          <input type="number" step="0.05" class="kp-leg-price" data-id="${leg.id}" value="${leg.price}">
        </div>
      </div>
    `;
    
    container.appendChild(card);
  });
  
  // Bind Remove Buttons
  container.querySelectorAll('.kp-remove-leg').forEach(btn => {
    btn.addEventListener('click', () => {
      const legId = btn.getAttribute('data-id');
      basketOrders = basketOrders.filter(leg => leg.id !== legId);
      updateBasketLegsList();
    });
  });
  
  // Bind Input Changes
  container.querySelectorAll('.kp-leg-qty').forEach(input => {
    input.addEventListener('change', (e) => {
      const legId = input.getAttribute('data-id');
      const val = parseInt(e.target.value) || 1;
      const leg = basketOrders.find(l => l.id === legId);
      if (leg) {
        leg.qty = val;
        recalculateBasketMargins();
      }
    });
  });
  
  container.querySelectorAll('.kp-leg-price').forEach(input => {
    input.addEventListener('change', (e) => {
      const legId = input.getAttribute('data-id');
      const val = parseFloat(e.target.value) || 1.00;
      const leg = basketOrders.find(l => l.id === legId);
      if (leg) {
        leg.price = val;
        recalculateBasketMargins();
      }
    });
  });
  
  recalculateBasketMargins();
}

function addLegToBasket(symbol, action, price) {
  const id = Math.random().toString(36).substring(2, 9);
  
  // default lot size
  let qty = 75; // Nifty lot size
  if (symbol.includes('BANKNIFTY')) qty = 15;
  else if (symbol.includes('FINNIFTY')) qty = 40;
  else if (!symbol.includes('NIFTY')) qty = 1; // stock
  
  basketOrders.push({
    id,
    basketId: activeBasketTab,
    symbol,
    action,
    price,
    qty
  });
  
  updateBasketLegsList();
}

function recalculateBasketMargins() {
  const activeLegs = basketOrders.filter(leg => leg.basketId === activeBasketTab);
  if (activeLegs.length === 0) {
    updateBasketMargin(0, 0);
    return;
  }
  
  // Simple simulation of hedge margins
  // Buying options requires full premium
  // Selling options requires margin (approx ₹120,000 per lot)
  // If we have long legs + short legs (a hedge), the margin required drops significantly
  let totalPremiumToPay = 0;
  let totalSellMargin = 0;
  let buys = 0;
  let sells = 0;
  
  activeLegs.forEach(leg => {
    const val = leg.qty * leg.price;
    if (leg.action.toUpperCase() === 'BUY') {
      totalPremiumToPay += val;
      buys++;
    } else {
      totalSellMargin += 120000 * (leg.qty / (leg.symbol.includes('BANK') ? 15 : (leg.symbol.includes('FIN') ? 40 : 75)));
      sells++;
    }
  });
  
  let requiredMargin = totalPremiumToPay + totalSellMargin;
  let releasedMargin = 0;
  
  // Apply hedge discount if we have both buys and sells
  if (buys > 0 && sells > 0) {
    releasedMargin = totalSellMargin * 0.65; // 65% margin release for spread
    requiredMargin -= releasedMargin;
  }
  
  updateBasketMargin(requiredMargin, releasedMargin);
}

function updateBasketMargin(required, released) {
  const extraMarginEl = document.getElementById('kp-basket-extra-margin');
  const releasedMarginEl = document.getElementById('kp-basket-released-margin');
  
  if (extraMarginEl) extraMarginEl.innerText = `₹${formatCurrency(required)}`;
  if (releasedMarginEl) releasedMarginEl.innerText = `₹${formatCurrency(released)}`;
}

// Execute all orders in active basket
async function executeActiveBasket() {
  const activeLegs = basketOrders.filter(leg => leg.basketId === activeBasketTab);
  if (activeLegs.length === 0) return;
  
  if (confirm(`Execute ${activeLegs.length} orders in Basket ${activeBasketTab}?`)) {
    // If we are on the mock page, execute them in the simulated trading backend!
    if (window.mockState && typeof window.executeSimulatedOrders === 'function') {
      window.executeSimulatedOrders(activeLegs);
    } else {
      // Just simulate alert
      alert("Basket executed successfully!");
    }
    
    // Clear active basket
    basketOrders = basketOrders.filter(leg => leg.basketId !== activeBasketTab);
    updateBasketLegsList();
    closeBasketSidebar();
  }
}

function toggleBasketSidebar() {
  const sidebar = document.querySelector('.kp-basket-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('open');
  }
}

function openBasketSidebar() {
  const sidebar = document.querySelector('.kp-basket-sidebar');
  if (sidebar) {
    sidebar.classList.add('open');
  }
}

function closeBasketSidebar() {
  const sidebar = document.querySelector('.kp-basket-sidebar');
  if (sidebar) {
    sidebar.classList.remove('open');
  }
}

/* ==========================================
   HELPERS & MTM CHARTING MODULES
   ========================================== */
function formatCurrency(val) {
  return parseFloat(val).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

// Live margin fetching from Zerodha's backend API
let lastApiMarginFetch = 0;

async function updateMarginsFromAPI() {
  // Only call this on real Kite page, not mock simulator
  if (window.location.href.includes('mock-kite.html') || document.getElementById('mock-kite-dashboard') !== null) {
    return;
  }
  
  const now = Date.now();
  if (now - lastApiMarginFetch < 5000) {
    return; // Rate limit: at most once every 5 seconds
  }
  
  try {
    const headers = {};
    const token = getSessionToken();
    if (token) {
      headers['Authorization'] = `enctoken ${token}`;
    }
    
    const response = await fetch('/oms/funds', { headers });
    if (response.ok) {
      const json = await response.json();
      if (json && json.status === 'success' && json.data) {
        const equity = json.data.equity;
        if (equity) {
          // Check both equity.net and equity.available.live_balance
          const avail = parseFloat(equity.net) || (equity.available ? parseFloat(equity.available.live_balance) : NaN);
          const used = parseFloat(equity.utilised?.debits) || 0;
          
          if (!isNaN(avail) && avail > 10) { // Only set if valid and > 10
            currentMargin = avail;
            usedMargin = isNaN(used) ? 0 : used;
            lastApiMarginFetch = now;
            
            if (DEBUG) console.log(`[KitePlus Debug] API Margins fetched: Available=${currentMargin}, Used=${usedMargin}`);
            
            // Cache in local storage
            if (typeof chrome !== 'undefined' && chrome.storage) {
              chrome.storage.local.set({ cachedMargin: currentMargin, cachedUsedMargin: usedMargin });
            }
          }
        }
      }
    }
  } catch (err) {
    if (DEBUG) console.error(`[KitePlus Debug] Error fetching margins from API:`, err);
  }
}

// Load history from storage on init
async function loadMtmHistory() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get(['mtmHistory']);
      if (res.mtmHistory) {
        mtmHistory = res.mtmHistory;
        
        // Filter history: keep only today's data (clear past days)
        const todayStr = new Date().toDateString();
        mtmHistory = mtmHistory.filter(pt => {
          const ptDate = new Date(pt.timestamp).toDateString();
          return ptDate === todayStr;
        });
      }
    }
  } catch (err) {
    console.error('Error loading MTM history:', err);
  }
}

// Record current MTM data point
function recordMtmDataPoint() {
  const pnl = getNetPnL();
  
  // Don't record 0 if we haven't scraped anything yet (to avoid a big drop to 0 at page load)
  if (pnl === 0 && mtmHistory.length === 0) {
    return;
  }
  
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const timestamp = now.getTime();
  
  // Rate limit: Limit recording to once every 10 seconds
  const lastPoint = mtmHistory[mtmHistory.length - 1];
  if (lastPoint && (timestamp - lastPoint.timestamp < 10000)) {
    return;
  }
  
  mtmHistory.push({
    time: timeStr,
    val: pnl, // Gross
    netVal: pnl - totalExecutedCharges, // Net after charges
    timestamp: timestamp
  });
  
  // Limit data points to 5000 to prevent local storage bloat
  if (mtmHistory.length > 5000) {
    mtmHistory.shift();
  }
  
  // Save to local storage
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ mtmHistory });
  }
}

// Collapsible MTM Chart state
let hoveredIdx = null;

function handleCanvasMouseMove(e) {
  const canvas = document.getElementById('kp-mtm-canvas');
  if (!canvas || mtmHistory.length < 2) return;
  
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  
  const chartPadding = { top: 20, right: 80, bottom: 30, left: 60 };
  const graphWidth = rect.width - chartPadding.left - chartPadding.right;
  
  const graphX = mouseX - chartPadding.left;
  let ratio = graphX / graphWidth;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  
  const idx = Math.round(ratio * (mtmHistory.length - 1));
  if (idx !== hoveredIdx && idx >= 0 && idx < mtmHistory.length) {
    hoveredIdx = idx;
    drawMtmChart();
  }
}

function handleCanvasMouseLeave() {
  if (hoveredIdx !== null) {
    hoveredIdx = null;
    drawMtmChart();
  }
}

// Dynamically detect light or dark theme based on Zerodha Kite's style
function updateChartTheme(chartWrapper) {
  if (!chartWrapper) return;
  
  let isDark = false;
  try {
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    if (bodyBg) {
      const match = bodyBg.match(/\d+/g);
      if (match && match.length >= 3) {
        const r = parseInt(match[0]);
        const g = parseInt(match[1]);
        const b = parseInt(match[2]);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        isDark = brightness < 120; // Dark background
      }
    }
  } catch (e) {
    console.error('Error computing body background style:', e);
  }
  
  if (document.body.classList.contains('theme-dark') || 
      document.body.classList.contains('dark') || 
      document.getElementById('mock-kite-dashboard') !== null ||
      window.location.href.includes('mock-kite.html')) {
    isDark = true;
  }
  
  if (isDark) {
    chartWrapper.classList.add('theme-dark');
  } else {
    chartWrapper.classList.remove('theme-dark');
  }
}

// Inject chart UI into positions page
function handleMtmChartInjection() {
  const positionsContainer = document.querySelector('.positions, .positions-container');
  if (!positionsContainer) return;
  
  let chartWrapper = document.getElementById('kp-mtm-chart-wrapper');
  if (!chartWrapper) {
    chartWrapper = document.createElement('div');
    chartWrapper.id = 'kp-mtm-chart-wrapper';
    chartWrapper.className = 'kp-chart-card collapsed'; // Start collapsed
    
    // Insert after the table parent
    const table = positionsContainer.querySelector('table');
    if (table) {
      const tableParent = table.closest('.table-wrapper') || table;
      tableParent.parentNode.insertBefore(chartWrapper, tableParent.nextSibling);
    } else {
      positionsContainer.appendChild(chartWrapper);
    }
    
    chartWrapper.innerHTML = `
      <div class="kp-chart-header" style="cursor: pointer;" id="kp-chart-toggle-header">
        <div style="display:flex; align-items:center; gap: 8px;">
          <span class="kp-chart-chevron">▶</span>
          <span class="kp-chart-dot"></span>
          <span class="kp-chart-title">Intraday MTM Chart</span>
        </div>
        <div class="kp-chart-stats">
          <span>MTM: <b id="kp-chart-pnl" class="profit">₹0.00 (0.00%)</b></span>
          <span>High: <b class="profit" id="kp-chart-high">₹0.00 (0.00%)</b></span>
          <span>Low: <b class="loss" id="kp-chart-low">₹0.00 (0.00%)</b></span>
          <button class="kp-chart-btn" id="kp-btn-clear-chart">Clear</button>
          <button class="kp-chart-btn" id="kp-btn-export-chart">Export CSV</button>
        </div>
      </div>
      <div class="kp-chart-body">
        <div class="kp-chart-canvas-container">
          <canvas id="kp-mtm-canvas"></canvas>
        </div>
      </div>
    `;
    
    // Bind toggle event
    const toggleHeader = chartWrapper.querySelector('#kp-chart-toggle-header');
    toggleHeader.addEventListener('click', () => {
      chartWrapper.classList.toggle('collapsed');
      const chevron = chartWrapper.querySelector('.kp-chart-chevron');
      if (chartWrapper.classList.contains('collapsed')) {
        chevron.innerText = '▶';
      } else {
        chevron.innerText = '▼';
        setTimeout(drawMtmChart, 50);
      }
    });
    
    // Bind events
    const clearBtn = chartWrapper.querySelector('#kp-btn-clear-chart');
    if (clearBtn) {
      clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm("Are you sure you want to clear today's MTM history?")) {
          mtmHistory = [];
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ mtmHistory: [] });
          }
          drawMtmChart();
        }
      });
    }
    
    const exportBtn = chartWrapper.querySelector('#kp-btn-export-chart');
    if (exportBtn) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportChartCSV();
      });
    }
    
    // Bind canvas hover events
    const canvas = chartWrapper.querySelector('#kp-mtm-canvas');
    if (canvas) {
      canvas.addEventListener('mousemove', handleCanvasMouseMove);
      canvas.addEventListener('mouseleave', handleCanvasMouseLeave);
    }
    
    // Handle canvas resize
    window.addEventListener('resize', drawMtmChart);
  }
  
  // Synchronize initial theme variables
  updateChartTheme(chartWrapper);
}

// Draw smooth gradient curve on canvas
function drawMtmChart() {
  const canvas = document.getElementById('kp-mtm-canvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  const chartWrapper = document.getElementById('kp-mtm-chart-wrapper');
  if (chartWrapper) {
    updateChartTheme(chartWrapper);
  }
  const isDark = chartWrapper ? chartWrapper.classList.contains('theme-dark') : false;
  
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)';
  const labelColor = isDark ? '#8a94a6' : '#666666';
  
  // Retina resolution handling
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  // Empty state
  if (mtmHistory.length < 2) {
    ctx.font = '13px "Inter", -apple-system, sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for intraday MTM data points... (Updates every 10s)', width / 2, height / 2);
    return;
  }
  
  // Calculate range bounds (using Net P&L as the main metric)
  let vals = mtmHistory.map(pt => pt.netVal !== undefined ? pt.netVal : pt.val);
  let maxVal = Math.max(...vals);
  let minVal = Math.min(...vals);
  
  const range = maxVal - minVal;
  const padding = range === 0 ? 100 : range * 0.15;
  maxVal += padding;
  minVal -= padding;
  
  // Update stats in header
  const highEl = document.getElementById('kp-chart-high');
  const lowEl = document.getElementById('kp-chart-low');
  
  const realMax = Math.max(...vals);
  const realMin = Math.min(...vals);
  
  const margin = getAvailableMargin();
  const used = getUsedMargin();
  const totalCapital = (margin + used) > 0 ? (margin + used) : 500000.00;
  
  const highPercent = (realMax / totalCapital) * 100;
  const lowPercent = (realMin / totalCapital) * 100;
  
  if (highEl) {
    const sign = realMax >= 0 ? '+' : '-';
    highEl.innerText = `${sign}₹${formatCurrency(Math.abs(realMax))} (${realMax >= 0 ? '+' : '-'}${Math.abs(highPercent).toFixed(2)}%)`;
    highEl.className = realMax >= 0 ? 'profit' : 'loss';
  }
  if (lowEl) {
    const sign = realMin >= 0 ? '+' : '-';
    lowEl.innerText = `${sign}₹${formatCurrency(Math.abs(realMin))} (${realMin >= 0 ? '+' : '-'}${Math.abs(lowPercent).toFixed(2)}%)`;
    lowEl.className = realMin >= 0 ? 'profit' : 'loss';
  }
  
  // Layout paddings
  const chartPadding = { top: 20, right: 80, bottom: 30, left: 60 };
  const graphWidth = width - chartPadding.left - chartPadding.right;
  const graphHeight = height - chartPadding.top - chartPadding.bottom;
  
  // Draw horizontal grids & prices
  const yLabelCount = 5;
  ctx.font = '10px "Inter", sans-serif';
  ctx.fillStyle = labelColor;
  ctx.textBaseline = 'middle';
  
  for (let i = 0; i < yLabelCount; i++) {
    const ratio = i / (yLabelCount - 1);
    const yVal = maxVal - ratio * (maxVal - minVal);
    const yPos = chartPadding.top + ratio * graphHeight;
    
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.moveTo(chartPadding.left, yPos);
    ctx.lineTo(width - chartPadding.right, yPos);
    ctx.stroke();
    
    // Right Y-axis: Currency value
    ctx.textAlign = 'left';
    ctx.fillText(`${yVal >= 0 ? '+' : ''}₹${formatCurrency(yVal)}`, width - chartPadding.right + 8, yPos);
  
    // Left Y-axis: Percentage on total capital size
    ctx.textAlign = 'right';
    const yPercent = (yVal / totalCapital) * 100;
    ctx.fillText(`${yPercent >= 0 ? '+' : ''}${yPercent.toFixed(2)}%`, chartPadding.left - 8, yPos);
  }
  
  // Zero Line
  if (minVal < 0 && maxVal > 0) {
    const zeroRatio = maxVal / (maxVal - minVal);
    const zeroY = chartPadding.top + zeroRatio * graphHeight;
    ctx.beginPath();
    ctx.strokeStyle = isDark ? 'rgba(239, 68, 68, 0.5)' : 'rgba(223, 81, 76, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(chartPadding.left, zeroY);
    ctx.lineTo(width - chartPadding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  
  // Coordinate Mapping
  const points = mtmHistory.map((pt, idx) => {
    const xRatio = idx / (mtmHistory.length - 1);
    const ptVal = pt.netVal !== undefined ? pt.netVal : pt.val;
    const yRatio = (maxVal - ptVal) / (maxVal - minVal);
    return {
      x: chartPadding.left + xRatio * graphWidth,
      y: chartPadding.top + yRatio * graphHeight
    };
  });
  
  // Draw curve line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  
  const lastPoint = mtmHistory[mtmHistory.length - 1];
  const currentPnl = lastPoint.netVal !== undefined ? lastPoint.netVal : lastPoint.val;
  const color = currentPnl >= 0 ? '#10b981' : '#ef4444';
  
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  
  // Area Gradient Fill
  const grad = ctx.createLinearGradient(0, chartPadding.top, 0, height - chartPadding.bottom);
  grad.addColorStop(0, currentPnl >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)');
  grad.addColorStop(1, currentPnl >= 0 ? 'rgba(16, 185, 129, 0)' : 'rgba(239, 68, 68, 0)');
  
  ctx.beginPath();
  ctx.moveTo(points[0].x, height - chartPadding.bottom);
  ctx.lineTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }
  ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  ctx.lineTo(points[points.length - 1].x, height - chartPadding.bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  
  // Draw X Time Labels
  ctx.fillStyle = labelColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  
  const xLabelCount = Math.min(6, mtmHistory.length);
  const step = Math.ceil(mtmHistory.length / xLabelCount);
  
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.min(i * step, mtmHistory.length - 1);
    const pt = mtmHistory[idx];
    const xPos = points[idx].x;
    
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.moveTo(xPos, height - chartPadding.bottom);
    ctx.lineTo(xPos, height - chartPadding.bottom + 4);
    ctx.stroke();
    
    ctx.fillText(pt.time.substring(0, 5), xPos, height - chartPadding.bottom + 8);
  }

  // Hover Tooltip rendering
  if (hoveredIdx !== null && hoveredIdx < points.length) {
    const pt = points[hoveredIdx];
    const dataPt = mtmHistory[hoveredIdx];
    
    // Draw vertical cursor line
    ctx.beginPath();
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(pt.x, chartPadding.top);
    ctx.lineTo(pt.x, height - chartPadding.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Draw point circle
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();
    
    // Draw tooltip box with both Gross and Net values
    const netVal = dataPt.netVal !== undefined ? dataPt.netVal : dataPt.val;
    const grossSign = dataPt.val >= 0 ? '+' : '-';
    const netSign = netVal >= 0 ? '+' : '-';
    const tooltipText = `${dataPt.time} | Gross: ${grossSign}₹${formatCurrency(Math.abs(dataPt.val))} | Net: ${netSign}₹${formatCurrency(Math.abs(netVal))}`;
    ctx.font = 'bold 11px "Inter", sans-serif';
    const textWidth = ctx.measureText(tooltipText).width;
    
    const tooltipPadding = { x: 8, y: 6 };
    const boxWidth = textWidth + tooltipPadding.x * 2;
    const boxHeight = 22;
    
    let boxX = pt.x - boxWidth / 2;
    // Bounds checking
    if (boxX < chartPadding.left) boxX = chartPadding.left;
    if (boxX + boxWidth > width - chartPadding.right) boxX = width - chartPadding.right - boxWidth;
    
    const boxY = Math.max(chartPadding.top, pt.y - boxHeight - 10);
    
    ctx.fillStyle = '#111827';
    ctx.strokeStyle = isDark ? '#374151' : '#e0e0e0';
    ctx.lineWidth = 1;
    
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = netVal >= 0 ? '#10b981' : '#ef4444';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tooltipText, boxX + tooltipPadding.x, boxY + boxHeight / 2);
  }
}

// Export history dataset as CSV
function exportChartCSV() {
  if (mtmHistory.length === 0) {
    alert("No chart data to export.");
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,Timestamp,Time,Gross MTM P&L,Net MTM P&L\n";
  mtmHistory.forEach(pt => {
    const netVal = pt.netVal !== undefined ? pt.netVal : pt.val;
    csvContent += `${pt.timestamp},${pt.time},${pt.val},${netVal}\n`;
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  const dateStr = new Date().toISOString().substring(0, 10);
  link.setAttribute("download", `KitePlus_MTM_History_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/* ==========================================
   MODULE 6: SIGNAL ENGINE — UI & Price Scraper
   ========================================== */
let signalCandleCollector = null;
let signalHistory = [];
let lastSignalResult = null;
let lastSignalTimestamp = 0;
let signalPanelCollapsed = false;
let lastTickScrapeTime = 0;

// Initialize the candle collector from the signal engine
function initSignalEngine() {
  if (!window.KPSignalEngine) {
    if (DEBUG) console.log('[KitePlus Signal] Waiting for signal engine to load...');
    return false;
  }
  if (!signalCandleCollector) {
    signalCandleCollector = new window.KPSignalEngine.CandleCollector(2 * 60 * 1000); // 2-min candles
    if (DEBUG) console.log('[KitePlus Signal] CandleCollector initialized (2-min candles)');
  }
  return true;
}

// Scrape the current price from the Kite chart page
function scrapeCurrentPrice() {
  // Strategy 1: Chart header LTP (works on the chart view)
  const chartLTP = document.querySelector(
    '.chart-container .chart-price, ' +
    '.chart-container .last-price, ' +
    '.chart-header .last-price, ' +
    '.chart-controls-bar .chart-price, ' +
    '.chart-widget .ltp, ' +
    '#chart-ltp'
  );
  if (chartLTP) {
    const val = parseFloat(chartLTP.innerText.replace(/[^0-9.-]/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 2: TradingView widget price display
  const tvPrices = document.querySelectorAll(
    '.chart-markup-table .price-axis .pane-legend-line .pane-legend-title__main-title, ' +
    '.tv-symbol-price-quote__value, ' +
    '.chart-markup-table .price-axis .last-price-label, ' +
    '.valueItem-AdJFPlHp .js-symbol-last, ' +
    '.chart-markup-table .pane .pane-legend .legendSeriesItem .apply-overflow-tooltip'
  );
  for (const el of tvPrices) {
    const val = parseFloat(el.innerText.replace(/[^0-9.-]/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 3: Depth / Market depth widget LTP
  const depthLTP = document.querySelector(
    '.depth .last-price, ' +
    '.depth-content .last-price, ' +
    '.marketdepth-widget .ltp, ' +
    '.instrument-widget .last-price'
  );
  if (depthLTP) {
    const val = parseFloat(depthLTP.innerText.replace(/[^0-9.-]/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 4: Watchlist selected instrument LTP
  const watchlistLTP = document.querySelector(
    '.instruments .active .last-price, ' +
    '.instruments .selected .last-price, ' +
    '.instruments .highlight .price, ' +
    '.instrument.active .last-price'
  );
  if (watchlistLTP) {
    const val = parseFloat(watchlistLTP.innerText.replace(/[^0-9.-]/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 5: Any visible LTP on the page — try broad selector
  const allPriceElements = document.querySelectorAll('.last-price, .ltp, [data-col="last_price"]');
  for (const el of allPriceElements) {
    const val = parseFloat(el.innerText.replace(/[^0-9.-]/g, ''));
    if (!isNaN(val) && val > 0) return val;
  }

  // Strategy 6: Mock simulator
  if (window.mockState && window.mockState.lastPrice !== undefined) {
    return window.mockState.lastPrice;
  }

  return null;
}

// Get the current instrument symbol from the chart page
function scrapeCurrentSymbol() {
  // Chart header symbol
  const symbolEl = document.querySelector(
    '.chart-container .tradingsymbol, ' +
    '.chart-header .tradingsymbol, ' +
    '.chart-controls-bar .symbol, ' +
    '.chart-widget .symbol-name, ' +
    '.chart-widget .instrument-name'
  );
  if (symbolEl) return symbolEl.innerText.trim();

  // TradingView title
  const tvTitle = document.querySelector(
    '.chart-markup-table .pane-legend-line .pane-legend-title__main-title, ' +
    '.tv-symbol-header__short-name'
  );
  if (tvTitle) return tvTitle.innerText.trim();

  // Breadcrumb or page title
  const breadcrumb = document.querySelector('.page-title, .chart-title, h1.tradingsymbol');
  if (breadcrumb) return breadcrumb.innerText.trim();

  // Fallback
  if (window.mockState && window.mockState.symbol) return window.mockState.symbol;
  return 'NIFTY';
}

// Main signal engine update loop — called every 200ms from updateDynamicValues
function updateSignalEngine() {
  if (!initSignalEngine()) return;

  const now = Date.now();
  // Rate limit tick scraping to every 1 second
  if (now - lastTickScrapeTime < 1000) return;
  lastTickScrapeTime = now;

  const price = scrapeCurrentPrice();
  if (price === null) return;

  // Feed tick to candle collector
  signalCandleCollector.addTick(price, now);
  signalCandleCollector.trim(500);

  // Generate signals (rate limit to every 2 seconds)
  if (now - lastSignalTimestamp < 2000 && lastSignalResult) return;
  lastSignalTimestamp = now;

  const candles = signalCandleCollector.getAllCandles();
  const result = window.KPSignalEngine.generateSignals(candles);
  
  // Check if we have a NEW strong signal (direction changed or new threshold crossed)
  const isNewSignal = result.direction && result.strength >= 83 &&
    (!lastSignalResult || lastSignalResult.direction !== result.direction ||
     lastSignalResult.strength < 83);
  
  if (isNewSignal) {
    // Record to history
    const timeStr = new Date().toLocaleTimeString('en-US', {
      hour12: false, hour: '2-digit', minute: '2-digit'
    });
    signalHistory.unshift({
      time: timeStr,
      direction: result.direction,
      strength: result.strength,
      price: result.currentPrice,
      message: result.message,
      timestamp: now
    });
    // Keep last 50 signals
    if (signalHistory.length > 50) signalHistory.pop();
    
    // Show toast notification
    showSignalToast(result);
  }

  lastSignalResult = result;

  // Update the panel UI
  updateSignalPanelUI(result);
}

// Handle signal panel injection / removal based on settings
function handleSignalPanel() {
  if (!settings.signals) {
    const existing = document.querySelector('.kp-signal-panel');
    if (existing) existing.remove();
    const toast = document.querySelector('.kp-signal-toast');
    if (toast) toast.remove();
    return;
  }

  // Only show on chart page or mock simulator
  const isChartPage = window.location.pathname.includes('/chart') ||
                      window.location.href.includes('mock-kite.html') ||
                      document.getElementById('mock-kite-dashboard') !== null ||
                      document.querySelector('.chart-container, .chart-widget, .tv-chart') !== null;

  // Also show on positions page for broader coverage
  const isPositionsPage = window.location.pathname.includes('/positions');

  if (!isChartPage && !isPositionsPage) {
    // Remove panel if we navigated away
    const existing = document.querySelector('.kp-signal-panel');
    if (existing) existing.remove();
    return;
  }

  let panel = document.querySelector('.kp-signal-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'kp-signal-panel';
    if (signalPanelCollapsed) panel.classList.add('collapsed');
    
    // Restore dragged position from local storage
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get(['signalPanelTop', 'signalPanelLeft']).then(res => {
        if (res.signalPanelTop !== undefined && res.signalPanelLeft !== undefined) {
          panel.style.top = res.signalPanelTop;
          panel.style.left = res.signalPanelLeft;
          panel.style.right = 'auto';
        }
      });
    }
    
    document.body.appendChild(panel);
    renderSignalPanel(panel);
  }
}

// Render the full signal panel structure
function renderSignalPanel(panel) {
  panel.innerHTML = `
    <div class="kp-signal-header" id="kp-signal-toggle" style="cursor: move;">
      <div class="kp-signal-header-left">
        <div class="kp-signal-icon">📊</div>
        <span class="kp-signal-header-chevron">▼</span>
        <span class="kp-signal-header-title">Signal Engine</span>
      </div>
      <div class="kp-signal-header-right">
        <span class="kp-signal-header-badge collecting" id="kp-signal-header-badge">LOADING</span>
        <button class="kp-signal-close-btn" id="kp-signal-close" title="Close Signal Panel">&times;</button>
      </div>
    </div>
    <div class="kp-signal-body">
      <div class="kp-signal-candle-info" id="kp-signal-candle-info">
        <span>Candles: <span class="candle-count" id="kp-candle-count">0</span></span>
        <span>Timeframe: <span class="candle-timeframe">2 min</span></span>
        <span>Symbol: <span id="kp-signal-symbol" style="color: #e2e8f0; font-weight: 600;">—</span></span>
      </div>
      <div class="kp-signal-main" id="kp-signal-main">
        <div class="kp-signal-main-badge neutral" id="kp-signal-main-badge">
          — Collecting Data...
        </div>
        <div class="kp-signal-strength-bar">
          <div class="kp-signal-strength-fill neutral" id="kp-signal-strength-fill" style="width: 0%"></div>
        </div>
        <div class="kp-signal-strength-label" id="kp-signal-strength-label">Confluence: 0%</div>
        <div class="kp-signal-price-info" id="kp-signal-price-info">
          <span>Price: <span class="value" id="kp-signal-price">—</span></span>
        </div>
      </div>
      <div class="kp-signal-indicators" id="kp-signal-indicators">
        <div class="kp-signal-indicators-title">Indicator Breakdown (6 indicators)</div>
        <div id="kp-signal-indicator-rows">
          <!-- Populated dynamically -->
        </div>
      </div>
      <div class="kp-signal-history">
        <div class="kp-signal-history-title">
          <span>Signal History</span>
          <span id="kp-signal-history-count" style="color: #94a3b8">0 signals</span>
        </div>
        <div class="kp-signal-history-list" id="kp-signal-history-list">
          <div class="kp-signal-history-empty">No signals yet. Collecting market data...</div>
        </div>
      </div>
      <div class="kp-signal-footer">
        <button class="kp-signal-add-basket-btn" id="kp-signal-add-basket" disabled>
          Add Signal to Express Basket
        </button>
        <div class="kp-signal-disclaimer">
          ⚠️ For educational purposes only. Not financial advice. Past indicator confluence does not guarantee future results.
        </div>
      </div>
    </div>
  `;

  // Bind drag & toggle collapse
  const toggleHeader = panel.querySelector('#kp-signal-toggle');
  
  let isDragging = false;
  let dragActive = false;
  let startX = 0, startY = 0;
  
  toggleHeader.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('a')) return;
    
    e.preventDefault();
    dragActive = true;
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
    
    let pos1 = 0, pos2 = 0, pos3 = e.clientX, pos4 = e.clientY;
    
    function onMouseMove(moveEv) {
      if (!dragActive) return;
      
      // If mouse moved more than 5px, it's a drag
      if (Math.abs(moveEv.clientX - startX) > 5 || Math.abs(moveEv.clientY - startY) > 5) {
        isDragging = true;
      }
      
      pos1 = pos3 - moveEv.clientX;
      pos2 = pos4 - moveEv.clientY;
      pos3 = moveEv.clientX;
      pos4 = moveEv.clientY;
      
      let newTop = panel.offsetTop - pos2;
      let newLeft = panel.offsetLeft - pos1;
      
      const rect = panel.getBoundingClientRect();
      const maxTop = window.innerHeight - (signalPanelCollapsed ? 52 : rect.height);
      const maxLeft = window.innerWidth - rect.width;
      
      newTop = Math.max(0, Math.min(newTop, maxTop));
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      
      panel.style.top = newTop + 'px';
      panel.style.left = newLeft + 'px';
      panel.style.right = 'auto';
    }
    
    function onMouseUp() {
      dragActive = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
      // Save position to storage
      if (isDragging && typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({
          signalPanelTop: panel.style.top,
          signalPanelLeft: panel.style.left
        });
      }
    }
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  toggleHeader.addEventListener('click', (e) => {
    // If dragging occurred, do not toggle collapse
    if (isDragging) {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // Don't toggle if clicking close button
    if (e.target.closest('.kp-signal-close-btn')) return;
    signalPanelCollapsed = !signalPanelCollapsed;
    panel.classList.toggle('collapsed', signalPanelCollapsed);
    const chevron = panel.querySelector('.kp-signal-header-chevron');
    chevron.innerText = signalPanelCollapsed ? '▶' : '▼';
    
    // Bounds check after collapse resize
    setTimeout(() => {
      const rect = panel.getBoundingClientRect();
      let newTop = panel.offsetTop;
      const maxTop = window.innerHeight - (signalPanelCollapsed ? 52 : rect.height);
      if (newTop > maxTop) {
        newTop = Math.max(0, maxTop);
        panel.style.top = newTop + 'px';
        if (typeof chrome !== 'undefined' && chrome.storage) {
          chrome.storage.local.set({ signalPanelTop: panel.style.top });
        }
      }
    }, 350);
  });

  // Bind close button
  const closeBtn = panel.querySelector('#kp-signal-close');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settings.signals = false;
    panel.remove();
    // Persist setting
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ settings });
    }
  });

  // Bind Add to Basket button
  const addBasketBtn = panel.querySelector('#kp-signal-add-basket');
  addBasketBtn.addEventListener('click', () => {
    if (!lastSignalResult || !lastSignalResult.direction || lastSignalResult.strength < 83) return;

    const symbol = scrapeCurrentSymbol();
    const action = 'BUY';
    const price = lastSignalResult.currentPrice || 100;
    const legName = `${symbol} ${lastSignalResult.direction}`;

    addLegToBasket(legName, action, price);
    openBasketSidebar();
  });
}

// Update the signal panel UI with the latest signal result
function updateSignalPanelUI(result) {
  if (!result) return;
  const panel = document.querySelector('.kp-signal-panel');
  if (!panel) return;

  // --- Header Badge ---
  const headerBadge = panel.querySelector('#kp-signal-header-badge');
  if (headerBadge) {
    if (!result.direction && result.message.includes('Collecting')) {
      headerBadge.textContent = `${signalCandleCollector ? signalCandleCollector.getCandleCount() : 0}/35`;
      headerBadge.className = 'kp-signal-header-badge collecting';
    } else if (result.direction && result.strength >= 100) {
      headerBadge.textContent = `${result.message}`;
      headerBadge.className = `kp-signal-header-badge signal-strong-${result.direction.toLowerCase()}`;
    } else if (result.direction && result.strength >= 83) {
      headerBadge.textContent = `${result.message}`;
      headerBadge.className = `kp-signal-header-badge signal-${result.direction.toLowerCase()}`;
    } else {
      headerBadge.textContent = 'NO SIGNAL';
      headerBadge.className = 'kp-signal-header-badge no-signal';
    }
  }

  // --- Candle Info ---
  const candleCount = panel.querySelector('#kp-candle-count');
  if (candleCount && signalCandleCollector) {
    candleCount.textContent = signalCandleCollector.getCandleCount();
  }

  const symbolEl = panel.querySelector('#kp-signal-symbol');
  if (symbolEl) {
    symbolEl.textContent = scrapeCurrentSymbol();
  }

  // --- Main Signal Badge ---
  const mainBadge = panel.querySelector('#kp-signal-main-badge');
  if (mainBadge) {
    if (result.direction && result.strength >= 83) {
      const isStrong = result.strength >= 100;
      mainBadge.className = `kp-signal-main-badge ${result.direction.toLowerCase()} ${isStrong ? 'strong' : ''}`;
      mainBadge.textContent = result.message;
    } else if (result.direction && result.strength >= 67) {
      mainBadge.className = 'kp-signal-main-badge neutral';
      mainBadge.textContent = result.message;
    } else if (result.message.includes('Collecting')) {
      mainBadge.className = 'kp-signal-main-badge neutral';
      mainBadge.textContent = result.message;
    } else {
      mainBadge.className = 'kp-signal-main-badge neutral';
      mainBadge.textContent = '— No Clear Signal';
    }
  }

  // --- Strength Bar ---
  const strengthFill = panel.querySelector('#kp-signal-strength-fill');
  if (strengthFill) {
    strengthFill.style.width = `${result.strength}%`;
    if (result.direction === 'CE') {
      strengthFill.className = 'kp-signal-strength-fill ce';
    } else if (result.direction === 'PE') {
      strengthFill.className = 'kp-signal-strength-fill pe';
    } else {
      strengthFill.className = 'kp-signal-strength-fill neutral';
    }
  }

  const strengthLabel = panel.querySelector('#kp-signal-strength-label');
  if (strengthLabel) {
    const ceCount = result.bullishCount || 0;
    const peCount = result.bearishCount || 0;
    strengthLabel.textContent = `Confluence: ${result.strength}% (CE: ${ceCount}/6 | PE: ${peCount}/6)`;
  }

  // --- Price ---
  const priceEl = panel.querySelector('#kp-signal-price');
  if (priceEl && result.currentPrice) {
    priceEl.textContent = `₹${result.currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // --- Indicator Rows ---
  const indicatorContainer = panel.querySelector('#kp-signal-indicator-rows');
  if (indicatorContainer && result.indicators) {
    const indicatorNames = {
      rsi: 'RSI (14)',
      macd: 'MACD',
      ema: 'EMA 9/21',
      bb: 'Bollinger',
      vwap: 'VWAP',
      supertrend: 'Supertrend'
    };

    const indicatorIcons = {
      rsi: '📈',
      macd: '📊',
      ema: '〰️',
      bb: '📉',
      vwap: '⚖️',
      supertrend: '🔺'
    };

    let rowsHTML = '';
    for (const [key, data] of Object.entries(result.indicators)) {
      const statusClass = data.signal === 'CE' ? 'bullish' :
                          data.signal === 'PE' ? 'bearish' : 'neutral-status';
      const statusIcon = data.signal === 'CE' ? '▲' :
                         data.signal === 'PE' ? '▼' : '—';

      rowsHTML += `
        <div class="kp-signal-indicator-row">
          <div class="kp-signal-indicator-name">
            <span class="kp-signal-indicator-status ${statusClass}">${statusIcon}</span>
            <span>${indicatorIcons[key] || '📊'} ${indicatorNames[key] || key}</span>
          </div>
          <span class="kp-signal-indicator-label">${data.label}</span>
          <span class="kp-signal-indicator-value">${data.value}</span>
        </div>
      `;
    }
    indicatorContainer.innerHTML = rowsHTML;
  }

  // --- Signal History ---
  const historyList = panel.querySelector('#kp-signal-history-list');
  const historyCount = panel.querySelector('#kp-signal-history-count');

  if (historyCount) {
    historyCount.textContent = `${signalHistory.length} signal${signalHistory.length !== 1 ? 's' : ''}`;
  }

  if (historyList) {
    if (signalHistory.length === 0) {
      historyList.innerHTML = '<div class="kp-signal-history-empty">No signals yet. Collecting market data...</div>';
    } else {
      let html = '';
      const displayHistory = signalHistory.slice(0, 15); // Show last 15
      displayHistory.forEach(sig => {
        const dirClass = sig.direction.toLowerCase();
        html += `
          <div class="kp-signal-history-item">
            <span class="signal-time">${sig.time}</span>
            <span class="signal-type ${dirClass}">BUY ${sig.direction}</span>
            <span class="signal-strength">${sig.strength}%</span>
            <span class="signal-price">₹${sig.price ? sig.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
          </div>
        `;
      });
      historyList.innerHTML = html;
    }
  }

  // --- Add to Basket Button ---
  const addBasketBtn = panel.querySelector('#kp-signal-add-basket');
  if (addBasketBtn) {
    if (result.direction && result.strength >= 83) {
      addBasketBtn.disabled = false;
      addBasketBtn.textContent = `Add BUY ${result.direction} to Express Basket`;
    } else {
      addBasketBtn.disabled = true;
      addBasketBtn.textContent = 'Add Signal to Express Basket';
    }
  }
}

// Show a toast notification for new strong signals
function showSignalToast(result) {
  // Remove existing toast
  let toast = document.querySelector('.kp-signal-toast');
  if (toast) toast.remove();

  toast = document.createElement('div');
  toast.className = `kp-signal-toast ${result.direction.toLowerCase()}`;
  toast.textContent = `${result.message} @ ₹${result.currentPrice ? result.currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'} (${result.strength}%)`;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add('show');
    });
  });

  // Auto-dismiss after 4 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 400);
  }, 4000);
}

// Run init
init();

