// KitePlus Extension Content Script
const DEBUG = true;

let settings = {
  grouping: true,
  basket: true,
  optionchain: true,
  charges: true,
  signals: true,
  stockAnalysis: true
};

const BROKER_ADAPTER = window.KPBrokerAdapters?.detectBroker?.();
let panelTheme = 'daylight'; // 'daylight' (clean white) | 'dark' (sleek slate)
try {
  chrome.storage.local.get(['panelTheme'], res => {
    if (res && res.panelTheme) {
      panelTheme = res.panelTheme;
      const p = document.querySelector('.kp-signal-panel');
      if (p) applyBrokerTheme(p);
    }
  });
} catch (_) {}

function getActiveBrokerInfo() {
  const ctx = typeof getBrokerContext === 'function' ? getBrokerContext() : null;
  const host = window.location.hostname.toLowerCase();
  const id = ctx?.brokerId || (
    host.includes('upstox.com') ? 'upstox'
      : host.includes('dhan.co') ? 'dhan'
        : 'kite'
  );
  const label = id === 'upstox' ? 'Upstox' : (id === 'dhan' ? 'Dhan' : 'Kite');
  return { id, label };
}

function applyBrokerTheme(el) {
  if (!el || !el.classList) return;
  const broker = getActiveBrokerInfo();
  el.classList.remove('kp-theme-kite', 'kp-theme-upstox', 'kp-theme-dhan');
  el.classList.add(`kp-theme-${broker.id}`);
  el.classList.remove('kp-mode-daylight', 'kp-mode-dark');
  el.classList.add(panelTheme === 'dark' ? 'kp-mode-dark' : 'kp-mode-daylight');
}

function togglePanelTheme() {
  panelTheme = panelTheme === 'dark' ? 'daylight' : 'dark';
  try {
    chrome.storage.local.set({ panelTheme });
  } catch (_) {}
  const panel = document.querySelector('.kp-signal-panel');
  if (panel) {
    applyBrokerTheme(panel);
    const themeBtn = panel.querySelector('#kp-signal-theme-toggle');
    if (themeBtn) themeBtn.textContent = panelTheme === 'dark' ? '☀️ Day' : '🌙 Dark';
  }
}

function applyBrokerBodyTheme() {
  const broker = getActiveBrokerInfo();
  document.body.classList.remove('kp-broker-kite', 'kp-broker-upstox', 'kp-broker-dhan');
  document.body.classList.add(`kp-broker-${broker.id}`);
}

// Global state
let currentMargin = 500000.00;
let usedMargin = 0.00;
let basketOrders = [];
let activeBasketTab = 1;
let cachedNetPnL = 0.00;
let mtmHistory = [];

// Initialize
async function init() {
  try {
    await loadSettings();
    // One-time recovery: old ✕ button permanently disabled signals
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const flag = await chrome.storage.local.get(['kpSignalsRecovered']);
      if (settings.signals === false && !flag.kpSignalsRecovered) {
        settings.signals = true;
        await chrome.storage.local.set({ settings, kpSignalsRecovered: true });
      } else if (!flag.kpSignalsRecovered) {
        await chrome.storage.local.set({ kpSignalsRecovered: true });
      }
    }
    await loadSignalPrefs();
    applyBrokerBodyTheme();
    if (IS_KITE) {
      try {
        await loadExecutedCharges();
        await loadMtmHistory();
        await updateMarginsFromAPI();
      } catch (e) {
        if (DEBUG) console.warn('[KitePlus] Kite init partial fail:', e);
      }
    }
    setupMutationObserver();
    setupSettingsListener();
    runModules();
    setInterval(() => {
      try { updateDynamicValues(); } catch (e) {
        if (DEBUG) console.warn('[KitePlus] update tick error:', e);
      }
    }, 200);
  } catch (err) {
    console.error('[KitePlus] init failed:', err);
    try { runModules(); } catch (e2) {}
  }
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

      if (IS_KITE) {
        handlePositionsGrouping();
        handleWatchlistOptionChain();
        handleOrderWindowCharges();
        handleExpressBasketDrawer();
      } else {
        document.querySelector('.kp-basket-sidebar')?.remove();
      }
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
let todayOrders = [];
let knownOrderIds = new Set();
let lastApiOrdersFetch = 0;
let chargesSource = 'est'; // 'contract' | 'orders' | 'est'

async function loadExecutedCharges() {
  const todayStr = new Date().toDateString();
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get(['totalExecutedCharges', 'executedChargesDate', 'chargesSource']);
      if (res.executedChargesDate === todayStr) {
        totalExecutedCharges = res.totalExecutedCharges || 0;
        executedChargesDate = res.executedChargesDate;
        chargesSource = res.chargesSource || 'est';
        // Wipe previously poisoned totals (e.g. ₹14L from per-fill overcount)
        if (chargesSource !== 'contract' && totalExecutedCharges > 75000) {
          totalExecutedCharges = 0;
          chargesSource = 'est';
          await chrome.storage.local.set({ totalExecutedCharges: 0, chargesSource: 'est' });
        }
      } else {
        totalExecutedCharges = 0;
        executedChargesDate = todayStr;
        chargesSource = 'est';
        await chrome.storage.local.set({ totalExecutedCharges: 0, executedChargesDate: todayStr, chargesSource: 'est' });
      }
    } else {
      const cachedDate = localStorage.getItem('kp_executed_charges_date');
      if (cachedDate === todayStr) {
        totalExecutedCharges = parseFloat(localStorage.getItem('kp_executed_charges')) || 0;
        executedChargesDate = cachedDate;
        if (totalExecutedCharges > 75000) totalExecutedCharges = 0;
      } else {
        totalExecutedCharges = 0;
        executedChargesDate = todayStr;
      }
    }
  } catch (err) {
    if (DEBUG) console.error('[KitePlus] Error loading executed charges:', err);
  }
}

function saveExecutedCharges(val, source) {
  totalExecutedCharges = Math.max(0, Number(val) || 0);
  if (source) chargesSource = source;
  const todayStr = new Date().toDateString();
  executedChargesDate = todayStr;
  mtmHistory.forEach(pt => {
    if (pt && Number.isFinite(pt.val)) {
      pt.netVal = pt.val - totalExecutedCharges;
      pt.charges = totalExecutedCharges;
    }
  });
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({
      totalExecutedCharges,
      executedChargesDate: todayStr,
      chargesSource,
      mtmHistory
    });
  } else {
    try {
      localStorage.setItem('kp_executed_charges', String(totalExecutedCharges));
      localStorage.setItem('kp_executed_charges_date', todayStr);
    } catch (e) {}
  }
}

