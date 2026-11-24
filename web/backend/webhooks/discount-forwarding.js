import { getSettings } from "../db.js";

// Called only after the existing Shopify HMAC check. Forward a signal, not
// stale discount terms; MyStorefront reads the current rule via our keyed API.
export async function forwardDiscountEvent(topic, shop, gid) {
  const match = /^gid:\/\/shopify\/DiscountCodeNode\/(\d+)$/.exec(String(gid || ""));
  if (!match) return; // automatic discounts are not creator codes
  const settings = await getSettings(shop);
  if (!settings?.mystorefront_api_key || !settings?.webhook_url) return;
  const endpoint = new URL(settings.webhook_url);
  if (endpoint.protocol !== "https:" || !endpoint.pathname.endsWith("/functions/v1/affiliate-postback")) {
    throw new Error("Invalid MyStorefront webhook endpoint");
  }
  endpoint.pathname = endpoint.pathname.replace(/affiliate-postback$/, "shopify-coupon-webhook");
  endpoint.search = "";
  endpoint.hash = "";
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(4000),
    headers: { "Content-Type": "application/json", "X-Mystorefront-Key": settings.mystorefront_api_key },
    body: JSON.stringify({ topic, shop_domain: shop, price_rule_id: match[1] }),
  });
  if (!response.ok) throw new Error("Discount forwarding HTTP " + response.status);
}
