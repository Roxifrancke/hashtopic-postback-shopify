import test from "node:test";
import assert from "node:assert/strict";
import {
  canRecordPixelObservation,
  observeShopifyPixelPrivacy,
} from "../prototypes/shopify-web-pixel/consent-gate.js";

test("requires explicit processing permission for both declared purposes",()=>{
  for(const state of [
    null,undefined,{},{analyticsProcessingAllowed:true},
    {analyticsProcessingAllowed:false,marketingAllowed:true},
    {analyticsProcessingAllowed:true,marketingAllowed:false},
    {analyticsProcessingAllowed:"true",marketingAllowed:true},
  ])assert.equal(canRecordPixelObservation(state),false);
  assert.equal(canRecordPixelObservation({
    analyticsProcessingAllowed:true,marketingAllowed:true,
    saleOfDataAllowed:false,
  }),true);
});

test("privacy tracker starts from Shopify init and updates on consent event",()=>{
  let onUpdate;
  const tracker=observeShopifyPixelPrivacy({
    init:{customerPrivacy:{
      analyticsProcessingAllowed:false,marketingAllowed:false,
    }},
    customerPrivacy:{subscribe(name,callback){
      assert.equal(name,"visitorConsentCollected");
      onUpdate=callback;
    }},
  });
  assert.equal(tracker.allowed(),false);
  onUpdate({customerPrivacy:{analyticsProcessingAllowed:true,marketingAllowed:true}});
  assert.equal(tracker.allowed(),true);
  onUpdate({customerPrivacy:{analyticsProcessingAllowed:true,marketingAllowed:false}});
  assert.equal(tracker.allowed(),false);
  onUpdate({});
  assert.equal(tracker.allowed(),false);
});

test("refuses to create tracker when Shopify privacy API is unavailable",()=>{
  assert.throws(()=>observeShopifyPixelPrivacy({
    init:{customerPrivacy:{analyticsProcessingAllowed:true,marketingAllowed:true}},
  }),/unavailable/);
});
