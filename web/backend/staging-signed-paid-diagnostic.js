/**
 * HMAC-verification must be completed by the caller before this is invoked.
 * One named staging Shopify test order only. No customer data or click IDs
 * in logs, no persistence, no network requests and no commission effects.
 */
import { isStagingOrderQuarantineEnabled } from "./staging-order-postback-quarantine.js";
import { classifyStagingOrderReferral } from "./web-pixel-staging-paid-review.js";

const SHOP = "mystorefront-test.myshopify.com";
const ORDER = "7278367473729"; // Shopify Bogus Gateway test order #1094

export function stagingPaidOrderEvidence({shop,rawBody,env=process.env}={}) {
  if (shop!==SHOP || !isStagingOrderQuarantineEnabled(shop,env))
    return null;
  let order;
  try {
    if(typeof rawBody!=="string" || rawBody.length>262144)return null;
    order=JSON.parse(rawBody);
  } catch { return null; }
  if(!order || String(order.id)!==ORDER)return null;
  const validPaid=order.financial_status==="paid" && !order.cancelled_at;
  const evidence=classifyStagingOrderReferral(order);
  const notePresent=Array.isArray(order.note_attributes) &&
    order.note_attributes.some(a=>a?.name==="MyStorefront click_id");
  const linePresent=Array.isArray(order.line_items) &&
    order.line_items.some(item=>
      Array.isArray(item?.properties) &&
      item.properties.some(p=>p?.name==="_MyStorefront click_id"));
  return {
    status: validPaid && evidence.status==="consistent"
      ? "signed_paid_referrals_consistent" : "signed_paid_referrals_not_confirmed",
    paid:validPaid,
    note_referral_present:notePresent,
    line_referral_present:linePresent,
    values_consistent:evidence.status==="consistent",
    consent_eligible:false,can_send_postback:false,commission_created:false,
  };
}

export function logStagingSignedPaidOrderDiagnostic({shop,rawBody,env=process.env,logger=console}={}) {
  const result=stagingPaidOrderEvidence({shop,rawBody,env});
  if(result)logger.info("[STAGING SIGNED PAID AUDIT] "+JSON.stringify(result));
  return result;
}
