// Zerodha Kite Simulator State & Interaction Logic

// Global state
window.mockState = {
  availableMargin: 500000.00,
  usedMargin: 0.00,
  executedTradesCount: 3,
  positions: [
    { product: 'MIS', symbol: 'NIFTY 26 JUN 18000 CE', qty: 75, avgPrice: 120.50, ltp: 125.20 },
    { product: 'NRML', symbol: 'BANKNIFTY 26 JUN 47500 PE', qty: -15, avgPrice: 210.00, ltp: 205.10 },
    { product: 'CNC', symbol: 'RELIANCE', qty: 10, avgPrice: 2850.00, ltp: 2910.50 }
  ],
  orders: [
    { time: '09:20:15', action: 'BUY', symbol: 'NIFTY 26 JUN 18000 CE', product: 'MIS', qty: 75, price: 120.50, status: 'EXECUTED' },
    { time: '09:45:30', action: 'SELL', symbol: 'BANKNIFTY 26 JUN 47500 PE', product: 'NRML', qty: 15, price: 210.00, status: 'EXECUTED' },
    { time: '10:05:10', action: 'BUY', symbol: 'RELIANCE', product: 'CNC', qty: 10, price: 2850.00, status: 'EXECUTED' }
  ]
};

// Mock Instruments Database
const instruments = [
  { symbol: 'NIFTY 50', name: 'Nifty 50 Index', ltp: 22410.20, change: 45.50, isIndex: true },
  { symbol: 'SENSEX', name: 'Sensex Index', ltp: 73895.50, change: 132.80, isIndex: true },
  { symbol: 'RELIANCE', name: 'Reliance Industries', ltp: 2910.50, change: 12.30, isIndex: false },
  { symbol: 'TCS', name: 'Tata Consultancy Services', ltp: 3850.20, change: -4.50, isIndex: false },
  { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd', ltp: 1495.00, change: -8.20, isIndex: false },
  { symbol: 'NIFTY 26 JUN 18000 CE', name: 'Nifty Options Jun 18000 Call', ltp: 125.20, change: 15.40, isIndex: false },
  { symbol: 'NIFTY 26 JUN 18000 PE', name: 'Nifty Options Jun 18000 Put', ltp: 92.15, change: -22.30, isIndex: false },
  { symbol: 'NIFTY 26 JUN 18200 CE', name: 'Nifty Options Jun 18200 Call', ltp: 54.80, change: 8.90, isIndex: false },
  { symbol: 'BANKNIFTY 26 JUN 47500 PE', name: 'Banknifty Options Jun 47500 Put', ltp: 205.10, change: -32.50, isIndex: false },
  { symbol: 'BANKNIFTY 26 JUN 48000 CE', name: 'Banknifty Options Jun 48000 Call', ltp: 185.30, change: 12.10, isIndex: false }
];

// Initialize
function initSimulator() {
  renderWatchlist();
  renderPositions();
  renderOrders();
  updateFundsDisplay();
  setupNavigation();
  setupSearch();
  setupOrderModal();
  
  // Start Real-Time Price Ticking
  setInterval(simulatePriceTicks, 1000);
}

// Render Watchlist in Sidebar
function renderWatchlist() {
  const container = document.getElementById('watchlist-instruments');
  if (!container) return;
  
  container.innerHTML = '';
  
  // Exclude indices from watchlist items but show them in header
  const listItems = instruments.filter(inst => !inst.isIndex);
  
  listItems.forEach(inst => {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.symbol = inst.symbol;
    
    const changeClass = inst.change >= 0 ? 'positive' : 'negative';
    const changeSign = inst.change >= 0 ? '+' : '';
    
    li.innerHTML = `
      <div class="symbol-info">
        <span class="symbol">${inst.symbol}</span>
        <span class="nice-name">${inst.name}</span>
      </div>
      <div class="price-info">
        <span class="ltp" id="ltp-${inst.symbol.replace(/\s+/g, '-')}">₹${inst.ltp.toFixed(2)}</span>
        <span class="change ${changeClass}" id="chg-${inst.symbol.replace(/\s+/g, '-')}">${changeSign}${inst.change.toFixed(2)}%</span>
      </div>
      <div class="actions">
        <button class="buy" data-symbol="${inst.symbol}" data-action="BUY">B</button>
        <button class="sell" data-symbol="${inst.symbol}" data-action="SELL">S</button>
        <button class="depth">D</button>
        <button class="chart">C</button>
      </div>
    `;
    
    container.appendChild(li);
  });
  
  // Bind Buy/Sell buttons
  container.querySelectorAll('.buy, .sell').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const symbol = btn.dataset.symbol;
      const action = btn.dataset.action;
      openOrderModalForm(symbol, action);
    });
  });
}

