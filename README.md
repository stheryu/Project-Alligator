Alligator · One cart. All stores.

Collect every “Add to Cart” in one place so you can review, compare, and never forget.

Demo: https://youtu.be/pWlEJEw95_g
Contact: https://www.linkedin.com/in/joohyunyu0130/

What it does
	•	Captures title, price, URL, and image the moment you click Add to Cart on supported sites.
	•	Shopping Mode toggle controls when listeners run.
	•	Popup lets you review items, delete individual entries, or Clear All.

Why

Carts live on separate sites, so items get scattered or forgotten. Alligator keeps them in one organized window.

Screenshots
Supported sites
	•	Amazon, Ebay, Zara, Shopbop, Bloomingdales
	•	Generic fallback for similar online stores

How it works
	•	Lightweight content scripts listen for “Add to Cart” actions on product pages.
	•	A generic fallback extracts product metadata when site-specific listeners are unavailable.
	•	A small popup UI displays captured items, with basic controls.

Install (for development)
	•	Clone or download this repository.

Privacy
	•	Captures only the product metadata you add (title, price, URL, image).
	•	No selling or sharing of personal data.
	•	No checkout or payment information is accessed.

Roadmap
	•	Smarter de-duplication across stores
	•	Expanded site coverage
	•	Lightweight metrics in the popup (items per session, site coverage)
	•	Export/share list

Known limitations
	•	Some pages with heavy dynamic content can be inconsistent for the generic fallback.
	•	If a site changes its DOM, a listener may need an update.
