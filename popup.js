// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const clearBtn = document.getElementById('clear');
  const emptyEl = document.getElementById('empty');
  const itemsEl = document.getElementById('items');

  // 1) Wire up the Clear All button
  clearBtn.addEventListener('click', () => {
    chrome.storage.local.set({ cartItems: [] }, () => {
      itemsEl.innerHTML = '';
      emptyEl.style.display = 'block';
    });
  });

  // 2) Load and render stored cart items
  chrome.storage.local.get({ cartItems: [] }, data => {
    const items = data.cartItems;
    if (!items.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    // Sort newest first
    items.sort((a, b) => b.addedAt - a.addedAt);
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div class="title">${item.title}</div>
        <div class="site">${item.site}</div>
        <div class="price">$${item.price.toFixed(2)}</div>
        <a href="${item.url}" target="_blank">View</a>
      `;
      itemsEl.appendChild(div);
    });
  });
});