import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {reviewStagingPixelAttribution} from "../backend/web-pixel-staging-review.js";

const shop="mystorefront-test.myshopify.com",secret="a-staging-test-secret-never-used-live";
const rawBody=Buffer.from(JSON.stringify({id:123456789,financial_status:"paid",cancelled_at:null}));
const signature=createHmac("sha256",secret).update(rawBody).digest("base64");
const candidate={shop,status:"candidate_only",requires_order_verification:true,
  order_id:"gid://shopify/Order/123456789",click_id:"test_referral_123456"};
const webhook={rawBody,signature,shop,topic:"orders/paid"};
const nowMs=Date.parse("2026-11-04T18:00:00Z");
const verifiedOrder={id:"123456789",financial_status:"paid",created_at:"2026-11-04T17:55:00Z",cancelled_at:null};
const referral={source:"trusted_mystorefront_server",valid:true,consent_eligible:true,shop,
  click_id:candidate.click_id,clicked_at:"2026-11-04T17:45:00Z",
  creator_id:"creator_test_1",brand_id:"brand_test_1"};
function args(){
  return {candidate,webhook,webhookSecret:secret,nowMs,
    fetchOrder:async()=>verifiedOrder,
    lookupLegacyDelivery:async()=>false,
    lookupTrustedClick:async()=>referral};
}

test("all trusted gates permit manual staging review but NEVER a postback",async()=>{
  const outcome=await reviewStagingPixelAttribution(args());
  assert.equal(outcome.status,"verified_for_staging_manual_review_only");
  assert.equal(outcome.commission_created,false);
  assert.equal(outcome.can_send_postback,false);
  assert.equal(outcome.requires_destination_idempotency,true);
  assert.equal(JSON.stringify(outcome).includes("creator_test_1"),false);
});

test("referral lookup missing, error, forged consent or wrong click block",async()=>{
  assert.equal((await reviewStagingPixelAttribution({...args(),lookupTrustedClick:undefined})).reason,"trusted_click_adapter_missing");
  assert.equal((await reviewStagingPixelAttribution({...args(),lookupTrustedClick:async()=>{throw Error("unavailable")}})).reason,"trusted_click_lookup_unavailable");
  assert.equal((await reviewStagingPixelAttribution({...args(),lookupTrustedClick:async()=>({...referral,consent_eligible:false})})).status,"blocked");
  assert.equal((await reviewStagingPixelAttribution({...args(),lookupTrustedClick:async()=>({...referral,click_id:"forged_referral_other"})})).status,"blocked");
});

test("wrong signature, duplicate legacy delivery and unpaid order block",async()=>{
  assert.equal((await reviewStagingPixelAttribution({...args(),webhook:{...webhook,signature:"invalid"}})).status,"blocked");
  assert.equal((await reviewStagingPixelAttribution({...args(),lookupLegacyDelivery:async()=>true})).status,"blocked");
  assert.equal((await reviewStagingPixelAttribution({...args(),fetchOrder:async()=>({...verifiedOrder,financial_status:"unpaid"})})).status,"blocked");
  assert.equal((await reviewStagingPixelAttribution({...args(),fetchOrder:async()=>{throw Error("offline")}})).reason,"shopify_verification_unavailable");
});

test("uses order time fetched from Shopify and blocks expired or future referral",async()=>{
  const delayed=await reviewStagingPixelAttribution({...args(),lookupTrustedClick:async()=>({...referral,clicked_at:"2026-11-04T17:56:00Z"})});
  assert.equal(delayed.reason,"outside_attribution_window");
  const missing=await reviewStagingPixelAttribution({...args(),fetchOrder:async()=>({...verifiedOrder,created_at:null})});
  assert.equal(missing.reason,"trusted_order_time_missing");
});
