import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {assessReadOnlyPixelPaidOrder,verifyStagingPaidWebhook} from "../backend/web-pixel-staging-paid-review.js";

const shop="mystorefront-test.myshopify.com";
const secret="fake-staging-webhook-secret-at-least-thirty-two-characters";
const rawBody=Buffer.from(JSON.stringify({
  id:123456789,financial_status:"paid",cancelled_at:null,
}));
const webhook={
  rawBody,
  hmac:createHmac("sha256",secret).update(rawBody).digest("base64"),
  topic:"orders/paid",shop,
};
const candidate={
  status:"candidate_only",shop,order_id:"123456789",
  click_id:"11111111-1111-4111-8111-111111111111",
  requires_order_verification:true,
};
const nowMs=Date.parse("2026-11-04T19:00:00Z");
const order={shop,id:"123456789",financial_status:"paid",cancelled_at:null,
  created_at:"2026-11-04T18:55:00Z"};
const click={status:"click_record_verified_pending_consent",
  clicked_at:"2026-11-04T18:45:00Z",
  commission_created:false,can_send_postback:false,consent_eligible:false};
const inputs=()=>({
  candidate,webhook,webhookSecret:secret,nowMs,
  fetchShopifyOrder:async()=>order,
  lookupTrustedClick:async()=>click,
  hasLegacyDelivery:async()=>false,
});
test("signed paid webhook HMAC is verified without creating commission",()=>{
  const r=verifyStagingPaidWebhook({...webhook,secret});
  assert.equal(r.status,"signed_paid_evidence");
  assert.equal(r.commission_created,false);
  assert.equal(r.can_send_postback,false);
  assert.equal(verifyStagingPaidWebhook({...webhook,hmac:"bad",secret}).status,"blocked");
  assert.equal(verifyStagingPaidWebhook({...webhook,topic:"orders/updated",secret}).status,"blocked");
  assert.equal(verifyStagingPaidWebhook({...webhook,shop:"other.myshopify.com",secret}).status,"blocked");
});
test("fully matching checkout remains blocked from payout, pending independent consent",async()=>{
  const r=await assessReadOnlyPixelPaidOrder(inputs());
  assert.equal(r.status,"verified_order_and_click_pending_consent");
  assert.equal(r.consent_eligible,false);
  assert.equal(r.commission_created,false);
  assert.equal(r.can_send_postback,false);
  assert.equal(JSON.stringify(r).includes(candidate.click_id),false);
});
test("forged webhook, wrong order or shop, unpaid, cancellation and stale click fail closed",async()=>{
  for(const bad of [
    {webhook:{...webhook,hmac:"forged"}},
    {candidate:{...candidate,order_id:"999999999"}},
    {fetchShopifyOrder:async()=>({...order,shop:"other.myshopify.com"})},
    {fetchShopifyOrder:async()=>({...order,financial_status:"pending"})},
    {fetchShopifyOrder:async()=>({...order,cancelled_at:"2026-11-04T18:56:00Z"})},
    {lookupTrustedClick:async()=>({...click,clicked_at:"2026-09-01T00:00:00Z"})},
    {lookupTrustedClick:async()=>({...click,clicked_at:"2026-11-04T18:56:00Z"})},
    {lookupTrustedClick:async()=>null},
    {hasLegacyDelivery:async()=>true},
    {hasLegacyDelivery:async()=>undefined},
    {fetchShopifyOrder:async()=>{throw Error("offline")}},
  ]) {
    const decision=await assessReadOnlyPixelPaidOrder({...inputs(),...bad});
    assert.equal(decision.status,"blocked");
    assert.equal(decision.commission_created,false);
    assert.equal(decision.can_send_postback,false);
  }
});
test("only exact test shop and server adapters are accepted",async()=>{
  const r=await assessReadOnlyPixelPaidOrder({...inputs(),
    candidate:{...candidate,shop:"other.myshopify.com"}});
  assert.equal(r.status,"blocked");
  assert.equal((await assessReadOnlyPixelPaidOrder({...inputs(),lookupTrustedClick:null})).status,"blocked");
});
