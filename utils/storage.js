// Project-Alligator/utils/storage.js
const CART_KEY = "cart";
const MODE_KEY = "shoppingMode";

export async function getCart() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ [CART_KEY]: [] }, (res) => resolve(res[CART_KEY] || []));
  });
}

export async function setCart(items) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [CART_KEY]: items || [] }, () => resolve());
  });
}

export async function addItem(item) {
  const cart = await getCart();
  // simple de-dupe by id+link
  const key = (item?.id || "") + "::" + (item?.link || "");
  const seen = new Set(cart.map(x => (x.id || "") + "::" + (x.link || "")));
  if (!seen.has(key)) {
    cart.push(item);
    await setCart(cart);
  }
  return cart;
}

export async function removeItem(idOrLink) {
  const cart = await getCart();
  const out = cart.filter(x => (x.id !== idOrLink && x.link !== idOrLink));
  await setCart(out);
  return out;
}

export async function clearCart() {
  await setCart([]);
  return [];
}

export async function getShoppingMode() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ [MODE_KEY]: true }, (res) => resolve(!!res[MODE_KEY]));
  });
}

export async function setShoppingMode(enabled) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [MODE_KEY]: !!enabled }, () => resolve());
  });
}