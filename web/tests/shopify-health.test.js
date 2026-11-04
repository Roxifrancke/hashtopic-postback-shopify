import test from "node:test";
import assert from "node:assert/strict";
import { secureKeyEquals, probeShopifyConnection } from "../backend/routes/shopify-health.js";

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
