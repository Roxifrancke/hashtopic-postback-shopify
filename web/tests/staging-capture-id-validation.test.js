import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../backend/routes/pixel-script.js',import.meta.url),'utf8');
// Evaluate only the pure script generator, avoiding the database-backed router.
const generatorSource=source.slice(source.indexOf('export function generateCaptureScript(')).replace('export function generateCaptureScript(','function generateCaptureScript(');
const generateCaptureScript=vm.runInNewContext(generatorSource+'\n generateCaptureScript;');

const click='c84cc8f8-787a-40f2-8b3c-3e79e51e3001';
function run(shop,query) {
  const calls=[];
  const storage=new Map();
  const formInputs=[];
  const form={
    tagName:'FORM',id:'product_form_123',
    getAttribute(name){return name==='action'?'/cart/add':null;},
    hasAttribute(){return false;},
    querySelector(){return null;},
    appendChild(input){formInputs.push(input);},
  };
  const ctx={
    URLSearchParams,Date,Number,JSON,Math,RegExp,encodeURIComponent,decodeURIComponent,
    location:{protocol:'https:',search:query},window:{
      location:{search:query},sessionStorage:{getItem:()=>null,setItem:()=>{}},
      localStorage:{setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)||null},
    },
    document:{
      readyState:'complete',cookie:'',
      querySelectorAll(selector){return selector==='form'?[form]:[];},
      createElement(){return {setAttribute(){}};},
      addEventListener(){},body:{},
    },
    fetch:(...args)=>{calls.push(args);return Promise.resolve({ok:true});},
    MutationObserver:class {observe(){}},
  };
  ctx.window.location=ctx.location;
  ctx.window.Shopify={customerPrivacy:{marketingAllowed:()=>true}};
  vm.runInNewContext(generateCaptureScript(['click_id'],'click_id',30,shop),ctx);
  return {calls,formInputs,storage};
}
test('staging accepts a canonical UUID and writes same value in cart and form',()=>{
  const r=run('mystorefront-test.myshopify.com','?click_id='+click);
  assert.equal(r.calls.length,1);
  assert.equal(JSON.parse(r.calls[0][1].body).attributes['MyStorefront click_id'],click);
  assert.equal(r.formInputs[0]?.value,click);
});
test('staging rejects malformed URL without cart/form writes or storage',()=>{
  for(const value of [click+'2.',click+'%20', 'not-an-id']){
    const r=run('mystorefront-test.myshopify.com','?click_id='+value);
    assert.equal(r.calls.length,0);
    assert.equal(r.formInputs.length,0);
    assert.equal(r.storage.size,0);
  }
});
test('production shop keeps previous capture behavior (no broad rollout)',()=>{
  const r=run('another.myshopify.com','?click_id='+click+'2.');
  assert.equal(r.calls.length,1);
  assert.equal(r.formInputs.length,1);
});

