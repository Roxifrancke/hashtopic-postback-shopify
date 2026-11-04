// Web Pixel attribution research: PURE event normalization only.
// No network I/O, API permissions, cookie writes, checkout changes, or commissions.
// Shopify Web Pixels run in a sandbox and do NOT write Shopify cart attributes.
// A server-side, consent-aware matcher would be needed before production use.

const CLICK_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function readReferralFromPageUrl(urlString) {
  if (typeof urlString !== "string") return null;
  try {
    const url = new URL(urlString);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const id = url.searchParams.get("click_id");
    return id && CLICK_ID_RE.test(id) ? id : null;
  } catch { return null; }
}

/** Create a minimal event envelope, avoiding Shopify customer email, phone,
 * address, checkout details, financial totals and browser fingerprints. */
export function toPixelAttributionObservation({ event, shop, nowMs = Date.now() }) {
  if (typeof shop !== "string" || !SHOP_RE.test(shop)) return null;
  if (!event || (event.name !== "page_viewed" && event.name !== "checkout_completed")) return null;
  if (typeof event.id !== "string" || !event.id || event.id.length > 200) return null;
  if (typeof event.clientId !== "string" || !event.clientId || event.clientId.length > 200) return null;
  const ts = Date.parse(event.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MAX_AGE_MS) return null;
  const base = {
    version: 1, shop, event_name: event.name, event_id: event.id,
    event_time: new Date(ts).toISOString(), client_id: event.clientId,
  };
  if (event.name === "page_viewed") {
    const clickId = readReferralFromPageUrl(event.context?.document?.location?.href);
    return clickId ? { ...base, click_id: clickId } : null;
  }
  const orderId = event.data?.checkout?.order?.id;
  // Shopify documents an order ID as string|null, without promising GID format.
  // Accept only unambiguous numeric IDs and canonical Shopify Order GIDs.
  if (typeof orderId !== "string" ||
      !(/^[0-9]{1,20}$/.test(orderId) || /^gid:\/\/shopify\/Order\/[0-9]{1,20}$/.test(orderId))) {
    return { ...base, order_id: null, outcome: "unmatched_checkout_event" };
  }
  return { ...base, order_id: orderId, outcome: "requires_verified_order_match" };
}

/** Strict research-only matcher. Correlation is a HYPOTHESIS, not order proof.
 * Never feed the result to the existing affiliate_orders/postback pipeline. */
export function proposeAttributionCandidate(referral, checkout, nowMs = Date.now()) {
  if (!referral || !checkout || referral.event_name !== "page_viewed" ||
      checkout.event_name !== "checkout_completed") return null;
  if (referral.shop !== checkout.shop || referral.client_id !== checkout.client_id) return null;
  if (typeof referral.click_id !== "string" || !CLICK_ID_RE.test(referral.click_id) ||
      typeof checkout.order_id !== "string") return null;
  const a = Date.parse(referral.event_time), b = Date.parse(checkout.event_time);
  if (![a,b].every(Number.isFinite) || b < a || b - a > MAX_AGE_MS || b > nowMs + 60_000) return null;
  return { shop: checkout.shop, order_id: checkout.order_id, click_id: referral.click_id,
           status: "candidate_only", requires_order_verification: true };
}
