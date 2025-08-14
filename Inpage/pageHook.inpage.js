// inpage/pageHook.inpage.js
// Runs in the page's JS context. Hooks fetch/XHR/form submit and posts events
// back to the content script via window.postMessage (CSP-safe; no inline code).
(() => {
  // Only match canonical add endpoints like Shopify /cart/add(.js|.json)
  const ADD_RE = /\/cart\/add(?:\.(?:js|json))?(?:\?|$)/i;

  const post = (via, url) => {
    try {
      window.postMessage(
        { source: "UnifiedCartPage", type: "ADD_EVENT", via: String(via || ""), url: String(url || "") },
        "*"
      );
    } catch {}
  };

  // Pull HTTP method from Request/init + optional X-HTTP-Method-Override
  function methodFrom(input, init) {
    try {
      if (input && typeof input === "object" && "method" in input && input.method) return String(input.method);
    } catch {}
    const m = (init && init.method) || "";
    const headers = (init && init.headers) || (input && input.headers);
    const getHeader = (hs, name) => {
      try {
        if (!hs) return "";
        if (hs.get) return hs.get(name) || "";
        if (Array.isArray(hs)) {
          const low = name.toLowerCase();
          for (const [k, v] of hs) if (String(k).toLowerCase() === low) return v;
          return "";
        }
        for (const k in hs) if (Object.prototype.hasOwnProperty.call(hs, k) && String(k).toLowerCase() === name.toLowerCase()) return hs[k];
        return "";
      } catch { return ""; }
    };
    const override = getHeader(headers, "X-HTTP-Method-Override");
    return override || m || "GET";
  }

  // --- fetch ---
  const _fetch = window.fetch;
  if (typeof _fetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (ADD_RE.test(url)) {
          const m = String(methodFrom(input, init)).toUpperCase();
          if (m === "POST") post("fetch", url);
        }
      } catch {}
      return _fetch.apply(this, arguments);
    };
  }

  // --- XHR ---
  const _open = XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open;
  if (_open) {
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        const m = String(method || "").toUpperCase();
        if (ADD_RE.test(String(url)) && m === "POST") {
          this.addEventListener("loadend", () => post("xhr", url));
        }
      } catch {}
      return _open.apply(this, arguments);
    };
  }

  // --- form submit (e.g., Shopify PDP forms) ---
  document.addEventListener("submit", (ev) => {
    try {
      const f = ev && ev.target;
      if (!f?.getAttribute) return;
      const action = String(f.getAttribute("action") || "");
      const method = String(f.getAttribute("method") || "GET").toUpperCase();
      if (ADD_RE.test(action) && method === "POST") post("submit", action);
    } catch {}
  }, true);

  // No UI-based click hints here (prevents storefront/grid false positives)

  try { console.debug("[UnifiedCart] inpage hook active (strict)"); } catch {}
})();