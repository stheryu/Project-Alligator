// background.js (minimal & safe)
console.log("Unified Cart SW bootstrap v0.1.17");

// Simple message handler + storage write + Zara PDP guard
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg?.action === "PING") {
      sendResponse({ ok: true });
      return; // sync
    }

    if (msg?.action === "ADD_ITEM" && msg.item) {
      // --- Zara PDP guard: ignore non-product Zara pages ---
      try {
  const link = String(msg.item.link || "");
  if (/\.zara\.com/i.test(link)) {
    const { pathname } = new URL(link);
    if (!/-p\d+(?:\.html|$)/i.test(pathname)) {
      console.log("[UnifiedCart] ignore non-PDP Zara link:", link);
      try { sendResponse({ ok: true, ignored: true }); } catch {}
      return;
    }
  }
} catch (_) {}

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
          // Notification is optional; comment out if it ever causes issues
          try {
            chrome.notifications.create({
              type: "basic",
              iconUrl: "icon48.png", // ensure this file exists or remove this block
              title: "Item Added",
              message: `${msg.item.title || "Item"} added to your unified cart.`
            });
          } catch (_) {}

          try { sendResponse({ ok: true }); } catch {}
        });
      });
      return true; // keep channel open until sendResponse
    }
  } catch (e) {
    console.error("[UnifiedCart] background error:", e);
    try { sendResponse({ ok: false, error: String(e) }); } catch {}
  }
});