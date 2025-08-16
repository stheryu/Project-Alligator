// content-scripts/pageBridge.hybris.js
(() => {
  if (window.__UC_BRIDGE_HYBRIS__) return;
  window.__UC_BRIDGE_HYBRIS__ = true;

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("Inpage/pageHook.hybris.inpage.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch {}

  // swallow benign MV3 lastError + tiny dedupe (same URL spam)
  const LAST = { url: "", t: 0 };
  const WINDOW_MS = 800;

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev?.data;
    if (!d || d.source !== "UnifiedCartPage" || d.type !== "ADD_EVENT") return;

    const now = Date.now();
    if (d.url && d.url === LAST.url && now - LAST.t < WINDOW_MS) return;
    LAST.url = d.url || ""; LAST.t = now;

    try {
      chrome.runtime.sendMessage({
        action: "PAGE_ADD_EVENT",
        via: d.via,
        url: d.url,
        method: d.method
      }, () => void chrome.runtime?.lastError);
    } catch {}
  }, false);
})();