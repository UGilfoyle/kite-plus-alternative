// Default settings
const DEFAULT_SETTINGS = {
  grouping: true,
  basket: true,
  optionchain: true,
  charges: true,
  signals: true,
  stockAnalysis: true
};

// Elements
const toggles = {
  grouping: document.getElementById('toggle-grouping'),
  basket: document.getElementById('toggle-basket'),
  optionchain: document.getElementById('toggle-optionchain'),
  charges: document.getElementById('toggle-charges'),
  signals: document.getElementById('toggle-signals'),
  stockAnalysis: document.getElementById('toggle-stock-analysis')
};

const openSandboxBtn = document.getElementById('open-sandbox');
const resetLink = document.getElementById('reset-settings');
const dhanClientIdEl = document.getElementById('dhan-client-id');
const dhanTokenEl = document.getElementById('dhan-access-token');
const dhanStatusEl = document.getElementById('dhan-status');
const dhanSaveBtn = document.getElementById('dhan-save');
const dhanTestBtn = document.getElementById('dhan-test');
const dhanClearBtn = document.getElementById('dhan-clear');

const upstoxApiKeyEl = document.getElementById('upstox-api-key');
const upstoxTokenEl = document.getElementById('upstox-access-token');
const upstoxStatusEl = document.getElementById('upstox-status');
const upstoxSaveBtn = document.getElementById('upstox-save');
const upstoxTestBtn = document.getElementById('upstox-test');
const upstoxClearBtn = document.getElementById('upstox-clear');

function setDhanStatus(text, kind) {
  if (!dhanStatusEl) return;
  dhanStatusEl.textContent = text;
  dhanStatusEl.classList.remove('ok', 'error', 'warn');
  if (kind) dhanStatusEl.classList.add(kind);
}

function setUpstoxStatus(text, kind) {
  if (!upstoxStatusEl) return;
  upstoxStatusEl.textContent = text;
  upstoxStatusEl.classList.remove('ok', 'error', 'warn');
  if (kind) upstoxStatusEl.classList.add(kind);
}

// Load settings
async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get('settings');
    const current = settings.settings || DEFAULT_SETTINGS;

    Object.keys(toggles).forEach(key => {
      if (toggles[key]) {
        toggles[key].checked = current[key] !== undefined ? current[key] : DEFAULT_SETTINGS[key];
      }
    });
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

async function loadDhanCreds() {
  try {
    const res = await chrome.storage.local.get(['dhanClientId', 'dhanAccessToken']);
    if (dhanClientIdEl) dhanClientIdEl.value = res.dhanClientId || '';
    if (dhanTokenEl) dhanTokenEl.value = res.dhanAccessToken || '';
    if (res.dhanClientId && res.dhanAccessToken) {
      setDhanStatus('Status: Dhan token saved (paid Data API required to work)', 'warn');
    } else {
      setDhanStatus('Status: Using free Yahoo (recommended)', 'ok');
    }
  } catch (err) {
    setDhanStatus('Status: Using free Yahoo', 'ok');
  }
}

async function saveDhanCreds() {
  const dhanClientId = (dhanClientIdEl?.value || '').trim();
  const dhanAccessToken = (dhanTokenEl?.value || '').trim();
  await chrome.storage.local.set({ dhanClientId, dhanAccessToken });
  if (dhanClientId && dhanAccessToken) {
    setDhanStatus('Status: Saved. Click Test to verify.', 'ok');
  } else {
    setDhanStatus('Status: Incomplete — need both Client ID and Access Token', 'warn');
  }
}

async function clearDhanCreds() {
  if (dhanClientIdEl) dhanClientIdEl.value = '';
  if (dhanTokenEl) dhanTokenEl.value = '';
  await chrome.storage.local.remove(['dhanClientId', 'dhanAccessToken']);
  setDhanStatus('Status: Using free Yahoo (recommended)', 'ok');
}

