// content-scripts/site-cart.js
(() => {
  if (!location.hostname.includes('shopbop.com')) return;

  // Grab all candidate rows
  const allRows = Array.from(
    document.querySelectorAll('div.Containers__FlexRowContainer-sc-jgm1i6-0')
  );

  // Keep only rows that have both a product link AND a “$” in the text
  const wrappers = allRows.filter(row => {
    const hasLink  = !!row.querySelector('a[data-at="productImageUrl"]');
    const hasPrice = /\$\d/.test(row.innerText);
    return hasLink && hasPrice;
  });

  console.log('🛒 [Shopbop] Found', wrappers.length, 'items');

  const items = wrappers.map(wrapper => {
    const link      = wrapper.querySelector('a[data-at="productImageUrl"]');
    const lines     = wrapper.innerText.split('\n').map(l=>l.trim()).filter(Boolean);
    const brand     = lines[0] || '';
    const name      = lines[1] || '';
    const title     = brand && name ? `${brand} – ${name}` : name || brand;
    const priceLine = lines.find(l => l.startsWith('$')) || '';
    const price     = parseFloat(priceLine.replace(/[^0-9.]/g, '')) || 0;
    const url       = link.href;
    const id        = `${url}::${title}`;

    return { id, site: 'shopbop.com', title, price, url, addedAt: Date.now() };
  }).filter(Boolean);

  if (items.length) {
    chrome.runtime.sendMessage({ type: 'ADD_CART_ITEMS', items }, resp =>
      console.log('📤 [Shopbop] Sent items:', resp)
    );
  }
})();