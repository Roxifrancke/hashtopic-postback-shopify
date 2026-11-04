/**
 * Trusted, READ-ONLY Shopify Admin API verification for Web Pixel candidates.
 * No HTTP route, no postbacks, no writes, no commission creation.
 * Only server code can call this; never use a browser-provided order object.
 */
import { queryShopifyGraphQL, validateShopDomain } from "./app-only-auth.js";
import {
  normalizeShopifyOrderId,
  assessVerifiedAttribution,
  assessLegacyDeliveryConflict,
} from "./web-pixel-order-verification.js";

// Use the modern GraphQL Admin API with the app-only Shopify credential.
// Keep the response free of addresses, email, financial totals and line items.
const VERIFIED_ORDER_QUERY = `query VerifyMyStorefrontPixelOrder($orderId: ID!) {
  shop { myshopifyDomain }
  order(id: $orderId) {
    id
    legacyResourceId
    displayFinancialStatus
    createdAt
    cancelledAt
  }
}`;
const TEST_SHOP = "mystorefront-test.myshopify.com";

export async function fetchTrustedShopifyOrder(shop, orderId, query = queryShopifyGraphQL) {
  validateShopDomain(shop);
  const canonicalId = normalizeShopifyOrderId(orderId);
  if (!canonicalId) throw new Error("Invalid Shopify order ID");
  const data = await query(shop, VERIFIED_ORDER_QUERY, {
    orderId: `gid://shopify/Order/${canonicalId}`,
  });
  // A token working for the wrong shop must NEVER authorize a candidate.
  if (data?.shop?.myshopifyDomain !== shop)
    throw new Error("Shopify identity mismatch");
  const order = data?.order;
  if (!order || normalizeShopifyOrderId(order.id) !== canonicalId ||
      normalizeShopifyOrderId(order.legacyResourceId) !== canonicalId)
    throw new Error("Shopify order not found or order ID mismatch");
  // Deliberately accept only PAID. Partial payments, authorizations, refunds,
  // voids and pending payments are not eligible for automatic attribution.
  return {
    id: canonicalId,
    financial_status: order.displayFinancialStatus === "PAID" ? "paid" : "unpaid",
    created_at: order.createdAt,
    cancelled_at: order.cancelledAt,
  };
}

/**
 * Read-only orchestration with explicit DB lookup injection.
 * This doesn't send a purchase to MyStorefront even if every check passes.
 * Missing/failed DB lookups fail closed. Shopify API errors fail closed.
 */
export async function verifyPixelCandidateWithoutCommission({
  candidate, nowMs = Date.now(),
  fetchOrder = fetchTrustedShopifyOrder,
  lookupLegacyDelivery,
}) {
  const blocked = reason => ({status:"blocked",reason,commission_created:false});
  if (!candidate || candidate.status !== "candidate_only" ||
      candidate.shop !== TEST_SHOP ||
      !normalizeShopifyOrderId(candidate.order_id) ||
      candidate.requires_order_verification !== true) {
    return blocked("candidate_not_allowed");
  }
  if (typeof lookupLegacyDelivery !== "function")
    return blocked("dedup_lookup_not_configured");
  let verifiedOrder;
  try {
    verifiedOrder = await fetchOrder(candidate.shop,candidate.order_id);
  } catch {
    return blocked("shopify_verification_unavailable");
  }
  const decision = assessVerifiedAttribution({
    candidate,verifiedOrder,verifiedShop:candidate.shop,nowMs,
  });
  if (decision.status !== "verified_paid_candidate")
    return blocked(decision.reason || "order_not_verified");
  let existingDelivery;
  try {
    existingDelivery = await lookupLegacyDelivery(candidate.shop,decision.order_id);
  } catch {
    return blocked("dedup_lookup_unavailable");
  }
  const dedup=assessLegacyDeliveryConflict(decision,{
    lookup_ok:true,shop:candidate.shop,order_id:decision.order_id,
    existing_delivery:existingDelivery,
  });
  if(dedup.status!=="eligible_for_further_review")
    return blocked(dedup.reason);
  // This is an observation, never payment proof: before any postback a separate
  // signed Shopify paid-webhook and referral/click validation must succeed.
  return {
    status:"verified_paid_candidate_pending_other_checks",
    shop:candidate.shop,order_id:decision.order_id,
    commission_created:false,requires_signed_paid_webhook:true,
    requires_click_validation:true,requires_consented_data_policy:true,
    requires_atomic_order_deduplication:true,
  };
}
