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
    logger.info("[STAGING PROOF AUDIT] "+safeStatus);
    return {started:true,status:safeStatus};
  } catch {
    logger.info("[STAGING PROOF AUDIT] blocked");
    return {started:true,status:"blocked"};
  }
}

// Isolated test-only reset. The live server never imports this.
export function resetStartupAttemptForTests() {attempted=false;}