function parseMoney(text) {
  if (text == null) return null;
  const n = parseFloat(String(text).replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function findContractNoteRoot() {
  const candidates = Array.from(document.querySelectorAll(
    '.modal-wrapper, .modal, .modal-dialog, .modal-content, [class*="contract"], [class*="charges"], body'
  ));
  for (const root of candidates) {
    const text = root.innerText || '';
    if (/Virtual\s*contract\s*note/i.test(text)) return root;
  }
  return null;
}

/** Parse Virtual contract note: Total Charges + trade rows (Time/Action/Qty/Price/Charges). */
function scrapeContractNoteFromDOM() {
  const root = findContractNoteRoot();
  if (!root) return { ok: false, trades: [] };

  const blob = (root.innerText || '').replace(/\s+/g, ' ');
  let total = null;
  const m = blob.match(/Total\s*Charges\s*[:\s]*₹?\s*([0-9,]+\.?[0-9]*)/i);
  if (m) total = parseMoney(m[1]);
  if (total == null) {
    const cells = Array.from(root.querySelectorAll('td, th, span, div, p, label, strong, b'));
    for (let i = 0; i < cells.length; i++) {
      const label = (cells[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^Total(\s*Charges)?$/i.test(label)) continue;
      const row = cells[i].closest('tr, .row, [class*="row"]') || cells[i].parentElement;
      const candidates = row
        ? Array.from(row.querySelectorAll('td, span, div, strong, b'))
        : [cells[i].nextElementSibling].filter(Boolean);
      for (let j = candidates.length - 1; j >= 0; j--) {
        const val = parseMoney(candidates[j]?.textContent);
        if (val != null && val > 0) { total = val; break; }
      }
      if (total != null) break;
    }
  }

  const trades = scrapeContractNoteTradeRows(root);
  if (total == null && trades.length) {
    total = trades.reduce((s, t) => s + (Number(t.leg_charges) || 0), 0);
  }
  if (total != null && total > 0) {
    saveExecutedCharges(total, 'contract');
    if (DEBUG) console.log('[KitePlus] Contract note Total Charges:', total, 'trades:', trades.length);
  }
  return { ok: total != null || trades.length > 0, trades, total };
}

function scrapeContractNoteTradeRows(root) {
  const trades = [];
  const pushTrade = (timeStr, action, instrument, qty, price, legCharges) => {
    if (!timeStr || !action || !instrument) return;
    const id = `note-${timeStr}-${action}-${instrument}-${qty || 0}-${price || 0}`;
    trades.push({
      order_id: id,
      trade_id: id,
      tradingsymbol: instrument,
      transaction_type: action,
      quantity: qty || 0,
      filled_quantity: qty || 0,
      average_price: price || 0,
      exchange: /\bNFO\b|\bBFO\b|\bMCX\b/i.test(instrument) ? 'NFO' : 'NSE',
      status: 'COMPLETE',
      order_timestamp: timeStr,
      fill_timestamp: timeStr,
      leg_charges: legCharges,
      source: 'contract-note'
    });
  };

  // Path A: table / row nodes
  const rows = Array.from(root.querySelectorAll('tr'));
  rows.forEach(row => {
    const cells = Array.from(row.querySelectorAll('td')).map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
    const text = cells.length ? cells.join(' | ') : (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || /^(Time|Instrument|Action|Qty)/i.test(text)) return;
    const clock = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
    const actionM = text.match(/\b(BUY|SELL)\b/i);
    if (!clock || !actionM) return;
    const timeStr = `${clock[1].padStart(2, '0')}:${clock[2]}${clock[3] ? ':' + clock[3] : ':00'}`;
    const action = actionM[1].toUpperCase();
    let instrument = '';
    let qty = 0;
    let price = null;
    let legCharges = null;
    if (cells.length >= 5) {
      // Expected: Time | Instrument | Action | Qty | Avg.price | Charges
      const timeIdx = cells.findIndex(c => /\d{1,2}:\d{2}/.test(c));
      const actIdx = cells.findIndex(c => /^(BUY|SELL)$/i.test(c));
      instrument = cells.find((c, i) => i !== timeIdx && i !== actIdx && /[A-Za-z]{3,}/.test(c) && !/^(BUY|SELL)$/i.test(c)) || '';
      const qtyIdx = cells.findIndex(c => /^\d{1,6}$/.test(c));
      qty = qtyIdx >= 0 ? parseInt(cells[qtyIdx], 10) : 0;
      const moneyCells = cells.map(c => parseMoney(c)).filter(n => n != null);
      if (moneyCells.length >= 2) {
        price = moneyCells[moneyCells.length - 2];
        legCharges = moneyCells[moneyCells.length - 1];
      } else if (moneyCells.length === 1) {
        price = moneyCells[0];
      }
    } else {
      const nums = [...text.matchAll(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/g)]
        .map(x => parseMoney(x[1])).filter(n => n != null);
      if (nums.length >= 3) {
        qty = Math.round(nums[0]);
        price = nums[1];
        legCharges = nums[2];
      } else if (nums.length === 2) {
        qty = Math.round(nums[0]);
        price = nums[1];
      }
      instrument = text
        .replace(clock[0], '')
        .replace(/\b(BUY|SELL)\b/i, '')
        .replace(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    pushTrade(timeStr, action, instrument, qty, price, legCharges);
  });

  // Path B: plain-text lines (Kite often renders contract note without classic <tr> cells)
  if (!trades.length) {
    const lines = (root.innerText || '').split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    lines.forEach(line => {
      if (/Total\s*Charges|Statutory|Brokerage|SEBI|Stamp|^Time\b/i.test(line)) return;
      // "15:27:38 NIFTY JUL 24150 CE NFO SELL 195 174.6 88.99"
      const m = line.match(
        /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s+(.+?)\s+\b(BUY|SELL)\b\s+(\d{1,6})\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)/i
      );
      if (m) {
        const timeStr = `${m[1].padStart(2, '0')}:${m[2]}${m[3] ? ':' + m[3] : ':00'}`;
        pushTrade(timeStr, m[5].toUpperCase(), m[4].trim(), parseInt(m[6], 10), parseFloat(m[7]), parseFloat(m[8]));
        return;
      }
      const loose = line.match(
        /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\s+(.+?)\s+\b(BUY|SELL)\b/i
      );
      if (!loose) return;
      const timeStr = `${loose[1].padStart(2, '0')}:${loose[2]}${loose[3] ? ':' + loose[3] : ':00'}`;
      const action = loose[5].toUpperCase();
      const instrument = loose[4].trim();
      const after = line.slice(line.toUpperCase().lastIndexOf(action) + action.length);
      const nums = [...after.matchAll(/([0-9]+(?:\.[0-9]+)?)/g)].map(x => parseFloat(x[1]));
      const qty = nums[0] ? Math.round(nums[0]) : 0;
      const price = nums.length >= 2 ? nums[1] : null;
      const legCharges = nums.length >= 3 ? nums[2] : null;
      pushTrade(timeStr, action, instrument, qty, price, legCharges);
    });
  }

  const seen = new Set();
  return trades.filter(t => {
    if (!t.tradingsymbol || seen.has(t.order_id)) return false;
    seen.add(t.order_id);
    return true;
  });
}

/** Scrape Kite Orders / Executed table on the page as a fallback. */
function scrapeOrdersTableFromDOM() {
  const tables = Array.from(document.querySelectorAll('table'));
  const out = [];
  tables.forEach((table, tIdx) => {
    const header = (table.querySelector('thead')?.innerText || table.innerText || '').slice(0, 400);
    if (!/Time|Instrument|Status|Avg|Type|Transaction/i.test(header)) return;
    Array.from(table.querySelectorAll('tbody tr, tr')).forEach((row, rIdx) => {
      const cells = Array.from(row.querySelectorAll('td')).map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
      if (cells.length < 4) return;
      const rowText = cells.join(' ');
      if (!/\b(COMPLETE|EXECUTED|BUY|SELL)\b/i.test(rowText)) return;
      if (/\b(OPEN|REJECTED|CANCELLED|TRIGGER PENDING)\b/i.test(rowText) &&
          !/\b(COMPLETE|EXECUTED)\b/i.test(rowText)) return;
      const clock = rowText.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
      const action = rowText.match(/\b(BUY|SELL)\b/i);
      if (!action) return;
      const statusOk = /\b(COMPLETE|EXECUTED)\b/i.test(rowText) || !/\b(OPEN|REJECTED|CANCELLED)\b/i.test(rowText);
      if (!statusOk) return;
      const nums = cells.map(c => parseMoney(c)).filter(n => n != null && n > 0);
      const qtyCell = cells.find(c => /^\d{1,6}$/.test(c));
      const qty = qtyCell ? parseInt(qtyCell, 10) : (nums.find(n => n >= 1 && n <= 50000 && Number.isInteger(n)) || 0);
      const price = nums.find(n => String(n).includes('.') || (n > 0 && n < 100000)) || 0;
      const symbol = cells.find(c => /[A-Z]{2,}/.test(c) && !/^(BUY|SELL|COMPLETE|EXECUTED|MIS|NRML|CNC|NFO|NSE|BSE)$/i.test(c)) || '';
      if (!symbol) return;
      const timeStr = clock
        ? `${clock[1].padStart(2, '0')}:${clock[2]}${clock[3] ? ':' + clock[3] : ':00'}`
        : formatClock(Date.now());
      const id = `dom-${tIdx}-${rIdx}-${timeStr}-${action[1]}-${symbol}-${qty}`;
      out.push({
        order_id: id,
        tradingsymbol: symbol,
        transaction_type: action[1].toUpperCase(),
        quantity: qty,
        filled_quantity: qty,
        average_price: price,
        exchange: /NFO|CE|PE|FUT/i.test(rowText) ? 'NFO' : 'NSE',
        status: 'COMPLETE',
        order_timestamp: timeStr,
        source: 'dom-table'
      });
    });
  });
  return out;
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function chargesForOrder(order) {
  // Prefer explicit per-leg charge from contract note only
  if (order.leg_charges != null && Number.isFinite(Number(order.leg_charges))) {
    const leg = Number(order.leg_charges);
    // Guard: a single options fill is almost never > ₹2k in charges
    if (leg >= 0 && leg < 2500) return leg;
  }
  const qty = parseInt(order.filled_quantity || order.quantity, 10) || 0;
  const price = parseFloat(order.average_price) || 0;
  if (qty <= 0 || price <= 0) return 0;
  // Guard: premium price for index options is almost never five-digit
  // (strike leaking in as price caused ~₹14L bogus totals)
  const symbol = order.tradingsymbol || order.symbol || '';
  const compact = String(symbol).replace(/\s+/g, '');
  const looksOption = /(CE|PE)$/i.test(compact);
  if (looksOption && price >= 10000) return 0;
  if (qty > 500000) return 0;

  const isSell = String(order.transaction_type || order.action || '').toUpperCase() === 'SELL';
  const exchange = order.exchange || '';
  const isFO = /^(NFO|BFO|MCX|CDS)$/i.test(exchange) || /FO/i.test(exchange) ||
    /-FUT$|-CE$|-PE$/i.test(symbol) || /\d(CE|PE)$/i.test(compact) ||
    /\b(CE|PE|FUT)\b/i.test(symbol) || looksOption;
  const isOption = looksOption || (isFO && /(CE|PE)/i.test(symbol));
  return calculateSingleLegCharges(qty, price, isSell, isFO, isOption).total;
}

/**
 * Session charges the Zerodha way:
 * - Brokerage ₹20 per distinct order_id (NOT per fill — 232 fills was overcounting hard)
 * - STT / exchange / stamp / GST on premium turnover (qty × avg price)
 * Falls back to contract-note total when available.
 */
function estimateSessionCharges(fills) {
  if (!fills || !fills.length) return { total: 0, turnover: 0, sellTurnover: 0, orders: 0 };

  const byOrder = new Map();
  let turnover = 0;
  let sellTurnover = 0;
  let buyTurnover = 0;
  let legSum = 0;
  let legCount = 0;

  fills.forEach(o => {
    const qty = parseInt(o.filled_quantity || o.quantity, 10) || 0;
    const price = parseFloat(o.average_price) || 0;
    if (qty <= 0 || price <= 0) return;
    const compact = String(o.tradingsymbol || o.symbol || '').replace(/\s+/g, '');
    if (/(CE|PE)$/i.test(compact) && price >= 10000) return; // skip strike-as-price junk

    const val = qty * price;
    turnover += val;
    const isSell = String(o.transaction_type || '').toUpperCase() === 'SELL';
    if (isSell) sellTurnover += val;
    else buyTurnover += val;

    const oid = String(o.order_id || o.exchange_order_id || orderIdentity(o));
    if (!byOrder.has(oid)) byOrder.set(oid, o);

    if (o.leg_charges != null && Number.isFinite(Number(o.leg_charges))) {
      const leg = Number(o.leg_charges);
      if (leg >= 0 && leg < 2500) {
        legSum += leg;
        legCount += 1;
      }
    }
  });

  // If contract-note rows gave per-leg charges for most fills, prefer that sum
  if (legCount >= Math.max(3, fills.length * 0.6)) {
    return { total: legSum, turnover, sellTurnover, orders: byOrder.size, method: 'note-legs' };
  }

  const nOrders = Math.max(1, byOrder.size);
  // Detect F&O vs equity from symbols
  const sample = fills.find(o => o.tradingsymbol || o.symbol) || {};
  const sym = String(sample.tradingsymbol || sample.symbol || '');
  const ex = String(sample.exchange || '');
  const isOption = /(CE|PE)$/i.test(sym.replace(/\s+/g, '')) || /(CE|PE)/i.test(sym);
  const isFO = isOption || /^(NFO|BFO|MCX|CDS)$/i.test(ex) || /FUT/i.test(sym);

  let brokerage, stt, exchangeTxn, stamp;
  if (isFO && isOption) {
    brokerage = nOrders * 20; // flat ₹20 / order
    stt = sellTurnover * 0.001; // 0.10% on sell premium
    exchangeTxn = turnover * 0.0003503;
    stamp = buyTurnover * 0.00003;
  } else if (isFO) {
    brokerage = Math.min(nOrders * 20, turnover * 0.0003);
    stt = sellTurnover * 0.0002; // futures STT ~0.02% on sell (approx)
    exchangeTxn = turnover * 0.0000173;
    stamp = buyTurnover * 0.00002;
  } else {
    brokerage = Math.min(nOrders * 20, turnover * 0.0003);
    stt = sellTurnover * 0.00025;
    exchangeTxn = turnover * 0.0000297;
    stamp = buyTurnover * 0.00003;
  }
  const sebi = turnover * 0.000001;
  const gst = 0.18 * (brokerage + exchangeTxn + sebi);
  const total = brokerage + stt + exchangeTxn + gst + sebi + stamp;

  return {
    total,
    turnover,
    sellTurnover,
    orders: nOrders,
    method: 'session-est',
    breakdown: { brokerage, stt, exchangeTxn, gst, sebi, stamp }
  };
}

function isChargesSane(total, fills, turnover) {
  const n = (fills && fills.length) || 0;
  if (!Number.isFinite(total) || total < 0) return false;
  // Hard ceiling for retail intraday unless from virtual contract note
  if (total > 75000) return false;
  if (n > 0 && total / n > 400) return false;
  if (turnover > 0 && total > turnover * 0.05) return false; // charges ≫ 5% of premium = wrong
  return true;
}

function sessionDayBounds() {
  const open = new Date();
  open.setHours(9, 0, 0, 0);
  const close = new Date();
  close.setHours(16, 0, 0, 0);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date();
  dayEnd.setHours(23, 59, 59, 999);
  return {
    openMs: open.getTime(),
    closeMs: close.getTime(),
    dayStartMs: dayStart.getTime(),
    dayEndMs: dayEnd.getTime()
  };
}

/** True if ms falls on today's calendar day (IST local). */
function isTodaySessionTs(ms) {
  if (!Number.isFinite(ms)) return false;
  const { dayStartMs, dayEndMs } = sessionDayBounds();
  return ms >= dayStartMs && ms <= dayEndMs;
}

/**
 * Parse fill time WITHOUT remapping other days onto today.
 * Clock-only strings (HH:MM) → today. Dated stamps from other days → null.
 */
function parseOrderFillMs(order) {
  const raw = order?.fill_timestamp || order?.exchange_update_timestamp ||
    order?.exchange_timestamp || order?.order_timestamp || order?.filled_timestamp ||
    order?.update_timestamp || order?.trade_timestamp || null;
  if (raw == null || raw === '') return null;

  const { dayStartMs, dayEndMs } = sessionDayBounds();

  if (typeof raw === 'number') {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return isTodaySessionTs(ms) ? ms : null;
  }

  const s = String(raw).trim();

  // Clock-only → assume today (Kite sometimes omits date on same-day trades)
  const clock = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const d = new Date();
    d.setHours(parseInt(clock[1], 10), parseInt(clock[2], 10), parseInt(clock[3] || '0', 10), 0);
    const ms = d.getTime();
    return isTodaySessionTs(ms) ? ms : null;
  }

  const kite = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (kite) {
    const ms = new Date(
      parseInt(kite[1], 10), parseInt(kite[2], 10) - 1, parseInt(kite[3], 10),
      parseInt(kite[4], 10), parseInt(kite[5], 10), parseInt(kite[6] || '0', 10)
    ).getTime();
    return isTodaySessionTs(ms) ? ms : null;
  }

  const t = Date.parse(s.replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  return isTodaySessionTs(t) ? t : null;
}

function isTodaySessionFill(order) {
  const raw = order?.fill_timestamp || order?.exchange_update_timestamp ||
    order?.exchange_timestamp || order?.order_timestamp || order?.filled_timestamp ||
    order?.update_timestamp || order?.trade_timestamp || null;
  // Day OMS book sometimes omits stamp — treat as today
  if (raw == null || raw === '') return true;
  return parseOrderFillMs(order) != null;
}

function orderFillTimestamp(order) {
  const parsed = parseOrderFillMs(order);
  if (parsed != null) return parsed;
  // Unknown / not today — callers that need a number get "now", but upserts must use isTodaySessionFill
  return Date.now();
}

/** Drop yesterday's MTM/fills when the calendar day rolls over. */
let mtmSessionDate = null;
function ensureTodayMtmSession() {
  const todayStr = new Date().toDateString();
  if (mtmSessionDate === todayStr) return false;
  const rolled = mtmSessionDate != null && mtmSessionDate !== todayStr;
  if (rolled) {
    if (DEBUG) console.log('[KitePlus] New trading day — clearing previous MTM session', mtmSessionDate, '→', todayStr);
    mtmHistory = [];
    todayOrders = [];
    knownOrderIds = new Set();
    totalExecutedCharges = 0;
    chargesSource = 'est';
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({
        mtmHistory: [],
        kpTodayOrders: null,
        totalExecutedCharges: 0,
        executedChargesDate: todayStr,
        chargesSource: 'est'
      });
    }
  }
  mtmSessionDate = todayStr;
  return rolled;
}

function kiteApiHeaders() {
  const headers = { 'X-Kite-Version': '3' };
  const token = getSessionToken();
  if (token) headers.Authorization = `enctoken ${token}`;
  return headers;
}

function normalizeOrderList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // Some OMS payloads nest day/net or variety buckets
  if (typeof data === 'object') {
    const out = [];
    Object.values(data).forEach(v => {
      if (Array.isArray(v)) out.push(...v);
      else if (v && typeof v === 'object') {
        Object.values(v).forEach(x => { if (Array.isArray(x)) out.push(...x); });
      }
    });
    return out;
  }
  return [];
}

function isFilledOrder(o) {
  const status = String(o.status || '').toUpperCase();
  const filled = parseInt(o.filled_quantity || o.quantity, 10) || 0;
  const avg = parseFloat(o.average_price) || 0;
  if (filled > 0 && avg > 0 && (status === 'COMPLETE' || status === 'EXECUTED' || status === 'UPDATE')) return true;
  return status === 'COMPLETE' || status === 'EXECUTED';
}

async function fetchOmsJson(path) {
  const response = await fetch(path, { headers: kiteApiHeaders(), credentials: 'include' });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  const json = await response.json();
  if (!json || json.status !== 'success') return [];
  return normalizeOrderList(json.data);
}

/** Prefer /oms/trades (actual fills + timestamps), then complete /oms/orders. */
async function fetchCompleteOrders() {
  const isMock = window.location.href.includes('mock-kite.html') ||
    document.getElementById('mock-kite-dashboard') !== null;
  if (isMock) {
    return (window.mockState?.orders || [])
      .filter(o => o.status === 'EXECUTED')
      .map((o, i) => ({
        order_id: `mock-${i}-${o.time}`,
        tradingsymbol: o.symbol,
        transaction_type: o.action,
        quantity: o.qty,
        filled_quantity: o.qty,
        average_price: o.price,
        exchange: /CE|PE|NIFTY|BANK/i.test(o.symbol || '') ? 'NFO' : 'NSE',
        status: 'COMPLETE',
        order_timestamp: o.time,
        fill_timestamp: o.time,
        source: 'mock'
      }));
  }

  let trades = [];
  try {
    trades = await fetchOmsJson('/oms/trades');
  } catch (err) {
    if (DEBUG) console.warn('[KitePlus] /oms/trades failed:', err.message || err);
  }
  if (trades.length) {
    return trades.map((t, i) => ({
      ...t,
      // Keep real order_id for brokerage-per-order; trade_id stays unique per fill
      trade_id: String(t.trade_id || `trade-${i}`),
      order_id: String(t.order_id || t.trade_id || `trade-${i}`),
      filled_quantity: parseInt(t.quantity || t.filled_quantity, 10) || 0,
      average_price: parseFloat(t.average_price != null ? t.average_price : t.price) || 0,
      fill_timestamp: t.fill_timestamp || t.exchange_timestamp || t.order_timestamp,
      source: 'trades-api'
    })).filter(o => {
      if (o.filled_quantity <= 0 || o.average_price <= 0) return false;
      const opt = /(CE|PE)$/i.test(String(o.tradingsymbol || '').replace(/\s+/g, ''));
      if (opt && o.average_price >= 10000) return false; // strike leaked as price
      return true;
    });
  }

  let orders = [];
  try {
    orders = await fetchOmsJson('/oms/orders');
  } catch (err) {
    if (DEBUG) console.warn('[KitePlus] /oms/orders failed:', err.message || err);
  }
  return orders.filter(isFilledOrder).map(o => ({ ...o, source: 'orders-api' }));
}

function orderIdentity(order) {
  return String(
    order.trade_id ||
    order.order_id ||
    order.exchange_order_id ||
    `${orderFillTimestamp(order)}-${order.transaction_type}-${order.tradingsymbol}-${order.filled_quantity || order.quantity}-${order.average_price}`
  );
}

function getLiveMtmSeries() {
  ensureTodayMtmSession();
  const nowPnl = Number.isFinite(cachedNetPnL) ? cachedNetPnL : 0;
  const { dayStartMs, dayEndMs } = sessionDayBounds();
  return mtmHistory
    .filter(pt => {
      if (!pt || pt.source === 'order') return false;
      if (!Number.isFinite(pt.timestamp) || !Number.isFinite(pt.val)) return false;
      // Strictly today's calendar day only
      if (pt.timestamp < dayStartMs || pt.timestamp > dayEndMs) return false;
      // Drop poisoned samples from the bad-charges era (vals tens of lakhs off)
      if (Math.abs(pt.val) > 200000) return false;
      if (nowPnl !== 0 && Math.abs(pt.val - nowPnl) > 100000) return false;
      return true;
    })
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Compact symbol key for FIFO matching */
function mtmSymKey(sym) {
  return String(sym || '').replace(/\s+/g, '').toUpperCase();
}

/**
 * Rebuild session Gross MTM from fills (FIFO realized) + shift so the
 * curve ends at live Kite Total P&L. Fixes empty chart when Positions
 * was only open for a few minutes but fills span 09:15→15:30.
 */
function buildRealizedMtmFromFills(fills) {
  const positions = new Map();
  const points = [];
  let realized = 0;

  const sorted = (fills || [])
    .slice()
    .filter(o => {
      const px = parseFloat(o.average_price) || 0;
      const qty = parseInt(o.filled_quantity || o.quantity, 10) || 0;
      const compact = mtmSymKey(o.tradingsymbol || o.symbol);
      if (qty <= 0 || px <= 0) return false;
      if (/(CE|PE)$/i.test(compact) && px >= 10000) return false;
      return true;
    })
    .sort((a, b) => orderFillTimestamp(a) - orderFillTimestamp(b));

  if (!sorted.length) return { points: [], realized: 0 };

  const firstTs = orderFillTimestamp(sorted[0]);
  points.push({
    timestamp: firstTs - 1000,
    time: formatClock(firstTs - 1000),
    val: 0,
    netVal: 0 - totalExecutedCharges,
    source: 'recon',
    charges: totalExecutedCharges
  });

  sorted.forEach(o => {
    const sym = mtmSymKey(o.tradingsymbol || o.symbol);
    const qty = parseInt(o.filled_quantity || o.quantity, 10) || 0;
    const price = parseFloat(o.average_price) || 0;
    const side = String(o.transaction_type || o.action || '').toUpperCase();
    let pos = positions.get(sym) || { qty: 0, avg: 0 };

    if (side === 'BUY') {
      if (pos.qty < 0) {
        const cover = Math.min(qty, -pos.qty);
        realized += (pos.avg - price) * cover;
        pos.qty += cover;
        const rem = qty - cover;
        if (rem > 0) {
          pos.qty = rem;
          pos.avg = price;
        } else if (pos.qty === 0) {
          pos.avg = 0;
        }
      } else {
        const newQty = pos.qty + qty;
        pos.avg = newQty ? ((pos.avg * pos.qty) + (price * qty)) / newQty : price;
        pos.qty = newQty;
      }
    } else if (side === 'SELL') {
      if (pos.qty > 0) {
        const closeQty = Math.min(qty, pos.qty);
        realized += (price - pos.avg) * closeQty;
        pos.qty -= closeQty;
        const rem = qty - closeQty;
        if (rem > 0) {
          pos.qty = -rem;
          pos.avg = price;
        } else if (pos.qty === 0) {
          pos.avg = 0;
        }
      } else {
        const absOld = Math.abs(pos.qty);
        const absNew = absOld + qty;
        pos.avg = absNew ? ((pos.avg * absOld) + (price * qty)) / absNew : price;
        pos.qty -= qty;
      }
    } else {
      return;
    }
    positions.set(sym, pos);

    const ts = orderFillTimestamp(o);
    const last = points[points.length - 1];
    if (!last || (ts - last.timestamp > 2500) || Math.abs(realized - last.val) >= 0.5) {
      points.push({
        timestamp: ts,
        time: formatClock(ts),
        val: realized,
        netVal: realized - totalExecutedCharges,
        source: 'recon',
        charges: totalExecutedCharges
      });
    } else {
      last.val = realized;
      last.netVal = realized - totalExecutedCharges;
      last.timestamp = ts;
      last.time = formatClock(ts);
    }
  });

  return { points, realized };
}

/** Series used to draw the chart — today's session only (no previous-day leakage). */
function getChartMtmSeries() {
  ensureTodayMtmSession();
  const { dayStartMs, dayEndMs } = sessionDayBounds();
  const liveNow = getNetPnL();
  const live = getLiveMtmSeries();
  const fills = todayOrders.filter(o =>
    isTodaySessionFill(o) &&
    (o.source === 'trades-api' || o.source === 'orders-api' ||
      o.source === 'contract-note' || o.source === 'mock')
  );

  const { points: recon, realized } = buildRealizedMtmFromFills(fills);
  const unrealized = liveNow - realized; // approx open-position MTM

  let series = recon.map(pt => ({
    ...pt,
    val: pt.val + unrealized,
    netVal: pt.val + unrealized - totalExecutedCharges
  }));

  // Prefer real live samples only when they cover a meaningful window and aren't poisoned
  if (live.length >= 2) {
    const liveSpan = live[live.length - 1].timestamp - live[0].timestamp;
    const liveMin = Math.min(...live.map(p => p.val));
    const liveMax = Math.max(...live.map(p => p.val));
    const sparse = liveSpan < 20 * 60 * 1000 && fills.length >= 15; // <20m of samples vs busy day
    const poisoned = (liveNow >= 0 && liveMin < liveNow - 3000) || (liveMax - liveMin > 50000);
    if (!sparse && !poisoned) {
      const liveStart = live[0].timestamp;
      const head = series.filter(pt => pt.timestamp < liveStart - 2000);
      if (head.length) {
        const joinGap = live[0].val - head[head.length - 1].val;
        head.forEach(pt => {
          pt.val += joinGap;
          pt.netVal = pt.val - totalExecutedCharges;
        });
      }
      series = head.concat(live.map(pt => ({
        ...pt,
        netVal: pt.val - totalExecutedCharges,
        source: pt.source || 'live'
      })));
    }
  }

  // Always pin the latest point to live Gross MTM
  const now = Date.now();
  if (!series.length) {
    series = [
      {
        timestamp: now - 60000,
        time: formatClock(now - 60000),
        val: liveNow,
        netVal: liveNow - totalExecutedCharges,
        source: 'live',
        charges: totalExecutedCharges
      },
      {
        timestamp: now,
        time: formatClock(now),
        val: liveNow,
        netVal: liveNow - totalExecutedCharges,
        source: 'live',
        charges: totalExecutedCharges
      }
    ];
  } else {
    const last = series[series.length - 1];
    if (now - last.timestamp > 1500) {
      series.push({
        timestamp: now,
        time: formatClock(now),
        val: liveNow,
        netVal: liveNow - totalExecutedCharges,
        source: 'live',
        charges: totalExecutedCharges
      });
    } else {
      last.val = liveNow;
      last.netVal = liveNow - totalExecutedCharges;
      last.timestamp = now;
      last.time = formatClock(now);
    }
  }

  series = series
    .filter(pt => Number.isFinite(pt.timestamp) && pt.timestamp >= dayStartMs && pt.timestamp <= dayEndMs)
    .sort((a, b) => a.timestamp - b.timestamp);
  return series;
}

function getMtmTimeBounds(live) {
  const { openMs, closeMs, dayStartMs, dayEndMs } = sessionDayBounds();
  const orderTs = todayOrders
    .filter(isTodaySessionFill)
    .map(o => parseOrderFillMs(o))
    .filter(t => t != null && t >= dayStartMs && t <= dayEndMs);
  const liveTs = (live || []).map(p => p.timestamp)
    .filter(t => Number.isFinite(t) && t >= dayStartMs && t <= dayEndMs);
  const all = [...orderTs, ...liveTs];
  const now = Math.min(Date.now(), dayEndMs);
  if (!all.length) {
    return { t0: openMs + 15 * 60000, t1: Math.max(now, openMs + 16 * 60000) };
  }
  let t0 = Math.min(...all);
  let t1 = Math.max(...all, now);
  // Clamp axis to today's market session (never spill into another day)
  t0 = Math.max(t0, openMs);
  t1 = Math.min(Math.max(t1, t0 + 60000), Math.min(closeMs + 1800000, dayEndMs));
  const pad = Math.max(60_000, (t1 - t0) * 0.02);
  return { t0: Math.max(openMs, t0 - pad), t1: Math.min(dayEndMs, t1 + pad) };
}

function netAtTimestamp(ts, live) {
  return interpolateGrossAt(ts, live) - totalExecutedCharges;
}

function interpolateGrossAt(ts, live) {
  const series = live && live.length ? live : getLiveMtmSeries();
  if (!series.length) return getNetPnL();
  if (ts <= series[0].timestamp) return series[0].val;
  const last = series[series.length - 1];
  if (ts >= last.timestamp) return last.val;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1];
    const b = series[i];
    if (ts >= a.timestamp && ts <= b.timestamp) {
      const span = Math.max(1, b.timestamp - a.timestamp);
      const r = (ts - a.timestamp) / span;
      return a.val + (b.val - a.val) * r;
    }
  }
  return last.val;
}

/** Keep fills in todayOrders only — never inject fake P&L points into the live curve. */
function syncOrderFills(list) {
  ensureTodayMtmSession();
  upsertTodayOrders(list);
  knownOrderIds = new Set(todayOrders.map(orderIdentity));
  if (typeof chrome !== 'undefined' && chrome.storage) {
    const todayStr = new Date().toDateString();
    chrome.storage.local.set({
      kpTodayOrders: {
        date: todayStr,
        orders: todayOrders.slice(-800)
      }
    });
  }
  if (DEBUG && todayOrders.length) {
    const a = formatClock(orderFillTimestamp(todayOrders[0]));
    const b = formatClock(orderFillTimestamp(todayOrders[todayOrders.length - 1]));
    console.log(`[KitePlus] Session fills (today only): ${todayOrders.length} · ${a} → ${b}`);
  }
  try { drawMtmChart(); } catch (e) {}
}

function upsertTodayOrders(list) {
  ensureTodayMtmSession();
  if (!list || !list.length) {
    // Still prune any stale fills already in memory
    todayOrders = todayOrders.filter(isTodaySessionFill)
      .sort((a, b) => orderFillTimestamp(a) - orderFillTimestamp(b));
    return;
  }
  const byId = new Map();
  todayOrders.filter(isTodaySessionFill).forEach(o => byId.set(orderIdentity(o), o));
  list.filter(isTodaySessionFill).forEach(o => byId.set(orderIdentity(o), o));
  todayOrders = Array.from(byId.values()).sort((a, b) => orderFillTimestamp(a) - orderFillTimestamp(b));
}

async function updateExecutedCharges() {
  // 1) Contract note — authoritative Total Charges when modal is open
  const note = scrapeContractNoteFromDOM();
  if (note.ok && note.total > 0) {
    // already saved inside scrape; still merge trade times
    if (note.trades && note.trades.length) syncOrderFills(note.trades);
  } else if (note.trades && note.trades.length) {
    syncOrderFills(note.trades);
  }

  // 2) DOM table — markers only (never for charge math; it was polluting totals)
  const domOrders = scrapeOrdersTableFromDOM();
  if (domOrders.length) syncOrderFills(domOrders);

  // 3) OMS trades/orders
  const now = Date.now();
  if (now - lastApiOrdersFetch < 3000) {
    updateChartHeaderMetrics();
    return;
  }
  lastApiOrdersFetch = now;
  try {
    const complete = await fetchCompleteOrders();
    if (complete.length) {
      syncOrderFills(complete);
    }

    // Charge basis: API fills + contract-note rows only (ignore DOM junk)
    const chargeFills = todayOrders.filter(o =>
      o.source === 'trades-api' || o.source === 'orders-api' ||
      o.source === 'contract-note' || o.source === 'mock'
    );
    const est = estimateSessionCharges(chargeFills.length ? chargeFills : complete);

    if (chargesSource === 'contract' && totalExecutedCharges > 0) {
      // keep note total
    } else if (isChargesSane(est.total, chargeFills, est.turnover)) {
      saveExecutedCharges(est.total, est.method === 'note-legs' ? 'note-legs' : 'est');
    } else {
      // Refuse to poison Net MTM — fall back to brokerage floor only
      const nOrders = Math.max(est.orders || 0, 1);
      const safe = Math.min(nOrders * 20 * 1.5, 25000); // rough brokerage+gst floor
      saveExecutedCharges(safe, 'safe');
      if (DEBUG) {
        console.warn('[KitePlus] Rejected insane charges', est.total, '→ safe', safe, est);
      }
    }

    if (DEBUG) {
      console.log('[KitePlus] Fills:', todayOrders.length, 'chargeFills:', chargeFills.length,
        'orders:', est.orders, 'turnover:', Math.round(est.turnover),
        'charges:', Math.round(totalExecutedCharges), 'src:', chargesSource, est.breakdown || '');
    }
  } catch (err) {
    if (DEBUG) console.error('[KitePlus] Orders fetch failed:', err);
  }
}

function updateChartHeaderMetrics() {
  const margin = getAvailableMargin();
  const used = getUsedMargin();
  const pnl = getNetPnL();
  const totalCapital = (margin + used) > 0 ? (margin + used) : 500000.00;
  const netPnl = pnl - totalExecutedCharges;
  const netPnlPercent = (netPnl / totalCapital) * 100;
  const pnlClass = pnl >= 0 ? 'profit' : 'loss';
  const pnlSign = pnl >= 0 ? '+' : '-';
  const netPnlClass = netPnl >= 0 ? 'profit' : 'loss';
  const netPnlSign = netPnl >= 0 ? '+' : '-';
  const srcTag = chargesSource === 'contract' ? 'note'
    : chargesSource === 'note-legs' ? 'note'
      : chargesSource === 'safe' ? 'approx'
        : chargesSource === 'est' ? 'est'
          : chargesSource === 'trades' ? 'est' : chargesSource;
  const fillCount = todayOrders.length;
  const pnlEl = document.getElementById('kp-chart-pnl');
  if (pnlEl) {
    pnlEl.innerHTML = `
      <span style="margin-right: 8px;">Gross MTM: <span class="${pnlClass}">${pnlSign}₹${formatCurrency(Math.abs(pnl))}</span></span>
      <span style="margin-right: 8px;">Net MTM: <span class="${netPnlClass}">${netPnlSign}₹${formatCurrency(Math.abs(netPnl))} (${netPnlSign}${Math.abs(netPnlPercent).toFixed(2)}%)</span></span>
      <span style="color:#64748b; font-size:10.5px;">Charges: ₹${formatCurrency(totalExecutedCharges)} <span style="opacity:.7">(${srcTag} · ${fillCount} fills)</span></span>
    `;
    pnlEl.className = '';
  }
}

// Real-time Dynamic updates loop
function updateDynamicValues() {
  if (IS_KITE) {
    updateExecutedCharges();
    updateChartHeaderMetrics();
  }
  
  if (IS_KITE && settings.grouping) {
    const table = document.querySelector('.positions table, .positions-container table');
    if (table) {
      updatePositionsGroupingValues(table);
    }
  }
  
  // Track and render MTM chart
  const isPositionsPage = window.location.pathname.includes('/positions') || 
                          window.location.href.includes('mock-kite.html') ||
                          document.getElementById('mock-kite-dashboard') !== null;
  if (IS_KITE && isPositionsPage) {
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
  } else if (symbol.includes('SENSEX')) {
    spotPrice = 77000;
    strikeGap = 100;
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
  } else if (symbol.includes('SENSEX')) {
    spotPrice = 77000;
    strikeGap = 100;
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
      stt = isSell ? (txnVal * 0.001) : 0; // 0.10% on option sell premium
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
  const isFO = symbol.includes('-FUT') || symbol.includes('-CE') || symbol.includes('-PE') || symbol.includes('NIFTY') || symbol.includes('BANKNIFTY') || symbol.includes('SENSEX') || symbol.includes('FINNIFTY');
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
  let qty = 75; // Nifty lot
  if (symbol.includes('BANKNIFTY')) qty = 15;
  else if (symbol.includes('FINNIFTY')) qty = 40;
  else if (symbol.includes('SENSEX')) qty = 10;
  else if (!symbol.includes('NIFTY')) qty = 1;
  
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
let marginApiDisabledUntil = 0;
let marginApiFailCount = 0;

async function updateMarginsFromAPI() {
  // Only on real Kite — never Upstox/Dhan/mock, and never hammer a dead endpoint.
  if (!IS_KITE) return;
  if (window.location.href.includes('mock-kite.html') || document.getElementById('mock-kite-dashboard') !== null) {
    return;
  }
  if (Date.now() < marginApiDisabledUntil) return;

  const now = Date.now();
  if (now - lastApiMarginFetch < 15000) {
    return; // Rate limit: at most once every 15 seconds
  }

  try {
    const headers = { 'X-Kite-Version': '3' };
    const token = getSessionToken();
    if (token) {
      headers['Authorization'] = `enctoken ${token}`;
    }

    // Correct Kite web OMS path (NOT /oms/funds — that 404s and spammed Network).
    const response = await fetch('/oms/user/margins', {
      headers,
      credentials: 'include'
    });

    if (response.status === 404 || response.status === 401 || response.status === 403) {
      marginApiFailCount += 1;
      // Back off hard so we don't pollute DevTools every few seconds
      marginApiDisabledUntil = Date.now() + Math.min(30 * 60 * 1000, 60 * 1000 * marginApiFailCount);
      lastApiMarginFetch = now;
      if (DEBUG) {
        console.log(`[KitePlus] Margins API ${response.status} — paused ${Math.round((marginApiDisabledUntil - now) / 1000)}s`);
      }
      return;
    }

    if (!response.ok) {
      lastApiMarginFetch = now;
      return;
    }

    const json = await response.json();
    if (json && json.status === 'success' && json.data) {
      const equity = json.data.equity || json.data;
      if (equity) {
        const avail = parseFloat(equity.net) ||
          (equity.available ? parseFloat(equity.available.live_balance || equity.available.cash) : NaN);
        const used = parseFloat(equity.utilised?.debits) ||
          parseFloat(equity.utilised?.span) || 0;

        if (!isNaN(avail) && avail > 10) {
          currentMargin = avail;
          usedMargin = isNaN(used) ? 0 : used;
          lastApiMarginFetch = now;
          marginApiFailCount = 0;
          marginApiDisabledUntil = 0;

          if (DEBUG) console.log(`[KitePlus] API Margins: Available=${currentMargin}, Used=${usedMargin}`);

          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ cachedMargin: currentMargin, cachedUsedMargin: usedMargin });
          }
        }
      }
    }
  } catch (err) {
    lastApiMarginFetch = now;
    if (DEBUG) console.error(`[KitePlus] Error fetching margins:`, err);
  }
}

// Load history from storage on init
async function loadMtmHistory() {
  try {
    ensureTodayMtmSession();
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get(['mtmHistory', 'kpTodayOrders']);
      const todayStr = new Date().toDateString();
      const { dayStartMs, dayEndMs } = sessionDayBounds();
      if (res.mtmHistory) {
        // Live samples only — today's calendar day, strip old/fake points
        mtmHistory = res.mtmHistory.filter(pt => {
          if (!pt || pt.source === 'order') return false;
          if (!Number.isFinite(pt.timestamp)) return false;
          if (pt.timestamp < dayStartMs || pt.timestamp > dayEndMs) return false;
          return new Date(pt.timestamp).toDateString() === todayStr;
        });
        mtmHistory.forEach(pt => {
          if (Number.isFinite(pt.val)) {
            pt.netVal = pt.val - totalExecutedCharges;
            if (pt.charges == null) pt.charges = totalExecutedCharges;
          }
        });
        mtmHistory.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        // Persist pruned list so yesterday never reloads
        chrome.storage.local.set({ mtmHistory });
      }
      if (res.kpTodayOrders && res.kpTodayOrders.date === todayStr && Array.isArray(res.kpTodayOrders.orders)) {
        todayOrders = res.kpTodayOrders.orders.filter(isTodaySessionFill);
        knownOrderIds = new Set(todayOrders.map(orderIdentity));
        chrome.storage.local.set({
          kpTodayOrders: { date: todayStr, orders: todayOrders.slice(-800) }
        });
      } else {
        todayOrders = [];
        knownOrderIds = new Set();
      }
    }
  } catch (err) {
    console.error('Error loading MTM history:', err);
  }
}

// Record current MTM data point (live P&L only — fills stay in todayOrders)
function recordMtmDataPoint() {
  ensureTodayMtmSession();
  const pnl = getNetPnL();
  const live = getLiveMtmSeries();
  if (pnl === 0 && live.length === 0 && todayOrders.length === 0) return;

  const timestamp = Date.now();
  // Keep mtmHistory as live-only + today-only
  const { dayStartMs, dayEndMs } = sessionDayBounds();
  mtmHistory = mtmHistory.filter(pt =>
    pt && pt.source !== 'order' &&
    Number.isFinite(pt.timestamp) &&
    pt.timestamp >= dayStartMs && pt.timestamp <= dayEndMs
  );
  const lastPoint = mtmHistory[mtmHistory.length - 1];
  if (lastPoint && (timestamp - lastPoint.timestamp < 2000)) {
    lastPoint.val = pnl;
    lastPoint.netVal = pnl - totalExecutedCharges;
    lastPoint.charges = totalExecutedCharges;
    lastPoint.time = formatClock(timestamp);
    lastPoint.timestamp = timestamp;
    return;
  }

  mtmHistory.push({
    time: formatClock(timestamp),
    val: pnl,
    netVal: pnl - totalExecutedCharges,
    charges: totalExecutedCharges,
    timestamp,
    source: 'live'
  });

  if (mtmHistory.length > 8000) mtmHistory = mtmHistory.slice(-8000);
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ mtmHistory });
  }
}

// Collapsible MTM Chart state
let hoveredIdx = null; // index into MTM series

