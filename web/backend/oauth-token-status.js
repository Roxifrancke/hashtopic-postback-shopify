/**
 * A read-only, credential-safe summary of the legacy Shopify OAuth token
 * lifecycle. No database import, refresh, or Shopify network calls.
 * A token marked present is NOT verified with Shopify.
 */
export function classifyStoredOAuthTokens(tokens, nowMs = Date.now()) {
  if (!tokens?.accessToken) return { status: "missing", reason: "no_stored_access_token" };
  const expiresAt = tokens.accessTokenExpiresAt instanceof Date
    ? tokens.accessTokenExpiresAt.getTime() : NaN;
  const refreshExpiresAt = tokens.refreshTokenExpiresAt instanceof Date
    ? tokens.refreshTokenExpiresAt.getTime() : NaN;
  if (!Number.isFinite(expiresAt)) {
    return { status: "unknown", reason: "access_expiry_not_recorded" };
  }
  if (expiresAt > nowMs) {
    return { status: "token_present", reason: "stored_access_token_unexpired_not_probed" };
  }
  if (!tokens.refreshToken) {
    return { status: "expired", reason: "access_expired_no_refresh_token" };
  }
  if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt <= nowMs) {
    return { status: "expired", reason: "access_and_refresh_expired" };
  }
  return { status: "renewal_required", reason: "access_expired_refresh_available" };
}
