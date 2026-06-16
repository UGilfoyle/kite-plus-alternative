// Background Service Worker for KitePlus Clone
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Open the mock trading platform to let the user test the extension immediately
    chrome.tabs.create({
      url: chrome.runtime.getURL('mock-kite.html')
    });
  }
});
