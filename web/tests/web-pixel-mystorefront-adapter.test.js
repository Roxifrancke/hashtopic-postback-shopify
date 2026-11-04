import test from "node:test";
import assert from "node:assert/strict";
import {createTrustedClickLookup,trustedClickAdapterConfigured,shopMatchesBrand} from "../backend/web-pixel-mystorefront-adapter.js";
const shop="mystorefront-test.myshopify.com";
const brandId="11111111-1111-4111-8111-111111111111";
const creatorId="22222222-2222-4222-8222-222222222222";
const linkId="33333333-3333-4333-8333-333333333333";
const clickId="test_referral_123456";
const key="testing-only-service-credential-that-is-longer-than-forty-characters";
const configuration={
  WEB_PIXEL_STAGING_TRUSTED_CLICK_ENABLED:"true",
  WEB_PIXEL_STAGING_RECEIVER_ENABLED:"true",
  WEB_PIXEL_STAGING_PERSISTENCE_ENABLED:"true",
  SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
  WEB_PIXEL_STAGING_BRAND_ID:brandId,
  WEB_PIXEL_STAGING_SUPABASE_URL:"https://exampleproject.supabase.co",
  WEB_PIXEL_STAGING_SUPABASE_SERVICE_KEY:key,
};
function mockFetch({missingClick=false,deleted=false,brandWebsite=shop}={}) {
  const requests=[];
  const fn=async (url,opts)=>{
    requests.push({url,opts});
    assert.equal(opts.headers.apikey,key);
    assert.equal(opts.redirect,"error");
    let rows;
    if(url.includes("/affiliate_clicks?"))rows=missingClick?[]:[{
      click_id:clickId,creator_id:creatorId,brand_id:brandId,
      link_id:linkId,created_at:"2026-11-04T16:30:00Z",
    }];
    else if(url.includes("/links?"))rows=[{id:linkId,user_id:creatorId,is_deleted:deleted}];
    else if(url.includes("/brand_accounts?"))rows=[{id:brandId,store_url:null,website_url:brandWebsite}];
    else throw Error("Unexpected table");
    return {ok:true,async json(){return rows;}};
  };
  return {fn,requests};
}
test("adapter is disabled without explicit flags and credentials",()=>{
  assert.equal(trustedClickAdapterConfigured({}),false);
  assert.equal(trustedClickAdapterConfigured(configuration),true);
  assert.equal(trustedClickAdapterConfigured({...configuration,WEB_PIXEL_STAGING_TRUSTED_CLICK_ENABLED:"false"}),false);
  assert.equal(trustedClickAdapterConfigured({...configuration,SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com"}),false);
});
test("read-only click lookup validates creator, link, brand and remains consent blocked",async()=>{
  const fetcher=mockFetch();
  const lookup=createTrustedClickLookup({
    supabaseUrl:configuration.WEB_PIXEL_STAGING_SUPABASE_URL,
    serviceKey:key,brandId,fetchImpl:fetcher.fn,
  });
  const result=await lookup({shop,clickId});
  assert.equal(result.valid,true);
  assert.equal(result.creator_id,creatorId);
  assert.equal(result.consent_eligible,false);
  assert.equal(fetcher.requests.length,3);
  assert.ok(fetcher.requests.every(x=>x.opts.method==="GET"));
  assert.equal(fetcher.requests.some(x=>x.url.includes(key)),false);
});
test("unknown referral or deleted link are rejected without creating commission",async()=>{
  for (const options of [{missingClick:true},{deleted:true}]) {
    const fetcher=mockFetch(options);
    const lookup=createTrustedClickLookup({
      supabaseUrl:configuration.WEB_PIXEL_STAGING_SUPABASE_URL,
      serviceKey:key,brandId,fetchImpl:fetcher.fn,
    });
    assert.equal(await lookup({shop,clickId}),null);
  }
});
test("rejects invalid store/domain and refuses missing secrets",async()=>{
  const f=mockFetch();
  assert.throws(()=>createTrustedClickLookup({
    supabaseUrl:"http://exampleproject.supabase.co",serviceKey:key,brandId,fetchImpl:f.fn,
  }),/HTTPS/);
  const lookup=createTrustedClickLookup({
    supabaseUrl:configuration.WEB_PIXEL_STAGING_SUPABASE_URL,
    serviceKey:key,brandId,fetchImpl:f.fn,
  });
  await assert.rejects(lookup({shop:"another.myshopify.com",clickId}),/Invalid staging/);
  assert.equal(f.requests.length,0);
});

test("rejects live HashTopic brand mapped to a different Shopify test shop",async()=>{
  const actualBrandDomain="mystorefront-test-2.myshopify.com";
  assert.equal(shopMatchesBrand(shop,{website_url:actualBrandDomain,store_url:null}),false);
  assert.equal(shopMatchesBrand(shop,{website_url:"https://"+shop+"/",store_url:null}),true);
  const fetcher=mockFetch({brandWebsite:actualBrandDomain});
  const lookup=createTrustedClickLookup({
    supabaseUrl:configuration.WEB_PIXEL_STAGING_SUPABASE_URL,
    serviceKey:key,brandId,fetchImpl:fetcher.fn,
  });
  assert.equal(await lookup({shop,clickId}),null);
});
