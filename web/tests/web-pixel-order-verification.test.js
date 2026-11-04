import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShopifyOrderId,
  assessVerifiedAttribution,
  assessLegacyDeliveryConflict,
} from "../backend/web-pixel-order-verification.js";

const now = Date.parse("2026-11-04T18:00:00Z");
const shop = "mystorefront-test.myshopify.com";
const candidate = {
  status: "candidate_only",
  requires_order_verification: true,
  shop,
  order_id: "gid://shopify/Order/123456789",
  click_id: "test_referral_123456",
};
const verifiedOrder = {
  id: 123456789,
  financial_status: "paid",
  created_at: "2026-11-04T17:50:00Z",
  cancelled_at: null,
};

test("normalizes only canonical numeric and GID Shopify order identifiers", () => {
  assert.equal(normalizeShopifyOrderId("gid://shopify/Order/123456789"),"123456789");
  assert.equal(normalizeShopifyOrderId(123456789),"123456789");
  assert.equal(normalizeShopifyOrderId("other-123456789"),null);
  assert.equal(normalizeShopifyOrderId("gid://shopify/DraftOrder/123456789"),null);
  assert.equal(normalizeShopifyOrderId("0"),null);
});

test("paid matching order stays a candidate with commission disabled", () => {
  const decision = assessVerifiedAttribution({
    candidate, verifiedOrder, verifiedShop:shop, nowMs:now,
  });
  assert.equal(decision.status,"verified_paid_candidate");
  assert.equal(decision.commission_created,false);
  assert.equal(decision.requires_existing_delivery_dedup,true);
  assert.equal(decision.requires_click_validation,true);
  assert.equal(decision.requires_commission_policy,true);
});

test("fails closed for wrong shop, order, unpaid or cancelled orders", () => {
  const assess = (patch = {}, order = verifiedOrder, s = shop) =>
    assessVerifiedAttribution({candidate:{...candidate,...patch},verifiedOrder:order,verifiedShop:s,nowMs:now});
  assert.equal(assess({shop:"some-other.myshopify.com"}).reason,"shop_mismatch");
  assert.equal(assess({}, {...verifiedOrder,id:123456780}).reason,"order_mismatch");
  assert.equal(assess({}, {...verifiedOrder,financial_status:"pending"}).reason,"payment_not_verified");
  assert.equal(assess({}, {...verifiedOrder,financial_status:"refunded"}).reason,"payment_not_verified");
  assert.equal(assess({}, {...verifiedOrder,cancelled_at:"2026-11-04T17:55:00Z"}).reason,"cancelled_or_refunded");
  assert.equal(assess({}, null).status,"rejected");
  assert.equal(assess({requires_order_verification:false}).status,"rejected");
});

test("never assumes no legacy delivery when lookup is absent, incomplete or conflicting", () => {
  const d = assessVerifiedAttribution({candidate,verifiedOrder,verifiedShop:shop,nowMs:now});
  assert.equal(assessLegacyDeliveryConflict(d,undefined).status,"blocked");
  assert.equal(assessLegacyDeliveryConflict(d,{}).status,"blocked");
  assert.equal(assessLegacyDeliveryConflict(d,{
    lookup_ok:true,shop,order_id:"123456789",existing_delivery:true,
  }).reason,"already_in_legacy_delivery_pipeline");
  assert.equal(assessLegacyDeliveryConflict(d,{
    lookup_ok:true,shop:"wrong.myshopify.com",order_id:"123456789",existing_delivery:false,
  }).status,"blocked");
  const ready = assessLegacyDeliveryConflict(d,{
    lookup_ok:true,shop,order_id:"123456789",existing_delivery:false,
  });
  assert.equal(ready.status,"eligible_for_further_review");
  assert.equal(ready.commission_created,false);
});
