(() => {
  if (window.__UC_HOOK__) return;
  window.__UC_HOOK__ = true;

  const post = (payload) => {
    window.postMessage({ source: "UnifiedCartPage", type: "ADD_EVENT", ...payload }, "*");
  };

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const [req, init] = args;
      const url = String(req?.url || req);
      if (/\/(cart\/add(\.js|\.json)?|Cart-AddProduct|Cart-MiniAddProduct)/i.test(url)) {
        const res = await origFetch.apply(this, args);
        // Let it complete successfully before nudging
        Promise.resolve().then(() => post({ via: "fetch", url, method: (init?.method || "GET").toUpperCase() }));
        return res;
      }
    } catch {}
    return origFetch.apply(this, args);
  };

  // Intercept XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.addEventListener("loadend", () => {
      if (/\/(cart\/add(\.js|\.json)?|Cart-AddProduct|Cart-MiniAddProduct)/i.test(String(url))) {
        post({ via: "xhr", url: String(url), method: String(method || "GET").toUpperCase() });
      }
    });
    return origOpen.call(this, method, url, ...rest);
  };
})();