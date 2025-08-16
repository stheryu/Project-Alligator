// inpage/pageHook.inpage.js
// Strict network/form add detection only (no UI fallback).

// TEMP: disable this script without deleting it
(() => {
  const DISABLED = true;
  if (DISABLED) {
    try { console.debug("[UnifiedCart] <filename>.js disabled"); } catch {}
    return; // nothing below will run
  }

  // --- original code stays below ---
})();

(function () {
  try {
    // Only explicit "add" endpoints
    const ADD_URL_RE = new RegExp(
      [
        String.raw`\/cart\/add(?:\.(?:js|json))?\b`,          // Shopify
        String.raw`\/Cart-(?:AddProduct|MiniAddProduct|AddToCart)\b`, // SFCC (e.g., DWR)
        String.raw`\badd-?to-?(?:cart|bag|basket)\b`,         // Generic wording
        String.raw`\/api\/(?:cart|basket)\/add\b`             // Common API
      ].join("|"),
      "i"
    );

    const METHOD_OK = (m) => {
      m = String(m || "GET").toUpperCase();
      return m === "POST" || m === "PUT" || m === "PATCH";
    };

    const post = (via, url, method) => {
      try {
        window.postMessage(
          { source: "UnifiedCartPage", type: "ADD_EVENT", via: String(via||""), url: String(url||""), method: String(method||"") },
          "*"
        );
      } catch {}
    };

    // fetch
    const _fetch = window.fetch;
    if (typeof _fetch === "function") {
      window.fetch = function (input, init) {
        try {
          let url = "", method = "GET";
          if (typeof input === "string") {
            url = input;
            method = (init && init.method) || "GET";
          } else {
            url = (input && input.url) || "";
            method = (input && input.method) || (init && init.method) || "GET";
          }
          if (ADD_URL_RE.test(String(url)) && METHOD_OK(method)) post("fetch", url, method);
        } catch {}
        return _fetch.apply(this, arguments);
      };
    }

    // XHR
    const _open = XMLHttpRequest && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open;
    if (_open) {
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          if (ADD_URL_RE.test(String(url)) && METHOD_OK(method)) {
            this.addEventListener("loadend", () => post("xhr", url, method));
          }
        } catch {}
        return _open.apply(this, arguments);
      };
    }

    // Forms
    document.addEventListener("submit", (ev) => {
      try {
        const f = ev && ev.target;
        if (!f) return;
        const action = (f.getAttribute && f.getAttribute("action")) || "";
        const method = (f.getAttribute && f.getAttribute("method")) || f.method || "GET";
        if (ADD_URL_RE.test(String(action)) && METHOD_OK(method)) post("submit", action, method);
      } catch {}
    }, true);

    console.debug("[UnifiedCart] inpage hook active (strict)");
  } catch (e) {
    console.debug("[UnifiedCart] inpage hook error:", e);
  }
})();