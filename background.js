// background.js
console.log("Unified Cart SW v0.1.10 starting");

// Simple in-memory throttle per tab to avoid bursts
const recentTabTriggers = new Map(); // tabId -> timestamp
function shouldNotifyTab(tabId, cooldownMs = 1200) {
  const now = Date.now();
  const last = recentTabTriggers.get(tabId) || 0;
  if (now - last < cooldownMs) return false;
  recentTabTriggers.set(tabId, now);
  return true;
}

// Helper: skip pixel/tracking artifacts
function isTrackingImage(url = "") {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.startsWith("data:") ||
    u.endsWith(".svg") ||
    /p13n\.gif|pixel|1x1|spacer|beacon/.test(u)
  );
}
function looksLikeNoise(item) {
  const t = (item.title || "").toLowerCase();
  const p = (item.price || "").trim();
  return !p && (isTrackingImage(item.img) || /p13n|1×1|1x1|pixel/.test(t));
}

// Messages from content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "PING") {
    sendResponse({ ok: true });
    return; // sync
  }

  if (msg?.action === "ADD_ITEM" && msg.item) {
    // Filter obvious noise just in case
    if (looksLikeNoise(msg.item)) {
      console.log("[UnifiedCart] Ignored tracking/noise item", msg.item);
      try { sendResponse({ ok: true, ignored: true }); } catch {}
      return;
    }

    chrome.storage.sync.get({ cart: [] }, ({ cart }) => {
      let items = Array.isArray(cart) ? cart : [];
      const keyId = String(msg.item.id || "");
      const keyLink = String(msg.item.link || "");

      // De-dupe by id OR link
      items = items.filter(
        it => String(it.id || "") !== keyId && String(it.link || "") !== keyLink
      );
      items.push(msg.item);

      chrome.storage.sync.set({ cart: items }, () => {
        try {
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icon48.png",
            title: "Item Added",
            message: `${msg.item.title || "Item"} added to your unified cart.`
          });
        } catch (_) {}
        try { sendResponse({ ok: true }); } catch {}
      });
    });
    return true; // keep channel open until sendResponse
  }
});

// Network-based detection — keep ONLY Amazon/eBay to avoid false positives
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const u = (details.url || "").toLowerCase();
      if (!/(cart|bag|basket|add|checkout)/.test(u)) return;
      if (!shouldNotifyTab(details.tabId)) return;

      // Only notify top frame; some sites load beacons in iframes
      chrome.tabs.sendMessage(
        details.tabId,
        { action: "ADD_TRIGGERED", via: "webRequest", url: details.url },
        { frameId: 0 }
      );
    },
    {
      urls: [
        "*://*.amazon.com/*",
        "*://*.ebay.com/*"
        // Walmart/Shopbop/Zara disabled intentionally to prevent random triggers
      ]
    }
  );
} catch (e) {
  console.error("[UnifiedCart] webRequest listener error:", e);
}