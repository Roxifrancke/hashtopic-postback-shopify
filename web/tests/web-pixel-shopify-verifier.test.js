import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchTrustedShopifyOrder,
  verifyPixelCandidateWithoutCommission,
} from "../backend/web-pixel-shopify-verifier.js";

const shop = "mystorefront-test.myshopify.com";
const candidate = {
  status:"candidate_only",
  requires_order_verification:true,
  shop,
  order_id:"gid://shopify/Order/123456789",
  click_id:"test_referral_123456",
};
const now = Date.parse("2026-11-04T18:00:00Z");
const graphqlData = {
  shop:{myshopifyDomain:shop},
  order:{
    id:"gid://shopify/Order/123456789",
    legacyResourceId:"123456789",
    displayFinancialStatus:"PAID",
    createdAt:"2026-11-04T17:40:00Z",
    cancelledAt:null,
  },
};

test("Shopify order lookup uses app-only GraphQL and returns only order verification fields",async ()=>{
  let invoked=false;
  const order=await fetchTrustedShopifyOrder(shop,candidate.order_id,async (s,q,vars)=>{
    invoked=true;
    assert.equal(s,shop);
    assert.match(q,/order\(id: \$orderId\)/);
    assert.equal(vars.orderId,candidate.order_id);
    return graphqlData;
  });
  assert.equal(invoked,true);
  assert.equal(order.financial_status,"paid");
  assert.equal(order.id,"123456789");
  assert.equal(Object.keys(order).sort().join(","),"cancelled_at,created_at,financial_status,id");
});

test("wrong Shopify shop, missing order and unexpected legacy ID fail closed",async ()=>{
  await assert.rejects(fetchTrustedShopifyOrder(shop,candidate.order_id,async()=>({
    ...graphqlData,shop:{myshopifyDomain:"another.myshopify.com"},
  })),/identity mismatch/);
  await assert.rejects(fetchTrustedShopifyOrder(shop,candidate.order_id,async()=>({
    ...graphqlData,order:null,
  })),/not found/);
  await assert.rejects(fetchTrustedShopifyOrder(shop,candidate.order_id,async()=>({
    ...graphqlData,order:{...graphqlData.order,legacyResourceId:"123456780"},
  })),/not found/);
  await assert.rejects(fetchTrustedShopifyOrder(shop,"bad-order",async()=>graphqlData),/Invalid Shopify/);
});

test("paid candidate with clean legacy lookup stays pending, never issues commission",async()=>{
  const decision=await verifyPixelCandidateWithoutCommission({
    candidate,nowMs:now,
    fetchOrder:async()=>({
      id:"123456789",financial_status:"paid",
      created_at:"2026-11-04T17:40:00Z",cancelled_at:null,
    }),
    lookupLegacyDelivery:async()=>false,
  });
  assert.equal(decision.status,"verified_paid_candidate_pending_other_checks");
  assert.equal(decision.commission_created,false);
  assert.equal(decision.requires_signed_paid_webhook,true);
  assert.equal(decision.requires_atomic_order_deduplication,true);
});

test("no trusted paid order or missing dedup check always blocks",async()=>{
  const valid=()=>({
    id:"123456789",financial_status:"paid",
    created_at:"2026-11-04T17:40:00Z",cancelled_at:null,
  });
  const base={candidate,nowMs:now,fetchOrder:async()=>valid()};
  assert.equal((await verifyPixelCandidateWithoutCommission(base)).reason,"dedup_lookup_not_configured");
  assert.equal((await verifyPixelCandidateWithoutCommission({...base,lookupLegacyDelivery:async()=>true})).reason,"already_in_legacy_delivery_pipeline");
  assert.equal((await verifyPixelCandidateWithoutCommission({...base,lookupLegacyDelivery:async()=>{throw Error("db offline")}})).reason,"dedup_lookup_unavailable");
  assert.equal((await verifyPixelCandidateWithoutCommission({...base,fetchOrder:async()=>{throw Error("API unavailable")},lookupLegacyDelivery:async()=>false})).reason,"shopify_verification_unavailable");
  assert.equal((await verifyPixelCandidateWithoutCommission({...base,fetchOrder:async()=>({...valid(),financial_status:"unpaid"}),lookupLegacyDelivery:async()=>false})).reason,"payment_not_verified");
  assert.equal((await verifyPixelCandidateWithoutCommission({...base,candidate:{...candidate,shop:"orphan-street-clothing-shop.myshopify.com"},lookupLegacyDelivery:async()=>false})).reason,"candidate_not_allowed");
});
