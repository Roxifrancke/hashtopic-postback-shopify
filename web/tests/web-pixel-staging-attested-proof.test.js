import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrustedReferral,
  createStagingTrustedReferralLookup,
  STAGING_TEST_SHOP
} from "../backend/web-pixel-staging-trusted-referral.js";

const brandId="4e1d2474-1750-4f62-a8d8-693903f4154f";
const clickId="11111111-1111-4111-8111-111111111111";
const creatorId="22222222-2222-4222-8222-222222222222";
const linkId="33333333-3333-4333-8333-333333333333";
const click={click_id:clickId,brand_id:brandId,creator_id:creatorId,link_id:linkId,created_at:"2026-11-04T18:45:00Z"};
const proof={click_id:clickId,brand_id:brandId,creator_id:creatorId,link_id:linkId,issuer:"affiliate-redirect",issued_at:"2026-11-04T18:45:01Z"};
const link={id:linkId,user_id:creatorId,is_deleted:false};
const brand={id:brandId,website_url:STAGING_TEST_SHOP,store_url:null};
const nowMs=Date.parse("2026-11-04T18:50:00Z");

test("the protected ledger confirms provenance without authorizing sales",()=>{
  const r=classifyTrustedReferral({click,proof,link,brand,nowMs});
  assert.equal(r.status,"click_record_verified_pending_consent");
  assert.equal(r.provenance_verified,true);
  assert.equal(r.consent_eligible,false);
  assert.equal(r.commission_created,false);
  assert.equal(r.can_send_postback,false);
  assert.equal(r.clicked_at,click.created_at);
});

test("no proof is not a verified click",()=>{
  const r=classifyTrustedReferral({click,link,brand,nowMs});
  assert.equal(r.status,"click_record_found_unproven");
  assert.equal(r.provenance_verified,false);
});

test("unmatched ledger fields or timestamps never authenticate a click",()=>{
  const variants=[
    {...proof,issuer:"browser"},
    {...proof,creator_id:brandId},
    {...proof,brand_id:creatorId},
    {...proof,link_id:creatorId},
    {...proof,click_id:creatorId},
    {...proof,issued_at:"2026-10-01T00:00:00Z"},
  ];
  for(const wrongProof of variants){
    const r=classifyTrustedReferral({click,link,brand,proof:wrongProof,nowMs});
    assert.equal(r.status,"blocked");
    assert.equal(r.commission_created,false);
    assert.equal(r.can_send_postback,false);
  }
});

test("read-only lookup requests a separate proof row and verifies it",async()=>{
  const calls=[];
  const scopedKey="test-restricted-read-key-not-for-live-use-000000";
  const lookup=createStagingTrustedReferralLookup({
    supabaseUrl:"https://exampleproject.supabase.co/",
    serviceKey:scopedKey,
    now:()=>nowMs,
    fetchImpl:async (url,options)=>{
      calls.push({url,options});
      const data=url.includes("/affiliate_click_proofs?")?[proof]:
        url.includes("/affiliate_clicks?")?[click]:
        url.includes("/brand_accounts?")?[brand]:
        url.includes("/links?")?[link]:[];
      return {ok:true,json:async()=>data};
    },
  });
  const r=await lookup({shop:STAGING_TEST_SHOP,clickId});
  assert.equal(r.status,"click_record_verified_pending_consent");
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.options.method==="GET"));
  assert.ok(calls.every(c=>!c.url.includes(scopedKey)));
  assert.equal(r.can_send_postback,false);
});
