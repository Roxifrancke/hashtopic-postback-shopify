import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTrustedReferral,verifyTrustedReferralCandidate,
} from "../backend/web-pixel-trusted-click.js";

const shop="mystorefront-test.myshopify.com";
const nowMs=Date.parse("2026-11-04T18:00:00Z");
const candidate={
  status:"candidate_only",requires_order_verification:true,
  shop,order_id:"123456789",click_id:"test_referral_123456",
};
const referral={
  source:"trusted_mystorefront_server",valid:true,consent_eligible:true,
  shop,click_id:candidate.click_id,
  clicked_at:"2026-11-04T17:30:00Z",
  creator_id:"creator_test_1",brand_id:"brand_test_1",
};
const orderCreatedAt="2026-11-04T17:55:00Z";

test("trusted server click within window yields only non-commission review approval",()=>{
  const result=evaluateTrustedReferral({candidate,referral,orderCreatedAt,nowMs});
  assert.equal(result.status,"trusted_referral_confirmed");
  assert.equal(result.commission_created,false);
  assert.equal(result.requires_paid_order_verification,true);
  assert.equal(JSON.stringify(result).includes("creator_test"),false);
});

test("fake, expired, wrong-brand, consent-denied and unknown clicks fail closed",()=>{
  const verify=r=>evaluateTrustedReferral({candidate,referral:r,orderCreatedAt,nowMs});
  assert.equal(verify(null).status,"blocked");
  assert.equal(verify({...referral,source:"browser_event"}).status,"blocked");
  assert.equal(verify({...referral,click_id:"test_referral_other"}).status,"blocked");
  assert.equal(verify({...referral,consent_eligible:false}).status,"blocked");
  assert.equal(verify({...referral,shop:"orphan-street-clothing-shop.myshopify.com"}).status,"blocked");
  assert.equal(verify({...referral,creator_id:""}).status,"blocked");
  assert.equal(verify({...referral,clicked_at:"2026-09-01T00:00:00Z"}).reason,"outside_attribution_window");
  assert.equal(verify({...referral,clicked_at:"2026-11-04T17:59:00Z"}).reason,"outside_attribution_window");
});

test("missing adapter and server lookup outage block all candidates",async()=>{
  const a={candidate,orderCreatedAt,nowMs};
  assert.equal((await verifyTrustedReferralCandidate(a)).reason,"trusted_click_adapter_missing");
  assert.equal((await verifyTrustedReferralCandidate({
    ...a,lookupTrustedClick:async()=>{throw Error("unavailable")},
  })).reason,"trusted_click_lookup_unavailable");
  const b=await verifyTrustedReferralCandidate({
    ...a,lookupTrustedClick:async({shop:s,clickId})=>{
      assert.equal(s,shop);assert.equal(clickId,candidate.click_id);return referral;
    },
  });
  assert.equal(b.status,"trusted_referral_confirmed");
  assert.equal(b.commission_created,false);
});