// Render Positions Page Table
function renderPositions() {
  const tbody = document.getElementById('positions-tbody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (window.mockState.positions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">No open positions.</td></tr>`;
    document.getElementById('total-pnl').innerText = '₹0.00';
    document.getElementById('total-pnl').className = 'total-pnl';
    return;
  }
  
  let totalPnL = 0;
  
  window.mockState.positions.forEach((pos, idx) => {
    // Calculate P&L: (LTP - AvgPrice) * Qty
    const pnl = (pos.ltp - pos.avgPrice) * pos.qty;
    totalPnL += pnl;
    
    const pnlClass = pnl >= 0 ? 'text-green' : 'text-red';
    const pnlSign = pnl >= 0 ? '+' : '';
    
    const tr = document.createElement('tr');
    tr.dataset.index = idx;
    
    // Format quantities
    const qtyDisplay = pos.qty > 0 ? pos.qty : pos.qty;
    const qtyClass = pos.qty > 0 ? 'text-green' : 'text-red';
    
    tr.innerHTML = `
      <td class="text-muted">${pos.product}</td>
      <td class="instrument"><strong>${pos.symbol}</strong></td>
      <td class="${qtyClass}">${qtyDisplay}</td>
      <td>${pos.avgPrice.toFixed(2)}</td>
      <td class="tick-pos-ltp" data-symbol="${pos.symbol}">${pos.ltp.toFixed(2)}</td>
      <td class="${pnlClass} pnl">${pnlSign}₹${Math.abs(pnl).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
    `;
    
    tbody.appendChild(tr);
  });
  
  // Update footer total P&L
  const totalPnLEl = document.getElementById('total-pnl');
  if (totalPnLEl) {
    totalPnLEl.innerText = (totalPnL >= 0 ? '+' : '-') + '₹' + Math.abs(totalPnL).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    totalPnLEl.className = `total-pnl ${totalPnL >= 0 ? 'text-green' : 'text-red'}`;
  }
  
  window.mockState.netPnL = totalPnL;
}

