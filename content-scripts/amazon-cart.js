// content-scripts/amazon-cart.js
(() => {
  console.log('🛒 [Amazon] Running refined Amazon cart scraper');

  // 1) Locate the “Active Items” container (aria-label may vary by locale)
  const activeSection =
    document.querySelector('[aria-label="Active Items"]') ||
    document.querySelector('#sc-active-cart');

  if (!activeSection) {
    console.warn('⚠️ [Amazon] No Active Items container found');
    return;
  }

  // 2) Within that section, select each cart-item
  const rows = Array.from(
    activeSection.querySelectorAll('div[data-testid="cart-item"], .sc-list-item')
  );
  const seen = new Set();
  const items = [];

  rows.forEach(row => {
    // 3) Filter out any non-item rows (e.g. recommendation banners inside the section)
    if (
      !row.querySelector('input[value="Delete"], button[aria-label*="Delete"], [data-testid="quantity"]')
    ) {
      return;
    }

    // 4) Grab title, price and link
    const titleEl =
      row.querySelector('[data-testid="cart-item-title"]') ||
      row.querySelector('.sc-product-title') ||
      row.querySelector('.sc-product-link');
    const priceEl =
      row.querySelector('[data-testid="cart-item-price"]') ||
      row.querySelector('.sc-product-price');
    const linkEl =
      row.querySelector('[data-testid="cart-item-image-link"] a') ||
      row.querySelector('.sc-product-link');

    if (!titleEl || !priceEl) return;

    const title = titleEl.innerText.trim();
    const price = parseFloat(priceEl.innerText.replace(/[^0-9.]/g, '')) || 0;
    const url = linkEl ? linkEl.href.split('?')[0] : location.href;
    const id = `${url}::${title}`;

    if (seen.has(id)) return;
    seen.add(id);

    items.push({ id, site: 'amazon.com', title, price, url, addedAt: Date.now() });
    console.log('〰️DBG Amazon:', title, price);
  });

  // 5) Send to background (or warn if none)
  if (items.length) {
    chrome.runtime.sendMessage({ type: 'ADD_CART_ITEMS', items }, _ =>
      console.log('📤 [Amazon] Sent items:', items)
    );
  } else {
    console.warn('⚠️ [Amazon] No cart items found in Active Items');
  }
})();