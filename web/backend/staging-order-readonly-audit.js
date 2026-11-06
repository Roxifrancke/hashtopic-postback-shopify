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
const AUDIT_ORDER = "7276986433601"; // Shopify Bogus Gateway test order #1091
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
  note_referral_present:false,line_referral_present:false,
  note_referral_uuid_valid:false,line_referral_uuid_valid:false,
  order_referral_values_match:false,
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
    if(!paid)return safe("order_not_paid");
    // Independently inspect each placement BEFORE extracting a preferred
    // value. A malformed order-level attribute must never shadow a valid
    // line-item ID and be reported simply as "missing".
    const noteIds=(Array.isArray(order.note_attributes)?order.note_attributes:[])
      .filter(a=>a?.name==="MyStorefront click_id").map(a=>a?.value);
    const itemIds=(Array.isArray(order.line_items)?order.line_items:[]).flatMap(item=>{
      const props=item?.properties;
      return Array.isArray(props)
        ? props.filter(a=>a?.name==="_MyStorefront click_id").map(a=>a?.value)
        : props && Object.hasOwn(props,"_MyStorefront click_id")
          ? [props["_MyStorefront click_id"]] : [];
    });
    const flags={
      paid:true,
      note_referral_present:noteIds.length>0,
      line_referral_present:itemIds.length>0,
      note_referral_uuid_valid:noteIds.length===1 &&
        typeof noteIds[0]==="string" && UUID.test(noteIds[0]),
      line_referral_uuid_valid:itemIds.length>0 &&
        itemIds.every(v=>typeof v==="string" && UUID.test(v)),
      order_referral_values_match:noteIds.length===1 && itemIds.length>0 &&
        itemIds.every(v=>v===noteIds[0]),
    };
    if(!flags.note_referral_present && !flags.line_referral_present)
      return safe("order_referral_missing_or_invalid",flags);
    if(!flags.note_referral_uuid_valid || !flags.line_referral_uuid_valid ||
       !flags.order_referral_values_match)
      return safe("order_referral_placements_inconsistent",flags);
    const orderClickId=noteIds[0];

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
      ...flags,
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
      "order_referral_missing_or_invalid","order_referral_placements_inconsistent","delivery_state_unknown",
      "audit_complete","read_only_audit_unavailable"
    ]);
    const output={
      status:statuses.has(result?.status)?result.status:"unexpected",
      paid:result?.paid===true,
      order_referral_present:result?.order_referral_present===true,
      provenance_verified:result?.provenance_verified===true,
      delivery_exists:typeof result?.delivery_exists==="boolean"?
        result.delivery_exists:null,
      consent_eligible:false,can_send_postback:false,commission_created:false,
      note_referral_present:result?.note_referral_present===true,
      line_referral_present:result?.line_referral_present===true,
      note_referral_uuid_valid:result?.note_referral_uuid_valid===true,
      line_referral_uuid_valid:result?.line_referral_uuid_valid===true,
      order_referral_values_match:result?.order_referral_values_match===true
    };
    logger.info("[STAGING ORDER READONLY AUDIT] "+JSON.stringify(output));
    return {started:true,...output};
  } catch {
    logger.info('[STAGING ORDER READONLY AUDIT] {"status":"read_only_audit_unavailable"}');
    return {started:true,status:"read_only_audit_unavailable"};
  }
}
export function resetOrderAuditForTests(){executed=false;}
