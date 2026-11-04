/**
 * A read-only composition of the three independent verification gates:
 * Shopify-signed paid webhook; Shopify Admin order; MyStorefront trusted click.
 *
 * DO NOT wire to live checkout/webhook delivery or payment pipelines.
 * The output is NEVER a commission, just an approval for further review.
 */
import { reconcileStagingPixelCandidate } from "./web-pixel-reconciliation.js";
import { verifyTrustedReferralCandidate } from "./web-pixel-trusted-click.js";

export async function reviewStagingPixelAttribution({
  candidate, webhook, webhookSecret, fetchOrder, lookupLegacyDelivery,
  lookupTrustedClick, nowMs=Date.now(),
}) {
  const blocked=reason=>({status:"blocked",reason,commission_created:false,can_send_postback:false});
  if(typeof lookupTrustedClick!=="function")return blocked("trusted_click_adapter_missing");
  if(typeof fetchOrder!=="function")return blocked("trusted_order_adapter_missing");
  // Resolve the order ONCE through a trusted server-side Shopify adapter.
  // Use the server-returned creation time, never a browser-supplied date.
  let trustedOrder;
  try {
    trustedOrder=await fetchOrder(candidate?.shop,candidate?.order_id);
  } catch {
    return blocked("shopify_verification_unavailable");
  }
  if(!trustedOrder || typeof trustedOrder.created_at!=="string")
    return blocked("trusted_order_time_missing");
  const paid=await reconcileStagingPixelCandidate({
    candidate,webhook,webhookSecret,fetchOrder:async()=>trustedOrder,
    lookupLegacyDelivery,nowMs,
  });
  if(paid.status!=="signed_paid_order_and_shopify_verified_pending_click_policy")
    return blocked(paid.reason || "paid_order_not_verified");
  const click=await verifyTrustedReferralCandidate({
    candidate,lookupTrustedClick,orderCreatedAt:trustedOrder.created_at,nowMs,
  });
  if(click.status!=="trusted_referral_confirmed")
    return blocked(click.reason || "trusted_click_not_verified");
  return {
    status:"verified_for_staging_manual_review_only",
    order_id:paid.order_id,shop:candidate.shop,
    commission_created:false,can_send_postback:false,
    requires_consent_policy_review:true,
    requires_atomic_order_deduplication:true,
    requires_destination_idempotency:true,
  };
}
