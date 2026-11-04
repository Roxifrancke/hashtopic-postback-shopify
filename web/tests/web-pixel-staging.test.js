import test from "node:test";
import assert from "node:assert/strict";
import { createStagingPixelHandler, isStagingPixelReceiverEnabled } from "../backend/routes/web-pixel-staging.js";

const origin="https://mystorefront-test.myshopify.com";
const shop="mystorefront-test.myshopify.com";
const now=Date.parse("2026-11-04T18:00:00Z");
const secret="local-test-secret-that-is-not-used-in-deployment";
const base={
  shop, event_id:"synthetic_event_referral_0001",client_id:"synthetic_client_0001",
  type:"referral",occurred_at:"2026-11-04T17:59:00Z",click_id:"test_referral_123456",
};
const checkout={...base,type:"checkout",event_id:"synthetic_event_checkout_0001",
  occurred_at:"2026-11-04T18:00:00Z",order_id:"gid://shopify/Order/123456789"};
delete checkout.click_id;

test("staging receiver is disabled by default and requires staging URL + secret",()=>{
  assert.equal(isStagingPixelReceiverEnabled({}),false);
  assert.equal(isStagingPixelReceiverEnabled({
    WEB_PIXEL_STAGING_RECEIVER_ENABLED:"true",
    SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com",
    WEB_PIXEL_STAGING_HASH_KEY:secret
  }),false);
  assert.equal(isStagingPixelReceiverEnabled({
    WEB_PIXEL_STAGING_RECEIVER_ENABLED:"true",
    SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
    WEB_PIXEL_STAGING_HASH_KEY:secret
  }),true);
});

test("returns only unverified candidate with no commission",()=>{
  const receiver=createStagingPixelHandler({secret,now:()=>now});
  assert.equal(receiver.observe(base,origin,"127.0.0.1").body.status,"referral_observed");
  const r=receiver.observe(checkout,origin,"127.0.0.1");
  assert.equal(r.code,202);
  assert.equal(r.body.status,"candidate_unverified");
  assert.equal(r.body.commission_created,false);
  assert.equal(r.body.requires_shopify_paid_order_verification,true);
  assert.equal(JSON.stringify(r).includes("synthetic_client"),false);
  assert.equal(JSON.stringify(r).includes("test_referral"),false);
});

test("rejects other domains, PII fields, bogus orders and duplicate events",()=>{
  const receiver=createStagingPixelHandler({secret,now:()=>now});
  assert.equal(receiver.observe(base,"https://evil.example","client1").code,403);
  assert.equal(receiver.observe({...base,email:"person@example.com"},origin,"client2").code,400);
  assert.equal(receiver.observe({...base,shop:"orphan-street-clothing-shop.myshopify.com"},origin,"client3").code,400);
  assert.equal(receiver.observe({...checkout,order_id:"something else"},origin,"client4").code,400);
  assert.equal(receiver.observe(base,origin,"client5").code,202);
  assert.equal(receiver.observe(base,origin,"client5").body.status,"duplicate_ignored");
});

test("no referral, different client, and request flood fail closed",()=>{
  const receiver=createStagingPixelHandler({secret,now:()=>now});
  assert.equal(receiver.observe(checkout,origin,"client1").body.status,"checkout_unmatched");
  assert.equal(receiver.observe({...base,event_id:"synthetic_event_referral_0002"},origin,"client2").code,202);
  assert.equal(receiver.observe({...checkout,event_id:"synthetic_event_checkout_0002",client_id:"synthetic_client_other"},origin,"client2").body.status,"checkout_unmatched");
  for(let i=0;i<30;i++) receiver.observe({...base,event_id:`synthetic_flood_event_${String(i).padStart(8,"0")}`},origin,"flood-client");
  assert.equal(receiver.observe({...base,event_id:"synthetic_flood_last"},origin,"flood-client").code,429);
});
