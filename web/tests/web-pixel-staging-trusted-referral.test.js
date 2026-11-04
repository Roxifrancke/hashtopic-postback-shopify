import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTrustedReferral,createStagingTrustedReferralLookup,STAGING_TEST_SHOP
} from "../backend/web-pixel-staging-trusted-referral.js";

const brandId="4e1d2474-1750-4f62-a8d8-693903f4154f";
const clickId="11111111-1111-4111-8111-111111111111";
const creatorId="22222222-2222-4222-8222-222222222222";
const linkId="33333333-3333-4333-8333-333333333333";
const nowMs=Date.parse("2026-11-04T18:50:00Z");
const click={click_id:clickId,brand_id:brandId,creator_id:creatorId,
  link_id:linkId,created_at:"2026-11-04T18:45:00Z"};
const link={id:linkId,user_id:creatorId,is_deleted:false};
const brand={id:brandId,website_url:STAGING_TEST_SHOP,store_url:null};
const key="staging-readonly-test-secret-never-a-real-service-role-key";

test("valid real-shaped UUID click does not prove server issuance",()=>{
  const result=classifyTrustedReferral({click,link,brand,nowMs});
  assert.deepEqual(result,{
    status:"click_record_found_unproven",
    reason:"server_issuance_not_attested",
    provenance_verified:false,
    consent_eligible:false,commission_created:false,can_send_postback:false,
  });
  assert.equal(JSON.stringify(result).includes(creatorId),false);
  assert.equal(JSON.stringify(result).includes(clickId),false);
});

test("incorrect shops, creators, deleted links, mismatched brands and stale clicks fail closed",()=>{
  const classify=(overrides={})=>classifyTrustedReferral({
    click,link,brand,nowMs,...overrides,
  });
  assert.equal(classify({brand:{...brand,website_url:"mystorefront-test-2.myshopify.com"}}).status,"blocked");
  assert.equal(classify({shop:"other-store.myshopify.com"}).status,"blocked");
  assert.equal(classify({click:{...click,brand_id:creatorId}}).status,"blocked");
  assert.equal(classify({link:{...link,user_id:brandId}}).status,"blocked");
  assert.equal(classify({link:{...link,is_deleted:true}}).status,"blocked");
  assert.equal(classify({click:{...click,created_at:"2026-08-01T00:00:00Z"}}).status,"blocked");
  assert.equal(classify({click:{...click,created_at:"2026-11-05T00:00:00Z"}}).status,"blocked");
  assert.equal(classify({click:{...click,click_id:"test_referral_foo"}}).status,"blocked");
});

function mockFetch({missing=false,deleted=false,mismatch=false,fail=false}={}){
  const calls=[];
  const fn=async(url,opts)=>{
    calls.push({url,opts});
    assert.equal(opts.method,"GET");
    assert.equal(opts.headers.apikey,key);
    if(fail)throw Error("staging source unavailable");
    let data=[];
    if(url.includes("/affiliate_clicks?"))data=missing?[]:[click];
    else if(url.includes("/links?"))data=[{...link,is_deleted:deleted}];
    else if(url.includes("/brand_accounts?"))data=[{
      ...brand,website_url:mismatch?"mystorefront-test-2.myshopify.com":STAGING_TEST_SHOP,
    }];
    return {ok:true,json:async()=>data};
  };
  return {fn,calls};
}

test("server-only lookup finds linked click but does not certify provenance",async()=>{
  const m=mockFetch();
  const lookup=createStagingTrustedReferralLookup({
    supabaseUrl:"https://exampleproject.supabase.co/",
    serviceKey:key,fetchImpl:m.fn,now:()=>nowMs,
  });
  const result=await lookup({clickId,shop:STAGING_TEST_SHOP});
  assert.equal(result.status,"click_record_found_unproven");
  assert.equal(result.provenance_verified,false);
  assert.equal(result.consent_eligible,false);
  assert.equal(result.commission_created,false);
  assert.equal(m.calls.length,3);
  assert.ok(m.calls.every(x=>!x.url.includes(key)));
});

test("lookup rejects absent clicks, invalid domains and errors",async()=>{
  for(const options of [{missing:true},{deleted:true},{mismatch:true},{fail:true}]){
    const m=mockFetch(options);
    const lookup=createStagingTrustedReferralLookup({
      supabaseUrl:"https://exampleproject.supabase.co/",
      serviceKey:key,fetchImpl:m.fn,now:()=>nowMs,
    });
    const result=await lookup({clickId,shop:STAGING_TEST_SHOP});
    assert.equal(result.status,"blocked");
    assert.equal(result.commission_created,false);
  }
  const m=mockFetch();
  const lookup=createStagingTrustedReferralLookup({
    supabaseUrl:"https://exampleproject.supabase.co/",
    serviceKey:key,fetchImpl:m.fn,now:()=>nowMs,
  });
  assert.equal((await lookup({clickId,shop:"wrong.myshopify.com"})).status,"blocked");
  assert.equal(m.calls.length,0);
  assert.throws(()=>createStagingTrustedReferralLookup({
    supabaseUrl:"http://exampleproject.supabase.co/",serviceKey:key,
  }),/Invalid Supabase/);
});
