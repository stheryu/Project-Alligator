// background.js

// 1) Listen for scraped items and store them
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ADD_CART_ITEMS') {
    chrome.storage.local.get({ cartItems: [] }, data => {
      const stored = data.cartItems;
      msg.items.forEach(item => {
        if (!stored.find(i => i.id === item.id)) {
          stored.push(item);
        }
      });
      chrome.storage.local.set({ cartItems: stored }, () => {
        sendResponse({ status: 'stored', total: stored.length });
      });
    });
    return true;
  }
});

// 2) Simple “is cart page?” check
function isCartPage(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return (
      path.includes('/cart') ||
      path.includes('/bag') ||
      path.includes('/checkout') ||
      path.includes('/basket')
    );
  } catch {
    return false;
  }
}

// 3) Inject the scraper on cart‐like pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isCartPage(tab.url)) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/generic-cart.js']
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('❌ Failed to inject generic-cart.js:', chrome.runtime.lastError);
      } else {
        console.log('✅ Injected generic-cart.js');
      }
    });
  }
});