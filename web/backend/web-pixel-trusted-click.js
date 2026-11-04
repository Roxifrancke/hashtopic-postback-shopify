/**
 * Server-only proof boundary for MyStorefront referral records.
 * Do not trust client-provided click IDs, shop/brand IDs, consent or timestamps.
 * The data passed to this module MUST come from an authenticated server-side
 * MyStorefront query. The production query adapter is intentionally absent.
 *
 * This module cannot send postbacks or credit a commission.
 */
const SHOP="mystorefront-test.myshopify.com";
const CLICK_RE=/^[A-Za-z0-9_-]{8,128}$/;
const ORDER_RE=/^[1-9][0-9]{0,19}$/;
const WINDOW_MS=30*24*60*60*1000;

export function evaluateTrustedReferral({
  candidate, referral, orderCreatedAt, nowMs=Date.now(),
}) {
  const blocked=reason=>({status:"blocked",reason,commission_created:false});
  if(candidate?.shop!==SHOP || candidate?.status!=="candidate_only" ||
     candidate.requires_order_verification!==true ||
     typeof candidate.click_id!=="string" || !CLICK_RE.test(candidate.click_id))
    return blocked("invalid_candidate");
  if(!referral || referral.source!=="trusted_mystorefront_server" ||
     referral.click_id!==candidate.click_id ||
     referral.shop!==SHOP || referral.valid!==true ||
     referral.consent_eligible!==true)
    return blocked("trusted_referral_not_confirmed");
  // An integration must map its own authoritative click timestamp to
  // clicked_at. Never fall back to the browser-provided timestamp.
  const clicked=Date.parse(referral.clicked_at);
  const ordered=Date.parse(orderCreatedAt);
  if(!Number.isFinite(clicked)||!Number.isFinite(ordered)||!Number.isFinite(nowMs)||
     clicked>ordered||ordered-clicked>=WINDOW_MS||
     ordered>nowMs+60000||clicked>nowMs+60000)
    return blocked("outside_attribution_window");
  if(typeof referral.creator_id!=="string" || referral.creator_id.length<1 ||
     typeof referral.brand_id!=="string" || referral.brand_id.length<1)
    return blocked("missing_trusted_creator_or_brand");
  return {status:"trusted_referral_confirmed",commission_created:false,
    // Never pass creator identity or other customer-related fields to browser.
    requires_paid_order_verification:true,
    requires_order_level_dedup:true,
  };
}

/**
 * Intended integration interface. The caller supplies a trusted MyStorefront
 * server adapter whose result must NOT originate from a browser event.
 * No direct Supabase service key, URL or schema is assumed by this code.
 */
export async function verifyTrustedReferralCandidate({
  candidate,orderCreatedAt,lookupTrustedClick,nowMs=Date.now(),
}) {
  const blocked=reason=>({status:"blocked",reason,commission_created:false});
  if(typeof lookupTrustedClick!=="function")
    return blocked("trusted_click_adapter_missing");
  if(candidate?.shop!==SHOP || typeof candidate?.click_id!=="string" ||
     !CLICK_RE.test(candidate.click_id) || candidate?.status!=="candidate_only" ||
     candidate?.requires_order_verification!==true)
    return blocked("invalid_candidate");
  let referral;
  try {
    referral=await lookupTrustedClick({shop:SHOP,clickId:candidate.click_id});
  } catch {
    return blocked("trusted_click_lookup_unavailable");
  }
  return evaluateTrustedReferral({candidate,referral,orderCreatedAt,nowMs});
}
