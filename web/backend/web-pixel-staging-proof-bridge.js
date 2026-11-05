/**
 * Server-only staging client. The shared bridge bearer token is distinct
 * from the Supabase service-role credential and never reaches a Web Pixel.
 * The MyStorefront edge function validates the protected proof internally.
 */
const PROJECT_HOST = "lhzqnkrjqaebcfxcmlgd.supabase.co";
const SHOP = "mystorefront-test.myshopify.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const blocked = (reason) => ({
  status:"blocked",reason,provenance_verified:false,
  consent_eligible:false,can_send_postback:false,commission_created:false,
});

export function createStagingProofBridgeLookup({
  endpoint,token,fetchImpl=fetch,
}={}) {
  let url;
  try {
    url = new URL(endpoint);
    if (url.origin!==`https://${PROJECT_HOST}` ||
        url.pathname!=="/functions/v1/staging-referral-proof-verify" ||
        url.search || url.hash || url.username || url.password || url.port)
      throw Error("invalid");
  } catch { throw Error("Invalid staging referral bridge endpoint"); }
  if (typeof token!=="string" || token.length<48 || token.length>256)
    throw Error("Staging bridge credential missing");
  if (typeof fetchImpl!=="function") throw Error("Invalid fetch adapter");
  return async function lookup({shop,clickId}={}) {
    if (shop!==SHOP || typeof clickId!=="string" || !UUID.test(clickId))
      return blocked("invalid_query");
    try {
      const response = await fetchImpl(url.href,{
        method:"POST",
        headers:{
          Authorization:`Bearer ${token}`,
          "Content-Type":"application/json",
          Accept:"application/json",
        },
        body:JSON.stringify({shop,click_id:clickId}),
        redirect:"error",signal:AbortSignal.timeout(8000),
      });
      if (!response?.ok) return blocked("bridge_unavailable");
      const result = await response.json();
      // A malformed or ambiguous response must not certify provenance.
      if(result?.status==="click_record_verified_pending_consent" &&
         result.provenance_verified===true &&
         result.consent_eligible===false &&
         result.can_send_postback===false &&
         result.commission_created===false &&
         typeof result.clicked_at==="string" &&
         Number.isFinite(Date.parse(result.clicked_at)))
        return {
          status:"click_record_verified_pending_consent",
          clicked_at:result.clicked_at,
          provenance_verified:true,
          consent_eligible:false,can_send_postback:false,
          commission_created:false,
        };
      if(result?.status==="blocked" ||
         result?.status==="click_record_found_unproven") return blocked("bridge_rejected");
      return blocked("invalid_bridge_response");
    } catch { return blocked("bridge_unavailable"); }
  };
}
