/**
 * One-shot, opt-in proof audit. Never mounted as an HTTP route.
 * This must not create or reconcile orders. No token or click ID logged.
 */
import { createStagingProofBridgeLookup } from "../backend/web-pixel-staging-proof-bridge.js";

const STAGING_HOST = "https://hashtopic-postback-shopify-staging.onrender.com";
const STAGING_DB = "mystorefront_postback_staging_db";
const SHOP = "mystorefront-test.myshopify.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blocked = (reason) => ({
  status:"blocked",reason,provenance_verified:false,
  consent_eligible:false,can_send_postback:false,commission_created:false,
});

export function verifyBridgeAuditConfig(env={}) {
  let db;
  try { db=new URL(env.DATABASE_URL); } catch {return {ready:false,reason:"staging_database_missing"};}
  if(env.SHOPIFY_APP_URL!==STAGING_HOST || db.pathname!=="/"+STAGING_DB)
    return {ready:false,reason:"not_staging_service"};
  if(env.WEB_PIXEL_STAGING_BRIDGE_AUDIT_ENABLED!=="true")
    return {ready:false,reason:"audit_disabled"};
  if(!UUID.test(env.WEB_PIXEL_STAGING_AUDIT_CLICK_ID||""))
    return {ready:false,reason:"click_id_missing"};
  if(typeof env.WEB_PIXEL_STAGING_BRIDGE_ENDPOINT!=="string")
    return {ready:false,reason:"endpoint_missing"};
  if(typeof env.WEB_PIXEL_STAGING_BRIDGE_TOKEN!=="string" ||
     env.WEB_PIXEL_STAGING_BRIDGE_TOKEN.length<48)
    return {ready:false,reason:"bridge_token_missing"};
  return {ready:true};
}

export async function runBridgeProofAudit({
  env={},lookupFactory=createStagingProofBridgeLookup,
}={}) {
  const config=verifyBridgeAuditConfig(env);
  if(!config.ready)return blocked(config.reason);
  try {
    const lookup=lookupFactory({
      endpoint:env.WEB_PIXEL_STAGING_BRIDGE_ENDPOINT,
      token:env.WEB_PIXEL_STAGING_BRIDGE_TOKEN,
    });
    const result=await lookup({shop:SHOP,clickId:env.WEB_PIXEL_STAGING_AUDIT_CLICK_ID});
    if(result.status!=="click_record_verified_pending_consent" ||
       result.provenance_verified!==true ||
       result.consent_eligible!==false ||
       result.can_send_postback!==false ||
       result.commission_created!==false)
      return blocked(
        result?.status==="blocked" &&
        ["bridge_unavailable","bridge_rejected","invalid_bridge_response","invalid_query",
         "click_invalid","outside_referral_window","link_or_shop_invalid",
         "server_issuance_not_attested","server_issuance_proof_invalid"].includes(result.reason)
          ? result.reason : "verification_failed"
      );
    return {
      status:"provenance_verified_pending_consent",
      provenance_verified:true,
      consent_eligible:false,can_send_postback:false,commission_created:false,
    };
  } catch { return blocked("connection_failed"); }
}

if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href){
  const result=await runBridgeProofAudit({env:process.env});
  console.log(JSON.stringify(result));
  // No success means consent/order verification has passed. Even valid
  // provenance is only a read-only diagnostic result.
  process.exitCode=result.provenance_verified ? 0 : 1;
}