async function testDhanCreds() {
  await saveDhanCreds();
  setDhanStatus('Status: Testing…', 'warn');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'KP_DHAN_TEST' });
    if (res?.ok) {
      setDhanStatus(`Status: Active · ${res.message || 'connected'}`, 'ok');
    } else {
      const err = String(res?.error || 'unknown error');
      if (/806|not subscribed|Data APIs not Subscribed/i.test(err)) {
        setDhanStatus(
          'Status: Failed — Dhan Data API not subscribed (₹499/mo). Free Trading API cannot provide LTP/history. Subscribe at web.dhan.co → Profile → DhanHQ APIs, then generate a new token.',
          'error'
        );
      } else {
        setDhanStatus(`Status: Failed — ${err}`, 'error');
      }
    }
  } catch (err) {
    setDhanStatus(`Status: Failed — ${err.message || String(err)}`, 'error');
  }
}

// Save setting
async function saveSetting(key, val) {
  try {
    const res = await chrome.storage.local.get('settings');
    const current = res.settings || { ...DEFAULT_SETTINGS };
    current[key] = val;
    await chrome.storage.local.set({ settings: current });

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && (
        tab.url.includes('kite.zerodha.com') ||
        tab.url.includes('upstox.com') ||
        tab.url.includes(chrome.runtime.id)
      )) {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings: current }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

Object.keys(toggles).forEach(key => {
  if (toggles[key]) {
    toggles[key].addEventListener('change', (e) => {
      saveSetting(key, e.target.checked);
    });
  }
});

if (openSandboxBtn) {
  openSandboxBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('mock-kite.html')
    });
  });
}

if (resetLink) {
  resetLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Reset all settings to default?')) {
      await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
      await loadSettings();

      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && (
          tab.url.includes('kite.zerodha.com') ||
          tab.url.includes('upstox.com') ||
          tab.url.includes(chrome.runtime.id)
        )) {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings: DEFAULT_SETTINGS }).catch(() => {});
        }
      }
    }
  });
}

dhanSaveBtn?.addEventListener('click', () => saveDhanCreds());
dhanTestBtn?.addEventListener('click', () => testDhanCreds());
dhanClearBtn?.addEventListener('click', () => clearDhanCreds());

async function loadUpstoxCreds() {
  try {
    const res = await chrome.storage.local.get(['upstoxApiKey', 'upstoxAccessToken']);
    if (upstoxApiKeyEl) upstoxApiKeyEl.value = res.upstoxApiKey || '';
    if (upstoxTokenEl) upstoxTokenEl.value = res.upstoxAccessToken || '';
    if (res.upstoxAccessToken) {
      setUpstoxStatus('Status: Upstox token saved — click Test to verify', 'warn');
    } else {
      setUpstoxStatus('Status: Using free Yahoo until token saved', 'ok');
    }
  } catch (_) {
    setUpstoxStatus('Status: Using free Yahoo until token saved', 'ok');
  }
}

async function saveUpstoxCreds() {
  const upstoxApiKey = (upstoxApiKeyEl?.value || '').trim();
  const upstoxAccessToken = (upstoxTokenEl?.value || '').trim();
  await chrome.storage.local.set({ upstoxApiKey, upstoxAccessToken });
  if (upstoxAccessToken) {
    setUpstoxStatus('Status: Saved. Click Test to verify.', 'ok');
  } else {
    setUpstoxStatus('Status: Need Access Token (API Key optional)', 'warn');
  }
}

async function clearUpstoxCreds() {
  if (upstoxApiKeyEl) upstoxApiKeyEl.value = '';
  if (upstoxTokenEl) upstoxTokenEl.value = '';
  await chrome.storage.local.remove(['upstoxApiKey', 'upstoxAccessToken', 'upstoxInstrumentCache']);
  setUpstoxStatus('Status: Using free Yahoo until token saved', 'ok');
}

