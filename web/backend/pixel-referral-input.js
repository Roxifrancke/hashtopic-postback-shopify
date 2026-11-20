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
  const raw = Array.isArray(body.click_history) ? body.click_history : [];
  const history = raw.slice(-50).filter((x) => x && CLICK_ID.test(String(x.click_id || "")) &&
    typeof x.at === "number" && Number.isFinite(x.at) &&
    x.at > Date.now() - 30 * 86400000 && x.at <= Date.now() + 60000
  ).map((x) => ({ click_id: String(x.click_id).toLowerCase(), at: x.at }));
  const journeyId = typeof body.journey_id === "string" &&
    CLICK_ID.test(body.journey_id) ? body.journey_id.toLowerCase() : null;
  return { shop, clickId, checkoutToken, orderId: parseOrderId(body.order_id),
    history, journeyId, historyComplete: body.history_complete === true };
}
