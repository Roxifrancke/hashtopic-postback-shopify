import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  validatePaidWebhookEvidence, reconcileStagingPixelCandidate,
} from "../backend/web-pixel-reconciliation.js";

const shop="mystorefront-test.myshopify.com";
const secret="a-staging-secret-never-used-in-production";
const rawBody=Buffer.from(JSON.stringify({
  id:123456789,financial_status:"paid",cancelled_at:null,
}));
const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
const webhook={rawBody,signature,shop,topic:"orders/paid"};
const candidate={
  shop,status:"candidate_only",requires_order_verification:true,
  order_id:"gid://shopify/Order/123456789",click_id:"test_referral_123456",
};
const nowMs=Date.parse("2026-11-04T18:00:00Z");
const fetchOrder=async()=>({
  id:"123456789", financial_status:"paid",
  created_at:"2026-11-04T17:50:00Z",cancelled_at:null,
});

test("accepts only signed Shopify-paid webhook evidence for the test shop",()=>{
  assert.deepEqual(validatePaidWebhookEvidence({
    rawBody,signature,webhookShop:shop,topic:"orders/paid",secret,
  }),{valid:true,order_id:"123456789"});
  assert.equal(validatePaidWebhookEvidence({
    rawBody,signature,webhookShop:"orphan-street-clothing-shop.myshopify.com",topic:"orders/paid",secret,
  }).valid,false);
  assert.equal(validatePaidWebhookEvidence({
    rawBody,signature,webhookShop:shop,topic:"orders/updated",secret,
  }).valid,false);
  assert.equal(validatePaidWebhookEvidence({
    rawBody,signature:signature.replace(/^./,signature[0]==="x"?"y":"x"),
    webhookShop:shop,topic:"orders/paid",secret,
  }).valid,false);
  assert.equal(validatePaidWebhookEvidence({
    rawBody:Buffer.from("{invalid"),signature,webhookShop:shop,topic:"orders/paid",secret,
  }).valid,false);
});

test("signed webhook + GraphQL order verification still never create commission",async()=>{
  const d=await reconcileStagingPixelCandidate({
    candidate,webhook,webhookSecret:secret,nowMs,fetchOrder,
    lookupLegacyDelivery:async()=>false,
  });
  assert.equal(d.status,"signed_paid_order_and_shopify_verified_pending_click_policy");
  assert.equal(d.commission_created,false);
  assert.equal(d.can_send_postback,false);
  assert.equal(d.requires_click_validation,true);
});

test("duplicate existing delivery, missing proof or wrong order fail closed",async()=>{
  const options={candidate,webhook,webhookSecret:secret,nowMs,fetchOrder,
    lookupLegacyDelivery:async()=>false};
  assert.equal((await reconcileStagingPixelCandidate({
    ...options,lookupLegacyDelivery:async()=>true,
  })).status,"blocked");
  assert.equal((await reconcileStagingPixelCandidate({
    ...options,webhook:{...webhook,signature:"not-a-signature"},
  })).status,"blocked");
  assert.equal((await reconcileStagingPixelCandidate({
    ...options,candidate:{...candidate,order_id:"gid://shopify/Order/999999999"},
  })).reason,"webhook_order_mismatch");
  assert.equal((await reconcileStagingPixelCandidate({
    ...options,fetchOrder:async()=>({...await fetchOrder(),financial_status:"pending"}),
  })).status,"blocked");
  assert.equal((await reconcileStagingPixelCandidate({
    ...options,lookupLegacyDelivery:async()=>{throw new Error("db unavailable")},
  })).status,"blocked");
});
