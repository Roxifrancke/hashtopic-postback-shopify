/**
 * Read-only reconciliation boundary: Shopify-signed webhook and an
 * independently fetched Shopify order plus server-verified MyStorefront click.
 *
 * NO route, worker, webhook handler, delivery queue, payout or commission
 * invokes this function. Consent remains unverified, so even a fully matching
 * candidate cannot become a payable sale.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SHOP="mystorefront-test.myshopify.com";
const ORDER_RE=/^(?:gid:\/\/shopify\/Order\/)?([1-9][0-9]{0,19})$/;
const WINDOW_MS=30*24*60*60*1000;
const blocked=reason=>({
  status:"blocked",reason,commission_created:false,
  can_send_postback:false,
});
const normalizeOrderId=value=>{
  const m=String(value??"").match(ORDER_RE);
  return m?m[1]:null;
};

export function verifyStagingPaidWebhook({
  rawBody,hmac,secret,topic,shop,
}={}){
  if(shop!==SHOP||topic!=="orders/paid"||
     !Buffer.isBuffer(rawBody)||rawBody.length===0||rawBody.length>262144||
     typeof hmac!=="string"||typeof secret!=="string"||secret.length<32)
    return blocked("webhook_evidence_invalid");
  const expected=createHmac("sha256",secret).update(rawBody).digest("base64");
  const a=Buffer.from(expected,"utf8"),b=Buffer.from(hmac,"utf8");
  if(a.length!==b.length||!timingSafeEqual(a,b))
    return blocked("webhook_signature_invalid");
  let payload;
  try{payload=JSON.parse(rawBody.toString("utf8"))}catch{
    return blocked("webhook_json_invalid");
  }
  if(!payload||normalizeOrderId(payload.id)===null||
     !["paid"].includes(payload.financial_status)||
     payload.cancelled_at)
    return blocked("webhook_order_unpaid_or_invalid");
  return {status:"signed_paid_evidence",order_id:normalizeOrderId(payload.id),
    commission_created:false,can_send_postback:false};
}

/**
 * All injected adapters must be trusted server-only implementations. The
 * click lookup must return data fetched from MyStorefront by a service
 * credential; Shopify order fetch must use Shopify Admin API and a token
 * bound to the test shop. No browser may invoke this helper.
 */
export async function assessReadOnlyPixelPaidOrder({
  candidate,webhook,webhookSecret,fetchShopifyOrder,
  lookupTrustedClick,hasLegacyDelivery,nowMs=Date.now(),
}={}){
  if(candidate?.shop!==SHOP||candidate?.status!=="candidate_only"||
     candidate?.requires_order_verification!==true||
     !normalizeOrderId(candidate?.order_id)||
     typeof candidate?.click_id!=="string")
    return blocked("candidate_not_allowed");
  if(typeof fetchShopifyOrder!=="function"||
     typeof lookupTrustedClick!=="function"||
     typeof hasLegacyDelivery!=="function")
    return blocked("trusted_adapter_unavailable");
  const signed=verifyStagingPaidWebhook({...webhook,secret:webhookSecret});
  if(signed.status!=="signed_paid_evidence")return signed;
  const orderId=normalizeOrderId(candidate.order_id);
  if(orderId!==signed.order_id)return blocked("webhook_order_mismatch");
  let order,click,exists;
  try{
    [order,click,exists]=await Promise.all([
      fetchShopifyOrder(SHOP,orderId),
      lookupTrustedClick({shop:SHOP,clickId:candidate.click_id}),
      hasLegacyDelivery(SHOP,orderId),
    ]);
  }catch{return blocked("trusted_verification_unavailable")}
  if(order?.shop!==SHOP||normalizeOrderId(order?.id)!==orderId||
     order?.financial_status!=="paid"||order?.cancelled_at)
    return blocked("shopify_order_not_paid_or_mismatched");
  const ordered=Date.parse(order.created_at);
  const clicked=Date.parse(click?.clicked_at);
  if(!Number.isFinite(nowMs)||!Number.isFinite(ordered)||
     !Number.isFinite(clicked)||ordered>nowMs+60000||
     clicked>ordered||ordered-clicked>=WINDOW_MS)
    return blocked("invalid_click_to_order_window");
  if(exists!==false)return blocked("existing_or_unknown_legacy_delivery");
  if(click?.status!=="click_record_verified_pending_consent"||
     click?.commission_created!==false||click?.can_send_postback!==false||
     !Number.isFinite(clicked))
    return blocked("trusted_referral_not_confirmed");
  // The referral store contains no server-verifiable Shopify consent state.
  // Therefore the only possible successful result is pending consent.
  return {
    status:"verified_order_and_click_pending_consent",
    consent_eligible:false,commission_created:false,
    can_send_postback:false,
    requires_atomic_order_level_idempotency:true,
  };
}
