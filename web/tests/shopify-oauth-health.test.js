import test from "node:test";
import assert from "node:assert/strict";
import { classifyStoredOAuthTokens } from "../backend/shopify-auth.js";

const now = Date.parse("2026-11-04T10:00:00Z");
const access = "test-access-token";
const refresh = "test-refresh-token";
const date = (delta) => new Date(now + delta);

test("stored OAuth metadata exposes no credentials", () => {
  const result = classifyStoredOAuthTokens({
    accessToken: access, refreshToken: refresh,
    accessTokenExpiresAt: date(60000),
    refreshTokenExpiresAt: date(600000),
  }, now);
  assert.equal(result.status, "token_present");
  assert.equal(result.reason, "stored_access_token_unexpired_not_probed");
  assert.equal(JSON.stringify(result).includes(access), false);
  assert.equal(JSON.stringify(result).includes(refresh), false);
});
test("expired access and still-active refresh is renewal required", () => {
  const result = classifyStoredOAuthTokens({
    accessToken: access, refreshToken: refresh,
    accessTokenExpiresAt: date(-1000),
    refreshTokenExpiresAt: date(600000),
  }, now);
  assert.equal(result.status, "renewal_required");
});
test("expired access and refresh classified expired", () => {
  const result = classifyStoredOAuthTokens({
    accessToken: access, refreshToken: refresh,
    accessTokenExpiresAt: date(-1000),
    refreshTokenExpiresAt: date(-500),
  }, now);
  assert.equal(result.status, "expired");
});
test("missing access, missing expiry and no refresh handled independently", () => {
  assert.equal(classifyStoredOAuthTokens({}, now).status, "missing");
  assert.equal(classifyStoredOAuthTokens({ accessToken: access }, now).status, "unknown");
  assert.equal(classifyStoredOAuthTokens({
    accessToken: access, accessTokenExpiresAt: date(-1000)
  }, now).status, "expired");
});
