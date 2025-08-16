// content-scripts/pageHook.js
(function injectPageHook() {
  const code = `
  (function () {
    const ADD_RE = /cart|bag|basket|add/i;
    const post = (via, url) => {
      try { window.postMessage({ source: 'UnifiedCartPage', type: 'ADD_EVENT', via, url }, '*'); } catch (e) {}
    };

    const _fetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (ADD_RE.test(url)) post('fetch', url);
      } catch (e) {}
      return _fetch.apply(this, arguments);
    };

    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (ADD_RE.test(url)) {
          this.addEventListener('loadend', () => post('xhr', url));
        }
      } catch (e) {}
      return _open.apply(this, arguments);
    };

    document.addEventListener('submit', () => { try { post('submit', location.href); } catch (e) {} }, true);
    console.debug('[UnifiedCart] pageHook injected');
  })();`;

  const s = document.createElement('script');
  s.textContent = code;
  (document.documentElement || document.head).appendChild(s);
  s.remove();
})();