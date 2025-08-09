// content-scripts/toastListener.js
(() => {
  if (window.__UC_TOAST_LOADED__) return;
  window.__UC_TOAST_LOADED__ = true;

  function ensureHost() {
    const HOST_ID = "uc-toast-host";
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      document.documentElement.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });

      const wrap = document.createElement("div");
      wrap.className = "uc-toast bottom"; // default; can switch to top-right
      wrap.textContent = "";

      const style = document.createElement("style");
      style.textContent = `
        .uc-toast {
          position: fixed;
          background: #E7F1BC;
          color: #058E3F;
          font-weight: 700;
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid #C9E08F;
          box-shadow: 0 4px 14px rgba(0,0,0,.12);
          font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
          font-size: 13px;
          z-index: 2147483647;
          pointer-events: none;
          opacity: 0;
          transform: translateY(-4px);
          transition: opacity .15s ease, transform .15s ease;
          max-width: min(90vw, 440px);
          text-align: center;
          white-space: nowrap;
        }
        .uc-toast.bottom {
          bottom: 16px;
          left: 50%;
          transform: translate(-50%, 4px);
        }
        .uc-toast.top-right {
          top: 10px;
          right: 12px;
          transform: translateY(-4px);
        }
        .uc-toast.show {
          opacity: 1;
          transform: translate(0, 0);
        }
      `;
      shadow.append(style, wrap);
      host.__ucShadow = shadow;
      host.__ucWrap = wrap;
    }
    return host;
  }

  function showToast(text = "Gotcha!", ms = 2000, pos = "top-right") {
    try {
      const host = ensureHost();
      const shadow = host.__ucShadow || host.shadowRoot;
      const wrap = host.__ucWrap || shadow.querySelector(".uc-toast");

      wrap.className = `uc-toast ${pos === "top-right" ? "top-right" : "bottom"}`;
      wrap.textContent = text;

      // show
      requestAnimationFrame(() => {
        wrap.classList.add("show");
        setTimeout(() => {
          wrap.classList.remove("show");
          setTimeout(() => { wrap.textContent = ""; }, 180);
        }, ms);
      });
    } catch {}
  }

  chrome.runtime?.onMessage?.addListener?.((msg) => {
    if (msg?.action === "SHOW_TOAST") {
      showToast(msg.text || "Gotcha!", 2000, msg.pos || "top-right");
    }
  });
})();