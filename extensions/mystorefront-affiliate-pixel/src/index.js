import { register } from "@shopify/web-pixels-extension";

// MyStorefront affiliate pixel.
//
// Runs in Shopify's strict sandbox on every storefront and checkout page,
// whatever theme is active and whether or not the theme app embed is on.
//
// 1. page_viewed: if the URL has ?click_id=<uuid>, remember it for 30 days.
// 2. checkout_started / checkout_completed: send the remembered click_id and
//    the checkout token to the MyStorefront Postback backend, which matches
//    it to the paid order.
//
// No cart changes, no customer details sent.

const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const STORAGE_KEY = "mystorefront_pixel_referral_v1";
const MAX_AGE_MS = 30 * 86400000;

function clickIdFromUrl(href) {
  try {
    const id = new URL(href).searchParams.get("click_id");
    return id && CLICK_ID.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

register(({ analytics, browser, settings }) => {
  const shop = String(settings?.shop || "").toLowerCase();
  const endpoint = String(settings?.endpoint || "");
  if (!SHOP.test(shop) || !endpoint.startsWith("https://")) return;

  async function readStored() {
    try {
      const raw = await browser.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const fresh =
        CLICK_ID.test(data?.click_id) &&
        Number.isFinite(data?.at) &&
        data.at <= Date.now() + 60000 &&
        Date.now() - data.at < MAX_AGE_MS;
      return fresh ? data : null;
    } catch {
      return null;
    }
  }

  async function capture(event) {
    const id = clickIdFromUrl(event?.context?.document?.location?.href || "");
    if (!id) return;
    try {
      // Newest click wins, same as the theme embed (URL beats stored value).
      await browser.localStorage.setItem(STORAGE_KEY, JSON.stringify({ click_id: id, at: Date.now() }));
    } catch {}
  }

  async function report(event) {
    const checkout = event?.data?.checkout;
    const token = checkout?.token;
    if (typeof token !== "string" || !token) return;
    const stored = await readStored();
    if (!stored) return;
    try {
      // text/plain keeps this a "simple" request, so no CORS preflight is needed.
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({
          shop,
          click_id: stored.click_id,
          checkout_token: token,
          order_id: checkout?.order?.id ? String(checkout.order.id) : null,
        }),
        keepalive: true,
      });
    } catch {}
  }

  analytics.subscribe("page_viewed", (event) => { void capture(event); });
  analytics.subscribe("checkout_started", (event) => { void report(event); });
  analytics.subscribe("checkout_completed", (event) => { void report(event); });
});
