// content-scripts/toastListener.js
// Keep your existing toast aesthetics. Only show when background confirms (confirm: true).

(() => {
  if (window.top !== window) return; // top frame only

  // --- your existing showToast implementation (unchanged visuals) ---
  function showToast(text = "Added", pos = "top-right", ttl = 1400) {
    // If you already have this function with your styles, keep it.
    // Below is the same minimal styling we used before — feel free to replace with your exact one.
    let root = document.getElementById("__uc_toast_root__");
    if (!root) {
      root = document.createElement("div");
      root.id = "__uc_toast_root__";
      Object.assign(root.style, {
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "none",
        inset: "0px",
      });
      document.documentElement.appendChild(root);
    }

    const box = document.createElement("div");
    box.className = "__uc_toast__";
    Object.assign(box.style, {
      position: "absolute",
      maxWidth: "260px",
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      fontSize: "13px",
      lineHeight: "1.25",
      color: "#fff",
      background: "rgba(5, 142, 63, 0.98)",
      borderRadius: "10px",
      padding: "10px 12px",
      boxShadow: "0 8px 30px rgba(0,0,0,.25)",
      transform: "translateY(-6px)",
      opacity: "0",
      transition: "opacity .16s ease, transform .16s ease",
      pointerEvents: "none",
    });

    const margin = 14;
    if (pos === "top-right")      { box.style.top = margin + "px";    box.style.right = margin + "px"; }
    else if (pos === "top-left")  { box.style.top = margin + "px";    box.style.left = margin + "px";  }
    else if (pos === "bottom-left"){ box.style.bottom = margin + "px"; box.style.left = margin + "px";  }
    else                           { box.style.bottom = margin + "px"; box.style.right = margin + "px"; }

    box.textContent = text;
    root.appendChild(box);

    requestAnimationFrame(() => { box.style.opacity = "1"; box.style.transform = "translateY(0)"; });
    setTimeout(() => {
      box.style.opacity = "0";
      box.style.transform = "translateY(-6px)";
      setTimeout(() => box.remove(), 180);
    }, ttl);
  }

  // --- gate: ONLY show on confirmed SHOW_TOAST from background ---
  chrome.runtime.onMessage.addListener((msg) => {
    try {
      if (!msg || msg.action !== "SHOW_TOAST" || msg.confirm !== true) return;
      const text = msg.text || "Added to cart";
      const pos  = msg.pos  || "top-right";
      showToast(text, pos);
    } catch {}
  });
})();