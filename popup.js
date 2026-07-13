// Default settings
const DEFAULT_SETTINGS = {
  grouping: true,
  basket: true,
  optionchain: true,
  charges: true,
  signals: true
};

// Elements
const toggles = {
  grouping: document.getElementById('toggle-grouping'),
  basket: document.getElementById('toggle-basket'),
  optionchain: document.getElementById('toggle-optionchain'),
  charges: document.getElementById('toggle-charges'),
  signals: document.getElementById('toggle-signals')
};

const openSandboxBtn = document.getElementById('open-sandbox');
const resetLink = document.getElementById('reset-settings');

// Load settings
async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get('settings');
    const current = settings.settings || DEFAULT_SETTINGS;
    
    // Apply states to toggles
    Object.keys(toggles).forEach(key => {
      if (toggles[key]) {
        toggles[key].checked = current[key] !== undefined ? current[key] : DEFAULT_SETTINGS[key];
      }
    });
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

// Save setting
async function saveSetting(key, val) {
  try {
    const res = await chrome.storage.local.get('settings');
    const current = res.settings || { ...DEFAULT_SETTINGS };
    current[key] = val;
    await chrome.storage.local.set({ settings: current });
    
    // Notify active tabs about settings change
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && (tab.url.includes('kite.zerodha.com') || tab.url.includes(chrome.runtime.id))) {
        chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings: current }).catch(() => {
          // Ignore tabs where script is not injected
        });
      }
    }
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Register listeners
Object.keys(toggles).forEach(key => {
  if (toggles[key]) {
    toggles[key].addEventListener('change', (e) => {
      saveSetting(key, e.target.checked);
    });
  }
});

// Launch Sandbox
if (openSandboxBtn) {
  openSandboxBtn.addEventListener('click', () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL('mock-kite.html')
    });
  });
}

// Reset Defaults
if (resetLink) {
  resetLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (confirm('Reset all settings to default?')) {
      await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
      await loadSettings();
      
      // Notify active tabs
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && (tab.url.includes('kite.zerodha.com') || tab.url.includes(chrome.runtime.id))) {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings: DEFAULT_SETTINGS }).catch(() => {});
        }
      }
    }
  });
}

// Init
document.addEventListener('DOMContentLoaded', loadSettings);
