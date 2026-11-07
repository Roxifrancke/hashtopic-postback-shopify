/**
 * One-shot INTERNAL read-only MyStorefront referral audit.
 *
 * No HTTP route, Web Pixel subscription, order webhook or payout code imports
 * this module. It can be run explicitly from a trusted staging server shell.
 * No click ID, creator ID, service key, access token or URL is logged.
 *
 * Avoid use of a broad production Supabase service-role key: provision a
 * dedicated, least-privilege credential with SELECT on required tables.
 * Source records are not independently proven to originate from the trusted
 * affiliate-redirect. Their presence can never be labeled "verified".
 */
import { createStagingTrustedReferralLookup } from "../backend/web-pixel-staging-trusted-referral.js";

const EXPECTED_HOST="https://hashtopic-postback-shopify-staging.onrender.com";
const EXPECTED_DB="mystorefront_postback_staging_db";
const SHOP="mystorefront-test.myshopify.com";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function stagingAuditConfiguration(env={}){
  const blocked=reason=>({ready:false,reason});
  let db;
  try{db=new URL(env.DATABASE_URL)}catch{return blocked("staging_database_missing")}
  if(env.SHOPIFY_APP_URL!==EXPECTED_HOST ||
     db.pathname!=="/"+EXPECTED_DB)return blocked("not_staging_service");
  if(env.WEB_PIXEL_STAGING_READONLY_AUDIT_ENABLED!=="true")
    return blocked("audit_disabled");
  if(!UUID.test(env.WEB_PIXEL_STAGING_AUDIT_CLICK_ID||""))
    return blocked("test_click_id_missing");
  if(typeof env.WEB_PIXEL_STAGING_SUPABASE_URL!=="string")
    return blocked("source_url_missing");
  if(typeof env.WEB_PIXEL_STAGING_SUPABASE_READ_KEY!=="string"||
     env.WEB_PIXEL_STAGING_SUPABASE_READ_KEY.length<40)
    return blocked("scoped_credential_missing");
  return {ready:true,reason:null};
}

export async function runStagingReadOnlyAudit({
  env={},lookupFactory=createStagingTrustedReferralLookup,
}={}){
  const config=stagingAuditConfiguration(env);
  if(!config.ready)return {
    status:"blocked",reason:config.reason,
    commission_created:false,can_send_postback:false,
  };
  try{
    const lookup=lookupFactory({
      supabaseUrl:env.WEB_PIXEL_STAGING_SUPABASE_URL,
      serviceKey:env.WEB_PIXEL_STAGING_SUPABASE_READ_KEY,
    });
    const result=await lookup({
      shop:SHOP,
      clickId:env.WEB_PIXEL_STAGING_AUDIT_CLICK_ID,
    });
    const verified=result.status==="click_record_verified_pending_consent" &&
      result.provenance_verified===true &&
      result.consent_eligible===false &&
      result.can_send_postback===false &&
      result.commission_created===false;
    const unproven=result.status==="click_record_found_unproven";
    return {
      status:verified?"provenance_verified_pending_consent":
        unproven?"record_found_unproven":"blocked",
      reason:verified?"consent_not_verified":
        unproven?"server_issuance_not_attested":(result.reason||"source_validation_failed"),
      provenance_verified:verified,
      consent_eligible:false,
      commission_created:false,can_send_postback:false,
    };
  }catch{
    return {
      status:"blocked",reason:"connection_failed",
      commission_created:false,can_send_postback:false,
    };
  }
}

// A CLI can import and call this once. Never install it as a recurring task,
// and never print env variables or raw Supabase error messages.
if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href){
  const result=await runStagingReadOnlyAudit({env:process.env});
  console.log(JSON.stringify(result));
  // Do not return exit code 0 for an unproven record.
  process.exitCode=1;
}