// Render Orders Page Table
function renderOrders() {
  const tbody = document.getElementById('orders-tbody');
  const badge = document.getElementById('pending-badge');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (window.mockState.orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No orders placed today.</td></tr>`;
    if (badge) badge.style.display = 'none';
    return;
  }
  
  const pendingCount = window.mockState.orders.filter(o => o.status === 'PENDING').length;
  if (badge) {
    if (pendingCount > 0) {
      badge.innerText = pendingCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
  
  window.mockState.orders.forEach(order => {
    const tr = document.createElement('tr');
    tr.className = order.status.toLowerCase();
    
    const statusClass = order.status === 'EXECUTED' ? 'text-green' : (order.status === 'REJECTED' ? 'text-red' : 'text-orange');
    
    tr.innerHTML = `
      <td class="text-muted">${order.time}</td>
      <td class="${order.action === 'BUY' ? 'text-green' : 'text-red'}">${order.action}</td>
      <td><strong>${order.symbol}</strong></td>
      <td class="text-muted">${order.product}</td>
      <td>${order.qty}</td>
      <td>${order.price.toFixed(2)}</td>
      <td class="${statusClass}">${order.status}</td>
    `;
    
    tbody.appendChild(tr);
  });
  
  window.mockState.executedTradesCount = window.mockState.orders.filter(o => o.status === 'EXECUTED').length;
}

// Update Funds
function updateFundsDisplay() {
  const avEl = document.getElementById('available-margin');
  const usEl = document.getElementById('used-margin');
  const dashAvEl = document.getElementById('dash-margin');
  const dashUsEl = document.getElementById('dash-used-margin');
  
  const formattedAv = '₹' + window.mockState.availableMargin.toLocaleString('en-IN', {minimumFractionDigits: 2});
  const formattedUs = '₹' + window.mockState.usedMargin.toLocaleString('en-IN', {minimumFractionDigits: 2});
  
  if (avEl) avEl.innerText = formattedAv;
  if (usEl) usEl.innerText = formattedUs;
  if (dashAvEl) dashAvEl.innerText = formattedAv;
  if (dashUsEl) dashUsEl.innerText = formattedUs;
}

// Setup Page Navigation
function setupNavigation() {
  const items = document.querySelectorAll('.nav-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      items.forEach(it => it.classList.remove('active'));
      item.classList.add('active');
      
      const pageId = item.dataset.page;
      document.querySelectorAll('.page-section').forEach(sec => {
        sec.classList.remove('active');
      });
      
      const targetSec = document.getElementById(`page-${pageId}`);
      if (targetSec) targetSec.classList.add('active');
      
      // Refresh grouping when visiting positions
      if (pageId === 'positions') {
        renderPositions();
      }
    });
  });
}

// Watchlist search filter
function setupSearch() {
  const searchInput = document.getElementById('watchlist-search');
  if (!searchInput) return;
  
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.toUpperCase();
    const rows = document.querySelectorAll('#watchlist-instruments .item');
    let visibleCount = 0;
    
    rows.forEach(row => {
      const sym = row.querySelector('.symbol').innerText;
      if (sym.includes(val)) {
        row.style.display = 'flex';
        visibleCount++;
      } else {
        row.style.display = 'none';
      }
    });
    
    document.getElementById('search-count').innerText = `${visibleCount}/${rows.length}`;
  });
}

// Open Order Placement Modal
function openOrderModalForm(symbol, action) {
  const modal = document.getElementById('order-window-modal');
  const form = document.getElementById('order-window-form');
  if (!modal || !form) return;
  
  // Update class
  form.className = `order-window ${action.toLowerCase()}`;
  
  // Update texts
  document.getElementById('order-action-label').innerText = action;
  document.getElementById('order-instrument-name').innerText = symbol;
  document.getElementById('submit-order-btn').innerText = action;
  document.getElementById('submit-order-btn').className = action === 'BUY' ? 'btn btn-blue' : 'btn btn-red';
  
  // Set default quantities
  const qtyInput = document.getElementById('order-qty');
  let defaultQty = 75;
  if (symbol.includes('BANKNIFTY')) defaultQty = 15;
  else if (symbol.includes('FINNIFTY')) defaultQty = 40;
  else if (symbol.includes('RELIANCE') || symbol.includes('TCS') || symbol.includes('HDFCBANK')) defaultQty = 10;
  qtyInput.value = defaultQty;
  
  // Find current price
  const inst = instruments.find(i => i.symbol === symbol);
  const priceInput = document.getElementById('order-price');
  if (inst && priceInput) {
    priceInput.value = inst.ltp.toFixed(2);
  }
  
  // Update margin required calculation
  updateOrderRequiredMargin();
  
  modal.classList.add('open');
}

function updateOrderRequiredMargin() {
  const qty = parseInt(document.getElementById('order-qty').value) || 0;
  const price = parseFloat(document.getElementById('order-price').value) || 0;
  const symbol = document.getElementById('order-instrument-name').innerText;
  
  const isFO = symbol.includes('NIFTY') || symbol.includes('BANK') || symbol.includes('FINNIFTY');
  let marginReq = qty * price;
  
  // Leverage estimation: F&O option buying needs full premium.
  // F&O selling needs margin (we simulate 10%). Equity needs 100% (CNC) or 20% (MIS).
  const isSell = document.getElementById('order-action-label').innerText === 'SELL';
  const product = document.querySelector('input[name="product"]:checked').value;
  
  if (isFO) {
    const isOption = symbol.includes('CE') || symbol.includes('PE');
    if (isOption) {
      if (isSell) {
        marginReq = 120000 * (qty / (symbol.includes('BANK') ? 15 : (symbol.includes('FIN') ? 40 : 75))); // flat margin
      }
      // Buy needs premium (qty * price) which is already marginReq
    } else {
      // Future
      marginReq = qty * price * 0.12; // 12% margin
    }
  } else {
    // Equities
    if (product === 'MIS') {
      marginReq = qty * price * 0.20; // 5x leverage
    } else {
      marginReq = qty * price; // 1x leverage CNC
    }
  }
  
  document.getElementById('order-margin-est').innerText = `₹${marginReq.toLocaleString('en-IN', {minimumFractionDigits: 2})}`;
}

function setupOrderModal() {
  const modal = document.getElementById('order-window-modal');
  const closeBtn = document.getElementById('close-order-modal');
  const submitBtn = document.getElementById('submit-order-btn');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', () => modal.classList.remove('open'));
  }
  
  // Bind inputs update
  const qtyInput = document.getElementById('order-qty');
  const priceInput = document.getElementById('order-price');
  
  if (qtyInput) qtyInput.addEventListener('input', updateOrderRequiredMargin);
  if (priceInput) priceInput.addEventListener('input', updateOrderRequiredMargin);
  
  document.querySelectorAll('input[name="product"]').forEach(radio => {
    radio.addEventListener('change', updateOrderRequiredMargin);
  });
  
  // Place Order Action
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      const symbol = document.getElementById('order-instrument-name').innerText;
      const action = document.getElementById('order-action-label').innerText;
      const product = document.querySelector('input[name="product"]:checked').value;
      const qty = parseInt(qtyInput.value);
      const price = parseFloat(priceInput.value);
      
      executeTrade(symbol, action, product, qty, price);
      modal.classList.remove('open');
    });
  }
}

// Place simulated trades
function executeTrade(symbol, action, product, qty, price) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  // Calc margin change
  let requiredMarginText = document.getElementById('order-margin-est').innerText.replace(/[^0-9.]/g, '');
  let requiredMargin = parseFloat(requiredMarginText) || 0;
  
  if (action === 'BUY' && window.mockState.availableMargin < requiredMargin) {
    // Insufficient funds
    window.mockState.orders.unshift({
      time: timeStr,
      type: 'LIMIT',
      action,
      symbol,
      product,
      qty,
      price,
      status: 'REJECTED'
    });
    alert("Insufficient funds for trade execution.");
    renderOrders();
    return;
  }
  
  // Success execute
  window.mockState.orders.unshift({
    time: timeStr,
    type: 'LIMIT',
    action,
    symbol,
    product,
    qty,
    price,
    status: 'EXECUTED'
  });
  
  // Update position
  const tradeQty = action === 'BUY' ? qty : -qty;
  const existingPos = window.mockState.positions.find(p => p.symbol === symbol && p.product === product);
  
  if (existingPos) {
    const currentQty = existingPos.qty;
    const newQty = currentQty + tradeQty;
    
    if (newQty === 0) {
      // Position closed
      window.mockState.positions = window.mockState.positions.filter(p => p !== existingPos);
    } else {
      // Adjust avg cost if buying/selling in same direction
      if ((currentQty > 0 && tradeQty > 0) || (currentQty < 0 && tradeQty < 0)) {
        // Average up/down
        existingPos.avgPrice = ((existingPos.avgPrice * Math.abs(currentQty)) + (price * Math.abs(tradeQty))) / Math.abs(newQty);
      }
      existingPos.qty = newQty;
    }
  } else {
    // Add new position
    window.mockState.positions.push({
      product,
      symbol,
      qty: tradeQty,
      avgPrice: price,
      ltp: price
    });
  }
  
  // Update margins
  if (action === 'BUY') {
    window.mockState.availableMargin -= requiredMargin;
    window.mockState.usedMargin += requiredMargin;
  } else {
    // If it closes an existing buy position, we free used margin
    window.mockState.availableMargin += requiredMargin;
    window.mockState.usedMargin = Math.max(0, window.mockState.usedMargin - requiredMargin);
  }
  
  // Re-draw
  renderPositions();
  renderOrders();
  updateFundsDisplay();
}

// F&O Express Basket execution helper (called by content.js)
window.executeSimulatedOrders = function(legs) {
  legs.forEach(leg => {
    executeTrade(leg.symbol, leg.action, 'MIS', leg.qty, leg.price);
  });
};

// Tick Prices in Background (Real-time Websocket simulation)
function simulatePriceTicks() {
  // Update Index values
  instruments.forEach(inst => {
    // Random walk
    const changePct = (Math.random() * 0.1 - 0.05); // -0.05% to +0.05%
    const diff = inst.ltp * changePct;
    inst.ltp += diff;
    inst.change += changePct * 100;
    
    // Update watchlist DOM directly
    const ltpEl = document.getElementById(`ltp-${inst.symbol.replace(/\s+/g, '-')}`);
    const chgEl = document.getElementById(`chg-${inst.symbol.replace(/\s+/g, '-')}`);
    
    if (ltpEl) ltpEl.innerText = `₹${inst.ltp.toFixed(2)}`;
    if (chgEl) {
      const changeClass = inst.change >= 0 ? 'change positive' : 'change negative';
      const changeSign = inst.change >= 0 ? '+' : '';
      chgEl.className = changeClass;
      chgEl.innerText = `${changeSign}${inst.change.toFixed(2)}%`;
    }
    
    // Sync indices inside header
    if (inst.symbol === 'NIFTY 50') {
      const elVal = document.getElementById('nifty-value');
      const elChg = document.getElementById('nifty-change');
      if (elVal) elVal.innerText = inst.ltp.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (elChg) {
        elChg.className = inst.change >= 0 ? 'index-change positive' : 'index-change negative';
        elChg.innerText = `${inst.change >= 0 ? '+' : ''}${inst.change.toFixed(2)} (+${(inst.change / 220).toFixed(2)}%)`;
      }
    } else if (inst.symbol === 'SENSEX') {
      const elVal = document.getElementById('sensex-value');
      const elChg = document.getElementById('sensex-change');
      if (elVal) elVal.innerText = inst.ltp.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
      if (elChg) {
        elChg.className = inst.change >= 0 ? 'index-change positive' : 'index-change negative';
        elChg.innerText = `${inst.change >= 0 ? '+' : ''}${inst.change.toFixed(2)} (+${(inst.change / 730).toFixed(2)}%)`;
      }
    }
    
    // Update ticks in active holdings page
    const holdPrices = document.querySelectorAll(`.tick-price[data-symbol="${inst.symbol}"]`);
    holdPrices.forEach(hp => {
      hp.innerText = inst.ltp.toFixed(2);
      // Recalculate holdings columns could be done here, keeping simple for now
    });
  });
  
  // Sync positions LTP and update P&L
  window.mockState.positions.forEach(pos => {
    const inst = instruments.find(i => i.symbol === pos.symbol);
    if (inst) {
      pos.ltp = inst.ltp;
    }
  });
  
  // Force update positions grid and totals
  renderPositions();
}

// Load
document.addEventListener('DOMContentLoaded', initSimulator);
