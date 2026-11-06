/**
 * Ephemeral, staging-locked boot check for Render Free (no shell access).
 * Runs at most once per process startup, only with TWO affirmative flags.
 * Never mounts an HTTP endpoint, sends a postback, or writes a sale.
 */
import {runBridgeProofAudit} from "../scripts/staging-proof-bridge-audit.mjs";

let attempted=false;
export async function runStagingProofStartupOnce({
  env=process.env, audit=runBridgeProofAudit, logger=console,
}={}) {
  if (attempted || env.WEB_PIXEL_STAGING_BRIDGE_STARTUP_ONCE!=="true")
    return {started:false};
  attempted=true;
  try {
    const result=await audit({env});
    // Never log secrets, click IDs, HTTP responses or raw exceptions.
    const safeStatus=result?.status==="provenance_verified_pending_consent" &&
      result?.provenance_verified===true &&
      result?.consent_eligible===false &&
      result?.can_send_postback===false &&
      result?.commission_created===false
      ? "provenance_verified_pending_consent" : "blocked";
    // Log only fixed reason codes owned by this audit. Never log arbitrary
    // edge-function text, click IDs, tokens, URLs or exceptions.
    const allowedReasons=new Set([
      "staging_database_missing","not_staging_service","audit_disabled",
      "click_id_missing","endpoint_missing","bridge_token_missing",
      "bridge_unavailable","bridge_rejected","invalid_bridge_response",
      "invalid_query","verification_failed","connection_failed",
      "click_invalid","outside_referral_window","link_or_shop_invalid",
      "server_issuance_not_attested","server_issuance_proof_invalid",
    ]);
    const reason=safeStatus==="blocked" && allowedReasons.has(result?.reason)
      ? result.reason : "unknown";
    logger.info("[STAGING PROOF AUDIT] "+safeStatus+
      (safeStatus==="blocked" ? " reason="+reason : ""));
    return {started:true,status:safeStatus};
  } catch {
    logger.info("[STAGING PROOF AUDIT] blocked reason=unknown");
    return {started:true,status:"blocked"};
  }
}

// Isolated test-only reset. The live server never imports this.
export function resetStartupAttemptForTests() {attempted=false;}
