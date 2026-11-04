/**
 * Staging-only read-only reconciliation proof.
 * Requires an independently Shopify-signed orders/paid webhook AND a trusted
 * GraphQL order lookup. Does not create deliveries, postbacks or commissions.
 *
 * This is a server-only library and is NOT wired into the live webhook route.
 * The old theme embed remains authoritative.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeShopifyOrderId } from "./web-pixel-order-verification.js";
import { verifyPixelCandidateWithoutCommission } from "./web-pixel-shopify-verifier.js";

const TEST_SHOP = "mystorefront-test.myshopify.com";
const MAX_WEBHOOK_BYTES = 128 * 1024;
const SIG_RE = /^[A-Za-z0-9+/]{43}=$/;

export function validatePaidWebhookEvidence({
  rawBody, signature, webhookShop, topic, secret,
}) {
  const rejected = (reason) => ({valid:false,reason});
  if (webhookShop !== TEST_SHOP || topic !== "orders/paid")
    return rejected("wrong_shop_or_topic");
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 ||
      rawBody.length > MAX_WEBHOOK_BYTES ||
      typeof secret !== "string" || secret.length < 16 ||
      typeof signature !== "string" || !SIG_RE.test(signature)) {
    return rejected("invalid_evidence_format");
  }
  const expected = createHmac("sha256",secret).update(rawBody).digest();
  const received = Buffer.from(signature,"base64");
  if (received.length !== expected.length ||
      !timingSafeEqual(received,expected)) return rejected("signature_mismatch");
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return rejected("invalid_json");
  }
  const orderId=normalizeShopifyOrderId(body?.id);
  if (!orderId || body?.financial_status !== "paid" || body?.cancelled_at)
    return rejected("not_paid_order");
  return {valid:true,order_id:orderId};
}

export async function reconcileStagingPixelCandidate({
  candidate, webhook, webhookSecret, nowMs = Date.now(),
  fetchOrder, lookupLegacyDelivery,
}) {
  const blocked = reason => ({status:"blocked",reason,commission_created:false});
  if (candidate?.shop !== TEST_SHOP || candidate?.status !== "candidate_only" ||
      candidate?.requires_order_verification !== true ||
      !normalizeShopifyOrderId(candidate.order_id))
    return blocked("invalid_candidate");
  const evidence=validatePaidWebhookEvidence({
    rawBody:webhook?.rawBody,
    signature:webhook?.signature,
    webhookShop:webhook?.shop,
    topic:webhook?.topic,
    secret:webhookSecret,
  });
  if (!evidence.valid) return blocked(evidence.reason);
  if (evidence.order_id !== normalizeShopifyOrderId(candidate.order_id))
    return blocked("webhook_order_mismatch");
  const decision=await verifyPixelCandidateWithoutCommission({
    candidate,nowMs,fetchOrder,lookupLegacyDelivery,
  });
  if (decision.status !== "verified_paid_candidate_pending_other_checks")
    return blocked(decision.reason || "shopify_verification_failed");
  // Explicitly withhold downstream mutations until trusted MyStorefront
  // click validation, consent, durable idempotency, refunds and replay rules
  // are implemented. Browser-provided referral IDs are never sufficient.
  return {
    status:"signed_paid_order_and_shopify_verified_pending_click_policy",
    order_id:evidence.order_id,
    commission_created:false,
    can_send_postback:false,
    requires_click_validation:true,
    requires_atomic_order_deduplication:true,
    requires_consent_review:true,
  };
}
