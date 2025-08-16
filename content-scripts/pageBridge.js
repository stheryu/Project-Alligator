(() => {
  if (window.top !== window) return;
  if (window.__UC_BRIDGE__) return;
  window.__UC_BRIDGE__ = true;

  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("Inpage/pageHook.inpage.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch {}

  window.addEventListener("message", (ev) => {
    const d = ev?.data;
    if (!d || d.source !== "UnifiedCartPage" || d.type !== "ADD_EVENT") return;
    chrome.runtime.sendMessage({ action: "PAGE_ADD_EVENT", via: d.via, url: d.url, method: d.method });
  }, false);
})();