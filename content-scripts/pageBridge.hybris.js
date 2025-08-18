// content-scripts/pageBridge.hybris.js
(() => {
  if (window.__UC_BRIDGE_HYBRIS__) return;
  window.__UC_BRIDGE_HYBRIS__ = true;

  let inpageReady = false;

  function dbg(...a){ try{ console.debug("[UnifiedCart-Hybris bridge]", ...a);}catch{} }

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("Inpage/pageHook.hybris.inpage.js");
    s.onload = () => { inpageReady = true; s.remove(); dbg("inpage hook loaded"); };
    s.onerror = () => { dbg("inpage hook FAILED to load (likely CSP) — falling back to UI-click mode"); };
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    dbg("inject error", e);
  }

  // Forward safe network nudges from inpage (when CSP allows)
  const LAST = { url: "", t: 0 };
  const WINDOW_MS = 800;
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev?.data;
    if (!d || d.source !== "UnifiedCartPage" || d.type !== "ADD_EVENT") return;
    const now = Date.now();
    if (d.url && d.url === LAST.url && now - LAST.t < WINDOW_MS) return;
    LAST.url = d.url || ""; LAST.t = now;
    try { chrome.runtime.sendMessage({ action: "PAGE_ADD_EVENT", via: d.via, url: d.url, method: d.method }, () => void chrome.runtime?.lastError); } catch {}
  }, false);

  // Expose a ping so the listener can know whether inpage is alive
  window.__UC_HYBRIS_INPAGE_READY__ = () => inpageReady;
})();