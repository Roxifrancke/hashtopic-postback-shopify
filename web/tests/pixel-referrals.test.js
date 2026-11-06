import test from "node:test";
import assert from "node:assert/strict";
import { validateReferral, parseOrderId } from "../backend/pixel-referral-input.js";

const ok = {
  shop: "mystorefront-test.myshopify.com",
  click_id: "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
  checkout_token: "abc123DEF456ghi789",
  order_id: "gid://shopify/OrderIdentity/6012345678",
};

test("accepts a normal pixel referral and lowercases the click_id", () => {
  const r = validateReferral(ok);
  assert.equal(r.clickId, "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.equal(r.orderId, "6012345678");
});

test("rejects bad shop, click_id or checkout token", () => {
  assert.equal(validateReferral({ ...ok, shop: "evil.com" }), null);
  assert.equal(validateReferral({ ...ok, click_id: "not-a-uuid" }), null);
  assert.equal(validateReferral({ ...ok, checkout_token: "x" }), null);
  assert.equal(validateReferral(null), null);
  assert.equal(validateReferral([ok]), null);
});

test("order_id is optional and parsed from gid or plain number", () => {
  assert.equal(validateReferral({ ...ok, order_id: null }).orderId, null);
  assert.equal(parseOrderId("123"), "123");
  assert.equal(parseOrderId("gid://shopify/Order/456"), "456");
  assert.equal(parseOrderId("gid://shopify/Order/abc"), null);
});
