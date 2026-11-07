import test from "node:test";
import assert from "node:assert/strict";
import {classifyTrustedReferral,createStagingTrustedReferralLookup,STAGING_TEST_SHOP} from "../backend/web-pixel-staging-trusted-referral.js";

const brandId="4e1d2474-1750-4f62-a8d8-693903f4154f";
const clickId="11111111-1111-4111-8111-111111111111";
const creatorId="22222222-2222-4222-8222-222222222222";
const linkId="33333333-3333-4333-8333-333333333333";
const click={click_id:clickId,creator_id:creatorId,link_id:linkId,
  brand_id:brandId,created_at:"2026-11-04T18:45:00Z"};
const link={id:linkId,user_id:creatorId,is_deleted:false};
const brand={id:brandId,website_url:STAGING_TEST_SHOP,store_url:null};
const issuance={click_id:clickId,link_id:linkId,creator_id:creatorId,
  brand_id:brandId,issuer:"affiliate_redirect",issued_at:"2026-11-04T18:45:00Z"};
const nowMs=Date.parse("2026-11-04T18:50:00Z");

test("no protected issuance, forged issuer or conflicting proof cannot authorize referral",()=>{
  for(const value of [null,
    {...issuance,issuer:"browser"},
    {...issuance,creator_id:brandId},
    {...issuance,link_id:brandId},
    {...issuance,issued_at:"2026-11-04T18:45:30Z"},
  ]){
    const r=classifyTrustedReferral({click,link,brand,issuance:value,nowMs});
    assert.equal(r.status,"click_record_found_unproven");
    assert.equal(r.provenance_verified,false);
    assert.equal(r.consent_eligible,false);
    assert.equal(r.can_send_postback,false);
    assert.equal(r.commission_created,false);
  }
});

test("protected server issuance enables provenance review but not attribution",()=>{
  const r=classifyTrustedReferral({click,link,brand,issuance,nowMs});
  assert.equal(r.status,"click_provenance_confirmed_pending_consent");
  assert.equal(r.provenance_verified,true);
  assert.equal(r.consent_eligible,false);
  assert.equal(r.commission_created,false);
  assert.equal(r.can_send_postback,false);
});

test("Supabase adapter reads the protected issuance with service credentials only",async()=>{
  const key="fake-only-read-key-sufficient-length-and-unused-in-real-services";
  const tables={
    affiliate_clicks:[click],
    links:[link],
    brand_accounts:[brand],
    affiliate_click_issuances:[issuance],
  };
  const calls=[];
  const lookup=createStagingTrustedReferralLookup({
    supabaseUrl:"https://testproject.supabase.co/",
    serviceKey:key,now:()=>nowMs,
    fetchImpl:async(url,options)=>{
      const parsed=new URL(url);
      const table=parsed.pathname.split("/").at(-1);
      calls.push(table);
      assert.equal(options.method,"GET");
      assert.equal(options.headers.apikey,key);
      return {ok:true,json:async()=>tables[table]||[]};
    },
  });
  const r=await lookup({shop:STAGING_TEST_SHOP,clickId});
  assert.equal(r.status,"click_provenance_confirmed_pending_consent");
  assert.deepEqual(calls,["affiliate_clicks","links","brand_accounts","affiliate_click_issuances"]);
  assert.equal(r.can_send_postback,false);
  assert.equal(r.commission_created,false);
});