function createCartConfirmationHarness(shop, responses) {
  const calls=[];
  const local=new Map();
  const session=new Map();
  const timers=[];
  const ctx={
    URLSearchParams,Date,Number,JSON,Math,RegExp,encodeURIComponent,decodeURIComponent,
    setTimeout(fn){timers.push(fn);},
    location:{protocol:'https:',search:'?click_id='+click},
    window:{
      location:{search:'?click_id='+click},
      sessionStorage:{
        getItem:k=>session.get(k)||null,
        setItem:(k,v)=>session.set(k,v),
      },
      localStorage:{
        getItem:k=>local.get(k)||null,
        setItem:(k,v)=>local.set(k,v),
      },
    },
    document:{
      readyState:'complete',cookie:'',
      querySelectorAll:()=>[],
      addEventListener(){},
      body:{},
    },
    fetch:(url,opts)=>{
      calls.push({url,opts});
      const next=responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    MutationObserver:class {observe(){}},
  };
  ctx.window.location=ctx.location;
  ctx.window.Shopify={customerPrivacy:{marketingAllowed:()=>true}};
  vm.runInNewContext(generateCaptureScript(['click_id'],'click_id',30,shop),ctx);
  return {calls,session,timers,ctx};
}
async function flushCartTasks() {
  for(let i=0;i<6;i++)await Promise.resolve();
}
test('staging marks cart saved only after JSON confirms matching attribute',async()=>{
  const h=createCartConfirmationHarness('mystorefront-test.myshopify.com',[
    {ok:true,json:async()=>({attributes:{'MyStorefront click_id':click}})},
  ]);
  assert.equal(h.session.get('mystorefront_cart_written'),undefined);
  await flushCartTasks();
  assert.equal(h.calls.length,1);
  assert.equal(h.session.get('mystorefront_cart_written'),click);
  assert.equal(h.timers.length,0);
});
test('staging retries a rejected cart mutation once, then confirms persistence',async()=>{
  const h=createCartConfirmationHarness('mystorefront-test.myshopify.com',[
    {ok:false,json:async()=>({})},
    {ok:true,json:async()=>({attributes:{'MyStorefront click_id':click}})},
  ]);
  await flushCartTasks();
  assert.equal(h.session.get('mystorefront_cart_written'),undefined);
  assert.equal(h.timers.length,1);
  h.timers.shift()();
  await flushCartTasks();
  assert.equal(h.calls.length,2);
  assert.equal(h.session.get('mystorefront_cart_written'),click);
});
test('staging does not mark saved after repeated failure or mismatched confirmation',async()=>{
  const h=createCartConfirmationHarness('mystorefront-test.myshopify.com',[
    {ok:true,json:async()=>({attributes:{'MyStorefront click_id':'wrong'}})},
    new Error('network unavailable'),
  ]);
  await flushCartTasks();
  assert.equal(h.session.get('mystorefront_cart_written'),undefined);
  h.timers.shift()();
  await flushCartTasks();
  assert.equal(h.calls.length,2);
  assert.equal(h.session.get('mystorefront_cart_written'),undefined);
  assert.equal(h.timers.length,0);
});
test('production capture retains its previous immediate success marker',async()=>{
  const h=createCartConfirmationHarness('live-merchant.myshopify.com',[
    {ok:true,json:async()=>({attributes:{}})},
  ]);
  assert.equal(h.session.get('mystorefront_cart_written'),click);
  await flushCartTasks();
  assert.equal(h.calls.length,1);
  assert.equal(h.timers.length,0);
});

test('staging refuses referral capture if Shopify privacy permission is unavailable or denied',()=>{
  const source=generateCaptureScript(['click_id'],'click_id',30,'mystorefront-test.myshopify.com');
  for(const privacy of [undefined,{marketingAllowed:()=>false},{marketingAllowed:()=>null},{marketingAllowed:()=>{throw Error('privacy unavailable')}},{}]){
    const writes=[];
    const local=new Map();
    const context={
      URLSearchParams,Date,Number,JSON,Math,RegExp,encodeURIComponent,decodeURIComponent,
      location:{protocol:'https:',search:'?click_id='+click},
      window:{
        Shopify:privacy===undefined?undefined:{customerPrivacy:privacy},
        localStorage:{setItem:(k,v)=>local.set(k,v),getItem:k=>local.get(k)||null},
        sessionStorage:{getItem:()=>null,setItem:()=>{}},
      },
      document:{
        readyState:'complete',cookie:'',querySelectorAll:()=>[],
        addEventListener(){},body:{},
      },
      fetch:(...args)=>{writes.push(args);return Promise.resolve({ok:true})},
      MutationObserver:class {observe(){}},
    };
    context.window.location=context.location;
    vm.runInNewContext(source,context);
    assert.equal(writes.length,0);
    assert.equal(local.size,0);
  }
});
test('production retains prior capture behavior when Shopify privacy API is missing',()=>{
  const r=run('another.myshopify.com','?click_id='+click);
  assert.equal(r.calls.length,1);
});
