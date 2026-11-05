/**
 * Explicitly opt-in, ONE-SHOT read-only audit for a known Shopify test order.
 * No webhook, queue, postback, sale, refund, commission or settings writes.
 * Do not mount as an HTTP route. Only for isolated Shopify staging Render.
 */
import { extractClickId } from "./postback-sender.js";
import { createStagingProofBridgeLookup } from "./web-pixel-staging-proof-bridge.js";

const HOST = "https://hashtopic-postback-shopify-staging.onrender.com";
const SHOP = "mystorefront-test.myshopify.com";
const DB = "/mystorefront_postback_staging_db";
const AUDIT_ORDER = "7275644289089"; // existing Shopify test order #1088
const BRIDGE_ENDPOINT = "https://lhzqnkrjqaebcfxcmlgd.supabase.co/functions/v1/staging-referral-proof-verify";
const API_VERSION = "2026-10";
const ORDER_ID = /^[1-9][0-9]{0,19}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = (status, extra={}) => ({
  status,
  paid:false, order_referral_present:false,
  provenance_verified:false, delivery_exists:null,
  consent_eligible:false, can_send_postback:false,
  commission_created:false,
  ...extra,
});

export function auditEnabled(env={}) {
  try {
    return env.WEB_PIXEL_STAGING_ORDER_AUDIT_ENABLED==="true" &&
      env.WEB_PIXEL_STAGING_ORDER_AUDIT_ONCE==="true" &&
      env.SHOPIFY_APP_URL===HOST &&
      new URL(env.DATABASE_URL).pathname===DB &&
      env.WEB_PIXEL_STAGING_ORDER_AUDIT_ID===AUDIT_ORDER &&
      typeof env.WEB_PIXEL_STAGING_BRIDGE_TOKEN==="string" &&
      env.WEB_PIXEL_STAGING_BRIDGE_TOKEN.length>=48 &&
      env.WEB_PIXEL_STAGING_BRIDGE_ENDPOINT===BRIDGE_ENDPOINT;
  } catch {return false;}
}

export async function auditOnePaidOrder({
  env={},getToken,fetchImpl=fetch,queryDelivery,
  createProofLookup=createStagingProofBridgeLookup,now=()=>Date.now(),
}={}) {
  if(!auditEnabled(env))return safe("disabled");
  if(typeof getToken!=="function" || typeof queryDelivery!=="function")
    return safe("adapter_unavailable");
  try {
    const tokens=await getToken(SHOP);
    // Read only: do not refresh or re-provision tokens as an audit side effect.
    if(!tokens?.accessToken ||
       (tokens.accessTokenExpiresAt &&
        new Date(tokens.accessTokenExpiresAt).getTime()<=now()+30000))
      return safe("shopify_token_unavailable");

    const url=`https://${SHOP}/admin/api/${API_VERSION}/orders/${AUDIT_ORDER}.json`;
    const response=await fetchImpl(url,{
      method:"GET",
      headers:{
        "X-Shopify-Access-Token":tokens.accessToken,
        "Accept":"application/json"
      },
      redirect:"error",
      signal:AbortSignal.timeout(10000),
    });
    if(!response?.ok)return safe("shopify_order_unavailable",{
      shopify_http_ok:false
    });
    const body=await response.json();
    const order=body?.order;
    if(String(order?.id)!==AUDIT_ORDER)
      return safe("shopify_order_mismatch");
    const paid=order.financial_status==="paid" && !order.cancelled_at;
    const orderClickId=extractClickId(order);
    if(!paid)return safe("order_not_paid");
    if(typeof orderClickId!=="string" || !UUID.test(orderClickId))
      return safe("order_referral_missing_or_invalid",{paid:true});

    const lookup=createProofLookup({
      endpoint:env.WEB_PIXEL_STAGING_BRIDGE_ENDPOINT,
      token:env.WEB_PIXEL_STAGING_BRIDGE_TOKEN,
      fetchImpl,
      now,
    });
    const proof=await lookup({shop:SHOP,clickId:orderClickId});
    const exists=await queryDelivery(SHOP,AUDIT_ORDER);
    if(typeof exists!=="boolean")
      return safe("delivery_state_unknown",{
        paid:true,order_referral_present:true,
        provenance_verified:proof?.provenance_verified===true,
      });
    return safe("audit_complete",{
      paid:true,order_referral_present:true,
      provenance_verified:proof?.status==="click_record_verified_pending_consent" &&
        proof?.provenance_verified===true &&
        proof?.can_send_postback===false &&
        proof?.commission_created===false,
      delivery_exists:exists,
    });
  } catch {return safe("read_only_audit_unavailable");}
}

let executed=false;
export async function runStagingOrderAuditAtStartupOnce({
  env=process.env,audit=auditOnePaidOrder,dependencies={},logger=console,
}={}){
  if(executed || !auditEnabled(env))return {started:false};
  executed=true;
  try {
    const result=await audit({env,...dependencies});
    // Whitelist only booleans/status, never print customer data, click ID,
    // payment info, Shopify access tokens, bridge token or raw errors.
    const statuses=new Set([
      "disabled","adapter_unavailable","shopify_token_unavailable",
      "shopify_order_unavailable","shopify_order_mismatch","order_not_paid",
      "order_referral_missing_or_invalid","delivery_state_unknown",
      "audit_complete","read_only_audit_unavailable"
    ]);
    const output={
      status:statuses.has(result?.status)?result.status:"unexpected",
      paid:result?.paid===true,
      order_referral_present:result?.order_referral_present===true,
      provenance_verified:result?.provenance_verified===true,
      delivery_exists:typeof result?.delivery_exists==="boolean"?
        result.delivery_exists:null,
      consent_eligible:false,can_send_postback:false,commission_created:false
    };
    logger.info("[STAGING ORDER READONLY AUDIT] "+JSON.stringify(output));
    return {started:true,...output};
  } catch {
    logger.info('[STAGING ORDER READONLY AUDIT] {"status":"read_only_audit_unavailable"}');
    return {started:true,status:"read_only_audit_unavailable"};
  }
}
export function resetOrderAuditForTests(){executed=false;}
