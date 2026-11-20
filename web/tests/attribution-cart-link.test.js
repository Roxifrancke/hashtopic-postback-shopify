import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShopifyAttributionCartLink,
  ATTRIBUTION_CART_ATTRIBUTE,
  ATTRIBUTION_LINE_ITEM_PROPERTY,
} from "../backend/attribution-cart-link.js";

const opts = {
  shop: "example.myshopify.com",
  variantId: "70881412",
  clickId: "34979241-cd73-4dd5-abf1-21e146ee0e42",
};

test("generates a Shopify legacy cart permalink with both attribution fields", () => {
  const url = new URL(buildShopifyAttributionCartLink(opts));
  assert.equal(url.host, "example.myshopify.com");
  assert.equal(url.pathname, "/cart/70881412:1");
  assert.equal(url.searchParams.get("storefront"), "true");
  assert.equal(url.searchParams.get("attributes[" + ATTRIBUTION_CART_ATTRIBUTE + "]"), opts.clickId);
  const props = JSON.parse(Buffer.from(url.searchParams.get("properties"), "base64url").toString());
  assert.equal(props[ATTRIBUTION_LINE_ITEM_PROPERTY], opts.clickId);
});

test("rejects untrusted domains, variants and click IDs", () => {
  assert.throws(() => buildShopifyAttributionCartLink({...opts, shop:"evil.example"}));
  assert.throws(() => buildShopifyAttributionCartLink({...opts, shop:"example.myshopify.com.evil.com"}));
  assert.throws(() => buildShopifyAttributionCartLink({...opts, variantId:"bad/redirect"}));
  assert.throws(() => buildShopifyAttributionCartLink({...opts, clickId:"bad&attributes[foo]=x"}));
  assert.throws(() => buildShopifyAttributionCartLink({...opts, quantity:0}));
});
