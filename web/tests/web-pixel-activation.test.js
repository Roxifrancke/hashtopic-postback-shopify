import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStagingAppPixel, stagingPixelActivationEnabled } from '../backend/web-pixel-activation.js';

const SHOP='mystorefront-test.myshopify.com';
const ENV={SHOPIFY_APP_URL:'https://hashtopic-postback-shopify-staging.onrender.com',WEB_PIXEL_STAGING_ACTIVATION_ENABLED:'true'};
const token='staging-token-for-tests';
const mock=(responses,requests=[])=>async(url,opts)=>{
  requests.push({url,opts,body:JSON.parse(opts.body)});
  const result=responses.shift();
  return {ok:result.ok!==false,status:result.status||200,json:async()=>result.body};
};
test('activation cannot run without staging host and explicit flag',async()=>{
  assert.equal(stagingPixelActivationEnabled(SHOP,{}),false);
  assert.equal(stagingPixelActivationEnabled('other.myshopify.com',ENV),false);
  let count=0;
  const result=await ensureStagingAppPixel({shop:'other.myshopify.com',token,env:ENV,fetchFn:async()=>{count++;}});
  assert.equal(result.status,'disabled');
  assert.equal(count,0);
});
test('existing connected pixel does not create duplicates',async()=>{
  const requests=[];
  const result=await ensureStagingAppPixel({shop:SHOP,token,env:ENV,fetchFn:mock([
    {body:{data:{webPixel:{id:'gid://shopify/WebPixel/1'}}}},
  ],requests)});
  assert.equal(result.status,'connected');
  assert.equal(requests.length,1);
});
test('creates app pixel with exact staging-only settings',async()=>{
  const requests=[];
  const result=await ensureStagingAppPixel({shop:SHOP,token,env:ENV,fetchFn:mock([
    {body:{data:{webPixel:null}}},
    {body:{data:{webPixelCreate:{webPixel:{id:'gid://shopify/WebPixel/2'},userErrors:[]}}}},
  ],requests)});
  assert.equal(result.status,'created');
  assert.equal(requests.length,2);
  assert.equal(requests[1].body.variables.pixel.settings.shop,SHOP);
  assert.match(requests[1].body.variables.pixel.settings.endpoint,/^https:\/\/hashtopic-postback-shopify-staging\.onrender\.com\/api\/staging\//);
  assert.equal(requests[1].url,'https://'+SHOP+'/admin/api/2026-01/graphql.json');
});
test('refuses absent token and reports insufficient scope without exposing token',async()=>{
  assert.equal((await ensureStagingAppPixel({shop:SHOP,token:null,env:ENV})).status,'token_unavailable');
  const result=await ensureStagingAppPixel({shop:SHOP,token,env:ENV,fetchFn:mock([
    {ok:false,status:403,body:{}},
  ])});
  assert.equal(result.status,'shopify_http_403');
  assert.equal(JSON.stringify(result).includes(token),false);
});
test('Shopify user error fails closed',async()=>{
  const result=await ensureStagingAppPixel({shop:SHOP,token,env:ENV,fetchFn:mock([
    {body:{data:{webPixel:null}}},
    {body:{data:{webPixelCreate:{webPixel:null,userErrors:[{code:'INVALID_SETTINGS',message:'invalid'}]}}}},
  ])});
  assert.equal(result.status,'shopify_user_error');
  assert.deepEqual(result.codes,['INVALID_SETTINGS']);
});
