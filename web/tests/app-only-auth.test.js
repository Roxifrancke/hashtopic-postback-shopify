import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  validateShopDomain, createClientAssertion, getApplicationOnlyToken,
  invalidateApplicationOnlyToken,
} from "../backend/app-only-auth.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config = { clientId: "test-client", kid: "test-key", privateKey };

test("permanent shop domains only", () => {
  assert.equal(validateShopDomain("example.myshopify.com"), "example.myshopify.com");
  assert.throws(() => validateShopDomain("shopify.com.evil.test"));
  assert.throws(() => validateShopDomain("https://example.myshopify.com"));
});

test("assertion has correct short-lived claims and unique jti", () => {
  const a = createClientAssertion("example.myshopify.com", config);
  const b = createClientAssertion("example.myshopify.com", config);
  const header = JSON.parse(Buffer.from(a.split(".")[0], "base64url").toString());
  const claims = JSON.parse(Buffer.from(a.split(".")[1], "base64url").toString());
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "test-key");
  assert.equal(claims.aud, "https://example.myshopify.com/admin/oauth/access_token");
  assert.equal(claims.exp - claims.iat, 60);
  assert.notEqual(a, b);
});

test("does not call API without configured signing key", async () => {
  const old = {
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY,
    SHOPIFY_APP_ONLY_PRIVATE_KEY: process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY,
    SHOPIFY_APP_ONLY_KEY_ID: process.env.SHOPIFY_APP_ONLY_KEY_ID,
  };
  try {
    delete process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY;
    delete process.env.SHOPIFY_APP_ONLY_KEY_ID;
    await assert.rejects(
      getApplicationOnlyToken("no-key.myshopify.com", async () => { throw new Error("Must not fetch"); }),
      /not configured/
    );
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateApplicationOnlyToken("no-key.myshopify.com");
  }
});
