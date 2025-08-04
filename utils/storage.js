// utils/storage.js
export function getCart() {
  return chrome.storage.sync.get({ cart: [] }).then((r) => r.cart || []);
}
export function setCart(items) {
  return chrome.storage.sync.set({ cart: items });
}
export function clearCart() {
  return chrome.storage.sync.set({ cart: [] });
}
export function removeItem(id) {
  return getCart()
    .then((items) => items.filter((i) => String(i.id) !== String(id)))
    .then(setCart);
}