import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const path=new URL('../../extensions/mystorefront-affiliate-pixel/src/index.js',import.meta.url);
const source=readFileSync(path,'utf8')
  .replace("import { register } from '@shopify/web-pixels-extension';",'')
  .replace('export function startAffiliatePixel(', 'function startAffiliatePixel(')
  .replace('register(startAffiliatePixel);','');
const getStarter=()=>vm.runInNewContext(source+'\nstartAffiliatePixel',{URL,Date,JSON,Number,String});

function harness(shop='mystorefront-test.myshopify.com'){
  const events={},cache=new Map(),requests=[];
  const browser={localStorage:{
    getItem:async key=>cache.get(key)||null,
    setItem:async(key,value)=>{cache.set(key,value);},
  }};
  const start=vm.runInNewContext(source+'\nstartAffiliatePixel',{
    URL,Date,JSON,Number,String,Promise,
    fetch:async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body)});return {ok:true};},
  });
  start({analytics:{subscribe:(event,callback)=>{events[event]=callback;}},
    browser,
    settings:{shop,endpoint:'https://hashtopic-postback-shopify-staging.onrender.com/api/staging/affiliate-pixel-candidate'}});
  return {events,cache,requests};
}
const click='6b04d055-3f51-4a01-8064-ad869892b0d3';
const checkout='aabbccddeeff00112233445566778899';
const pause=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};

test('on checkout_started, pixel sends only a referral candidate with checkout token',async()=>{
  const h=harness();
  assert.deepEqual(Object.keys(h.events).sort(),['checkout_completed','checkout_started','page_viewed']);
  h.events.page_viewed({context:{document:{location:{href:'https://mystorefront-test.myshopify.com/products/abc?click_id='+click}}}});
  await pause();
  h.events.checkout_started({id:'sh-checkout-1',data:{checkout:{token:checkout}}});
  await pause();
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].body.checkout_token,checkout);
  assert.equal(h.requests[0].body.click_id,click);
  assert.equal(h.requests[0].body.order_id,null);
  assert.equal(h.requests[0].body.type,'pixel_candidate');
  assert.equal(Object.hasOwn(h.requests[0].body,'commission'),false);
});
test('checkout_completed optionally carries order ID without waiting for thank-you page to attribute token',async()=>{
  const h=harness();
  h.events.page_viewed({context:{document:{location:{href:'https://mystorefront-test.myshopify.com/?click_id='+click}}}});
  await pause();
  h.events.checkout_completed({id:'sh-checkout-2',data:{checkout:{token:checkout,order:{id:'gid://shopify/Order/7278367473729'}}}});
  await pause();
  assert.equal(h.requests[0].body.order_id,'7278367473729');
});
test('malformed click is never stored or transmitted',async()=>{
  const h=harness();
  h.events.page_viewed({context:{document:{location:{href:'https://mystorefront-test.myshopify.com/?click_id=not-valid'}}}});
  await pause();
  h.events.checkout_started({id:'sh-checkout-3',data:{checkout:{token:checkout}}});
  await pause();
  assert.equal(h.requests.length,0);
  assert.equal(h.cache.size,0);
});
test('no pixel subscriptions or requests for live brands',()=>{
  const h=harness('other.myshopify.com');
  assert.equal(Object.keys(h.events).length,0);
});
