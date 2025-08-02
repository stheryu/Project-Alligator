// content-scripts/generic-cart.js
(() => {
  console.log('🛒 [Generic] Fallback cart scraper running');

  // 1) Find all elements whose text contains a $-price
  const priceEls = Array.from(document.querySelectorAll('body *'))
    .filter(el => /\$\s*\d/.test(el.innerText));

  const seen = new Set();
  const items = [];

  priceEls.forEach(el => {
    // 2) Bubble up until we reach an element with ≥2 lines of text
    let wrapper = el;
    while (
      wrapper.parentElement &&
      wrapper.parentElement.innerText.split('\n').length < 2
    ) {
      wrapper = wrapper.parentElement;
    }

    const text = wrapper.innerText;
    // 3) Skip site-wide noise/promos
    if (/(skip to content|add to bag|recommended|accessories to match|calculated at checkout|your items)/i.test(text)) {
      return;
    }

    // 4) Break into lines, trim out blanks
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // 5) Pick the first valid price & title
    const priceLine = lines.find(l => /^\$\s*\d/.test(l));
    const titleLine = lines.find(l => !l.startsWith('$') && l.split(' ').length >= 3);
    if (!priceLine || !titleLine) return;

    const price = parseFloat(priceLine.replace(/[^0-9.]/g, '')) || 0;
    const title = titleLine;

    // 6) Extract URL if possible
    const linkEl = wrapper.querySelector('a[href]');
    const url    = linkEl ? linkEl.href : location.href;
    const id     = `${url}::${title}`;

    // 7) Deduplicate
    if (seen.has(id)) return;
    seen.add(id);

    items.push({ id, site: location.hostname, title, price, url, addedAt: Date.now() });
    console.log('〰️DBG: added item', title, price);
  });

  // 8) Send to background
  if (items.length) {
    chrome.runtime.sendMessage({ type: 'ADD_CART_ITEMS', items }, resp =>
      console.log('📤 [Generic] Sent items:', resp)
    );
  } else {
    console.warn('⚠️ [Generic] No valid items found');
  }
})();