async function testUpstoxCreds() {
  await saveUpstoxCreds();
  setUpstoxStatus('Status: Testing…', 'warn');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'KP_UPSTOX_TEST' });
    if (res?.ok) {
      setUpstoxStatus(`Status: Active · ${res.message || 'connected'}`, 'ok');
    } else {
      const err = String(res?.error || 'unknown error');
      if (/401|403|token|expired|unauthorized/i.test(err)) {
        setUpstoxStatus(
          'Status: Failed — token expired or invalid. Generate a new Access Token in Upstox developer app (~expires 3:30 AM IST).',
          'error'
        );
      } else {
        setUpstoxStatus(`Status: Failed — ${err}`, 'error');
      }
    }
  } catch (err) {
    setUpstoxStatus(`Status: Failed — ${err.message || String(err)}`, 'error');
  }
}

upstoxSaveBtn?.addEventListener('click', () => saveUpstoxCreds());
upstoxTestBtn?.addEventListener('click', () => testUpstoxCreds());
upstoxClearBtn?.addEventListener('click', () => clearUpstoxCreds());

const investorRiskEl = document.getElementById('investor-risk-pct');
const investorCapitalEl = document.getElementById('investor-capital');
const investorStatusEl = document.getElementById('investor-status');
const investorSaveBtn = document.getElementById('investor-save');
const journalClearBtn = document.getElementById('journal-clear');

function setInvestorStatus(text, kind) {
  if (!investorStatusEl) return;
  investorStatusEl.textContent = text;
  investorStatusEl.classList.remove('ok', 'error', 'warn');
  if (kind) investorStatusEl.classList.add(kind);
}

async function loadInvestorDefaults() {
  try {
    const res = await chrome.storage.local.get(['investorRiskPct', 'investorCapital', 'tradeJournal']);
    const risk = Number(res.investorRiskPct);
    const cap = Number(res.investorCapital);
    if (investorRiskEl && Number.isFinite(risk) && risk > 0) investorRiskEl.value = String(risk);
    if (investorCapitalEl && Number.isFinite(cap) && cap > 0) investorCapitalEl.value = String(cap);
    const n = Array.isArray(res.tradeJournal) ? res.tradeJournal.length : 0;
    const r = investorRiskEl?.value || '1';
    const c = Number(investorCapitalEl?.value || 100000).toLocaleString('en-IN');
    setInvestorStatus(`Risk ${r}% · capital ₹${c} · journal ${n}`, 'ok');
  } catch (_) {
    setInvestorStatus('Using defaults', 'warn');
  }
}

async function saveInvestorDefaults() {
  const investorRiskPct = Math.min(5, Math.max(0.25, parseFloat(investorRiskEl?.value) || 1));
  const investorCapital = Math.max(1000, parseFloat(investorCapitalEl?.value) || 100000);
  if (investorRiskEl) investorRiskEl.value = String(investorRiskPct);
  if (investorCapitalEl) investorCapitalEl.value = String(investorCapital);
  await chrome.storage.local.set({ investorRiskPct, investorCapital });
  setInvestorStatus(
    `Saved · Risk ${investorRiskPct}% · capital ₹${investorCapital.toLocaleString('en-IN')}`,
    'ok'
  );
}

async function clearTradeJournal() {
  if (!confirm('Clear all Megamind journal entries?')) return;
  await chrome.storage.local.set({ tradeJournal: [] });
  setInvestorStatus('Journal cleared', 'ok');
}

investorSaveBtn?.addEventListener('click', () => saveInvestorDefaults());
journalClearBtn?.addEventListener('click', () => clearTradeJournal());

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadDhanCreds();
  await loadUpstoxCreds();
  await loadInvestorDefaults();
  await applyBrokerPopupTheme();
});

async function applyBrokerPopupTheme() {
  let broker = 'kite';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (/upstox\.com/i.test(url)) broker = 'upstox';
    else if (/kite\.zerodha\.com/i.test(url) || /mock-kite/i.test(url)) broker = 'kite';
  } catch (_) {}

  document.body.classList.remove('theme-kite', 'theme-upstox');
  document.body.classList.add(`theme-${broker}`);
  const chip = document.getElementById('broker-chip');
  if (chip) chip.textContent = broker === 'upstox' ? 'Upstox' : 'Kite';
}
