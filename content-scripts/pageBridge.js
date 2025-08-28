// content-scripts/pageBridge.js (generic bridge)
(() => {
  if (window.__UC_BRIDGE__) return;
  window.__UC_BRIDGE__ = true;

  if (document.documentElement?.dataset?.alSfccInjected === "1") {
    return;
  }

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("Inpage/pageHook.inpage.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch {
  }

  const LAST = { url: "", t: 0 };
  const WINDOW_MS = 800;

  function sendToBG(payload) {
    try {
      if (!chrome?.runtime?.id) return; // extension reloaded / page stale
      chrome.runtime.sendMessage(payload, () => void chrome.runtime?.lastError);
    } catch {}
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev?.data;
    if (!d || d.source !== "UnifiedCartPage" || d.type !== "ADD_EVENT") return;

    const now = Date.now();
    if (d.url && d.url === LAST.url && now - LAST.t < WINDOW_MS) return;
    LAST.url = d.url || ""; LAST.t = now;

    queueMicrotask(() => sendToBG({
      action: "PAGE_ADD_EVENT",
      via: d.via,
      url: d.url,
      method: d.method
    }));
  }, false);
})();