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
    location:{protocol:'https:'},window:{
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
