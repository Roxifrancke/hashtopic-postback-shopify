import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { shopifyHealthRouter, secureKeyEquals, probeShopifyConnection, probeWebPixel } from "../backend/routes/shopify-health.js";

test("store-bound keys must match and be nonempty", () => {
  assert.equal(secureKeyEquals("abc", "abc"), true);
  assert.equal(secureKeyEquals("abc", "xyz"), false);
  assert.equal(secureKeyEquals("", ""), false);
});

test("verified Shopify identity is required", async () => {
  const query = async () => ({ shop: { myshopifyDomain: "test.myshopify.com" } });
  const result = await probeShopifyConnection("test.myshopify.com", query, () => true);
  assert.equal(result.api_auth, "verified");
  const other = await probeShopifyConnection("other.myshopify.com", query, () => true);
  assert.equal(other.api_auth, "unknown");
});

test("no credentials means unknown, not disconnected", async () => {
  const result = await probeShopifyConnection("test.myshopify.com", async () => null, () => false);
  assert.equal(result.api_auth, "unknown");
});

test("errors never reveal Shopify response contents", async () => {
  const result = await probeShopifyConnection("test.myshopify.com", async () => {
    throw new Error("private-secret-content");
  }, () => true);
  assert.equal(result.api_auth, "unknown");
  assert.equal(JSON.stringify(result).includes("private-secret-content"), false);
});

test("health endpoint rejects unauthorised requests and only probes matching shop key", async () => {
  const app = express();
  let probes = 0;
  app.use("/api/shopify-health", shopifyHealthRouter({
    getSettings: async (shop) => shop === "test.myshopify.com"
      ? { mystorefront_api_key: "brand-secret" } : null,
    probe: async () => { probes++; return { api_auth: "verified", reason: "app_only_graphql_success" }; },
    probePixel: async () => ({ status: "registered", reason: "pixel_record_found" }),
    getOAuthTokens: async () => ({ accessToken: "private-access-token",
      refreshToken: "private-refresh-token",
      accessTokenExpiresAt: new Date(Date.now() - 60000),
      refreshTokenExpiresAt: new Date(Date.now() + 600000) })
  }));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const url = base + "/api/shopify-health?shop=test.myshopify.com";
    const missing = await fetch(url);
    assert.equal(missing.status, 401);
    const wrong = await fetch(url, { headers: { "X-Mystorefront-Key": "wrong" } });
    assert.equal(wrong.status, 401);
    const invalidDomain = await fetch(base + "/api/shopify-health?shop=localhost", {
      headers: { "X-Mystorefront-Key": "brand-secret" }
    });
    assert.equal(invalidDomain.status, 400);
    const otherShop = await fetch(base + "/api/shopify-health?shop=other.myshopify.com", {
      headers: { "X-Mystorefront-Key": "brand-secret" }
    });
    assert.equal(otherShop.status, 401);
    assert.equal(probes, 0);
    const success = await fetch(url, { headers: { "X-Mystorefront-Key": "brand-secret" } });
    assert.equal(success.status, 200);
    const body = await success.json();
    assert.equal(body.api_auth, "verified");
    assert.equal(body.web_pixel.status, "registered");
    assert.equal(body.stored_oauth.status, "renewal_required");
    assert.equal(JSON.stringify(body).includes("private-access-token"), false);
    assert.equal(JSON.stringify(body).includes("private-refresh-token"), false);
    assert.equal(body.end_to_end, "unverified");
    assert.equal(body.webhook_delivery, "unverified");
    assert.equal(probes, 1);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("Web Pixel probe distinguishes registered, absent, and missing read scope", async () => {
  const registered = await probeWebPixel("test.myshopify.com", async () => ({ webPixel: { id: "gid://shopify/WebPixel/123" } }), () => true);
  assert.equal(registered.status, "registered");
  const absent = await probeWebPixel("test.myshopify.com", async () => ({ webPixel: null }), () => true);
  assert.equal(absent.status, "not_registered");
  const missingScope = await probeWebPixel("test.myshopify.com", async () => {
    throw new Error("Access denied for webPixel field. Required access: read_pixels");
  }, () => true);
  assert.equal(missingScope.status, "scope_missing");
  const unavailable = await probeWebPixel("test.myshopify.com", async () => {
    throw new Error("Shopify request timed out");
  }, () => true);
  assert.equal(unavailable.status, "unavailable");
});
