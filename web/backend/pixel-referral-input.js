// Input checks for Web Pixel referrals. Kept separate from pixel-referrals.js
// (which needs the database) so they can be unit tested on their own.

export const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export const CLICK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CHECKOUT_TOKEN = /^[A-Za-z0-9_-]{12,128}$/;

/** Pull the numeric order ID out of "123" or "gid://shopify/Order/123". */
export function parseOrderId(value) {
  const match = String(value ?? "").match(/(?:^|\/)([1-9][0-9]{0,19})$/);
  return match ? match[1] : null;
}

/** Returns a clean referral object, or null if the body is not usable. */
export function validateReferral(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const shop = String(body.shop || "").toLowerCase();
  const clickId = String(body.click_id || "").toLowerCase();
  const checkoutToken = String(body.checkout_token || "");
  if (!SHOP.test(shop) || !CLICK_ID.test(clickId) || !CHECKOUT_TOKEN.test(checkoutToken)) {
    return null;
  }
  return { shop, clickId, checkoutToken, orderId: parseOrderId(body.order_id) };
}