function handleCanvasMouseMove(e) {
  const canvas = document.getElementById('kp-mtm-canvas');
  const series = getChartMtmSeries();
  if (!canvas || series.length < 1) return;

  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const chartPadding = { top: 20, right: 80, bottom: 30, left: 60 };
  const graphWidth = rect.width - chartPadding.left - chartPadding.right;
  const graphX = mouseX - chartPadding.left;
  let ratio = graphX / graphWidth;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;

  const { t0, t1 } = getMtmTimeBounds(series);
  const span = Math.max(1, t1 - t0);
  const targetT = t0 + ratio * span;

  let bestLive = null;
  let bestLiveDist = Infinity;
  for (let i = 0; i < series.length; i++) {
    const d = Math.abs(series[i].timestamp - targetT);
    if (d < bestLiveDist) { bestLiveDist = d; bestLive = i; }
  }

  if (bestLive !== hoveredIdx) {
    hoveredIdx = bestLive;
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
          <span class="kp-chart-title">Today's MTM Chart</span>
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
          knownOrderIds = new Set();
          todayOrders = [];
          hoveredIdx = null;
          if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ mtmHistory: [], kpTodayOrders: null });
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

  const series = getChartMtmSeries();
  series.forEach(pt => {
    if (Number.isFinite(pt.val)) pt.netVal = pt.val - totalExecutedCharges;
  });

  if (series.length < 2 && todayOrders.length === 0) {
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for fills / live MTM…', width / 2, height / 2);
    return;
  }

  const currentGross = series.length ? series[series.length - 1].val : getNetPnL();
  const currentNet = currentGross - totalExecutedCharges;

  // Chart plots GROSS MTM across the full session (recon from fills + live)
  let vals = series.map(pt => pt.val);
  if (!vals.length) vals = [currentGross, 0];
  let maxVal = Math.max(...vals, 0);
  let minVal = Math.min(...vals, 0);

  const range = maxVal - minVal;
  const padding = range === 0 ? Math.max(100, Math.abs(currentGross) * 0.25 || 100) : range * 0.15;
  maxVal += padding;
  minVal -= padding;

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

  const chartPadding = { top: 20, right: 80, bottom: 30, left: 60 };
  const graphWidth = width - chartPadding.left - chartPadding.right;
  const graphHeight = height - chartPadding.top - chartPadding.bottom;
  const { t0, t1 } = getMtmTimeBounds(series);
  const tSpan = Math.max(1, t1 - t0);
  const xOf = (ts) => chartPadding.left + ((ts - t0) / tSpan) * graphWidth;
  const yOf = (val) => chartPadding.top + ((maxVal - val) / (maxVal - minVal || 1)) * graphHeight;

  // Y grid
  const yLabelCount = 5;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
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
    ctx.textAlign = 'left';
    ctx.fillText(`${yVal >= 0 ? '+' : ''}₹${formatCurrency(yVal)}`, width - chartPadding.right + 8, yPos);
    ctx.textAlign = 'right';
    const yPercent = (yVal / totalCapital) * 100;
    ctx.fillText(`${yPercent >= 0 ? '+' : ''}${yPercent.toFixed(2)}%`, chartPadding.left - 8, yPos);
  }

  // Zero line
  if (minVal < 0 && maxVal > 0) {
    const zeroY = yOf(0);
    ctx.beginPath();
    ctx.strokeStyle = isDark ? 'rgba(239, 68, 68, 0.5)' : 'rgba(223, 81, 76, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(chartPadding.left, zeroY);
    ctx.lineTo(width - chartPadding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // X labels across today's session
  ctx.fillStyle = labelColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xLabelCount = 6;
  for (let i = 0; i < xLabelCount; i++) {
    const ts = t0 + (i / (xLabelCount - 1)) * tSpan;
    const xPos = xOf(ts);
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.moveTo(xPos, height - chartPadding.bottom);
    ctx.lineTo(xPos, height - chartPadding.bottom + 4);
    ctx.stroke();
    ctx.fillText(formatClock(ts).substring(0, 5), xPos, height - chartPadding.bottom + 8);
  }

  const color = currentGross >= 0 ? '#10b981' : '#ef4444';
  const points = series.map(pt => ({
    x: xOf(pt.timestamp),
    y: yOf(pt.val),
    pt
  }));

  if (points.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    const grad = ctx.createLinearGradient(0, chartPadding.top, 0, height - chartPadding.bottom);
    grad.addColorStop(0, currentGross >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)');
    grad.addColorStop(1, currentGross >= 0 ? 'rgba(16, 185, 129, 0)' : 'rgba(239, 68, 68, 0)');
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
  } else if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // Tooltip — MTM curve only (no order markers)
  let tipX = null;
  let tipY = null;
  let tooltipText = '';
  let tipNet = currentNet;

  if (hoveredIdx != null && series[hoveredIdx]) {
    const dataPt = series[hoveredIdx];
    tipX = xOf(dataPt.timestamp);
    tipY = yOf(dataPt.val);
    const netVal = dataPt.val - totalExecutedCharges;
    tipNet = netVal;
    const grossSign = dataPt.val >= 0 ? '+' : '-';
    const netSign = netVal >= 0 ? '+' : '-';
    tooltipText = `${dataPt.time || formatClock(dataPt.timestamp)}  Gross ${grossSign}₹${formatCurrency(Math.abs(dataPt.val))}  Net ${netSign}₹${formatCurrency(Math.abs(netVal))}  Chg ₹${formatCurrency(totalExecutedCharges)}`;
  }

  if (tipX != null && tooltipText) {
    ctx.beginPath();
    ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(tipX, chartPadding.top);
    ctx.lineTo(tipX, height - chartPadding.bottom);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(tipX, tipY, 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
    const textWidth = ctx.measureText(tooltipText).width;
    const tooltipPadding = { x: 8, y: 6 };
    const boxWidth = Math.min(textWidth + tooltipPadding.x * 2, graphWidth);
    const boxHeight = 22;
    let boxX = tipX - boxWidth / 2;
    if (boxX < chartPadding.left) boxX = chartPadding.left;
    if (boxX + boxWidth > width - chartPadding.right) boxX = width - chartPadding.right - boxWidth;
    const boxY = Math.max(chartPadding.top, tipY - boxHeight - 10);

    ctx.fillStyle = '#111827';
    ctx.strokeStyle = isDark ? '#374151' : '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tipNet >= 0 ? '#10b981' : '#ef4444';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tooltipText, boxX + tooltipPadding.x, boxY + boxHeight / 2);
  }
}

// Export history dataset as CSV
function exportChartCSV() {
  if (mtmHistory.length === 0 && todayOrders.length === 0) {
    alert("No chart data to export.");
    return;
  }

  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    'Timestamp,Time,Gross_MTM,Net_MTM,Charges,Source,OrderLabel,OrderQty,OrderPrice,OrderCharges'
  ];
  getChartMtmSeries().forEach(pt => {
    const netVal = pt.val - totalExecutedCharges;
    rows.push([
      pt.timestamp,
      pt.time || formatClock(pt.timestamp),
      pt.val,
      netVal,
      totalExecutedCharges,
      pt.source || 'recon',
      '', '', '', ''
    ].join(','));
  });
  todayOrders.filter(isTodaySessionFill).forEach(o => {
    const ts = orderFillTimestamp(o);
    rows.push([
      ts,
      formatClock(ts),
      '',
      '',
      o.leg_charges != null ? o.leg_charges : '',
      o.source || 'fill',
      esc(`${o.transaction_type || ''} ${o.tradingsymbol || ''}`.trim()),
      o.filled_quantity || o.quantity || '',
      o.average_price != null ? o.average_price : '',
      o.leg_charges != null ? o.leg_charges : ''
    ].join(','));
  });

  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const dateStr = new Date().toISOString().substring(0, 10);
  link.download = `KitePlus_MTM_History_${dateStr}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ==========================================
   MODULE 6: SIGNAL ENGINE — UI & Price Scraper
   Retail buyer signals for Nifty / Sensex (+ options),
   timeframe selector, support/resistance alerts.
   ========================================== */
let signalCandleCollector = null;
let signalHistory = [];
let lastSignalResult = null;
let lastSignalTimestamp = 0;
let signalPanelCollapsed = false;
let signalSectionsCollapsed = {
  guide: true,
  learn: false,
  invest: false,
  tools: true,
  journal: true,
  sr: true,
  indicators: true,
  history: true,
  backtest: true
};
let investorRiskPct = 1;
let investorCapital = 100000;
let tradeJournal = [];
let lastTickScrapeTime = 0;
let signalTimeframeId = '15m';
let signalTradeMode = 'intraday'; // 'scalp' | 'intraday' | 'swing' | 'positional'
let swingTradeState = { direction: 0 }; // persistent state for swing engine
let signalActiveSymbol = null;
let signalInstrument = null;
let srAlerts = []; // { id, price, type: 'support'|'resistance', enabled, lastTriggered }
let lastSrCheckPrice = null;
let lastBacktestReport = null;
let stockHistory = [];
let stockHistoryMeta = null;
let stockHistoryKey = null;
let stockHistoryLoadingKey = null;
let lastEquityResult = null;
let trackedPositions = {};
let lastAnalysisActions = {};
let dhanLtpCache = { symbol: null, ltp: null, fetchedAt: 0, loading: false };
let chartSeedKey = null;
let chartSeedAt = 0;
let chartSeedInFlight = false;

const SIGNAL_TF_MS = {
  '1m': 60 * 1000,
  '2m': 2 * 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '45m': 45 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1D': 24 * 60 * 60 * 1000,
  '1W': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000
};

function isPositionalTf(tfId) {
  return tfId === '1D' || tfId === '1W' || tfId === '1M';
}

async function loadSignalPrefs() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      const res = await chrome.storage.local.get([
        'signalTimeframe', 'signalTradeMode', 'srAlerts', 'lastBacktestReport',
        'trackedPositions', 'lastAnalysisActions', 'signalSectionsCollapsed',
        'signalFocusLayout', 'investorRiskPct', 'investorCapital', 'tradeJournal'
      ]);
      const hadMode = ['scalp', 'intraday', 'swing', 'positional'].includes(res.signalTradeMode);
      const hadTf = !!(res.signalTimeframe && SIGNAL_TF_MS[res.signalTimeframe]);
      if (hadMode) {
        signalTradeMode = res.signalTradeMode;
      }
      if (hadTf) {
        signalTimeframeId = res.signalTimeframe;
      }
      // Upstox charts: default toward positional 1D until the user picks a mode/TF.
      if (ACTIVE_BROKER === 'upstox' && !hadMode) {
        signalTradeMode = 'positional';
        if (!hadTf) signalTimeframeId = '1D';
        chrome.storage.local.set({
          signalTradeMode: 'positional',
          signalTimeframe: signalTimeframeId
        });
      }
      // Stocks Intraday default is 15m — migrate old 2m default only.
      if (signalTradeMode === 'intraday' && signalTimeframeId === '2m') {
        signalTimeframeId = '15m';
        chrome.storage.local.set({ signalTimeframe: '15m' });
      }
      if ((signalTradeMode === 'positional' || signalTradeMode === 'swing') && !isPositionalTf(signalTimeframeId)) {
        signalTimeframeId = '1D';
      }
      if (Array.isArray(res.srAlerts)) {
        srAlerts = res.srAlerts;
      }
      if (res.lastBacktestReport) {
        lastBacktestReport = res.lastBacktestReport;
      }
      if (res.trackedPositions && typeof res.trackedPositions === 'object') {
        trackedPositions = res.trackedPositions;
      }
      if (res.lastAnalysisActions && typeof res.lastAnalysisActions === 'object') {
        lastAnalysisActions = res.lastAnalysisActions;
      }
      if (Number.isFinite(Number(res.investorRiskPct)) && Number(res.investorRiskPct) > 0) {
        investorRiskPct = Math.min(5, Math.max(0.25, Number(res.investorRiskPct)));
      }
      if (Number.isFinite(Number(res.investorCapital)) && Number(res.investorCapital) > 0) {
        investorCapital = Number(res.investorCapital);
      }
      if (Array.isArray(res.tradeJournal)) {
        tradeJournal = res.tradeJournal;
      }
      // One-time focus layout: keep decision + learn/invest open.
      if (res.signalFocusLayout !== 3) {
        signalSectionsCollapsed = {
          guide: true,
          learn: false,
          invest: false,
          tools: true,
          journal: true,
          sr: true,
          indicators: true,
          history: true,
          backtest: true
        };
        chrome.storage.local.set({
          signalFocusLayout: 3,
          signalSectionsCollapsed
        });
      } else if (res.signalSectionsCollapsed && typeof res.signalSectionsCollapsed === 'object') {
        signalSectionsCollapsed = { ...signalSectionsCollapsed, ...res.signalSectionsCollapsed };
      }
    }
  } catch (e) {
    if (DEBUG) console.warn('[KitePlus Signal] prefs load failed', e);
  }
}

function defaultHoldBars() {
  if (signalTradeMode === 'scalp') return 3;
  if (signalTradeMode === 'swing') return 8;
  if (signalTradeMode === 'positional') return 10;
  return 5;
}

function saveBacktestReport(report) {
  lastBacktestReport = report;
  if (typeof chrome !== 'undefined' && chrome.storage) {
    // Trim trades for storage size
    const slim = report ? {
      ...report,
      trades: (report.trades || []).slice(-30)
    } : null;
    chrome.storage.local.set({ lastBacktestReport: slim });
  }
}

function getSignalThresholds() {
  // Swing mode uses its own rating system (0-10 score, score >= 8.0 required for signal)
  if (signalTradeMode === 'swing') {
    const swingDefaults = window.KPSwingEngine?.DEFAULTS || {};
    return {
      strongAt: 85,
      actionableAt: 80,
      leanAt: 65,
      minCandles: 45,
      swingMode: true
    };
  }
  const kind = signalInstrument?.kind;
  const sym = String(signalInstrument?.symbol || signalActiveSymbol || '').replace(/\s+/g, '');
  const looksDeriv = kind === 'option' || kind === 'index' ||
    /\d{4,6}(CE|PE)$/i.test(sym) ||
    /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX)$/i.test(sym);
  const eqProfile = window.KPPositionalEngine?.MODE_PROFILES?.[signalTradeMode]
    || window.KPPositionalEngine?.getModeProfile?.(signalTradeMode);
  // Never use equity 36-candle scalp profile for options/index
  if (!looksDeriv && eqProfile) {
    return {
      strongAt: Math.min(90, (eqProfile.buyAt || 60) + 12),
      actionableAt: eqProfile.buyAt || 60,
      leanAt: Math.max(40, (eqProfile.buyAt || 60) - 12),
      minCandles: eqProfile.minCandles || 50
    };
  }
  if (window.KPSignalEngine?.getModeProfile) {
    const modeId = signalTradeMode === 'positional' ? 'intraday' : signalTradeMode;
    const m = window.KPSignalEngine.getModeProfile(modeId);
    return {
      strongAt: m.strongAt,
      actionableAt: m.actionableAt,
      leanAt: m.leanAt,
      minCandles: m.minCandles
    };
  }
  if (signalTradeMode === 'scalp') {
    return { strongAt: 70, actionableAt: 58, leanAt: 46, minCandles: 6 };
  }
  return { strongAt: 78, actionableAt: 65, leanAt: 52, minCandles: 12 };
}

function setSignalTradeMode(modeId) {
  if (!['scalp', 'intraday', 'swing', 'positional'].includes(modeId)) return;
  signalTradeMode = modeId;
  if (modeId === 'swing') swingTradeState = { direction: 0 };
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ signalTradeMode: modeId });
  }
  const preferred =
    modeId === 'positional' ? '1D'
      : modeId === 'swing' ? '1D'
        : modeId === 'scalp' ? '1m'
          : '15m';
  if (SIGNAL_TF_MS[preferred]) {
    setSignalTimeframe(preferred);
  } else {
    refreshTfButtonStates();
    refreshAnalysisForCurrentTf();
  }
  lastSignalResult = null;
  lastEquityResult = null;
  stockHistoryKey = null;
  document.querySelectorAll('.kp-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === modeId);
  });
  const minEl = document.querySelector('#kp-candle-need');
  if (minEl) minEl.textContent = String(getSignalThresholds().minCandles);
  const thrEl = document.querySelector('#kp-mode-thresholds');
  if (thrEl) {
    const t = getSignalThresholds();
    if (modeId === 'swing') {
      thrEl.textContent = `Swing Pro · Rating ≥${window.KPSwingEngine?.DEFAULTS?.minimumScore || 7.5}/10`;
    } else {
      thrEl.textContent = `Act only if Strong ≥${t.strongAt}% · Buy ≥${t.actionableAt}%`;
    }
  }
  const holdInput = document.querySelector('#kp-bt-hold');
  if (holdInput && !holdInput.dataset.userEdited) {
    holdInput.value = String(defaultHoldBars());
  }
}

function saveSrAlerts() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ srAlerts });
  }
}

function initSignalEngine() {
  if (!window.KPSignalEngine) {
    if (DEBUG) console.log('[KitePlus Signal] Waiting for signal engine…');
    return false;
  }
  if (!signalCandleCollector) {
    const ms = SIGNAL_TF_MS[signalTimeframeId] || SIGNAL_TF_MS['2m'];
    signalCandleCollector = new window.KPSignalEngine.CandleCollector(ms);
    if (DEBUG) console.log('[KitePlus Signal] Collector ready', signalTimeframeId);
  }
  return true;
}

function refreshTfButtonStates() {
  const analysisTf = equityAnalysisTimeframe(signalTradeMode, signalTimeframeId);
  document.querySelectorAll('.kp-tf-btn').forEach(btn => {
    const tf = btn.dataset.tf;
    const blocked = (signalTradeMode === 'positional' || signalTradeMode === 'swing') && !isPositionalTf(tf);
    btn.disabled = blocked;
    btn.classList.toggle('is-blocked', blocked);
    btn.title = blocked
      ? (signalTradeMode === 'swing' ? 'Swing Pro uses 1D / 1W' : 'Positional mode uses 1D / 1W / 1M')
      : `Analyze on ${tf}`;
    const activeTf = (signalTradeMode === 'positional' || signalTradeMode === 'swing') ? analysisTf : signalTimeframeId;
    btn.classList.toggle('active', tf === activeTf);
  });
  const hint = document.querySelector('#kp-tf-hint');
  if (hint) {
    hint.textContent = signalTradeMode === 'swing'
      ? `Swing Pro · analyzing ${analysisTf} · Structure + 1:2 RR`
      : signalTradeMode === 'positional'
        ? `Positional · analyzing ${analysisTf}`
        : signalTradeMode === 'scalp'
          ? 'Scalp · keep TF tight (1m–5m)'
          : 'Intraday · match the candle you trade';
  }
}

function setSignalTimeframe(tfId) {
  if (!SIGNAL_TF_MS[tfId]) return;
  if ((signalTradeMode === 'positional' || signalTradeMode === 'swing') && !isPositionalTf(tfId)) {
    updateDataBadge({
      status: signalTradeMode === 'swing'
        ? 'Swing Pro uses daily/weekly — switched to 1D'
        : 'Positional mode ignores 4h/intraday — switched to 1D',
      level: 'warn'
    });
    tfId = '1D';
  }
  signalTimeframeId = tfId;
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ signalTimeframe: tfId });
  }
  if (signalCandleCollector) {
    signalCandleCollector.setInterval(SIGNAL_TF_MS[tfId]);
  }
  signalHistory = [];
  lastSignalResult = null;
  lastEquityResult = null;
  stockHistory = [];
  stockHistoryMeta = null;
  stockHistoryKey = null;
  stockHistoryLoadingKey = null;
  lastSignalTimestamp = 0;
  chartSeedKey = null;
  chartSeedAt = 0;
  optionTickBuffer = [];
  dhanLtpCache = { symbol: null, ltp: null, fetchedAt: 0, loading: false };
  updateDataBadge({ status: `TF ${tfId} — reloading + re-analyzing…` });
  const label = document.querySelector('#kp-tf-label');
  if (label) label.textContent = tfId;
  refreshTfButtonStates();
  refreshAnalysisForCurrentTf();
}

async function refreshAnalysisForCurrentTf() {
  const ctx = getBrokerContext();
  const symbol = ctx.symbol || scrapeCurrentSymbol() || signalActiveSymbol;
  if (!symbol || !window.KPSignalEngine) return;
  const instrument = window.KPSignalEngine.classifyInstrument(symbol);
  if (!instrument.exchange && ctx.exchange) instrument.exchange = ctx.exchange;
  signalInstrument = instrument;
  signalActiveSymbol = (instrument.symbol || symbol).toUpperCase();

  if ((instrument.kind === 'equity' || signalTradeMode === 'swing') && settings.stockAnalysis !== false) {
    const mode = signalTradeMode === 'positional' ? 'positional'
      : signalTradeMode === 'swing' ? 'swing'
        : signalTradeMode === 'scalp' ? 'scalp' : 'intraday';
    const analysisTf = equityAnalysisTimeframe(mode, signalTimeframeId);
    try {
      await ensureStockHistory(instrument, analysisTf);
    } catch (_) {}
  } else if (instrument.kind === 'option' || instrument.kind === 'index') {
    initSignalEngine();
    await seedFromTradingPanel(signalActiveSymbol, true);
  }

  lastSignalTimestamp = 0;
  updateSignalEngine();
}

/**
 * Authoritative price for the OPEN chart: TradingView/ChartIQ legend "O … H … L … C …"
 * Prefer this over random watchlist .last-price (which caused LTP 13 vs chart 354).
 */
function scrapeChartLegendClose() {
  const parseClose = (text) => {
    if (!text) return null;
    const m = String(text).match(
      /O\s*([0-9]+(?:\.[0-9]+)?)\s*H\s*([0-9]+(?:\.[0-9]+)?)\s*L\s*([0-9]+(?:\.[0-9]+)?)\s*C\s*([0-9]+(?:\.[0-9]+)?)/i
    );
    if (!m) return null;
    const close = Number(m[4]);
    return Number.isFinite(close) && close > 0 ? close : null;
  };

  const docs = [document];
  try {
    document.querySelectorAll('iframe#chart-iframe, iframe[id*="chart"], iframe').forEach(frame => {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (_) {}
    });
  } catch (_) {}

  for (const doc of docs) {
    const legendNodes = doc.querySelectorAll(
      '.pane-legend, [class*="pane-legend"], [data-name="legend"], [data-name="legend-source-item"], ' +
      '.chart-markup-table, [class*="legendSource"]'
    );
    for (const node of legendNodes) {
      const close = parseClose(node.textContent);
      if (close != null && close < 15000) return close;
    }
    try {
      const blob = (doc.body?.innerText || '').slice(0, 12000);
      const close = parseClose(blob);
      if (close != null && close < 15000) return close;
    } catch (_) {}
  }

  for (const doc of docs) {
    const labels = doc.querySelectorAll(
      '.price-axis-last, .price-axis__last-value, [class*="price-axis"] [class*="last"], ' +
      '.chart-markup-table .price-axis .last-price-label, ' +
      '.stx_current_hr_up, .stx_current_hr_down, [class*="currentHR"], [class*="last-price-label"], ' +
      'cq-hu-price, .hu-price, [class*="hu-price"]'
    );
    for (const el of labels) {
      const n = parseFloat(String(el.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(n) && n > 0 && n < 15000) return n;
    }
  }

  return null;
}

/**
 * Kite shows option LTP as BUY/SELL quote chips (e.g. 346.50 BUY · 345.65 SELL)
 * when O/H/L/C legend isn't visible — that was why Collecting stuck on a perfect chart.
 */
function scrapeOptionQuoteLtp() {
  const roots = [
    ...document.querySelectorAll(
      '.chart-container, .chart-wrapper, .chart-page, .ciq-chart, cq-context, ' +
      '.instrument-select, .wrap, [class*="chart-container"], [class*="ChartHeader"], ' +
      '[class*="instrument-header"], [class*="InstrumentHeader"], .tv-symbol-header'
    ),
    document.body
  ];

  const pickPremium = (nums) => {
    const premiums = nums.filter(n => Number.isFinite(n) && n >= 0.05 && n < 15000);
    if (!premiums.length) return null;
    premiums.sort((a, b) => a - b);
    return premiums[Math.floor(premiums.length / 2)] || premiums[0];
  };

  for (const root of roots) {
    if (!root) continue;
    const buyNodes = root.querySelectorAll(
      '.buy .price, .buy-price, [class*="buy"] .price, button.buy, .quotes .buy, ' +
      '[data-balloon*="Buy" i], [title*="Buy" i], .buy'
    );
    const sellNodes = root.querySelectorAll(
      '.sell .price, .sell-price, [class*="sell"] .price, button.sell, .quotes .sell, ' +
      '[data-balloon*="Sell" i], [title*="Sell" i], .sell'
    );
    const buys = [];
    const sells = [];
    buyNodes.forEach(n => {
      const v = parseFloat(String(n.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(v) && v > 0 && v < 15000) buys.push(v);
    });
    sellNodes.forEach(n => {
      const v = parseFloat(String(n.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(v) && v > 0 && v < 15000) sells.push(v);
    });
    if (buys.length && sells.length) {
      const mid = (buys[0] + sells[0]) / 2;
      if (Number.isFinite(mid) && mid > 0 && mid < 15000) return mid;
    }
    if (buys.length) return buys[0];
    if (sells.length) return sells[0];

    const text = (root.innerText || '').replace(/\s+/g, ' ').slice(0, 8000);
    const pairs = [];
    const re = /([0-9]+(?:\.[0-9]+)?)\s*(?:BUY|SELL)\b|\b(?:BUY|SELL)\s*([0-9]+(?:\.[0-9]+)?)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = parseFloat(m[1] || m[2]);
      if (Number.isFinite(v) && v >= 0.05 && v < 15000) pairs.push(v);
      if (pairs.length >= 6) break;
    }
    const picked = pickPremium(pairs);
    if (picked != null) return picked;
  }

  // ChartIQ / TV last-price labels on the price axis (e.g. 304.15 line)
  const axisDocs = [document];
  try {
    document.querySelectorAll('iframe#chart-iframe, iframe[id*="chart"], iframe').forEach(f => {
      try { if (f.contentDocument) axisDocs.push(f.contentDocument); } catch (_) {}
    });
  } catch (_) {}
  for (const doc of axisDocs) {
    const labels = doc.querySelectorAll(
      '.price-axis-last, [class*="price-axis"] [class*="last"], ' +
      '.stx_current_hr_up, .stx_current_hr_down, [class*="currentHR"], ' +
      'cq-hu-price, .hu-price, [class*="hu-price"], .mSticky, [class*="sticky"], ' +
      '[class*="last-price-label"], [class*="LastPrice"]'
    );
    for (const el of labels) {
      const n = parseFloat(String(el.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(n) && n >= 0.05 && n < 15000) return n;
    }
  }
  return null;
}

/** Live option LTP from Kite OMS quote — reliable when chart DOM scrape fails. */
let kiteQuoteCache = { key: '', ltp: null, at: 0, loading: false };

/**
 * Kite OMS needs exchange tradingsymbol like SENSEX2672377000PE —
 * NOT display text "SENSEX 23rd JUL 77000 PE" (that 404s the quote call).
 */
function resolveKiteOptionTradingSymbol(raw) {
  const fromUrl = window.KPBrokerAdapters?.symbolFromUrl?.() || '';
  const urlCompact = String(fromUrl).replace(/\s+/g, '').toUpperCase();
  if (/^(SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)[A-Z0-9]*\d{4,6}(CE|PE)$/.test(urlCompact)) {
    return urlCompact;
  }

  // Path: /chart/web/ciq/BFO-OPT/SENSEX2672377000PE
  try {
    const path = decodeURIComponent(window.location.pathname + window.location.hash);
    const m = path.match(
      /(?:BFO-OPT|NFO-OPT|BFO|NFO)\/([A-Z0-9]+(?:CE|PE))\b/i
    ) || path.match(
      /((?:SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)[A-Z0-9]*\d{4,6}(?:CE|PE))/i
    );
    if (m) return String(m[1]).replace(/\s+/g, '').toUpperCase();
  } catch (_) {}

  const fromChart = String(window.KPChartReader?.readSnapshot?.()?.symbol || '')
    .replace(/\s+/g, '')
    .toUpperCase();
  if (/^(SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)[A-Z0-9]*\d{4,6}(CE|PE)$/.test(fromChart)) {
    return fromChart;
  }

  const compact = String(raw || '').replace(/\s+/g, '').toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // Already kite-style compact (no month words / ordinals)
  if (/^(SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)\d{6,14}(CE|PE)$/.test(compact)) {
    return compact;
  }
  // Reject display names like SENSEX23RDJUL77000PE for OMS
  if (/JUL|JAN|FEB|MAR|APR|MAY|JUN|AUG|SEP|OCT|NOV|DEC|ST|ND|RD|TH/i.test(compact) &&
      !/^\d{2}[A-Z]{3}\d/.test(compact.replace(/^(SENSEX|NIFTY|BANKNIFTY|FINNIFTY|BANKEX|MIDCPNIFTY)/, ''))) {
    return urlCompact || fromChart || '';
  }
  if (/\d{4,6}(CE|PE)$/.test(compact)) return compact;
  return urlCompact || fromChart || compact;
}

/**
 * Stable collector key for options — URL tradingsymbol preferred.
 * Prevents SENSEX23RDJUL77000PE ↔ SENSEX2672377000PE flip from wiping candles.
 */
function stableOptionSymbolKey(raw) {
  const trading = resolveKiteOptionTradingSymbol(raw);
  if (trading && /\d{4,6}(CE|PE)$/i.test(trading)) return trading;
  const compact = compactInstrumentKey(raw);
  const m = compact.match(
    /^(SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY).*?(\d{4,6})(CE|PE)$/i
  );
  if (m) return `${m[1].toUpperCase()}${m[2]}${m[3].toUpperCase()}`;
  return compact;
}

function sameOptionIdentity(a, b) {
  if (!a || !b) return false;
  const ka = stableOptionSymbolKey(a);
  const kb = stableOptionSymbolKey(b);
  if (ka && kb && ka === kb) return true;
  // Must match underlying + strike + CE/PE — CE→PE is a NEW instrument
  const strikeOf = (s) => {
    const c = compactInstrumentKey(s);
    const m = c.match(/(SENSEX|BANKEX|NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY).*?(\d{4,6})(CE|PE)$/i);
    return m ? `${m[1]}${m[2]}${m[3]}`.toUpperCase() : '';
  };
  const sa = strikeOf(a);
  const sb = strikeOf(b);
  return !!(sa && sb && sa === sb);
}

/** CE↔PE / strike change → wipe candles and re-read the new chart. */
function onSignalInstrumentSwitched(symbolKey) {
  signalActiveSymbol = symbolKey;
  signalHistory = [];
  lastSignalResult = null;
  lastEquityResult = null;
  stockHistoryKey = null;
  stockHistory = [];
  chartSeedKey = null;
  chartSeedAt = 0;
  optionTickBuffer = [];
  dhanLtpCache = { symbol: null, ltp: null, fetchedAt: 0, loading: false };
  kiteQuoteCache = { key: '', ltp: null, at: 0, loading: false };
  lastTickScrapeTime = 0;
  lastSignalTimestamp = 0;
  try { window.KPChartReader?.clearCache?.(); } catch (_) {}
  try { window.KPChartReader?.refreshSnapshot?.(); } catch (_) {}
  if (DEBUG) console.log('[KitePlus Signal] Switched chart → re-read', symbolKey, signalInstrument?.optionType);
}

/** Seed collector immediately from cached ChartIQ/TV snap (no await). */
function syncSeedFromChartSnap() {
  if (!signalCandleCollector) return 0;
  const snap = window.KPChartReader?.readSnapshot?.() || {};
  let bars = Array.isArray(snap.candles) ? snap.candles : [];
  // Don't seed bars from a different CE/PE while chart is still catching up
  if (signalInstrument?.kind === 'option') {
    const snapKey = stableOptionSymbolKey(snap.symbol || '');
    const wantKey = stableOptionSymbolKey(signalInstrument.symbol || signalActiveSymbol || '');
    if (snapKey && wantKey && !sameOptionIdentity(snapKey, wantKey)) return 0;
    bars = filterPremiumCandles(bars);
  }
  if (bars.length < 2) return 0;
  const before = signalCandleCollector.getCandleCount();
  if (bars.length > before) {
    signalCandleCollector.seedCandles(bars);
    return bars.length;
  }
  return before;
}

function fetchKiteQuoteLtp(symbol) {
  if (!IS_KITE) return Promise.resolve(null);
  const compact = resolveKiteOptionTradingSymbol(symbol);
  if (!compact || !/\d{4,6}(CE|PE)$/i.test(compact)) {
    if (DEBUG) console.warn('[KitePlus] No kite tradingsymbol for quote', symbol, '→', compact);
    return Promise.resolve(null);
  }

  const now = Date.now();
  if (kiteQuoteCache.key === compact && kiteQuoteCache.ltp != null && now - kiteQuoteCache.at < 1000) {
    return Promise.resolve(kiteQuoteCache.ltp);
  }
  if (kiteQuoteCache.loading && kiteQuoteCache.key === compact) {
    return Promise.resolve(kiteQuoteCache.ltp);
  }

  if (kiteQuoteCache.key !== compact) {
    kiteQuoteCache = { key: compact, ltp: null, at: 0, loading: true };
  } else {
    kiteQuoteCache.loading = true;
  }

  const headers = kiteApiHeaders();
  const origin = window.location.origin || 'https://kite.zerodha.com';
  const exchanges = /SENSEX|BANKEX/i.test(compact) ? ['BFO', 'NFO'] : ['NFO', 'BFO'];
  const paths = [
    `${origin}/oms/quote/ltp`,
    `${origin}/oms/quote`,
    '/oms/quote/ltp',
    '/oms/quote'
  ];

  const tryOne = async (path, ex) => {
    const instrument = `${ex}:${compact}`;
    const res = await fetch(`${path}?i=${encodeURIComponent(instrument)}`, {
      headers,
      credentials: 'include'
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.status !== 'success' || !json.data) return null;
    const row = json.data[instrument] || Object.values(json.data)[0];
    const ltp = Number(row?.last_price ?? row?.last ?? row?.price);
    if (Number.isFinite(ltp) && ltp > 0 && ltp < 50000) return ltp;
    return null;
  };

  return (async () => {
    try {
      for (const path of paths) {
        for (const ex of exchanges) {
          const ltp = await tryOne(path, ex);
          if (ltp != null) {
            kiteQuoteCache = { key: compact, ltp, at: Date.now(), loading: false };
            if (DEBUG) console.log('[KitePlus] OMS quote LTP', path, ex, compact, ltp);
            return ltp;
          }
        }
      }
      if (DEBUG) console.warn('[KitePlus] OMS quote empty for', compact);
    } catch (err) {
      if (DEBUG) console.warn('[KitePlus] OMS quote failed', err);
    } finally {
      kiteQuoteCache.loading = false;
    }
    return null;
  })();
}

/** Apply LTP into collector + panel immediately (don't wait for next 250ms tick). */
function applyOptionLtpNow(price, symbolLabel) {
  if (!Number.isFinite(price) || price <= 0) return;
  updateLivePriceUI(price, symbolLabel || signalInstrument?.symbol);
  updateDataBadge({
    status: null,
    level: 'ok',
    note: `LTP ₹${price.toFixed(2)} · live`,
    error: null
  });
  if (signalCandleCollector && initSignalEngine()) {
    signalCandleCollector.addTick(price, Date.now());
    signalCandleCollector.trim(500);
    recordOptionTick(price, Date.now());
    const need = getSignalThresholds().minCandles;
    const microMs = signalTradeMode === 'scalp' ? 2 * 1000 : 30 * 1000;
    const analysisCount = Math.max(
      signalCandleCollector.getCandleCount(),
      buildFastCandlesFromTicks(price, Date.now(), microMs, false).length
    );
    const countEl = document.querySelector('#kp-candle-count');
    const needEl = document.querySelector('#kp-candle-need');
    if (countEl) countEl.textContent = String(analysisCount);
    if (needEl) needEl.textContent = String(need);
  }
  // Allow next updateSignalEngine tick immediately so Ready X/8 advances.
  lastTickScrapeTime = 0;
}

function scrapeWatchlistLtpForSymbol(wantedRaw) {
  const wanted = String(wantedRaw || '').toUpperCase().replace(/\s+/g, '');
  if (!wanted || wanted.length < 6) return null;

  const rows = document.querySelectorAll(
    '.instruments .instrument, .marketwatch-sidebar .instrument, ' +
    '[class*="marketwatch"] .instrument, tr.instrument, .instrument'
  );
  for (const row of rows) {
    const symEl = row.querySelector(
      '.tradingsymbol, .symbol, [class*="tradingsymbol"], [class*="symbol-name"]'
    );
    const rowSym = String(symEl?.textContent || '')
      .toUpperCase()
      .replace(/\s+/g, '')
      .replace(/\b(NSE|BSE|NFO|BFO)\b/g, '');
    const rowText = (row.textContent || '').toUpperCase().replace(/\s+/g, '');
    const exact =
      rowSym === wanted ||
      rowText.includes(wanted) ||
      (wanted.length >= 10 && rowSym && wanted.includes(rowSym) && rowSym.length >= 10);
    if (!exact) continue;

    const priceEl = row.querySelector(
      '.last-price, .ltp, [data-col="last_price"], [data-field="last_price"]'
    );
    if (!priceEl) continue;
    const n = parseFloat(String(priceEl.textContent || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 15000) return n;
  }
  return null;
}

function scrapeCurrentPrice() {
  const ctx = window.KPBrokerAdapters?.getContext?.() || {};
  const wanted = String(ctx.symbol || signalActiveSymbol || signalInstrument?.symbol || '')
    .toUpperCase().replace(/\s+/g, '');
  const isOption = /\d{4,6}(CE|PE)$/.test(wanted) || signalInstrument?.kind === 'option';
  const chartClose = scrapeChartLegendClose();
  const quoteLtp = isOption ? scrapeOptionQuoteLtp() : null;

  const accept = (raw, { mustMatchChart = true } = {}) => {
    const val = parseFloat(String(raw || '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
    if (isNaN(val) || val <= 0) return null;
    if (isOption && val > 15000) return null;
    const ref = chartClose != null ? chartClose : quoteLtp;
    if (mustMatchChart && ref != null && ref > 0) {
      const drift = Math.abs(val - ref) / ref;
      if (drift > 0.18) return null;
    }
    return val;
  };

  // 1) Chart legend C
  if (chartClose != null) return chartClose;

  // 2) Visible BUY/SELL quote chips on the open option chart
  if (quoteLtp != null) return quoteLtp;

  // 3) Watchlist row for THIS option only
  {
    const wl = scrapeWatchlistLtpForSymbol(wanted);
    const v = accept(wl, { mustMatchChart: false });
    if (v != null) return v;
  }

  // 4) Chart bridge snapshot
  const snap = window.KPChartReader?.readSnapshot?.() || {};
  if (Number.isFinite(snap.ltp) && snap.ltp > 0) {
    const v = accept(snap.ltp, { mustMatchChart: false });
    if (v != null) return v;
    const last = snap.candles?.length ? snap.candles[snap.candles.length - 1] : null;
    const lc = accept(last?.close, { mustMatchChart: false });
    if (lc != null) return lc;
  }

  // 5) Header / depth near chart
  const header = document.querySelector(
    '.chart-container .chart-price, .chart-header .last-price, ' +
    '.chart-controls-bar .chart-price, .instrument-select .last-price, ' +
    '.instrument-select .ltp, #chart-ltp, .tv-symbol-price-quote__value'
  );
  {
    const v = accept(header?.innerText, { mustMatchChart: false });
    if (v != null) return v;
  }

  const depth = document.querySelector(
    '.depth .last-price, .depth-content .last-price, .marketdepth-widget .ltp'
  );
  {
    const v = accept(depth?.innerText, { mustMatchChart: false });
    if (v != null) return v;
  }

  if (window.mockState && window.mockState.lastPrice !== undefined) {
    return window.mockState.lastPrice;
  }

  return null;
}

function stockHistoryReferencePrice() {
  if (!stockHistory.length) return null;
  const last = stockHistory[stockHistory.length - 1];
  const close = Number(last?.close);
  return Number.isFinite(close) && close > 0 ? close : null;
}

/** Prefer chart LTP only when it matches this stock's history; never feed index prices into equity analysis. */
function resolveInstrumentPrice(instrument, scrapedPrice) {
  const scraped = Number(scrapedPrice);
  const hasScraped = Number.isFinite(scraped) && scraped > 0;
  const reference = stockHistoryReferencePrice();

  if (instrument?.kind === 'equity' && reference != null) {
    if (hasScraped) {
      const drift = Math.abs(scraped - reference) / reference;
      // Index LTP (e.g. Nifty ~24k) vs SBIN (~900) fails this gate.
      if (drift <= 0.2) return scraped;
      if (DEBUG) {
        console.log('[KitePlus] Ignoring mismatched LTP for', instrument.symbol, scraped, 'vs hist', reference);
      }
    }
    return reference;
  }

  if (hasScraped) return scraped;
  return reference;
}

function scrapeCurrentSymbol() {
  const ctxSym = window.KPBrokerAdapters?.getContext?.()?.symbol;
  if (ctxSym) return ctxSym;

  const adapterSymbol = window.KPBrokerAdapters?.detectBroker?.()?.scrapeSymbol?.();
  if (adapterSymbol) return adapterSymbol;

  const junk = /POSITIONS|ORDERS|HOLDINGS|FUNDS|KITE|ZERODHA|UPSTOX|DASHBOARD|WATCHLIST|MARKETWATCH/i;
  const accept = (raw) => {
    const t = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!t || junk.test(t) || t.length > 48 || !/[A-Z]/.test(t)) return null;
    return t.replace(/\b(NSE|BSE|NFO|BFO|NSE-EQ|NFO-OPT)\b[:/\s-]*/g, '').replace(/\s+(EQ|BE)$/g, '').trim() || null;
  };

  try {
    const decoded = decodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
    const urlPatterns = [
      /\/(?:NFO-OPT|BFO-OPT|NFO|BFO)\/([A-Z0-9&._-]{6,48})(?:\/|$|\?)/i,
      /\/chart\/[^?#]*\/(?:NFO-OPT|BFO-OPT|NFO|BFO)\/([A-Z0-9&._-]{6,48})/i,
      /(?:NFO-OPT|BFO-OPT|NFO|BFO)[:/|%-]+([A-Z0-9&._-]{6,48})/i,
      /\/(?:NSE-EQ|BSE-EQ|NSE|BSE)\/([A-Z0-9&._-]{1,32})(?:\/|$|\?)/i,
      /(?:NSE|BSE|NFO|BFO)[:/|%-]+([A-Z0-9&._-]{1,48})/i,
      /(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX)[A-Z0-9]*\d{4,6}(?:CE|PE)/i,
      /([A-Z]{2,15}\d{2}[A-Z]{3}\d{4,6}(?:CE|PE))/i
    ];
    for (const pattern of urlPatterns) {
      const match = decoded.match(pattern);
      if (match) {
        const fromUrl = accept(match[1] || match[0]);
        if (fromUrl) return fromUrl;
      }
    }
  } catch (_) {}

  const symbolEl = document.querySelector(
    '.chart-container .tradingsymbol, ' +
    '.chart-header .tradingsymbol, ' +
    '.chart-controls-bar .symbol, ' +
    '.chart-controls-bar .tradingsymbol, ' +
    '.chart-widget .symbol-name, ' +
    '.instrument-select .nice-name, ' +
    '.instrument-select .tradingsymbol, ' +
    '.marketwatch-sidebar .instrument.selected .tradingsymbol, ' +
    '.instruments .selected .tradingsymbol, ' +
    '[data-label="symbol"]'
  );
  if (symbolEl) {
    const t = accept(symbolEl.innerText);
    if (t) return t;
  }

  const tvTitle = document.querySelector(
    '.tv-symbol-header__short-name, ' +
    '.tv-symbol-header__first-line, ' +
    '.pane-legend-title__description, ' +
    '.pane-legend-line__title_name'
  );
  if (tvTitle) {
    const t = accept(tvTitle.innerText);
    if (t) return t;
  }

  if (window.mockState && window.mockState.symbol) {
    const t = accept(window.mockState.symbol);
    if (t) return t;
  }
  return null;
}

function equityAnalysisTimeframe(mode, tfId) {
  if (mode === 'positional' || mode === 'swing') {
    return isPositionalTf(tfId) ? tfId : '1D';
  }
  return tfId || '45m';
}

function formatPrice(n) {
  if (n == null || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function checkSrAlerts(price) {
  if (price == null || !srAlerts.length) {
    lastSrCheckPrice = price;
    return;
  }
  const prev = lastSrCheckPrice;
  lastSrCheckPrice = price;
  if (prev == null) return;

  srAlerts.forEach(alert => {
    if (!alert.enabled) return;
    const level = Number(alert.price);
    if (isNaN(level)) return;

    const crossed =
      (prev < level && price >= level) ||
      (prev > level && price <= level) ||
      Math.abs(price - level) / level < 0.00015;

    if (!crossed) return;
    if (alert.lastTriggered && Date.now() - alert.lastTriggered < 60000) return;

    alert.lastTriggered = Date.now();
    saveSrAlerts();
    showSrAlertToast(alert, price);
    notifySrAlert(alert, price);
  });
}

function showSrAlertToast(alert, price) {
  let toast = document.querySelector('.kp-sr-toast');
  if (toast) toast.remove();
  toast = document.createElement('div');
  toast.className = `kp-sr-toast ${alert.type}`;
  applyBrokerTheme(toast);
  toast.innerHTML = `<strong>${alert.type === 'support' ? 'Support' : 'Resistance'}</strong> ${formatPrice(alert.price)} touched @ ${formatPrice(price)}`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}

function notifySrAlert(alert, price) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'KP_SR_ALERT',
        title: `${alert.type === 'support' ? 'Support' : 'Resistance'} hit`,
        message: `${alert.price} · LTP ${price}`
      });
    }
  } catch (_) {}
}

function notifyAnalysisAlert(title, message) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'KP_ANALYSIS_ALERT', title, message });
    }
  } catch (_) {}
}

function chartEngineLabel(ctx) {
  const eng = ctx?.chartEngine || window.KPChartReader?.detectEngine?.() || '';
  if (eng === 'chartiq') return 'ChartIQ';
  if (eng === 'tradingview') return 'TradingView';
  return ctx?.chartSource || 'panel';
}

/**
 * Seed collector from the open trading-panel chart (ChartIQ OHLC preferred).
 * Used for options always; for stocks as live overlay / fallback before Yahoo.
 */
async function seedFromTradingPanel(symbolKey, force = false) {
  if (!signalCandleCollector || !window.KPChartReader?.seedCollectorFromChart) return 0;
  const key = `${symbolKey || ''}:${signalTimeframeId}`;
  const fresh = Date.now() - chartSeedAt < 8000;
  if (!force && chartSeedKey === key && fresh) return 0;
  if (chartSeedInFlight) return 0;
  chartSeedInFlight = true;
  try {
    await window.KPChartReader.refreshSnapshot?.();
    const snap = window.KPChartReader.readSnapshot?.() || {};
    if (signalInstrument?.kind === 'option') {
      const snapKey = stableOptionSymbolKey(snap.symbol || '');
      const wantKey = stableOptionSymbolKey(symbolKey || signalInstrument.symbol || '');
      // Wait until chart snap matches the new CE/PE before seeding
      if (snapKey && wantKey && !sameOptionIdentity(snapKey, wantKey)) return 0;
    }
    const seeded = await window.KPChartReader.seedCollectorFromChart(signalCandleCollector);
    if (signalInstrument?.kind === 'option') {
      const filtered = filterPremiumCandles(signalCandleCollector.getAllCandles());
      if (filtered.length >= 2) signalCandleCollector.seedCandles(filtered);
      else if (filtered.length === 0) {
        signalCandleCollector.reset?.();
      }
    }
    if (seeded > 0 || signalCandleCollector.getCandleCount() > 0) {
      chartSeedKey = key;
      chartSeedAt = Date.now();
      if (DEBUG) {
        console.log('[KitePlus] Seeded from chart panel', {
          engine: snap.engine,
          source: snap.source,
          bars: signalCandleCollector.getCandleCount(),
          tf: snap.timeframe,
          symbol: snap.symbol
        });
      }
    }
    return signalCandleCollector.getCandleCount();
  } catch (err) {
    if (DEBUG) console.log('[KitePlus] Chart seed failed', err);
    return 0;
  } finally {
    chartSeedInFlight = false;
  }
}

function getBrokerContext() {
  return window.KPBrokerAdapters?.getContext?.() || {
    broker: ACTIVE_BROKER,
    brokerLabel: BROKER_LABEL,
    symbol: scrapeCurrentSymbol(),
    exchange: 'NSE',
    ltp: scrapeCurrentPrice(),
    timeframe: null,
    chartEngine: window.KPChartReader?.detectEngine?.() || 'dom',
    chartSource: null,
    chartCandles: []
  };
}

function fetchStockHistory(symbol, exchange, tfId) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Extension runtime unavailable'));
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'KP_STOCK_CANDLES', symbol, exchange: exchange || 'NSE', tfId: tfId || '1D' },
      (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error(res?.error || 'Stock history fetch failed'));
          return;
        }
        resolve(res);
      }
    );
  });
}

function fetchDhanLtp(symbol, exchange) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Extension runtime unavailable'));
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'KP_DHAN_LTP', symbol, exchange: exchange || 'NSE' },
      (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error(res?.error || 'Dhan LTP failed'));
          return;
        }
        resolve(res);
      }
    );
  });
}

function refreshDhanLtp(instrument) {
  if (!instrument || instrument.kind !== 'equity') return;
  const symbol = instrument.symbol;
  const key = symbol;
  if (dhanLtpCache.loading && dhanLtpCache.symbol === key) return;
  if (dhanLtpCache.symbol === key && Date.now() - dhanLtpCache.fetchedAt < 5000) return;
  dhanLtpCache.loading = true;
  dhanLtpCache.symbol = key;
  fetchDhanLtp(symbol, instrument.exchange || 'NSE')
    .then((res) => {
      dhanLtpCache = {
        symbol: key,
        ltp: Number(res.ltp),
        fetchedAt: Date.now(),
        loading: false,
        source: 'Dhan'
      };
      if (stockHistoryMeta) {
        stockHistoryMeta.liveSource = 'Dhan';
        updateDataBadge(stockHistoryMeta);
      }
    })
    .catch(() => {
      dhanLtpCache.loading = false;
    });
}

function syncAutoSrLevels(levels) {
  if (!levels) return;
  const autos = [];
  (levels.supports || []).slice(0, 3).forEach((lvl, i) => {
    autos.push({
      id: `auto_s_${i}_${Math.round(lvl.price * 100)}`,
      price: lvl.price,
      type: 'support',
      enabled: true,
      auto: true,
      touches: lvl.touches,
      lastTriggered: 0
    });
  });
  (levels.resistances || []).slice(0, 3).forEach((lvl, i) => {
    autos.push({
      id: `auto_r_${i}_${Math.round(lvl.price * 100)}`,
      price: lvl.price,
      type: 'resistance',
      enabled: true,
      auto: true,
      touches: lvl.touches,
      lastTriggered: 0
    });
  });
  const manual = srAlerts.filter(a => !a.auto);
  srAlerts = [...autos, ...manual].slice(0, 20);
  saveSrAlerts();
  renderSrAlertList();
}

async function ensureStockHistory(instrument, tfId) {
  if (!instrument || instrument.kind !== 'equity' || settings.stockAnalysis === false) return null;
  const symbol = instrument.symbol;
  const exchange = instrument.exchange || 'NSE';
  const key = `${exchange}:${symbol}:${tfId}`;
  if (stockHistoryKey === key && stockHistory.length) return stockHistoryMeta;
  if (stockHistoryLoadingKey === key) return stockHistoryMeta;

  stockHistoryLoadingKey = key;
  const brokerCtx = getBrokerContext();
  updateDataBadge({ status: `Loading ${tfId} history…`, broker: brokerCtx.brokerLabel });

  // Prefer OHLC already loaded on the trading panel (same TF candles the user sees).
  try {
    await window.KPChartReader?.refreshSnapshot?.();
  } catch (_) {}
  const panelSnap = window.KPChartReader?.readSnapshot?.() || null;
  const panelCandles = Array.isArray(panelSnap?.candles) ? panelSnap.candles : [];
  const panelTfOk = !panelSnap?.timeframe || panelSnap.timeframe === tfId ||
    ((signalTradeMode === 'positional' || signalTradeMode === 'swing') && isPositionalTf(panelSnap.timeframe));

  // Positional & Swing need deep history (EMA200 / Daily) — prefer API over thin panel series.
  const minPanelBars = (signalTradeMode === 'positional' || signalTradeMode === 'swing') ? 120 : 30;
  if (panelCandles.length >= minPanelBars && panelTfOk) {
    stockHistory = panelCandles.slice(-500);
    stockHistoryMeta = {
      source: ACTIVE_BROKER === 'upstox' ? 'Upstox' : (panelSnap.source || 'Chart panel'),
      liveSource: `${brokerCtx.brokerLabel} · ${chartEngineLabel(brokerCtx)}`,
      chartEngine: panelSnap.engine,
      interval: panelSnap.timeframe || tfId,
      requestedTimeframe: tfId,
      aggregated: false,
      candleCount: stockHistory.length,
      firstTime: stockHistory[0]?.startTime || null,
      lastTime: stockHistory[stockHistory.length - 1]?.startTime || null,
      yahooSymbol: null,
      securityId: null,
      dhanError: null,
      fallback: false,
      dhanStatus: null,
      fetchedAt: Date.now(),
      error: null,
      note: 'Panel OHLC (same candles as chart)'
    };
    stockHistoryKey = key;
    if (signalCandleCollector?.seedCandles) {
      signalCandleCollector.seedCandles(stockHistory);
    }
    chartSeedKey = `${(instrument.symbol || '').toUpperCase()}:${signalTimeframeId}`;
    chartSeedAt = Date.now();
    updateDataBadge(stockHistoryMeta);
    lastSignalResult = null;
    lastEquityResult = null;
    lastSignalTimestamp = 0;
    stockHistoryLoadingKey = null;
    return stockHistoryMeta;
  }

  try {
    const data = await fetchStockHistory(symbol, exchange, tfId);
    stockHistory = data.candles || [];
    const histSource = data.source || 'Yahoo';
    stockHistoryMeta = {
      source: histSource,
      liveSource: histSource === 'Upstox' || histSource === 'Dhan'
        ? histSource
        : `${brokerCtx.brokerLabel} · ${chartEngineLabel(brokerCtx)}`,
      chartEngine: brokerCtx.chartEngine,
      interval: data.interval,
      requestedTimeframe: data.requestedTimeframe || tfId,
      aggregated: !!data.aggregated,
      candleCount: stockHistory.length,
      firstTime: data.firstTime,
      lastTime: data.lastTime,
      yahooSymbol: data.yahooSymbol,
      securityId: data.securityId || null,
      instrumentKey: data.instrumentKey || null,
      dhanError: data.dhanError || null,
      upstoxError: data.upstoxError || null,
      fallback: !!data.fallback,
      dhanStatus: data.dhanStatus || null,
      upstoxStatus: data.upstoxStatus || null,
      fetchedAt: data.fetchedAt || Date.now(),
      error: null,
      note: panelCandles.length && histSource !== 'Upstox'
        ? `${histSource} hist · panel had ${panelCandles.length} bars (TF mismatch or thin)`
        : null
    };
    stockHistoryKey = key;
    if (signalCandleCollector?.seedCandles) {
      signalCandleCollector.seedCandles(stockHistory);
    }
    updateDataBadge(stockHistoryMeta);
    if (DEBUG) {
      console.log('[KitePlus] Stock history source:', stockHistoryMeta.source, {
        dhanStatus: stockHistoryMeta.dhanStatus,
        dhanError: stockHistoryMeta.dhanError,
        bars: stockHistoryMeta.candleCount,
        symbol
      });
    }
    lastSignalResult = null;
    lastEquityResult = null;
    lastSignalTimestamp = 0;
    dhanLtpCache = { symbol: null, ltp: null, fetchedAt: 0, loading: false };
    if (stockHistoryMeta.source === 'Dhan') {
      refreshDhanLtp(instrument);
    }
    return stockHistoryMeta;
  } catch (err) {
    // Last resort: thin panel series if Yahoo failed
    if (panelCandles.length >= 10) {
      stockHistory = panelCandles.slice(-500);
      stockHistoryMeta = {
        source: panelSnap?.source || 'Chart panel',
        liveSource: `${brokerCtx.brokerLabel} · ${chartEngineLabel(brokerCtx)}`,
        chartEngine: panelSnap?.engine,
        requestedTimeframe: tfId,
        candleCount: stockHistory.length,
        firstTime: stockHistory[0]?.startTime || null,
        lastTime: stockHistory[stockHistory.length - 1]?.startTime || null,
        error: null,
        note: `Panel fallback after hist error: ${err.message || err}`
      };
      stockHistoryKey = key;
      if (signalCandleCollector?.seedCandles) signalCandleCollector.seedCandles(stockHistory);
      updateDataBadge(stockHistoryMeta);
      return stockHistoryMeta;
    }
    stockHistoryMeta = {
      source: 'Yahoo',
      liveSource: `${brokerCtx.brokerLabel} · ${chartEngineLabel(brokerCtx)}`,
      error: err.message || String(err),
      candleCount: 0
    };
    updateDataBadge(stockHistoryMeta);
    return stockHistoryMeta;
  } finally {
    if (stockHistoryLoadingKey === key) stockHistoryLoadingKey = null;
  }
}

function updateDataBadge(meta) {
  const el = document.querySelector('#kp-data-badge');
  if (!el) return;
  if (!meta) {
    el.textContent = 'Waiting for chart…';
    el.classList.remove('error', 'warn');
    return;
  }
  if (meta.status && !meta.candleCount && !meta.error && !meta.note) {
    el.textContent = meta.status;
    el.classList.toggle('warn', meta.level === 'warn');
    el.classList.toggle('error', meta.level === 'error');
    return;
  }
  if (meta.note && meta.source === 'Live chart' && !meta.error) {
    el.classList.remove('error', 'warn');
    const liveCount = meta.candleCount != null
      ? meta.candleCount
      : (signalCandleCollector ? signalCandleCollector.getCandleCount() : 0);
    const eng = meta.chartEngine || window.KPChartReader?.detectEngine?.() || '';
    const engLabel = eng === 'chartiq' ? 'ChartIQ' : eng === 'tradingview' ? 'TradingView' : 'panel';
    el.textContent = `Live ${meta.liveSource || 'chart'} · ${engLabel} · ${meta.note} · TF ${meta.requestedTimeframe || signalTimeframeId} · ${liveCount} candles`;
    return;
  }
  if (meta.error) {
    el.textContent = `History error: ${meta.error}`;
    el.classList.add('error');
    el.classList.remove('warn');
    return;
  }
  el.classList.remove('error', 'warn');
  const first = meta.firstTime ? new Date(meta.firstTime).toLocaleDateString('en-IN') : '—';
  const last = meta.lastTime ? new Date(meta.lastTime).toLocaleString('en-IN', {
    hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short'
  }) : '—';
  const agg = meta.aggregated ? ' · aggregated' : '';
  const analysisNote = (signalTradeMode === 'positional' || signalTradeMode === 'swing') && isPositionalTf(meta.requestedTimeframe || '')
    ? ` · ${signalTradeMode === 'swing' ? 'Swing Pro' : 'Positional'} ${meta.requestedTimeframe || '1D'}`
    : '';
  const tf = meta.requestedTimeframe || signalTimeframeId;
  let histLabel = meta.source || 'Yahoo';
  if (meta.fallback && meta.source === 'Yahoo') {
    histLabel = 'Yahoo fallback';
    el.classList.add('warn');
  } else if (meta.source === 'Upstox') {
    histLabel = `Upstox · ${tf}`;
  } else if (meta.source === 'Dhan') {
    histLabel = `Dhan · ${tf}`;
  }
  let extraNote = '';
  if (meta.source === 'Dhan' && meta.securityId) {
    extraNote = ` · id ${meta.securityId}`;
  } else if (meta.fallback && meta.upstoxError) {
    extraNote = ` · Upstox: ${String(meta.upstoxError).slice(0, 40)}`;
    el.classList.add('warn');
  } else if (meta.fallback && meta.dhanError && !/not configured/i.test(meta.dhanError || '')) {
    extraNote = ` · Dhan skipped: ${meta.dhanError.slice(0, 40)}`;
    el.classList.add('warn');
  }
  // Compact badge: "Upstox · 1D · 250 bars" when broker history is primary
  if (meta.source === 'Upstox' || meta.source === 'Dhan' || (meta.fallback && meta.source === 'Yahoo')) {
    el.textContent = `${histLabel}${agg}${analysisNote} · ${meta.candleCount || 0} bars · ${first}→${last}${extraNote}`;
  } else {
    el.textContent = `Live ${meta.liveSource || '—'} · Hist ${histLabel}${extraNote} · ${tf}${agg}${analysisNote} · ${meta.candleCount || 0} bars · ${first}→${last}`;
  }
  if (meta.note) {
    el.textContent += ` · ${meta.note}`;
  }
}

function equityResultToPanelResult(eq, instrument) {
  const score = eq.score || 0;
  const action = eq.action || 'WAIT';
  const thr = getSignalThresholds();
  const t2 = eq.targetLevels?.t2 || eq.targetLevel;
  let message;
  if (action === 'BUY') {
    message = `YES BUY ${instrument.symbol}`;
  } else if (action === 'HOLD') {
    message = `HOLD ${instrument.symbol} · trail to targets`;
  } else if (action === 'EXIT') {
    message = `EXIT ${instrument.symbol}`;
  } else {
    message = `WAIT — ${instrument.symbol}`;
  }
  return {
    direction: action === 'BUY' || action === 'HOLD' ? 'BUY' : action === 'EXIT' ? 'WAIT' : null,
    action,
    strength: score,
    message,
    currentPrice: eq.currentPrice,
    instrument,
    mode: eq.mode || signalTradeMode,
    timeframe: eq.timeframe || signalTimeframeId,
    thresholds: thr,
    reasons: eq.reasons || [],
    lessons: eq.lessons || [],
    topDrivers: eq.topDrivers || [],
    coachTip: eq.coachTip || '',
    decisionWhy: eq.decisionWhy || '',
    checklist: eq.checklist || [],
    pickVerdict: eq.pickVerdict || (action === 'BUY' ? 'YES' : action === 'WAIT' ? 'NO' : action),
    weeklyBias: eq.weeklyBias || 'unknown',
    monthlyBias: eq.monthlyBias || 'n/a',
    patternLabel: eq.patternLabel || eq.indicators?.patternLabel || '',
    patterns: eq.patterns || null,
    buyAt: eq.buyAt != null ? eq.buyAt : thr.actionableAt,
    invalidationLevel: eq.invalidationLevel,
    targetLevel: t2,
    targetLevels: eq.targetLevels || null,
    riskReward: eq.riskReward,
    riskRewards: eq.riskRewards || null,
    expectedHold: eq.expectedHold,
    confirmationTimeframe: eq.confirmationTimeframe,
    supportResistance: eq.supportResistance,
    indicators: eq.indicators || {},
    brain: {
      momentum: eq.indicators?.volumeRatio || 0,
      candleBias: eq.indicators?.structure === 'bullish' ? 1 : eq.indicators?.structure === 'bearish' ? -1 : 0,
      bullScore: score / 20,
      bearScore: (100 - score) / 20,
      agreement: score / 100,
      edge: Math.abs(score - 50) / 10,
      minCandles: eq.dataSufficiency?.required || 0,
      mode: eq.mode
    },
    equity: true,
    timestamp: eq.timestamp || Date.now()
  };
}

function maybeAlertEquityTransition(symbol, action, result) {
  if (!symbol || !action) return;
  const prev = lastAnalysisActions[symbol];
  if (prev === action) return;
  const isBuyTransition = (prev === 'WAIT' || prev === 'HOLD' || !prev) && action === 'BUY';
  const isExitTransition = (prev === 'BUY' || prev === 'HOLD') && action === 'EXIT';
  lastAnalysisActions[symbol] = action;
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ lastAnalysisActions });
  }
  if (!isBuyTransition && !isExitTransition) return;
  const timeStr = new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit'
  });
  signalHistory.unshift({
    time: timeStr,
    direction: result?.direction || (action === 'BUY' ? 'BUY' : 'WAIT'),
    action,
    strength: result?.strength || 0,
    price: result?.currentPrice,
    message: result?.message,
    symbol,
    timestamp: Date.now()
  });
  if (signalHistory.length > 50) signalHistory.pop();
  notifyAnalysisAlert(
    `Megamind ${action}`,
    `${symbol} · score ${result?.strength || 0}% · LTP ${result?.currentPrice ?? '—'}`
  );
  if (result) showSignalToast(result);
}

function suggestedShareQty(entry, stop, capital, riskPct) {
  const e = Number(entry);
  const s = Number(stop);
  const cap = Number(capital);
  const rp = Number(riskPct);
  if (![e, s, cap, rp].every(n => Number.isFinite(n) && n > 0)) return null;
  const riskPerShare = Math.abs(e - s);
  if (riskPerShare < 0.01) return null;
  const riskCash = cap * (rp / 100);
  return Math.max(0, Math.floor(riskCash / riskPerShare));
}

function saveTradeJournal() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ tradeJournal: tradeJournal.slice(0, 100) });
  }
}

function journalHitRate() {
  const closed = tradeJournal.filter(j => j.outcome);
  if (!closed.length) return { closed: 0, wins: 0, rate: null };
  const wins = closed.filter(j => ['t1', 't2', 't3', 'win'].includes(j.outcome)).length;
  return { closed: closed.length, wins, rate: Math.round((wins / closed.length) * 100) };
}

function logJournalIdea(opts) {
  const eq = lastEquityResult || {};
  const inst = signalInstrument || {};
  const symbol = (opts?.symbol || inst.symbol || '').toUpperCase();
  if (!symbol) return null;
  const entry = {
    id: 'j_' + Date.now().toString(36),
    symbol,
    mode: opts?.mode || signalTradeMode,
    tf: opts?.tf || signalTimeframeId,
    action: opts?.action || eq.action || 'WAIT',
    score: opts?.score != null ? opts.score : (eq.score || 0),
    entry: opts?.entry != null ? opts.entry : eq.currentPrice,
    stop: opts?.stop != null ? opts.stop : eq.invalidationLevel,
    t1: eq.targetLevels?.t1 ?? null,
    t2: eq.targetLevels?.t2 ?? eq.targetLevel ?? null,
    t3: eq.targetLevels?.t3 ?? null,
    userNote: opts?.userNote || '',
    createdAt: Date.now(),
    outcome: null,
    exitedAt: null
  };
  tradeJournal.unshift(entry);
  if (tradeJournal.length > 100) tradeJournal.pop();
  saveTradeJournal();
  renderJournalList();
  return entry;
}

function setJournalOutcome(id, outcome) {
  const row = tradeJournal.find(j => j.id === id);
  if (!row) return;
  row.outcome = outcome;
  row.exitedAt = Date.now();
  saveTradeJournal();
  renderJournalList();
}

function renderJournalList() {
  const list = document.querySelector('#kp-journal-list');
  const summary = document.querySelector('#kp-journal-summary');
  if (!list) return;
  const hit = journalHitRate();
  if (summary) {
    summary.textContent = hit.closed
      ? `Your ideas · ${hit.wins}/${hit.closed} closed wins (${hit.rate}%)`
      : 'Log ideas to build your personal hit-rate (not engine backtest)';
  }
  if (!tradeJournal.length) {
    list.innerHTML = '<div class="kp-journal-empty">No journal entries yet · Track or Log idea</div>';
    return;
  }
  list.innerHTML = tradeJournal.slice(0, 12).map(j => {
    const when = new Date(j.createdAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
    const outcomeBtns = j.outcome
      ? `<span class="kp-journal-outcome ${j.outcome}">${j.outcome}</span>`
      : `<span class="kp-journal-actions">
          <button type="button" data-j-out="t1" data-j-id="${j.id}">T1</button>
          <button type="button" data-j-out="t2" data-j-id="${j.id}">T2</button>
          <button type="button" data-j-out="stopped" data-j-id="${j.id}">Stop</button>
          <button type="button" data-j-out="scratch" data-j-id="${j.id}">Flat</button>
        </span>`;
    return `<div class="kp-journal-item">
      <div class="kp-journal-main">
        <strong>${j.symbol}</strong>
        <span>${j.action} · ${j.score}% · ${j.mode}/${j.tf}</span>
        <span class="kp-journal-when">${when}</span>
      </div>
      ${outcomeBtns}
    </div>`;
  }).join('');
}

function updateInvestorSizing(eq) {
  const qtyEl = document.querySelector('#kp-size-qty');
  const riskEl = document.querySelector('#kp-risk-pct');
  const capEl = document.querySelector('#kp-risk-capital');
  if (riskEl && document.activeElement !== riskEl) riskEl.value = String(investorRiskPct);
  if (capEl && document.activeElement !== capEl) capEl.value = String(investorCapital);
  if (!qtyEl) return;
  const entry = eq?.currentPrice ?? lastEquityResult?.currentPrice;
  const stop = eq?.invalidationLevel ?? lastEquityResult?.invalidationLevel;
  const qty = suggestedShareQty(entry, stop, investorCapital, investorRiskPct);
  if (qty == null) {
    qtyEl.textContent = '— shares (need stop + LTP)';
  } else {
    const riskCash = investorCapital * (investorRiskPct / 100);
    qtyEl.textContent = `≈ ${qty} shares · risk ≈ ₹${Math.round(riskCash).toLocaleString('en-IN')} (edu only)`;
  }
}

/* ==========================================
   SWING EXTRAS — Dashboard + Trade Card
   ========================================== */
function renderSwingExtras(sw) {
  if (!sw) return;
  const d = sw.dashboard;
  const trade = sw.trade || sw.signalTrade;

  // --- Equity levels card (reuse existing #kp-equity-levels) ---
  const levelsEl = document.querySelector('#kp-equity-levels');
  if (levelsEl && trade) {
    const isLong = trade.direction === 'LONG';
    const dirColor = isLong ? 'var(--kp-green, #00c853)' : 'var(--kp-red, #ff1744)';
    const bgGradient = isLong
      ? 'linear-gradient(135deg, rgba(0, 200, 83, 0.08) 0%, rgba(0, 200, 83, 0.02) 100%)'
      : 'linear-gradient(135deg, rgba(255, 23, 68, 0.08) 0%, rgba(255, 23, 68, 0.02) 100%)';
    const borderCol = isLong ? 'rgba(0, 200, 83, 0.35)' : 'rgba(255, 23, 68, 0.35)';

    levelsEl.innerHTML = `
      <div class="kp-swing-trade-card" style="border:1px solid ${borderCol};border-left:4px solid ${dirColor};padding:10px 12px;margin:8px 0;border-radius:6px;background:${bgGradient};box-shadow:0 2px 8px rgba(0,0,0,0.15)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-weight:700;font-size:13px;color:${dirColor};letter-spacing:0.3px">🎯 ${trade.direction} · 1:2 R:R</span>
          <span style="font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(255,255,255,0.1);color:${dirColor}">Score ${trade.rating}/10</span>
        </div>
        <div class="kp-swing-levels" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;font-size:11px;background:rgba(0,0,0,0.15);padding:6px 8px;border-radius:4px">
          <div><span style="opacity:0.6;font-size:10px">Entry</span><br><strong style="font-size:12px">${formatPrice(trade.entry)}</strong></div>
          <div><span style="opacity:0.6;font-size:10px">Stop Loss</span><br><strong style="color:var(--kp-red, #ff1744);font-size:12px">${formatPrice(trade.stopLoss)}</strong></div>
          <div><span style="opacity:0.6;font-size:10px">Target 1:2</span><br><strong style="color:var(--kp-green, #00c853);font-size:12px">${formatPrice(trade.target1)}</strong></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;opacity:0.7;margin-top:6px">
          <span>Risk: <b style="color:var(--kp-red, #ff1744)">${formatPrice(trade.risk)}</b></span>
          <span>Reward: <b style="color:var(--kp-green, #00c853)">${formatPrice(trade.reward)}</b></span>
          <span>Ratio: <b>${trade.rr}</b></span>
        </div>
      </div>
    `;
  } else if (levelsEl) {
    levelsEl.innerHTML = `
      <div style="font-size:11px;opacity:0.6;padding:8px 10px;border-radius:4px;background:rgba(255,255,255,0.03);border:1px dashed rgba(255,255,255,0.1);margin:6px 0;text-align:center">
        ⏳ Waiting for high-confluence setup (Score ≥ 8.0 + Breakout/Pullback)
      </div>
    `;
  }

  // --- Equity meta (reuse #kp-equity-meta for swing dashboard) ---
  const metaEl = document.querySelector('#kp-equity-meta');
  if (metaEl && d) {
    const trendColor = d.trendBias === 'bullish' ? 'var(--kp-green, #00c853)'
      : d.trendBias === 'bearish' ? 'var(--kp-red, #ff1744)' : 'var(--kp-amber, #ffab00)';
    const longColor = d.longScore >= d.minimumScore ? 'var(--kp-green, #00c853)' : (d.longScore >= 6 ? 'var(--kp-amber, #ffab00)' : 'rgba(255,255,255,0.5)');
    const shortColor = d.shortScore >= d.minimumScore ? 'var(--kp-red, #ff1744)' : (d.shortScore >= 6 ? 'var(--kp-amber, #ffab00)' : 'rgba(255,255,255,0.5)');

    metaEl.innerHTML = `
      <div class="kp-swing-dashboard" style="font-size:11px;margin:6px 0;padding:10px;border-radius:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:4px">
          <span style="font-weight:600;font-size:12px;letter-spacing:0.2px">Swing Pro Indicators</span>
          <span style="font-size:10px;font-weight:700;color:${trendColor}">${d.trend}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;line-height:1.5">
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">EMA Stack</span><strong>${d.emaStack}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">RSI(14)</span><strong>${d.rsi ?? '—'}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">Volume</span><strong>${d.volumeRatio != null ? d.volumeRatio + 'x' : '—'}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">ADX (14)</span><strong>${d.adx ?? '—'}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">DI+ / DI-</span><strong>${d.diPlus ?? '—'}/${d.diMinus ?? '—'}</strong></div>
          <div style="display:flex;justify-content:space-between"><span style="opacity:0.6">ATR (14)</span><strong>${d.atr ?? '—'}</strong></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.06);padding-top:2px"><span style="opacity:0.7">Long Rating</span><strong style="color:${longColor}">${d.longScore}/10</strong></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.06);padding-top:2px"><span style="opacity:0.7">Short Rating</span><strong style="color:${shortColor}">${d.shortScore}/10</strong></div>
        </div>
      </div>
    `;
  }

  // --- Reasons / checklist (reuse #kp-equity-reasons) ---
  const reasonsEl = document.querySelector('#kp-equity-reasons');
  if (reasonsEl && sw.checklist) {
    reasonsEl.innerHTML = sw.checklist.map(c => {
      const icon = c.pass ? '✓' : '✗';
      const color = c.pass ? 'var(--kp-green, #00c853)' : 'var(--kp-red, #ff1744)';
      return `<div class="kp-reason-row" style="display:flex;gap:8px;align-items:center;font-size:11px;padding:2px 0">
        <span style="color:${color};font-weight:700;font-size:13px;width:14px;text-align:center">${icon}</span>
        <span style="flex:1">${c.label}</span>
        <span style="font-size:10px;opacity:0.6">${c.detail}</span>
      </div>`;
    }).join('');
  }

  // --- Coach tip (reuse #kp-equity-coach) ---
  const coachEl = document.querySelector('#kp-equity-coach');
  if (coachEl && sw.coachTip) {
    coachEl.textContent = sw.coachTip;
    coachEl.style.display = '';
  }

  // --- Pick card ---
  const pickCard = document.querySelector('#kp-pick-card');
  if (pickCard) {
    if (sw.longSignal || sw.shortSignal) {
      const dir = sw.longSignal ? 'LONG' : 'SHORT';
      const score = sw.longSignal ? sw.longScore : sw.shortScore;
      const color = sw.longSignal ? 'var(--kp-green, #00c853)' : 'var(--kp-red, #ff1744)';
      pickCard.innerHTML = `
        <div style="padding:10px 12px;border-radius:6px;background:rgba(255,255,255,0.04);border:1px solid ${color};box-shadow:0 0 10px rgba(0,200,83,0.15)">
          <div style="font-weight:700;color:${color};font-size:13px">🎯 ${dir} SIGNAL TRIGGERED · Score ${score}/10</div>
          <div style="font-size:11px;opacity:0.8;margin-top:4px">${sw.coachTip || ''}</div>
        </div>
      `;
    } else if (sw.slHit) {
      pickCard.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--kp-red, #ff1744);background:rgba(255,23,68,0.1);border-radius:4px">⛔ Stop-Loss Hit — Position closed. Wait for next clean setup.</div>';
    } else if (sw.t1Hit) {
      pickCard.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--kp-green, #00c853);background:rgba(0,200,83,0.1);border-radius:4px">✅ Target 1:2 Reached! Book profits.</div>';
  // Update on-chart HUD overlay
  updateChartOverlayHud(sw);
}

/* ==========================================
   ON-CHART VISUAL OVERLAY HUD
   Attaches floating signals and levels directly over the chart area
   ========================================== */
function updateChartOverlayHud(signalData) {
  let hud = document.querySelector('#kp-chart-overlay-hud');
  if (!hud) {
    const chartContainer = document.querySelector('#tv_chart_container, #chart-iframe, cq-context, .ciq-chart, [class*="chart-container"], .tradingview-widget-container') || document.body;
    hud = document.createElement('div');
    hud.id = 'kp-chart-overlay-hud';
    hud.className = 'kp-chart-overlay-hud';
    if (chartContainer === document.body) {
      hud.style.position = 'fixed';
      hud.style.top = '64px';
      hud.style.left = '70px';
    } else {
      chartContainer.style.position = 'relative';
      chartContainer.appendChild(hud);
    }
  }

  if (!signalData) {
    hud.innerHTML = '';
    return;
  }

  const trade = signalData.trade || signalData.signalTrade;
  const isSwing = signalData.swing || signalTradeMode === 'swing';
  const sym = signalActiveSymbol || 'STOCK';

  if (isSwing && trade) {
    const isLong = trade.direction === 'LONG';
    const actionText = isLong ? `BUY ABOVE ${formatPrice(trade.entry)}` : `SELL BELOW ${formatPrice(trade.entry)}`;
    const actionClass = isLong ? 'long' : 'short';
    const tagEmoji = isLong ? '🎯' : '🔻';

    hud.innerHTML = `
      <div class="kp-chart-hud-pill ${actionClass}">
        <span>${tagEmoji} <b>${sym}</b> · ${actionText}</span>
        <span class="hud-level hud-sl">SL: ${formatPrice(trade.stopLoss)}</span>
        <span class="hud-level hud-target">T1 (1:2): ${formatPrice(trade.target1)}</span>
        <span class="hud-score">Rating ${trade.rating}/10</span>
      </div>
    `;
  } else if (signalData.action === 'BUY' || signalData.action === 'SELL') {
    const isBuy = signalData.action === 'BUY';
    const actionClass = isBuy ? 'long' : 'short';
    hud.innerHTML = `
      <div class="kp-chart-hud-pill ${actionClass}">
        <span>${isBuy ? '🟢' : '🔴'} <b>${sym}</b> · ${signalData.action} ${signalData.direction || ''}</span>
        <span class="hud-level">Strength ${signalData.strength}%</span>
        <span class="hud-score">${signalData.mode ? signalData.mode.toUpperCase() : 'SIGNAL'}</span>
      </div>
    `;
  } else {
    hud.innerHTML = `
      <div class="kp-chart-hud-pill wait">
        <span>⏳ <b>${sym}</b> · Waiting for high-confluence setup</span>
        <span class="hud-score">${signalTradeMode.toUpperCase()}</span>
      </div>
    `;
  }
}

function renderEquityExtras(eq) {
  const reasonsEl = document.querySelector('#kp-equity-reasons');
  if (reasonsEl) {
    reasonsEl.innerHTML = (eq.reasons || []).slice(0, 3).map(r => `<div class="kp-reason-row">• ${r}</div>`).join('') ||
      '<div class="kp-reason-row">Waiting for a clean reason…</div>';
  }
  const levelsEl = document.querySelector('#kp-equity-levels');
  if (levelsEl) {
    const t1 = eq.targetLevels?.t1;
    const t2 = eq.targetLevels?.t2 || eq.targetLevel;
    const t3 = eq.targetLevels?.t3;
    levelsEl.innerHTML = `
      <span class="kp-level-primary" title="Leave if price breaks here">${kpIcon('stop')} Stop ${formatPrice(eq.invalidationLevel)}</span>
      <span class="kp-level-primary" title="First book zone">${kpIcon('target')} T1 ${formatPrice(t1)}</span>
      <span class="kp-level-primary" title="Main target">${kpIcon('target')} T2 ${formatPrice(t2)}</span>
      <span class="kp-level-primary" title="Stretch target">${kpIcon('target')} T3 ${formatPrice(t3)}</span>
      <span class="kp-level-primary" title="Reward to risk on T2">R:R ${eq.riskReward != null ? eq.riskReward : '—'}</span>
    `;
  }
  const metaEl = document.querySelector('#kp-equity-meta');
  if (metaEl) {
    const weekly = eq.weeklyBias || 'unknown';
    const pattern = eq.patternLabel || eq.indicators?.patternLabel || '';
    metaEl.innerHTML = `
      <span>Hold ${eq.expectedHold || '—'}</span>
      <span>Confirm ${eq.confirmationTimeframe || '—'}</span>
      <span class="kp-weekly-bias ${weekly}">Weekly: ${weekly}</span>
      ${pattern ? `<span class="kp-pattern-label">Pattern: ${pattern}</span>` : ''}
    `;
  }

  const pickEl = document.querySelector('#kp-pick-card');
  if (pickEl) {
    const verdict = eq.pickVerdict || 'NO';
    const buyAt = eq.buyAt != null ? eq.buyAt : getSignalThresholds().actionableAt;
    const score = eq.score || 0;
    const pattern = eq.patternLabel || eq.indicators?.patternLabel || '';
    const checks = (eq.checklist || []).map(c =>
      `<div class="kp-check ${c.pass ? 'pass' : 'fail'}">
        <span class="kp-check-mark">${c.pass ? '✓' : '✕'}</span>
        <span>${c.label}</span>
        <span class="kp-check-detail">${c.detail || ''}</span>
      </div>`
    ).join('');
    pickEl.innerHTML = `
      <div class="kp-pick-verdict ${String(verdict).toLowerCase()}">Pick: ${verdict}</div>
      <div class="kp-pick-conf">Confidence ${score}% · Buy bar ${buyAt}%</div>
      ${pattern ? `<div class="kp-pick-pattern">Pattern: ${pattern}</div>` : ''}
      <div class="kp-pick-checks">${checks || '<div class="kp-check-detail">Collecting checklist…</div>'}</div>
    `;
  }

  const learnWhy = document.querySelector('#kp-learn-why');
  const learnDrivers = document.querySelector('#kp-learn-drivers');
  const learnTip = document.querySelector('#kp-learn-tip');
  if (learnWhy) learnWhy.textContent = eq.decisionWhy || (eq.reasons && eq.reasons[0]) || '—';
  if (learnDrivers) {
    const drivers = eq.topDrivers || [];
    learnDrivers.innerHTML = drivers.length
      ? drivers.map(d => `
          <div class="kp-learn-driver ${d.bias || 'neutral'}">
            <strong>${(d.id || '').toUpperCase()}</strong>
            <span>${d.plainWhy || ''}</span>
            <em>${d.score != null ? d.score + '/100' : ''}</em>
          </div>`).join('')
      : '<div class="kp-learn-driver neutral">Lessons appear when history is ready</div>';
  }
  if (learnTip) learnTip.textContent = eq.coachTip || 'Learn → decide → size → journal.';

  const holdMap = document.querySelector('#kp-hold-map');
  if (holdMap) {
    holdMap.innerHTML = `
      <div><strong>Hold map</strong> · ${eq.expectedHold || '—'}</div>
      <div>Invalidation = thesis broken at Stop ${formatPrice(eq.invalidationLevel)}</div>
      <div>Scale: book T1 · trail to T2/T3</div>
    `;
  }

  updateInvestorSizing(eq);

  const srAuto = document.querySelector('#kp-auto-sr');
  if (srAuto && eq.supportResistance) {
    const s = (eq.supportResistance.supports || []).slice(0, 3)
      .map(l => `<span class="kp-auto-s">S ${formatPrice(l.price)} (${l.touches || 0})</span>`).join('');
    const r = (eq.supportResistance.resistances || []).slice(0, 3)
      .map(l => `<span class="kp-auto-r">R ${formatPrice(l.price)} (${l.touches || 0})</span>`).join('');
    srAuto.innerHTML = (s + r) || '<span class="kp-sr-empty">No auto levels yet</span>';
  }
}

function updateLivePriceUI(price, symbol) {
  const panel = document.querySelector('.kp-signal-panel');
  if (!panel) return;
  const priceEl = panel.querySelector('#kp-signal-price');
  if (priceEl && Number.isFinite(Number(price)) && Number(price) > 0) {
    priceEl.textContent = formatPrice(price);
  }
  if (symbol) {
    const symbolEl = panel.querySelector('#kp-signal-symbol');
    if (symbolEl) symbolEl.textContent = symbol;
  }
}

function compactInstrumentKey(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function updateSignalEngine() {
  if (!initSignalEngine()) return;

  const now = Date.now();
  const peekCtx = getBrokerContext();
  const peekKind = window.KPSignalEngine?.classifyInstrument?.(peekCtx.symbol || '')?.kind;
  const tickEvery = (peekKind === 'option' || peekKind === 'index') ? 250 : 1000;
  if (now - lastTickScrapeTime < tickEvery) return;
  lastTickScrapeTime = now;

  const ctx = peekCtx;
  // Options/index: panel TF owns analysis — never auto-hijack from chart (that was
  // wiping the candle collector every time the chart TF flickered).
  const chartTf = ctx.timeframe;
  if (chartTf && SIGNAL_TF_MS[chartTf] && chartTf !== signalTimeframeId) {
    const userPicked = document.querySelector('.kp-tf-btn.active[data-user-picked="1"]');
    const positionalLocksDaily = (signalTradeMode === 'positional' || signalTradeMode === 'swing') && !isPositionalTf(chartTf);
    const peekInst = window.KPSignalEngine?.classifyInstrument?.(ctx.symbol || scrapeCurrentSymbol() || '');
    const isDeriv = peekInst?.kind === 'option' || peekInst?.kind === 'index';
    const equityStock = peekInst?.kind === 'equity' || signalInstrument?.kind === 'equity';
    if (!userPicked && !positionalLocksDaily && !equityStock && !isDeriv) {
      setSignalTimeframe(chartTf);
    }
  }

  const symbol = ctx.symbol || scrapeCurrentSymbol();
  const instrument = window.KPSignalEngine.classifyInstrument(symbol || signalActiveSymbol || '');
  if (!instrument.exchange && ctx.exchange) instrument.exchange = ctx.exchange;

  // Stick to an option once locked — don't flip to a watchlist equity mid-session.
  if (
    signalInstrument?.kind === 'option' &&
    instrument.kind === 'equity' &&
    compactInstrumentKey(signalActiveSymbol).length > 10
  ) {
    // keep prior option instrument
  } else if (
    signalInstrument?.kind === 'option' &&
    instrument.kind === 'option' &&
    sameOptionIdentity(signalInstrument.symbol, instrument.symbol)
  ) {
    // Keep locked option; prefer URL tradingsymbol when available
    const better = resolveKiteOptionTradingSymbol(instrument.symbol || symbol) ||
      resolveKiteOptionTradingSymbol(signalInstrument.symbol);
    if (better && better !== compactInstrumentKey(signalInstrument.symbol)) {
      signalInstrument = {
        ...signalInstrument,
        ...instrument,
        symbol: better
      };
    }
  } else {
    signalInstrument = instrument;
  }

  const isDeriv = signalInstrument?.kind === 'option' || signalInstrument?.kind === 'index';
  const symbolKey = isDeriv
    ? stableOptionSymbolKey(
      resolveKiteOptionTradingSymbol(signalInstrument?.symbol || symbol || signalActiveSymbol) ||
      signalInstrument?.symbol ||
      symbol ||
      signalActiveSymbol ||
      'UNKNOWN'
    )
    : compactInstrumentKey(
      (signalInstrument?.kind === 'option' ? signalInstrument.symbol : null) ||
      symbol ||
      signalActiveSymbol ||
      'UNKNOWN'
    );

  // Only reset collector on a *real* instrument change — not display↔trading rename.
  // CE → PE / new strike = new read (candles wiped + chart re-seeded).
  if (signalCandleCollector.symbol && sameOptionIdentity(signalCandleCollector.symbol, symbolKey)) {
    signalCandleCollector.symbol = symbolKey;
    signalActiveSymbol = symbolKey;
  } else if (signalCandleCollector.setSymbol(symbolKey)) {
    onSignalInstrumentSwitched(symbolKey);
  }

  updateLivePriceUI(undefined, signalInstrument.symbol || symbolKey);

  if (signalInstrument.kind === 'equity' && settings.stockAnalysis !== false) {
    const mode = signalTradeMode === 'positional' ? 'positional'
      : signalTradeMode === 'swing' ? 'swing'
        : signalTradeMode === 'scalp' ? 'scalp' : 'intraday';
    const analysisTf = equityAnalysisTimeframe(mode, signalTimeframeId);
    // Auto-fetch D/W/M/45m history on chart open (Upstox → Dhan → Yahoo).
    ensureStockHistory(signalInstrument, analysisTf).then((meta) => {
      if (!meta || meta.error) return;
      lastSignalTimestamp = 0;
      try { updateSignalEngine(); } catch (_) {}
    }).catch(() => {});
    refreshDhanLtp(signalInstrument);
    seedFromTradingPanel(symbolKey, false);
  } else if (signalInstrument.kind === 'option' || signalInstrument.kind === 'index') {
    const need = getSignalThresholds().minCandles;
    // Sync seed first (cached ChartIQ bars), then async refresh
    syncSeedFromChartSnap();
    seedFromTradingPanel(symbolKey, signalCandleCollector.getCandleCount() < need);
    const snap = window.KPChartReader?.readSnapshot?.() || {};
    stockHistory = [];
    stockHistoryKey = null;
    stockHistoryMeta = {
      source: 'Live chart',
      liveSource: `${ctx.brokerLabel || BROKER_LABEL} · ${chartEngineLabel(ctx)}`,
      chartEngine: snap.engine || ctx.chartEngine,
      requestedTimeframe: signalTimeframeId,
      candleCount: signalCandleCollector?.getCandleCount?.() || 0,
      error: null,
      note: signalInstrument.kind === 'option'
        ? `Option ${signalInstrument.optionType || ''} · live ticks · need ${need}×${signalTimeframeId}`
        : `Index · live ticks · need ${need}×${signalTimeframeId}`
    };
    updateDataBadge(stockHistoryMeta);
  }

  const scrapedPrice = scrapeCurrentPrice();
  const ctxLtp = ctx.ltp != null ? Number(ctx.ltp) : null;
  const dhanLtp = (dhanLtpCache.symbol === signalInstrument.symbol && Number.isFinite(dhanLtpCache.ltp))
    ? dhanLtpCache.ltp
    : null;
  let price = (signalInstrument.kind === 'option' || signalInstrument.kind === 'index')
    ? (Number.isFinite(Number(scrapedPrice)) && Number(scrapedPrice) > 0
      ? Number(scrapedPrice)
      : (Number.isFinite(ctxLtp) && ctxLtp > 0 && ctxLtp < 15000 ? ctxLtp : null))
    : resolveInstrumentPrice(signalInstrument, dhanLtp != null ? dhanLtp : (scrapedPrice ?? ctxLtp));

  const quoteTradingSym = resolveKiteOptionTradingSymbol(
    signalInstrument.symbol || symbolKey || ctx.symbol || ''
  ) || symbolKey;

  // Cached OMS quote — accept even if slightly stale
  if ((signalInstrument.kind === 'option' || signalInstrument.kind === 'index') && price == null) {
    if (
      kiteQuoteCache.ltp != null &&
      Number.isFinite(kiteQuoteCache.ltp) &&
      kiteQuoteCache.ltp > 0 &&
      (kiteQuoteCache.key === quoteTradingSym || sameOptionIdentity(kiteQuoteCache.key, quoteTradingSym)) &&
      Date.now() - (kiteQuoteCache.at || 0) < 15000
    ) {
      price = kiteQuoteCache.ltp;
    }
  }

  if (price == null) {
    try { window.KPChartReader?.refreshSnapshot?.(); } catch (_) {}
    const snap = window.KPChartReader?.readSnapshot?.() || {};
    const lastClose = snap.candles?.length ? Number(snap.candles[snap.candles.length - 1].close) : null;
    if (Number.isFinite(snap.ltp) && snap.ltp > 0 && snap.ltp < 20000) price = snap.ltp;
    else if (Number.isFinite(lastClose) && lastClose > 0 && lastClose < 20000) price = lastClose;
    else {
      const q2 = scrapeOptionQuoteLtp();
      if (q2 != null) price = q2;
    }
  }

  // Kick OMS quote with REAL tradingsymbol (URL), apply immediately when it returns
  if ((signalInstrument.kind === 'option' || signalInstrument.kind === 'index') &&
      (price == null || Date.now() - (kiteQuoteCache.at || 0) > 2000)) {
    fetchKiteQuoteLtp(quoteTradingSym || signalInstrument.symbol || symbolKey).then(ltp => {
      if (ltp == null) return;
      applyOptionLtpNow(ltp, signalInstrument?.symbol || quoteTradingSym);
    });
  }

  if (price == null && Number.isFinite(Number(lastSignalResult?.currentPrice))) {
    price = Number(lastSignalResult.currentPrice);
  }

  if (price == null) {
    const histRef = stockHistoryReferencePrice();
    const collectorCandles = signalCandleCollector?.getAllCandles?.() || [];
    const lastBar = collectorCandles[collectorCandles.length - 1];
    const fallback = histRef || (lastBar ? Number(lastBar.close) : null);
    if (Number.isFinite(fallback) && fallback > 0) {
      price = fallback;
    } else {
      const tip = quoteTradingSym
        ? `Waiting LTP · ${quoteTradingSym}`
        : 'Waiting for option LTP…';
      updateDataBadge({
        status: tip,
        level: 'warn'
      });
      const need = getSignalThresholds().minCandles;
      const needEl = document.querySelector('#kp-candle-need');
      if (needEl) needEl.textContent = String(need);
      if (lastSignalResult) updateSignalPanelUI(lastSignalResult);
      return;
    }
  }

  // Only reset on insane jumps when both values look like option premiums
  const lastClose = (() => {
    const all = signalCandleCollector?.getAllCandles?.() || [];
    const c = all[all.length - 1];
    return c ? Number(c.close) : null;
  })();
  if (
    signalInstrument.kind === 'option' &&
    lastClose != null && lastClose > 0 && lastClose < 15000 &&
    price > 0 && price < 15000 &&
    (price / lastClose > 10 || lastClose / price > 10)
  ) {
    if (DEBUG) console.log('[KitePlus] Reset candles — absurd LTP jump', lastClose, '→', price);
    signalCandleCollector.reset?.();
    chartSeedKey = null;
    chartSeedAt = 0;
    optionTickBuffer = [];
    lastSignalResult = null;
  }

  updateLivePriceUI(price, signalInstrument.symbol || symbolKey);
  checkSrAlerts(price);

  const ref = stockHistoryReferencePrice();
  const tickLooksValid = signalInstrument.kind === 'option' || signalInstrument.kind === 'index' ||
    signalInstrument.kind !== 'equity' || !ref || Math.abs(price - ref) / ref <= 0.2;
  if (tickLooksValid) {
    signalCandleCollector.addTick(price, now);
    signalCandleCollector.trim(500);
    if (signalInstrument.kind === 'option' || signalInstrument.kind === 'index') {
      recordOptionTick(price, now);
    }
  }

  if (signalInstrument.kind === 'option' || signalInstrument.kind === 'index') {
    const snap = window.KPChartReader?.readSnapshot?.() || {};
    const need = getSignalThresholds().minCandles;
    const analysisCandles = resolveAnalysisCandles(signalCandleCollector.getAllCandles(), price, now);
    const analysisCount = analysisCandles.length;
    updateDataBadge({
      source: 'Live chart',
      liveSource: `${ctx.brokerLabel || BROKER_LABEL} · ${chartEngineLabel(ctx)}`,
      chartEngine: snap.engine || ctx.chartEngine,
      requestedTimeframe: signalTimeframeId,
      candleCount: analysisCount,
      note: analysisCount < need
        ? `Collecting ${analysisCount}/${need} · live`
        : `Ready · ${signalInstrument.optionType || 'index'} bias live`,
      error: null
    });
    const countEl = document.querySelector('#kp-candle-count');
    const needEl = document.querySelector('#kp-candle-need');
    if (countEl) countEl.textContent = String(analysisCount);
    if (needEl) needEl.textContent = String(need);
  }

  if (now - lastSignalTimestamp < (signalInstrument.kind === 'option' ? 800 : 2000) && lastSignalResult) {
    const stillCollecting = (lastSignalResult.message || '').includes('Collecting');
    const needNow = getSignalThresholds().minCandles;
    const readyNow = (signalInstrument.kind === 'option' || signalInstrument.kind === 'index')
      ? resolveAnalysisCandles(signalCandleCollector.getAllCandles(), price, now).length >= needNow
      : (signalCandleCollector?.getCandleCount?.() || 0) >= needNow;
    // Don't freeze on Collecting once bars are ready — regenerate immediately
    if (!(stillCollecting && readyNow)) {
      lastSignalResult.currentPrice = price;
      lastSignalResult.instrument = signalInstrument;
      if (readyNow && lastSignalResult.candleCount != null) {
        lastSignalResult.candleCount = Math.max(lastSignalResult.candleCount, needNow);
      }
      updateSignalPanelUI(lastSignalResult);
      return;
    }
  }
  lastSignalTimestamp = now;

  let candles = signalCandleCollector.getAllCandles();
  if (signalInstrument.kind === 'equity' && stockHistory.length) {
    candles = [...stockHistory];
    const last = candles[candles.length - 1];
    if (last && tickLooksValid && Math.abs(last.close - price) / last.close > 0.0005) {
      candles.push({
        startTime: now,
        open: last.close,
        high: Math.max(last.close, price),
        low: Math.min(last.close, price),
        close: price,
        volume: 1,
        complete: false
      });
    }
  }

  if (signalInstrument.kind === 'option' || signalInstrument.kind === 'index') {
    candles = resolveAnalysisCandles(candles, price, now);
  }

  let result;
  // ── SWING MODE — use dedicated swing engine ──
  if (signalTradeMode === 'swing' && window.KPSwingEngine?.generateSwingSignal) {
    try {
      const swingResult = window.KPSwingEngine.generateSwingSignal(candles, {
        tradeState: swingTradeState
      });
      // Map swing result to panel result format
      const swingAction = swingResult.action === 'LONG' ? 'BUY'
        : swingResult.action === 'SHORT' ? 'BUY'
          : swingResult.action === 'HOLD_LONG' ? 'HOLD'
            : swingResult.action === 'HOLD_SHORT' ? 'HOLD'
              : 'WAIT';
      const swingDirection = swingResult.action === 'LONG' ? 'CE'
        : swingResult.action === 'SHORT' ? 'PE'
          : swingResult.action === 'HOLD_LONG' ? 'CE'
            : swingResult.action === 'HOLD_SHORT' ? 'PE'
              : null;
      const maxScore = 10;
      const domScore = Math.max(swingResult.longScore || 0, swingResult.shortScore || 0);
      const strengthPct = Math.round((domScore / maxScore) * 100);
      result = {
        direction: swingDirection,
        action: swingAction,
        strength: strengthPct,
        message: swingResult.status || 'WAIT',
        currentPrice: price,
        instrument: signalInstrument,
        mode: 'swing',
        thresholds: getSignalThresholds(),
        indicators: swingResult.indicators || {},
        brain: {
          momentum: 0,
          edge: Math.abs((swingResult.longScore || 0) - (swingResult.shortScore || 0)),
          agreement: domScore / maxScore,
          minCandles: swingResult.minCandles || 45
        },
        equity: true,
        swing: true,
        swingData: swingResult
      };
      lastEquityResult = null;
      renderSwingExtras(swingResult);
    } catch (err) {
      if (DEBUG) console.error('[KitePlus] Swing signal error', err);
      result = {
        direction: null,
        action: 'WAIT',
        strength: 0,
        message: `Swing engine error — ${err.message || 'retry'}`,
        currentPrice: price,
        instrument: signalInstrument,
        mode: 'swing',
        thresholds: getSignalThresholds(),
        indicators: {},
        brain: null,
        equity: true,
        swing: true
      };
    }
  } else if (signalInstrument.kind === 'equity' && window.KPPositionalEngine?.generateEquitySignal && settings.stockAnalysis !== false) {
    const mode = signalTradeMode === 'positional' ? 'positional'
      : signalTradeMode === 'scalp' ? 'scalp' : 'intraday';
    const analysisTf = equityAnalysisTimeframe(mode, signalTimeframeId);
    const tracked = trackedPositions[signalInstrument.symbol];
    try {
      const eq = window.KPPositionalEngine.generateEquitySignal(candles, {
        mode,
        timeframe: analysisTf,
        position: tracked || null,
        maxHorizonDays: tracked?.horizonDays || (mode === 'positional' ? 20 : undefined)
      });
      lastEquityResult = eq;
      result = equityResultToPanelResult(eq, signalInstrument);
      if (eq.supportResistance) syncAutoSrLevels(eq.supportResistance);
      maybeAlertEquityTransition(signalInstrument.symbol, eq.action, result);
      renderEquityExtras(eq);
    } catch (err) {
      if (DEBUG) console.error('[KitePlus] Equity signal error', err);
      updateDataBadge({
        status: `Analysis error: ${err.message || err}`,
        level: 'error'
      });
      result = {
        direction: null,
        action: 'WAIT',
        strength: 0,
        message: `Engine error — ${err.message || 'retry TF'}`,
        currentPrice: price,
        instrument: signalInstrument,
        mode: signalTradeMode,
        thresholds: getSignalThresholds(),
        indicators: {},
        brain: null,
        equity: true
      };
    }
  } else {
    const mode = signalTradeMode === 'positional' ? 'intraday' : signalTradeMode;
    if (!signalInstrument.symbol || signalInstrument.kind === 'other' || !signalInstrument.supported) {
      result = {
        direction: null,
        action: 'WAIT',
        strength: 0,
        message: 'Open an option or index chart',
        currentPrice: price,
        instrument: signalInstrument,
        mode: signalTradeMode,
        thresholds: getSignalThresholds(),
        indicators: {},
        brain: null,
        equity: false
      };
    } else {
      result = window.KPSignalEngine.generateSignals(candles, {
        ...signalInstrument,
        mode,
        minCandles: getSignalThresholds().minCandles
      });
      result.currentPrice = price;
      result.candleCount = candles.length;
      const buyFloor = (result.thresholds && result.thresholds.actionableAt) || getSignalThresholds().actionableAt;
      const actionable =
        result.action === 'BUY' && result.strength >= buyFloor &&
        result.direction && result.direction !== 'WAIT';

      const isNewSignal = actionable && (
        !lastSignalResult ||
        lastSignalResult.direction !== result.direction ||
        lastSignalResult.action !== result.action ||
        lastSignalResult.strength < buyFloor ||
        (lastSignalResult.instrument && lastSignalResult.instrument.symbol !== result.instrument.symbol)
      );

      if (isNewSignal) {
        const timeStr = new Date().toLocaleTimeString('en-US', {
          hour12: false, hour: '2-digit', minute: '2-digit'
        });
        signalHistory.unshift({
          time: timeStr,
          direction: result.direction,
          action: result.action,
          strength: result.strength,
          price: result.currentPrice,
          message: result.message,
          symbol: signalInstrument.symbol,
          timestamp: now
        });
        if (signalHistory.length > 50) signalHistory.pop();
        showSignalToast(result);
      }
    }
  }

  lastSignalResult = result;
  updateSignalPanelUI(result);
}

/** Rolling tick → short OHLC for options when panel history is empty. */
let optionTickBuffer = [];
function recordOptionTick(price, now = Date.now()) {
  if (!Number.isFinite(price) || price <= 0) return;
  optionTickBuffer.push({ t: now, p: price });
  const cutoff = now - 20 * 60 * 1000;
  optionTickBuffer = optionTickBuffer.filter(x => x.t >= cutoff);
}

function buildFastCandlesFromTicks(price, now, intervalMs, record = true) {
  if (record) recordOptionTick(price, now);
  if (optionTickBuffer.length < 4) {
    return signalCandleCollector?.getAllCandles?.() || [];
  }

  const map = new Map();
  optionTickBuffer.forEach(({ t, p }) => {
    const start = Math.floor(t / intervalMs) * intervalMs;
    const bucket = map.get(start);
    if (!bucket) {
      map.set(start, { startTime: start, open: p, high: p, low: p, close: p, volume: 1, complete: true });
    } else {
      bucket.high = Math.max(bucket.high, p);
      bucket.low = Math.min(bucket.low, p);
      bucket.close = p;
      bucket.volume += 1;
    }
  });
  return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
}

/**
 * Group ticks into bars by count — only used for UI progress, NOT for BUY decisions.
 * Fake flat bars were firing weak BUYs; analysis path no longer uses these.
 */
function buildTickGroupCandles(need = 8) {
  const ticks = optionTickBuffer;
  if (!ticks.length || ticks.length < 4) return [];
  const target = Math.max(4, need);
  const perBar = Math.max(2, Math.floor(ticks.length / target));
  const bars = [];
  for (let i = 0; i + 1 < ticks.length && bars.length < 200; i += perBar) {
    const slice = ticks.slice(i, Math.min(ticks.length, i + perBar));
    if (slice.length < 1) break;
    const prices = slice.map(x => x.p);
    const open = prices[0];
    const close = prices[prices.length - 1];
    bars.push({
      startTime: slice[0].t,
      open,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close,
      volume: slice.length,
      complete: true
    });
  }
  return bars;
}

function filterPremiumCandles(candles) {
  return (candles || []).filter(c => {
    const close = Number(c?.close);
    return Number.isFinite(close) && close >= 0.05 && close < 15000;
  });
}

/** True if candle set has enough movement for technicals (not flat noise). */
function candlesHaveRealRange(candles, minPct = 0.15) {
  const closes = (candles || []).map(c => Number(c.close)).filter(n => Number.isFinite(n) && n > 0);
  if (closes.length < 4) return false;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  return lo > 0 && ((hi - lo) / lo) * 100 >= minPct;
}

/**
 * Prefer real chart/collector OHLC. Micro tick bars only if they show real movement.
 * Never use tick-group fakes for signal math.
 */
function resolveAnalysisCandles(baseCandles, price, now) {
  let candles = filterPremiumCandles(baseCandles);
  const need = getSignalThresholds().minCandles;
  const minPct = signalTradeMode === 'scalp' ? 0.15 : 0.25;

  if (candles.length >= need && candlesHaveRealRange(candles, minPct)) return candles;

  const microMs = signalTradeMode === 'scalp' ? 15 * 1000 : 60 * 1000;
  const fast = filterPremiumCandles(buildFastCandlesFromTicks(price, now, microMs, false));
  if (fast.length >= need && candlesHaveRealRange(fast, minPct)) return fast;

  // Prefer whichever has more real structure; engine will WAIT if still thin/flat
  if (fast.length > candles.length && candlesHaveRealRange(fast, minPct * 0.5)) return fast;
  return candles;
}

function handleSignalPanel() {
  if (!settings.signals) {
    document.querySelector('.kp-signal-panel')?.remove();
    document.querySelector('.kp-signal-toast')?.remove();
    document.querySelector('.kp-sr-toast')?.remove();
    return;
  }

  const isChartPage = window.KPBrokerAdapters?.detectBroker?.()?.isChartPage?.() ||
    window.location.pathname.includes('/chart') ||
    window.location.href.includes('mock-kite.html') ||
    document.getElementById('mock-kite-dashboard') !== null ||
    document.querySelector('.chart-container, .chart-widget, .tv-chart') !== null;
  const isPositionsPage = window.location.pathname.includes('/positions');

  if (!isChartPage && !(IS_KITE && isPositionsPage)) {
    document.querySelector('.kp-signal-panel')?.remove();
    return;
  }

  let panel = document.querySelector('.kp-signal-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'kp-signal-panel';
    applyBrokerTheme(panel);
    if (signalPanelCollapsed) panel.classList.add('collapsed');

    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get([
        'signalPanelTop', 'signalPanelLeft', 'signalPanelWidth', 'signalPanelHeight'
      ]).then(res => {
        const minW = 400;
        const defaultW = '460px';
        let width = res.signalPanelWidth;
        let height = res.signalPanelHeight;
        if (width) {
          const w = parseInt(width, 10);
          // Upgrade old cramped 320–380 saves; only clamp truly huge old modal sizes
          if (!Number.isFinite(w) || w < minW) width = defaultW;
          else if (w > 720) width = defaultW;
        } else {
          width = defaultW;
        }
        if (height) {
          const h = parseInt(height, 10);
          if (!Number.isFinite(h) || h > window.innerHeight - 24) {
            height = '';
          }
        }
        if (width) panel.style.width = width;
        if (height && !signalPanelCollapsed) panel.style.height = height;
        if (res.signalPanelLeft) {
          placeSignalPanel(panel, res.signalPanelLeft, res.signalPanelTop || '56px');
        } else {
          centerSignalPanel(panel);
        }
      });
    } else {
      requestAnimationFrame(() => centerSignalPanel(panel));
    }

    document.body.appendChild(panel);
    loadSignalPrefs().then(() => renderSignalPanel(panel));
  } else {
    applyBrokerTheme(panel);
  }
}

function placeSignalPanel(panel, left, top) {
  panel.classList.add('kp-placed');
  panel.style.transform = 'none';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  let leftPx = typeof left === 'number' ? left : parseInt(left, 10);
  let topPx = typeof top === 'number' ? top : parseInt(top, 10);
  if (!Number.isFinite(leftPx) || !Number.isFinite(topPx)) {
    centerSignalPanel(panel);
    return;
  }
  // Keep panel on-screen (saved coords can push it off after resize)
  const w = Math.max(panel.offsetWidth || 460, 400);
  const h = Math.max(panel.offsetHeight || 200, 48);
  leftPx = Math.max(8, Math.min(leftPx, window.innerWidth - Math.min(w, 200)));
  topPx = Math.max(8, Math.min(topPx, window.innerHeight - Math.min(h, 80)));
  panel.style.left = `${leftPx}px`;
  panel.style.top = `${topPx}px`;
}

function centerSignalPanel(panel) {
  if (!panel) return;
  // Dock right — cleaner than a centered modal over the chart.
  panel.classList.remove('kp-placed');
  panel.style.transform = 'none';
  panel.style.left = 'auto';
  panel.style.right = '12px';
  panel.style.top = '56px';
  panel.style.bottom = '12px';
  panel.style.width = Math.min(460, window.innerWidth - 24) + 'px';
  if (!signalPanelCollapsed) {
    panel.style.height = 'auto';
    panel.style.maxHeight = (window.innerHeight - 68) + 'px';
  }
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({
      signalPanelTop: panel.style.top,
      signalPanelLeft: '',
      signalPanelWidth: panel.style.width,
      signalPanelHeight: signalPanelCollapsed ? undefined : panel.style.height
    });
  }
}

function saveSignalPanelGeometry(panel) {
  if (!panel || typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.local.set({
    signalPanelTop: panel.style.top,
    signalPanelLeft: panel.style.left,
    signalPanelWidth: panel.style.width,
    signalPanelHeight: signalPanelCollapsed ? undefined : panel.style.height
  });
}

function saveSignalSectionsCollapsed() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    chrome.storage.local.set({ signalSectionsCollapsed });
  }
}

function kpIcon(name) {
  const common = 'class="kp-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const map = {
    guide: `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none"/></svg>`,
    levels: `<svg ${common}><path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h14"/></svg>`,
    indicators: `<svg ${common}><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15l3-4 3 2 5-7"/></svg>`,
    history: `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    backtest: `<svg ${common}><path d="M4 19h16"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-4"/></svg>`,
    wait: `<svg ${common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
    buy: `<svg ${common}><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>`,
    hold: `<svg ${common}><path d="M8 5v14"/><path d="M16 5v14"/></svg>`,
    exit: `<svg ${common}><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>`,
    stop: `<svg ${common}><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/></svg>`,
    target: `<svg ${common}><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>`,
    track: `<svg ${common}><path d="M12 3v4"/><circle cx="12" cy="14" r="7"/><path d="M12 11v3l2 2"/></svg>`
  };
  return map[name] || '';
}

function sectionCollapsedClass(id) {
  return signalSectionsCollapsed[id] ? ' is-collapsed' : '';
}

function sectionToggleLabel(id) {
  return signalSectionsCollapsed[id] ? 'Expand' : 'Collapse';
}

function renderSignalPanel(panel) {
  applyBrokerTheme(panel);
  const analysisTf = equityAnalysisTimeframe(signalTradeMode, signalTimeframeId);
  const tfButtons = Object.keys(SIGNAL_TF_MS).map(id => {
    const blocked = (signalTradeMode === 'positional' || signalTradeMode === 'swing') && !isPositionalTf(id);
    const active = (signalTradeMode === 'positional' || signalTradeMode === 'swing') ? id === analysisTf : id === signalTimeframeId;
    return `<button type="button" class="kp-tf-btn${active ? ' active' : ''}${blocked ? ' is-blocked' : ''}" data-tf="${id}" ${blocked ? 'disabled' : ''} title="${blocked ? (signalTradeMode === 'swing' ? 'Swing Pro uses 1D / 1W' : 'Positional uses 1D / 1W / 1M') : `Analyze on ${id}`}">${id}</button>`;
  }).join('');
  const thr = getSignalThresholds();

  const activeBroker = getActiveBrokerInfo();
  panel.innerHTML = `
    <div class="kp-signal-header" id="kp-signal-toggle">
      <div class="kp-signal-header-left">
        <span class="kp-signal-mark">M</span>
        <span class="kp-signal-header-title">Megamind</span>
        <span class="kp-broker-chip">${activeBroker.label}</span>
      </div>
      <div class="kp-signal-header-right">
        <button type="button" class="kp-signal-theme-btn" id="kp-signal-theme-toggle" title="Toggle Daylight / Dark Theme">${panelTheme === 'dark' ? '☀️ Day' : '🌙 Dark'}</button>
        <button type="button" class="kp-signal-collapse-btn" id="kp-signal-collapse" title="${signalPanelCollapsed ? 'Expand panel' : 'Collapse panel'}">${signalPanelCollapsed ? 'Expand' : 'Collapse'}</button>
        <button type="button" class="kp-signal-center-btn" id="kp-signal-center" title="Dock right">Dock</button>
        <span class="kp-signal-header-badge collecting" id="kp-signal-header-badge">…</span>
        <button class="kp-signal-close-btn" id="kp-signal-close" title="Close" type="button">×</button>
      </div>
    </div>
    <div class="kp-signal-body kp-focus-body">
      <div class="kp-mode-bar kp-focus-modes">
        <button type="button" class="kp-mode-btn${signalTradeMode === 'scalp' ? ' active' : ''}" data-mode="scalp" title="Minutes · tight stops">
          <span class="kp-mode-name">Scalp</span>
        </button>
        <button type="button" class="kp-mode-btn${signalTradeMode === 'intraday' ? ' active' : ''}" data-mode="intraday" title="Same session · no overnight">
          <span class="kp-mode-name">Intraday</span>
        </button>
        <button type="button" class="kp-mode-btn${signalTradeMode === 'swing' ? ' active' : ''}" data-mode="swing" title="Daily structure · 1:2 R:R">
          <span class="kp-mode-name">Swing</span>
        </button>
        <button type="button" class="kp-mode-btn${signalTradeMode === 'positional' ? ' active' : ''}" data-mode="positional" title="Multi-day · daily/weekly">
          <span class="kp-mode-name">Positional</span>
        </button>
      </div>
      <div class="kp-focus-rule" id="kp-mode-thresholds" title="Act when confluence clears these bars">${signalTradeMode === 'swing' ? `Swing Pro · Rating ≥${window.KPSwingEngine?.DEFAULTS?.minimumScore || 7.5}/10` : `Strong ≥${thr.strongAt}% · Buy ≥${thr.actionableAt}%`}</div>

      <div class="kp-data-badge kp-focus-data" id="kp-data-badge">Waiting for chart…</div>

      <div class="kp-panel-section${sectionCollapsedClass('guide')}" data-section="guide">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('guide')}
            <span class="kp-section-title">How to read</span>
            <span class="kp-section-hint">decision flow</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="guide">${sectionToggleLabel('guide')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-read-guide">
            <p><strong>1</strong> Read the decision — BUY / WAIT / HOLD / EXIT.</p>
            <p><strong>2</strong> Confirm checklist and levels (Stop · T1–T3).</p>
            <p><strong>3</strong> Size with risk % (education only).</p>
            <p><strong>4</strong> Journal outcomes to improve your process.</p>
          </div>
        </div>
      </div>

      <div class="kp-focus-meta">
        <div class="kp-focus-meta-item">
          <span class="kp-meta-label">Symbol</span>
          <span class="kp-meta-value" id="kp-signal-symbol">—</span>
        </div>
        <div class="kp-focus-meta-item">
          <span class="kp-meta-label">Mode</span>
          <span class="kp-meta-value" id="kp-signal-mode">—</span>
        </div>
        <div class="kp-focus-meta-item">
          <span class="kp-meta-label">Ready</span>
          <span class="kp-meta-value"><span id="kp-candle-count">0</span>/<span id="kp-candle-need">${thr.minCandles}</span></span>
        </div>
        <div class="kp-focus-meta-item">
          <span class="kp-meta-label">LTP</span>
          <span class="kp-meta-value" id="kp-signal-price">—</span>
        </div>
      </div>

      <div class="kp-signal-tf kp-focus-tf">
        <span class="kp-tf-label" id="kp-tf-label" title="Candle size">TF</span>
        <div class="kp-tf-group" id="kp-tf-group">${tfButtons}</div>
      </div>
      <div class="kp-tf-hint" id="kp-tf-hint">${signalTradeMode === 'swing'
        ? `Swing Pro · analyzing ${analysisTf} · Structure + 1:2 RR`
        : signalTradeMode === 'positional'
          ? `Positional · analyzing ${analysisTf}`
          : signalTradeMode === 'scalp'
            ? 'Scalp · keep TF tight (1m–5m)'
            : 'Intraday · match the candle you trade'}</div>

      <div class="kp-signal-main kp-focus-main" id="kp-signal-main">
        <div class="kp-focus-kicker">Decision</div>
        <div class="kp-signal-main-badge neutral" id="kp-signal-main-badge">Collecting…</div>
        <div class="kp-signal-strength-bar">
          <div class="kp-signal-strength-fill neutral" id="kp-signal-strength-fill" style="width:0%"></div>
        </div>
        <div class="kp-signal-strength-label" id="kp-signal-strength-label">Confluence 0%</div>
        <div class="kp-brain-row" id="kp-brain-row"></div>
        <div class="kp-pick-card" id="kp-pick-card"></div>
        <div class="kp-equity-levels" id="kp-equity-levels"></div>
        <div class="kp-equity-meta" id="kp-equity-meta"></div>
        <div class="kp-equity-reasons" id="kp-equity-reasons"></div>
        <div class="kp-focus-actions">
          <button type="button" class="kp-log-idea-btn" id="kp-log-idea">Log idea</button>
        </div>
      </div>

      <div class="kp-panel-section${sectionCollapsedClass('learn')}" data-section="learn">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('guide')}
            <span class="kp-section-title">Learn</span>
            <span class="kp-section-hint">why this decision</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="learn">${sectionToggleLabel('learn')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-learn-why" id="kp-learn-why">—</div>
          <div class="kp-learn-drivers" id="kp-learn-drivers"></div>
          <div class="kp-learn-tip" id="kp-learn-tip">Learn → decide → size → journal.</div>
        </div>
      </div>

      <div class="kp-panel-section${sectionCollapsedClass('invest')}" data-section="invest">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('target')}
            <span class="kp-section-title">Investor plan</span>
            <span class="kp-section-hint">risk % · hold map</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="invest">${sectionToggleLabel('invest')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-invest-row">
            <label title="Percent of capital you are willing to lose if Stop hits">
              Risk %
              <input type="number" id="kp-risk-pct" class="kp-bt-hold" min="0.25" max="5" step="0.25" value="${investorRiskPct}" />
            </label>
            <label title="Notional capital for educational sizing">
              Capital ₹
              <input type="number" id="kp-risk-capital" class="kp-sr-input kp-capital-input" min="1000" step="1000" value="${investorCapital}" />
            </label>
          </div>
          <div class="kp-size-qty" id="kp-size-qty">— shares</div>
          <div class="kp-hold-map" id="kp-hold-map"></div>
          <div class="kp-field-hint">Sizing is educational only — not an order. Stop hit ≈ you lose the risk %.</div>
        </div>
      </div>

      <div class="kp-panel-section${sectionCollapsedClass('tools')}" data-section="tools">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('track')}
            <span class="kp-section-title">Track</span>
            <span class="kp-section-hint">optional watch</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="tools">${sectionToggleLabel('tools')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-track-row">
            <label title="Trading days to watch after Track">
              Horizon (days)
              <input type="number" id="kp-track-horizon" class="kp-bt-hold" min="5" max="20" value="10" />
            </label>
            <button type="button" class="kp-track-btn" id="kp-track-btn" title="Remember entry + watch for stop/target">Track</button>
            <button type="button" class="kp-track-clear" id="kp-track-clear">Clear</button>
          </div>
          <div class="kp-field-hint">Track also logs a journal idea so you can mark T1 / Stop later.</div>
        </div>
      </div>

      <div class="kp-panel-section${sectionCollapsedClass('journal')}" data-section="journal">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('history')}
            <span class="kp-section-title">Journal</span>
            <span class="kp-section-hint">your process</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="journal">${sectionToggleLabel('journal')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-journal-summary" id="kp-journal-summary">Log ideas to build your personal hit-rate</div>
          <div class="kp-journal-list" id="kp-journal-list"></div>
        </div>
      </div>

      <div class="kp-panel-section kp-sr-section${sectionCollapsedClass('sr')}" data-section="sr">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('levels')}
            <span class="kp-section-title">S / R</span>
            <span class="kp-section-hint">levels only</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="sr">${sectionToggleLabel('sr')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-auto-sr" id="kp-auto-sr"></div>
          <div class="kp-sr-form">
            <input type="number" id="kp-sr-price" class="kp-sr-input" placeholder="Level price" step="any" />
            <select id="kp-sr-type" class="kp-sr-select">
              <option value="support">Support</option>
              <option value="resistance">Resistance</option>
            </select>
            <button type="button" class="kp-sr-add" id="kp-sr-add">Add</button>
          </div>
          <button type="button" class="kp-sr-ltp" id="kp-sr-ltp">Use current LTP as level</button>
          <div class="kp-sr-list" id="kp-sr-list"></div>
        </div>
      </div>

      <div class="kp-panel-section kp-signal-indicators${sectionCollapsedClass('indicators')}" data-section="indicators">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('indicators')}
            <span class="kp-section-title">Indicators</span>
            <span class="kp-section-hint">detail · optional</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="indicators">${sectionToggleLabel('indicators')}</button>
        </div>
        <div class="kp-section-body">
          <div id="kp-signal-indicator-rows"></div>
        </div>
      </div>

      <div class="kp-panel-section kp-signal-history${sectionCollapsedClass('history')}" data-section="history">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('history')}
            <span class="kp-section-title">History</span>
            <span class="kp-section-hint">recent · <span id="kp-signal-history-count">0</span></span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="history">${sectionToggleLabel('history')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-signal-history-list" id="kp-signal-history-list">
            <div class="kp-signal-history-empty">No signals yet</div>
          </div>
        </div>
      </div>

      <div class="kp-panel-section kp-bt-section${sectionCollapsedClass('backtest')}" data-section="backtest">
        <div class="kp-section-head">
          <div class="kp-section-head-left">
            ${kpIcon('backtest')}
            <span class="kp-section-title">Backtest</span>
            <span class="kp-section-hint">past only</span>
          </div>
          <button type="button" class="kp-section-toggle" data-section-toggle="backtest">${sectionToggleLabel('backtest')}</button>
        </div>
        <div class="kp-section-body">
          <div class="kp-field-hint">Hold = exit after N candles in the test. “This chart” uses the open stock; Index uses Nifty/Sensex/Bank Nifty.</div>
          <div class="kp-bt-row">
            <select id="kp-bt-index" class="kp-sr-select" title="Index for Index backtest">
              <option value="NIFTY">Nifty</option>
              <option value="SENSEX">Sensex</option>
              <option value="BANKNIFTY">Bank Nifty</option>
            </select>
            <label class="kp-bt-hold-label" title="Exit trade after this many candles">
              Hold (bars)
              <input type="number" id="kp-bt-hold" class="kp-bt-hold" min="1" max="20" value="${defaultHoldBars()}" />
            </label>
          </div>
          <div class="kp-bt-actions">
            <button type="button" class="kp-bt-run" id="kp-bt-run-chart" title="Backtest the stock on this chart">This chart</button>
            <button type="button" class="kp-bt-run" id="kp-bt-run" title="Backtest selected index">Index</button>
            <button type="button" class="kp-bt-csv" id="kp-bt-csv" title="Upload your own candles CSV">CSV</button>
            <input type="file" id="kp-bt-file" accept=".csv,text/csv,text/plain" hidden />
          </div>
          <input type="text" id="kp-bt-symbol" class="kp-sr-input kp-bt-symbol" placeholder="CSV symbol e.g. RELIANCE or SENSEX 77300 PE" />
          <div class="kp-bt-status" id="kp-bt-status">Uses current mode + TF · Yahoo history or CSV</div>
          <div class="kp-bt-results" id="kp-bt-results"></div>
        </div>
      </div>

      <div class="kp-signal-footer">
        <button class="kp-signal-add-basket-btn" id="kp-signal-add-basket" disabled type="button">
          Add to Express Basket
        </button>
        <div class="kp-signal-disclaimer">Focus · analysis only · not advice · past ≠ future</div>
      </div>
    </div>
    <div class="kp-signal-resize" id="kp-signal-resize" title="Drag to resize"></div>
  `;

  renderSrAlertList();
  bindSignalPanelEvents(panel);
  refreshTfButtonStates();
  renderJournalList();
  if (lastEquityResult) renderEquityExtras(lastEquityResult);
  if (!panel.classList.contains('kp-placed')) {
    requestAnimationFrame(() => centerSignalPanel(panel));
  }
  if (lastBacktestReport) renderBacktestReport(lastBacktestReport);
}

function renderSrAlertList() {
  const list = document.getElementById('kp-sr-list');
  if (!list) return;
  if (!srAlerts.length) {
    list.innerHTML = '<div class="kp-sr-empty">Add support / resistance levels from the chart</div>';
    return;
  }
  list.innerHTML = srAlerts.map(a => `
    <div class="kp-sr-item" data-id="${a.id}">
      <label class="kp-sr-toggle">
        <input type="checkbox" ${a.enabled ? 'checked' : ''} data-sr-toggle="${a.id}" />
        <span class="kp-sr-type-tag ${a.type}">${a.type === 'support' ? 'S' : 'R'}</span>
        <span class="kp-sr-level">${formatPrice(a.price)}</span>
        ${a.auto ? `<span class="kp-sr-auto">Auto${a.touches ? ` · ${a.touches}` : ''}</span>` : ''}
      </label>
      <button type="button" class="kp-sr-del" data-sr-del="${a.id}" title="Remove">×</button>
    </div>
  `).join('');
}

function bindSignalPanelEvents(panel) {
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

    if (!panel.classList.contains('kp-placed')) {
      const rect = panel.getBoundingClientRect();
      placeSignalPanel(panel, rect.left, rect.top);
      panel.style.width = rect.width + 'px';
      panel.style.height = rect.height + 'px';
    }

    let pos3 = e.clientX;
    let pos4 = e.clientY;

    function onMouseMove(moveEv) {
      if (!dragActive) return;
      if (Math.abs(moveEv.clientX - startX) > 5 || Math.abs(moveEv.clientY - startY) > 5) {
        isDragging = true;
      }
      const dx = moveEv.clientX - pos3;
      const dy = moveEv.clientY - pos4;
      pos3 = moveEv.clientX;
      pos4 = moveEv.clientY;
      let newTop = panel.offsetTop + dy;
      let newLeft = panel.offsetLeft + dx;
      const rect = panel.getBoundingClientRect();
      const maxTop = window.innerHeight - (signalPanelCollapsed ? 48 : Math.min(rect.height, 80));
      const maxLeft = window.innerWidth - Math.min(rect.width, 80);
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
      if (isDragging) saveSignalPanelGeometry(panel);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function setSignalPanelCollapsed(collapsed) {
    signalPanelCollapsed = !!collapsed;
    panel.classList.toggle('collapsed', signalPanelCollapsed);
    const btn = panel.querySelector('#kp-signal-collapse');
    if (btn) {
      btn.textContent = signalPanelCollapsed ? 'Expand' : 'Collapse';
      btn.title = signalPanelCollapsed ? 'Expand panel' : 'Collapse panel';
    }
    if (!signalPanelCollapsed) {
      const h = parseInt(panel.style.height, 10);
      if (!Number.isFinite(h) || h <= 48) {
        panel.style.height = Math.min(680, window.innerHeight - 40) + 'px';
      }
    }
    saveSignalPanelGeometry(panel);
  }

  panel.querySelector('#kp-signal-theme-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePanelTheme();
  });

  panel.querySelector('#kp-signal-collapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setSignalPanelCollapsed(!signalPanelCollapsed);
  });

  panel.querySelectorAll('[data-section-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-section-toggle');
      if (!id) return;
      signalSectionsCollapsed[id] = !signalSectionsCollapsed[id];
      const section = panel.querySelector(`[data-section="${id}"]`);
      if (section) section.classList.toggle('is-collapsed', !!signalSectionsCollapsed[id]);
      btn.textContent = sectionToggleLabel(id);
      saveSignalSectionsCollapsed();
    });
  });

  panel.querySelector('#kp-signal-center')?.addEventListener('click', (e) => {
    e.stopPropagation();
    centerSignalPanel(panel);
  });

  const resizeHandle = panel.querySelector('#kp-signal-resize');
  resizeHandle?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!panel.classList.contains('kp-placed')) {
      const rect = panel.getBoundingClientRect();
      placeSignalPanel(panel, rect.left, rect.top);
    }
    const startW = panel.offsetWidth;
    const startH = panel.offsetHeight;
    const originX = e.clientX;
    const originY = e.clientY;

    function onResizeMove(moveEv) {
      const nextW = Math.max(400, Math.min(window.innerWidth - panel.offsetLeft - 8, startW + (moveEv.clientX - originX)));
      const nextH = Math.max(360, Math.min(window.innerHeight - panel.offsetTop - 8, startH + (moveEv.clientY - originY)));
      panel.style.width = nextW + 'px';
      if (!signalPanelCollapsed) panel.style.height = nextH + 'px';
    }

    function onResizeUp() {
      document.removeEventListener('mousemove', onResizeMove);
      document.removeEventListener('mouseup', onResizeUp);
      saveSignalPanelGeometry(panel);
    }

    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
  });

  panel.querySelector('#kp-signal-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Collapse only — do NOT disable settings.signals (that made the panel "vanish")
    signalPanelCollapsed = true;
    panel.classList.add('collapsed');
    const chevron = panel.querySelector('#kp-signal-collapse');
    if (chevron) chevron.textContent = '▲';
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ signalPanelCollapsed: true });
    }
  });

  panel.querySelector('#kp-tf-group')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.kp-tf-btn');
    if (!btn || btn.disabled || btn.classList.contains('is-blocked')) return;
    document.querySelectorAll('.kp-tf-btn').forEach(b => b.removeAttribute('data-user-picked'));
    btn.dataset.userPicked = '1';
    setSignalTimeframe(btn.dataset.tf);
  });

  panel.querySelector('.kp-mode-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.kp-mode-btn');
    if (!btn) return;
    setSignalTradeMode(btn.dataset.mode);
  });

  panel.querySelector('#kp-bt-hold')?.addEventListener('input', (e) => {
    e.target.dataset.userEdited = '1';
  });

  panel.querySelector('#kp-bt-run')?.addEventListener('click', () => {
    runIndexBacktest();
  });

  panel.querySelector('#kp-bt-run-chart')?.addEventListener('click', () => {
    runChartStockBacktest();
  });

  panel.querySelector('#kp-track-btn')?.addEventListener('click', () => {
    const inst = signalInstrument;
    if (!inst?.symbol || inst.kind !== 'equity') return;
    const price = lastSignalResult?.currentPrice || scrapeCurrentPrice();
    const horizon = parseInt(document.querySelector('#kp-track-horizon')?.value, 10) || 10;
    trackedPositions[inst.symbol] = {
      entryPrice: price,
      entryTime: Date.now(),
      horizonDays: Math.max(5, Math.min(20, horizon)),
      invalidationLevel: lastEquityResult?.invalidationLevel,
      targetLevel: lastEquityResult?.targetLevel
    };
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ trackedPositions });
    }
    logJournalIdea({
      symbol: inst.symbol,
      action: lastEquityResult?.action || 'HOLD',
      entry: price,
      stop: lastEquityResult?.invalidationLevel,
      score: lastEquityResult?.score,
      userNote: `Tracked ${horizon}d`
    });
    setBacktestStatus(`Tracking ${inst.symbol} for ${horizon} trading days · journal logged`);
  });

  panel.querySelector('#kp-log-idea')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const inst = signalInstrument;
    if (!inst?.symbol || inst.kind !== 'equity') {
      setBacktestStatus('Open an equity chart to log an idea', true);
      return;
    }
    logJournalIdea({
      symbol: inst.symbol,
      action: lastEquityResult?.action || lastSignalResult?.action || 'WAIT',
      score: lastEquityResult?.score || lastSignalResult?.strength
    });
    setBacktestStatus(`Journaled ${inst.symbol}`);
  });

  const persistRisk = () => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ investorRiskPct, investorCapital });
    }
    updateInvestorSizing(lastEquityResult);
  };

  panel.querySelector('#kp-risk-pct')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      investorRiskPct = Math.min(5, Math.max(0.25, v));
      persistRisk();
    }
  });

  panel.querySelector('#kp-risk-capital')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= 1000) {
      investorCapital = v;
      persistRisk();
    }
  });

  panel.querySelector('#kp-journal-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-j-out]');
    if (!btn) return;
    setJournalOutcome(btn.getAttribute('data-j-id'), btn.getAttribute('data-j-out'));
  });

  panel.querySelector('#kp-track-clear')?.addEventListener('click', () => {
    const inst = signalInstrument;
    if (!inst?.symbol) return;
    delete trackedPositions[inst.symbol];
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ trackedPositions });
    }
    setBacktestStatus(`Cleared track for ${inst.symbol}`);
  });

  panel.querySelector('#kp-bt-csv')?.addEventListener('click', () => {
    panel.querySelector('#kp-bt-file')?.click();
  });

  panel.querySelector('#kp-bt-file')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => runCsvBacktest(String(reader.result || ''), file.name);
    reader.onerror = () => setBacktestStatus('Failed to read CSV', true);
    reader.readAsText(file);
    e.target.value = '';
  });

  panel.querySelector('#kp-sr-add')?.addEventListener('click', () => {
    const input = panel.querySelector('#kp-sr-price');
    const typeEl = panel.querySelector('#kp-sr-type');
    const price = parseFloat(input?.value);
    if (isNaN(price) || price <= 0) {
      input?.focus();
      return;
    }
    srAlerts.unshift({
      id: 'sr_' + Date.now().toString(36),
      price,
      type: typeEl?.value === 'resistance' ? 'resistance' : 'support',
      enabled: true,
      lastTriggered: 0
    });
    if (srAlerts.length > 20) srAlerts.pop();
    saveSrAlerts();
    if (input) input.value = '';
    renderSrAlertList();
  });

  panel.querySelector('#kp-sr-ltp')?.addEventListener('click', () => {
    const px = scrapeCurrentPrice() || lastSignalResult?.currentPrice;
    const input = panel.querySelector('#kp-sr-price');
    if (px && input) {
      input.value = String(Math.round(px * 100) / 100);
      input.focus();
    }
  });

  panel.querySelector('#kp-sr-list')?.addEventListener('click', (e) => {
    const del = e.target.closest('[data-sr-del]');
    if (del) {
      srAlerts = srAlerts.filter(a => a.id !== del.dataset.srDel);
      saveSrAlerts();
      renderSrAlertList();
      return;
    }
  });

  panel.querySelector('#kp-sr-list')?.addEventListener('change', (e) => {
    const tog = e.target.closest('[data-sr-toggle]');
    if (!tog) return;
    const alert = srAlerts.find(a => a.id === tog.dataset.srToggle);
    if (alert) {
      alert.enabled = tog.checked;
      saveSrAlerts();
    }
  });

  // Quick-add: use current LTP as level
  panel.querySelector('#kp-sr-price')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#kp-sr-add')?.click();
  });

  panel.querySelector('#kp-signal-add-basket')?.addEventListener('click', () => {
    const floor = getSignalThresholds().actionableAt;
    if (!lastSignalResult || lastSignalResult.action !== 'BUY' || lastSignalResult.strength < floor) return;
    const symbol = scrapeCurrentSymbol() || 'NIFTY';
    const price = lastSignalResult.currentPrice || 100;
    let legName;
    if (lastSignalResult.instrument?.kind === 'option') {
      legName = lastSignalResult.instrument.symbol;
    } else {
      const und = lastSignalResult.instrument?.underlying || symbol;
      legName = `${und} ${lastSignalResult.direction}`;
    }
    addLegToBasket(legName, 'BUY', price);
    openBasketSidebar();
  });
}

function setBacktestStatus(text, isError) {
  const el = document.querySelector('#kp-bt-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

function getBacktestHoldBars() {
  const input = document.querySelector('#kp-bt-hold');
  const n = parseInt(input?.value, 10);
  if (!isNaN(n) && n >= 1 && n <= 20) return n;
  return defaultHoldBars();
}

function fetchYahooCandles(underlying, tfId) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Extension runtime unavailable'));
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'KP_YAHOO_CANDLES', underlying, tfId },
      (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!res || !res.ok) {
          reject(new Error(res?.error || 'Yahoo fetch failed'));
          return;
        }
        resolve(res);
      }
    );
  });
}

function renderBacktestReport(report) {
  const box = document.querySelector('#kp-bt-results');
  if (!box) return;
  if (!report) {
    box.innerHTML = '';
    return;
  }
  if (!report.ok) {
    box.innerHTML = `<div class="kp-bt-error">${report.error || 'Backtest failed'}</div>`;
    return;
  }

  const s = report.stats || {};
  const isEquityPct = report.stats?.totalReturn != null || report.trades?.[0]?.returnPct != null;
  const holdLabel = report.holdBars != null
    ? `hold ${report.holdBars}`
    : (report.stats?.maxHorizonDays != null ? `horizon ${report.stats.maxHorizonDays}d` : '');
  const meta = [
    report.source || 'backtest',
    report.mode || signalTradeMode,
    `TF ${report.tfId || report.timeframe || signalTimeframeId}`,
    `${report.candlesUsed || 0} bars`,
    holdLabel
  ].filter(Boolean).join(' · ');

  const tradesHtml = (report.trades || []).slice(-10).reverse().map(t => {
    const ts = t.entryTime || t.time;
    const tStr = ts
      ? new Date(ts).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })
      : '—';
    const pnl = t.pnlPts != null ? t.pnlPts : t.returnPct;
    const pnlStr = pnl == null ? '—'
      : `${pnl > 0 ? '+' : ''}${pnl}${isEquityPct ? '%' : ''}`;
    return `<div class="kp-bt-trade ${t.win ? 'win' : 'loss'}">
      <span>${tStr}</span>
      <span>${t.side || 'BUY'}</span>
      <span>${t.strength != null ? t.strength : (t.entryScore || 0)}%</span>
      <span>${pnlStr}</span>
    </div>`;
  }).join('');

  const pnlLabel = isEquityPct ? 'ret%' : 'pnl';
  box.innerHTML = `
    <div class="kp-bt-meta">${meta}</div>
    <div class="kp-bt-stats">
      <div><b>${s.trades || 0}</b><span>trades</span></div>
      <div><b>${s.winRate || 0}%</b><span>win</span></div>
      <div><b>${s.profitFactor == null ? '—' : s.profitFactor}</b><span>PF</span></div>
      <div><b>${s.expectancy > 0 ? '+' : ''}${s.expectancy || 0}</b><span>exp</span></div>
      <div><b>${s.totalPnl > 0 ? '+' : ''}${s.totalPnl || 0}${isEquityPct ? '%' : ''}</b><span>${pnlLabel}</span></div>
      <div><b>${s.maxDD || 0}</b><span>maxDD</span></div>
    </div>
    <div class="kp-bt-trade-list">${tradesHtml || '<div class="kp-bt-empty">No actionable BUY signals in range</div>'}</div>
  `;
}

function runBacktestOnCandles(candles, meta) {
  const symbol = meta.symbol || meta.underlying || 'NIFTY';
  const instrument = window.KPSignalEngine.classifyInstrument(symbol);
  const holdBars = getBacktestHoldBars();
  let report;

  if (signalTradeMode === 'swing' && window.KPSwingEngine?.backtestSwing) {
    report = window.KPSwingEngine.backtestSwing(candles, {
      holdBars: holdBars || 12,
      minimumScore: 8.0
    });
  } else if (instrument.kind === 'equity' && window.KPPositionalEngine?.backtestEquity) {
    const mode = signalTradeMode === 'positional' ? 'positional'
      : signalTradeMode === 'scalp' ? 'scalp' : 'intraday';
    report = window.KPPositionalEngine.backtestEquity(candles, {
      mode,
      timeframe: meta.tfId || signalTimeframeId,
      maxHorizonDays: holdBars,
      costPct: 0.1
    });
    // Normalize stats naming for shared renderer
    if (report.ok && report.stats) {
      report.stats.totalPnl = report.stats.totalReturn;
      report.stats.expectancy = report.stats.expectancy;
      report.stats.maxDD = report.stats.maxDrawdown;
      report.trades = (report.trades || []).map(t => ({
        ...t,
        side: t.side || 'BUY',
        strength: t.entryScore != null ? t.entryScore : (t.score || t.strength || 0),
        pnlPts: t.returnPct != null ? t.returnPct : t.pnlPts,
        win: t.win != null ? t.win : (t.returnPct || 0) > 0
      }));
      report.holdBars = holdBars;
    }
  } else if (!window.KPSignalEngine?.backtestSignals) {
    setBacktestStatus('Signal engine missing', true);
    return;
  } else {
    report = window.KPSignalEngine.backtestSignals(candles, {
      mode: signalTradeMode === 'positional' ? 'intraday' : signalTradeMode,
      instrument,
      symbol,
      holdBars
    });
  }

  const full = {
    ...report,
    source: meta.source,
    tfId: meta.tfId || signalTimeframeId,
    underlying: meta.underlying || instrument.underlying || symbol,
    ranAt: Date.now()
  };

  if (!full.ok) {
    setBacktestStatus(full.error || 'Backtest failed', true);
    renderBacktestReport(full);
    saveBacktestReport(full);
    return;
  }

  const s = full.stats;
  setBacktestStatus(
    `${meta.source}: ${s.trades} trades · ${s.winRate}% win · PF ${s.profitFactor}`,
    false
  );
  renderBacktestReport(full);
  saveBacktestReport(full);
}

async function runChartStockBacktest() {
  const inst = signalInstrument || window.KPSignalEngine.classifyInstrument(scrapeCurrentSymbol() || '');
  if (!inst?.symbol || inst.kind !== 'equity') {
    setBacktestStatus('Open an equity chart first', true);
    return;
  }
  setBacktestStatus(`Fetching ${inst.symbol} (${signalTimeframeId})…`);
  try {
    const data = await fetchStockHistory(inst.symbol, inst.exchange || 'NSE', signalTimeframeId);
    const src = data.source || 'Yahoo';
    setBacktestStatus(`Got ${data.candles.length} bars from ${src} · running…`);
    runBacktestOnCandles(data.candles, {
      source: src,
      symbol: inst.symbol,
      underlying: inst.symbol,
      tfId: signalTimeframeId
    });
  } catch (err) {
    setBacktestStatus(err.message || String(err), true);
  }
}

async function runIndexBacktest() {
  const underlying = document.querySelector('#kp-bt-index')?.value || 'NIFTY';
  const tfId = signalTimeframeId;
  setBacktestStatus(`Fetching ${underlying} (${tfId})…`);
  try {
    const data = await fetchYahooCandles(underlying, tfId);
    setBacktestStatus(`Got ${data.candles.length} bars (${data.interval}) · running…`);
    runBacktestOnCandles(data.candles, {
      source: 'Yahoo',
      underlying,
      symbol: underlying,
      tfId,
      yahooInterval: data.interval
    });
  } catch (err) {
    setBacktestStatus(err.message || String(err), true);
  }
}

function runCsvBacktest(text, fileName) {
  if (!window.KPSignalEngine?.parseCandleCSV) {
    setBacktestStatus('CSV parser missing', true);
    return;
  }
  const parsed = window.KPSignalEngine.parseCandleCSV(text);
  if (parsed.error && (!parsed.candles || parsed.candles.length < 12)) {
    setBacktestStatus(parsed.error, true);
    return;
  }
  const custom = document.querySelector('#kp-bt-symbol')?.value?.trim();
  const symbol = custom || fileName?.replace(/\.csv$/i, '') || 'CUSTOM';
  setBacktestStatus(`CSV ${parsed.candles.length} bars · running…`);
  runBacktestOnCandles(parsed.candles, {
    source: 'CSV',
    symbol,
    underlying: symbol,
    tfId: signalTimeframeId
  });
}

function directionClass(direction) {
  if (direction === 'CE' || direction === 'BUY' || direction === 'HOLD') return 'ce';
  if (direction === 'PE' || direction === 'WAIT' || direction === 'EXIT') return 'pe';
  return 'neutral';
}

function updateSignalPanelUI(result) {
  if (!result) return;
  const panel = document.querySelector('.kp-signal-panel');
  if (!panel) return;

  const thr = result.thresholds || getSignalThresholds();
  const strongAt = thr.strongAt || 88;
  const buyAt = thr.actionableAt || 72;
  const minNeed = thr.minCandles || (result.brain && result.brain.minCandles) || getSignalThresholds().minCandles;
  const isEquity = !!(result.equity || (result.instrument && result.instrument.kind === 'equity'));

  const needEl = panel.querySelector('#kp-candle-need');
  if (needEl) needEl.textContent = String(minNeed);

  const thrEl = panel.querySelector('#kp-mode-thresholds');
  if (thrEl) thrEl.textContent = `Act only if Strong ≥${strongAt}% · Buy ≥${buyAt}%`;

  const inst = result.instrument || signalInstrument || {};
  const headerBadge = panel.querySelector('#kp-signal-header-badge');
  if (headerBadge) {
    if (!result.direction && (result.message || '').includes('Collecting')) {
      headerBadge.textContent = `${signalCandleCollector ? signalCandleCollector.getCandleCount() : 0}/${minNeed}`;
      headerBadge.className = 'kp-signal-header-badge collecting';
    } else if (result.action === 'HOLD') {
      headerBadge.textContent = 'HOLD';
      headerBadge.className = 'kp-signal-header-badge signal-ce';
    } else if (result.action === 'EXIT') {
      headerBadge.textContent = 'EXIT';
      headerBadge.className = 'kp-signal-header-badge signal-pe';
    } else if (result.action === 'BUY' && (isEquity || result.strength >= strongAt)) {
      headerBadge.textContent = result.strength >= strongAt ? 'STRONG' : 'BUY';
      headerBadge.className = result.strength >= strongAt
        ? `kp-signal-header-badge signal-strong-${directionClass(result.direction)}`
        : `kp-signal-header-badge signal-${directionClass(result.direction)}`;
    } else if (result.action === 'BUY' && result.strength >= buyAt) {
      headerBadge.textContent = result.direction === 'CE' ? 'BUY CE' : result.direction === 'PE' ? 'BUY PE' : 'BUY';
      headerBadge.className = `kp-signal-header-badge signal-${directionClass(result.direction)}`;
    } else if (result.action === 'WAIT') {
      headerBadge.textContent = 'WAIT';
      headerBadge.className = 'kp-signal-header-badge no-signal';
    } else if ((result.message || '').includes('Collecting')) {
      headerBadge.textContent = `${result.candleCount != null ? result.candleCount : (signalCandleCollector ? signalCandleCollector.getCandleCount() : 0)}/${minNeed}`;
      headerBadge.className = 'kp-signal-header-badge collecting';
    } else {
      headerBadge.textContent = result.action || 'WAIT';
      headerBadge.className = 'kp-signal-header-badge no-signal';
    }
  }

  const candleCount = panel.querySelector('#kp-candle-count');
  if (candleCount) {
    const histCount = isEquity && stockHistory.length
      ? stockHistory.length
      : (result.candleCount != null
        ? result.candleCount
        : (signalCandleCollector ? signalCandleCollector.getCandleCount() : 0));
    candleCount.textContent = String(histCount);
  }

  if (stockHistoryMeta) updateDataBadge(stockHistoryMeta);

  const symbolEl = panel.querySelector('#kp-signal-symbol');
  if (symbolEl) symbolEl.textContent = inst.symbol || scrapeCurrentSymbol() || '—';

  const modeEl = panel.querySelector('#kp-signal-mode');
  if (modeEl) {
    const trade = result.mode || signalTradeMode;
    const tradeTag = trade === 'scalp' ? 'Scalp' : trade === 'swing' ? 'Swing Pro' : trade === 'positional' ? 'Positional' : 'Intraday';
    const analysisTf = result.timeframe || equityAnalysisTimeframe(trade, signalTimeframeId);
    if (trade === 'swing') {
      modeEl.textContent = `Swing Pro · ${analysisTf} · 1:2 RR`;
    } else if (isEquity || inst.kind === 'equity') {
      modeEl.textContent = `${tradeTag} · ${analysisTf}`;
    } else if (inst.kind === 'option') {
      modeEl.textContent = `${tradeTag} · ${inst.optionType || 'OPT'}`;
    } else if (inst.kind === 'index') {
      modeEl.textContent = `${tradeTag} · ${inst.underlying} CE/PE`;
    } else {
      modeEl.textContent = `${tradeTag} · open chart`;
    }
  }

  const mainBadge = panel.querySelector('#kp-signal-main-badge');
  if (mainBadge) {
    const dc = directionClass(result.direction || result.action);
    const actionIcon = result.action === 'BUY' ? kpIcon('buy')
      : result.action === 'HOLD' ? kpIcon('hold')
        : result.action === 'EXIT' ? kpIcon('exit')
          : result.action === 'WAIT' ? kpIcon('wait') : '';
    if (result.action === 'BUY' && (isEquity || result.strength >= buyAt)) {
      mainBadge.className = `kp-signal-main-badge ${dc}${result.strength >= strongAt ? ' strong' : ''}`;
      mainBadge.innerHTML = `${actionIcon}<span>${result.message}</span>`;
    } else if (result.action === 'HOLD') {
      mainBadge.className = 'kp-signal-main-badge ce';
      mainBadge.innerHTML = `${actionIcon}<span>${result.message}</span>`;
    } else if (result.action === 'EXIT') {
      mainBadge.className = 'kp-signal-main-badge pe';
      mainBadge.innerHTML = `${actionIcon}<span>${result.message}</span>`;
    } else if (result.action === 'WAIT') {
      mainBadge.className = 'kp-signal-main-badge pe';
      mainBadge.innerHTML = `${actionIcon}<span>${result.message}</span>`;
    } else if ((result.message || '').includes('Collecting')) {
      mainBadge.className = 'kp-signal-main-badge neutral';
      mainBadge.textContent = result.message;
    } else {
      mainBadge.className = 'kp-signal-main-badge neutral';
      mainBadge.textContent = result.message || 'No clear signal';
    }
  }

  const brainRow = panel.querySelector('#kp-brain-row');
  if (brainRow) {
    if (result.swing && result.swingData) {
      const sd = result.swingData;
      const dom = sd.longScore >= sd.shortScore ? 'L' : 'S';
      brainRow.innerHTML = `
        <span>Long ${sd.longScore}/10</span>
        <span>Short ${sd.shortScore}/10</span>
        <span>${sd.dashboard?.trend || '—'}</span>
      `;
    } else if (result.brain && !isEquity) {
      const b = result.brain;
      brainRow.innerHTML = `
        <span>mom ${b.momentum > 0 ? '+' : ''}${b.momentum}%</span>
        <span>edge ${b.edge}</span>
        <span>agree ${Math.round(b.agreement * 100)}%</span>
      `;
    } else if (isEquity && lastEquityResult) {
      const eq = lastEquityResult;
      brainRow.innerHTML = `
        <span>score ${eq.score || 0}</span>
        <span>R:R ${eq.riskReward != null ? eq.riskReward : '—'}</span>
        <span>${eq.confirmationTimeframe || ''}</span>
      `;
    } else {
      brainRow.innerHTML = '';
    }
  }

  if (result.swing && result.swingData) renderSwingExtras(result.swingData);
  else if (isEquity && lastEquityResult) renderEquityExtras(lastEquityResult);

  const strengthFill = panel.querySelector('#kp-signal-strength-fill');
  if (strengthFill) {
    strengthFill.style.width = `${result.strength || 0}%`;
    strengthFill.className = `kp-signal-strength-fill ${directionClass(result.direction || result.action)}`;
  }

  const strengthLabel = panel.querySelector('#kp-signal-strength-label');
  if (strengthLabel) {
    const pct = result.strength || 0;
    const action = result.action || 'WAIT';
    if (isEquity) {
      const tip = pct >= buyAt
        ? (action === 'BUY' ? 'clear enough to consider' : action === 'WAIT' ? 'not clean — sit' : action.toLowerCase())
        : 'below Buy bar — do nothing';
      strengthLabel.textContent = `${pct}% agree · ${tip}`;
    } else if (result.brain) {
      strengthLabel.textContent = `${pct}% agree · B ${result.brain.bullScore} / S ${result.brain.bearScore}`;
    } else {
      const ceCount = result.bullishCount || 0;
      const peCount = result.bearishCount || 0;
      strengthLabel.textContent = `${pct}% agree · bull ${ceCount}/6 · bear ${peCount}/6`;
    }
  }

  const priceEl = panel.querySelector('#kp-signal-price');
  if (priceEl) priceEl.textContent = formatPrice(result.currentPrice);

  const indicatorContainer = panel.querySelector('#kp-signal-indicator-rows');
  if (indicatorContainer && result.indicators) {
    if (isEquity) {
      const ind = result.indicators;
      const analysisTf = result.timeframe || equityAnalysisTimeframe(result.mode || signalTradeMode, signalTimeframeId);
      const emaBias = (value, price) => {
        if (value == null || price == null) return 'neutral';
        return price >= value ? 'bullish' : 'bearish';
      };
      const rows = [
        ['EMA 50 · ' + analysisTf, emaBias(ind.ema50, result.currentPrice), ind.ema50],
        ['EMA 100 · ' + analysisTf, emaBias(ind.ema100, result.currentPrice), ind.ema100],
        ['EMA 200 · ' + analysisTf, emaBias(ind.ema200, result.currentPrice), ind.ema200],
        ['RSI 14', ind.rsi14 == null ? 'neutral' : ind.rsi14 >= 55 ? 'bullish' : ind.rsi14 <= 45 ? 'bearish' : 'neutral', ind.rsi14],
        ['MACD 12/26/9', ind.macd != null && ind.macdSignal != null
          ? (ind.macd > ind.macdSignal ? 'bullish' : 'bearish') : 'neutral',
          ind.macd != null ? `${ind.macd}${ind.macdHistogram != null ? ` · h ${ind.macdHistogram}` : ''}` : '—'],
        ['Supertrend', ind.supertrendDirection || 'neutral', ind.supertrend],
        ['Volume', ind.volumeRatio >= 1.2 ? 'bullish' : ind.volumeRatio < 0.8 ? 'bearish' : 'neutral',
          ind.volumeRatio != null ? `${ind.volumeRatio}x` : '—'],
        ['Weekly filter', ind.weeklyFilter || 'unavailable', ind.weeklyFilter || '—']
      ];
      indicatorContainer.innerHTML = rows.map(([name, bias, value]) => {
        const statusClass = bias === 'bullish' ? 'bullish' : bias === 'bearish' ? 'bearish' : 'neutral-status';
        const mark = bias === 'bullish' ? '▲' : bias === 'bearish' ? '▼' : '·';
        return `
          <div class="kp-signal-indicator-row">
            <div class="kp-signal-indicator-name">
              <span class="kp-signal-indicator-status ${statusClass}">${mark}</span>
              <span>${name}</span>
            </div>
            <span class="kp-signal-indicator-label">${bias || '—'}</span>
            <span class="kp-signal-indicator-value">${value == null ? '—' : value}</span>
          </div>`;
      }).join('');
    } else {
      const names = {
        rsi: signalTradeMode === 'scalp' ? 'RSI 7' : 'RSI 10',
        macd: signalTradeMode === 'scalp' ? 'MACD 5/10' : 'MACD 6/13',
        ema: signalTradeMode === 'scalp' ? 'EMA 3/8' : 'EMA 5/13',
        bb: 'Bollinger',
        vwap: 'VWAP',
        supertrend: 'Supertrend'
      };
      let rowsHTML = '';
      for (const [key, data] of Object.entries(result.indicators)) {
        if (!data || typeof data !== 'object' || data.signal == null) continue;
        const statusClass = data.signal === 'CE' ? 'bullish' : data.signal === 'PE' ? 'bearish' : 'neutral-status';
        const mark = data.signal === 'CE' ? '▲' : data.signal === 'PE' ? '▼' : '·';
        rowsHTML += `
          <div class="kp-signal-indicator-row">
            <div class="kp-signal-indicator-name">
              <span class="kp-signal-indicator-status ${statusClass}">${mark}</span>
              <span>${names[key] || key}</span>
            </div>
            <span class="kp-signal-indicator-label">${data.label}</span>
            <span class="kp-signal-indicator-value">${data.value}</span>
          </div>`;
      }
      indicatorContainer.innerHTML = rowsHTML;
    }
  }

  const historyList = panel.querySelector('#kp-signal-history-list');
  const historyCount = panel.querySelector('#kp-signal-history-count');
  if (historyCount) historyCount.textContent = String(signalHistory.length);

  if (historyList) {
    if (!signalHistory.length) {
      historyList.innerHTML = '<div class="kp-signal-history-empty">No signals yet</div>';
    } else {
      historyList.innerHTML = signalHistory.slice(0, 15).map(sig => {
        const dirClass = directionClass(sig.direction || sig.action);
        const label = sig.action === 'WAIT' ? 'WAIT'
          : sig.action === 'HOLD' ? 'HOLD'
            : sig.action === 'EXIT' ? 'EXIT'
              : sig.direction === 'CE' || sig.direction === 'PE'
                ? `BUY ${sig.direction}`
                : 'BUY';
        return `
          <div class="kp-signal-history-item">
            <span class="signal-time">${sig.time}</span>
            <span class="signal-type ${dirClass}">${label}</span>
            <span class="signal-strength">${sig.strength}%</span>
            <span class="signal-price">${formatPrice(sig.price)}</span>
          </div>`;
      }).join('');
    }
  }

  const addBasketBtn = panel.querySelector('#kp-signal-add-basket');
  if (addBasketBtn) {
    if (!IS_KITE || isEquity || inst.kind === 'equity') {
      addBasketBtn.disabled = true;
      addBasketBtn.textContent = isEquity || inst.kind === 'equity'
        ? 'Analysis only · no orders'
        : 'Basket (Kite only)';
    } else {
      const canAdd = result.action === 'BUY' && result.strength >= buyAt;
      addBasketBtn.disabled = !canAdd;
      if (canAdd) {
        if (inst.kind === 'option') {
          addBasketBtn.textContent = `Basket · BUY ${inst.optionType || ''}`.trim();
        } else {
          addBasketBtn.textContent = `Basket · BUY ${result.direction}`;
        }
      } else {
        addBasketBtn.textContent = 'Add to Express Basket';
      }
    }
  }

  const trackSection = panel.querySelector('[data-section="tools"]');
  if (trackSection) {
    trackSection.style.display = (isEquity || inst.kind === 'equity') ? '' : 'none';
  }
}

function showSignalToast(result) {
  let toast = document.querySelector('.kp-signal-toast');
  if (toast) toast.remove();
  toast = document.createElement('div');
  toast.className = `kp-signal-toast ${directionClass(result.direction)}`;
  applyBrokerTheme(toast);
  toast.textContent = `${result.message} · ${formatPrice(result.currentPrice)} · ${result.strength}%`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}


// Run init
init();

