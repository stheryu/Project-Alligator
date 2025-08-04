// utils/storage.js
export function getCart() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ cart: [] }, (res) => {
      resolve(Array.isArray(res.cart) ? res.cart : []);
    });
  });
}

export function setCart(items) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ cart: Array.isArray(items) ? items : [] }, () => resolve());
  });
}

export function clearCart() {
  return setCart([]);
}

export function removeItem(id) {
  const key = String(id);
  return getCart().then((items) => {
    const next = items.filter((it) => String(it.id || "") !== key);
    return setCart(next);
  });
}