// Inpage/pageHook.hybris.inpage.js
// Hybris/Zara/Mango network hook (frame-safe)
// Emits ADD_EVENT on strong POST signals and ignores analytics.

(() => {
  if (window.__UC_HYBRIS_HOOK__) return;
  window.__UC_HYBRIS_HOOK__ = true;

  const DEBUG = true;
  const dbg = (...a) => DEBUG && console.debug("[UC hybris hook]", ...a);

  const IS_ZARA  = /(\.|^)zara\.com$/i.test(location.hostname);
  const IS_MANGO = /(\.|^)mango\.com$/i.test(location.hostname) || /(\.|^)shop\.mango\.com$/i.test(location.hostname);

  // Ignore telemetry / CDNs
  const IGNORE_HOSTS = /(dynatrace|doubleclick|google-analytics|googletag|adobedtm|omniture|newrelic|datadog|segment|optimizely|hotjar|snowplow|facebook|quantserve|akamai|krxd|cloudfront)\./i;

  // Minimal dedupe (same URL in quick succession)
  let LAST_URL = "", LAST_T = 0;
  function dedup(url, ms = 900) {
    const t = Date.now();
    if (url === LAST_URL && t - LAST_T < ms) return true;
    LAST_URL = url; LAST_T = t; return false;
  }

  const postToCS = (payload) => {
    try {
      window.postMessage({ source: "UnifiedCartPage", type: "ADD_EVENT", ...payload }, "*");
      dbg("emit", payload.via, payload.method, payload.url);
    } catch {}
  };

  const hostOf = (u) => { try { return new URL(u, location.href).hostname; } catch { return ""; } };

  function bodyToString(body) {
    try {
      if (!body) return "";
      if (typeof body === "string") return body;
      if (body instanceof URLSearchParams) return body.toString();
      if (body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body.entries()) obj[k] = typeof v === "string" ? v : "[blob]";
        return new URLSearchParams(obj).toString();
      }
      if (typeof body === "object") return JSON.stringify(body);
    } catch {}
    return "";
  }

  // Matchers
  const RE_HYBRIS_ENTRIES_V = /\/(?:occ|rest)\/v\d+\/[^/]+\/users\/[^/]+\/carts\/[^/]+\/entries\b/i;
  const RE_HYBRIS_ENTRIES   = /\/carts?\/(?:current|[a-z0-9-]+)\/entries\b/i;

  // Observed Zara (bag) patterns and safe variants
  const RE_ZARA_BAG = /(\/api\/commerce\/bag(\/items)?|\/bag\/(add|add-item|addItem)|\/shopping-?bag)\b/i;

  // GraphQL (Mango commonly)
  const RE_GRAPHQL     = /(graphql|api\/graphql|\/gateway)\b/i;
  const RE_GRAPHQL_MUT = /\b(addToCart|addCartEntry|addItemToCart|cartAdd|addLineItem|addBagItem)\b/i;

  // Safe generic
  const RE_GENERIC_CART_ADD = /\/cart(?:s)?\/(add|add-product|entries|line-items|addentry)\b/i;
  const RE_BASKET_ADD       = /(basket|bag|add-to-bag|addtobasket)\b/i;

  function looksLikeAdd(url, method, bodyStr) {
    if (method !== "POST") return false;
    const host = hostOf(url);
    if (IGNORE_HOSTS.test(host)) return false;

    const u = String(url || "");
    const hasProd = /\b(product|productCode|sku|variant|style|pid|id)\b/i.test(bodyStr);
    const hasQty  = /\b(qty|quantity)\b/i.test(bodyStr);

    if (RE_HYBRIS_ENTRIES_V.test(u) || RE_HYBRIS_ENTRIES.test(u)) return hasProd || hasQty || RE_GRAPHQL_MUT.test(bodyStr);
    if (IS_ZARA && RE_ZARA_BAG.test(u)) return true;
    if (IS_MANGO && RE_GRAPHQL.test(u) && RE_GRAPHQL_MUT.test(bodyStr)) return true;
    if (RE_GENERIC_CART_ADD.test(u) || RE_BASKET_ADD.test(u)) return hasProd || hasQty || RE_GRAPHQL_MUT.test(bodyStr);

    // Last resort: same-site POST with cart/bag + add in path
    try {
      const { hostname, pathname } = new URL(u, location.href);
      const sameSite = hostname.split(".").slice(-2).join(".") === location.hostname.split(".").slice(-2).join(".");
      if (sameSite && /\/(cart|bag|basket)\b/i.test(pathname) && /\badd/i.test(pathname)) return true;
    } catch {}
    return false;
  }

  // ---- fetch wrapper ----
  const _fetch = window.fetch;
  if (typeof _fetch === "function") {
    window.fetch = async function(input, init) {
      try {
        const url    = (input && input.url) ? input.url : String(input || "");
        const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
        const bodyStr= bodyToString(init?.body ?? (input && input.body));
        if (looksLikeAdd(url, method, bodyStr) && !dedup(url)) {
          const res = await _fetch.apply(this, arguments);
          Promise.resolve().then(() => postToCS({ via: "fetch", url, method }));
          return res;
        }
      } catch {}
      return _fetch.apply(this, arguments);
    };
  }

  // ---- XHR wrapper (instance listener — fixes "Illegal invocation") ----
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try { this.__uc_m = String(method || "GET").toUpperCase(); this.__uc_u = String(url || ""); } catch {}
    return _open.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(body) {
    try {
      this.__uc_b = body;
      // IMPORTANT: attach on the instance (not on the prototype)
      this.addEventListener("loadend", () => {
        try {
          const method = this.__uc_m || "GET";
          const url    = this.__uc_u || "";
          const bodyStr= bodyToString(this.__uc_b);
          if (looksLikeAdd(url, method, bodyStr) && !dedup(url)) {
            Promise.resolve().then(() => postToCS({ via: "xhr", url, method }));
          }
        } catch {}
      });
    } catch {}
    return _send.apply(this, [body]);
  };

  dbg("active in frame:", location.hostname, location.pathname);
})();