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
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_KEYS=new Set(["MyStorefront click_id","click_id"]);
const ITEM_KEYS=new Set(["_MyStorefront click_id","click_id","_click_id"]);

/** Strict read-only evidence check; never silently prefer one conflicting field. */
export function classifyStagingOrderReferral(order){
  if(!order || typeof order!=="object")return {status:"blocked",reason:"order_referral_missing"};
  const values=[];
  if(Array.isArray(order.note_attributes))for(const attr of order.note_attributes){
    if(NOTE_KEYS.has(attr?.name))values.push(attr.value);
  }
  if(Array.isArray(order.line_items))for(const item of order.line_items){
    const props=item?.properties;
    if(Array.isArray(props)){
      for(const prop of props)if(ITEM_KEYS.has(prop?.name))values.push(prop.value);
    }else if(props && typeof props==="object"){
      for(const [name,value] of Object.entries(props))
        if(ITEM_KEYS.has(name))values.push(value);
    }
  }
  if(values.length===0)return {status:"blocked",reason:"order_referral_missing"};
  if(values.some(v=>typeof v!=="string" || !UUID.test(v)))
    return {status:"blocked",reason:"order_referral_invalid"};
  const unique=new Set(values.map(v=>v.toLowerCase()));
  if(unique.size!==1)return {status:"blocked",reason:"order_referral_conflict"};
  return {status:"consistent",click_id:[...unique][0]};
}

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
  // A candidate click must be present on the independently fetched Shopify
  // order. Never join a genuine creator click to an unrelated paid order.
  const orderEvidence=classifyStagingOrderReferral(order);
  if(orderEvidence.status!=="consistent")return blocked(orderEvidence.reason);
  const orderClickId=orderEvidence.click_id;
  if(!UUID.test(candidate.click_id) ||
     orderClickId!==candidate.click_id.toLowerCase())
    return blocked("order_referral_mismatch");

  // When the signed webhook carries a click ID, it must agree as well.
  // Absence in the webhook does not override the Admin order's evidence.
  let webhookOrder;
  try{webhookOrder=JSON.parse(webhook.rawBody.toString("utf8"))}catch{
    return blocked("webhook_json_invalid");
  }
  const webhookEvidence=classifyStagingOrderReferral(webhookOrder);
  // Signed Shopify webhooks may omit referral fields. If present, every field
  // must be valid and match the independently fetched Admin order.
  if(webhookEvidence.status==="blocked" &&
     webhookEvidence.reason!=="order_referral_missing")
    return blocked("webhook_referral_invalid_or_conflicting");
  if(webhookEvidence.status==="consistent" &&
     webhookEvidence.click_id!==orderClickId)
    return blocked("webhook_referral_mismatch");
  const ordered=Date.parse(order.created_at);
  const clicked=Date.parse(click?.clicked_at);
  if(!Number.isFinite(nowMs)||!Number.isFinite(ordered)||
     !Number.isFinite(clicked)||ordered>nowMs+60000||
     clicked>ordered||ordered-clicked>=WINDOW_MS)
    return blocked("invalid_click_to_order_window");
  if(exists!==false)return blocked("existing_or_unknown_legacy_delivery");
  if(click?.status!=="click_record_verified_pending_consent"||
     click?.provenance_verified!==true||
     click?.consent_eligible!==false||
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
