import test from "node:test";
import assert from "node:assert/strict";
import {durableStagingEnabled,observeDurableStagingPixel} from "../backend/routes/web-pixel-staging-durable.js";

const shop="mystorefront-test.myshopify.com";
const origin="https://mystorefront-test.myshopify.com";
const secret="test-only-value-that-is-longer-than-32-chars";
const nowMs=Date.parse("2026-11-04T18:00:00Z");
const input={
  shop,type:"referral",event_id:"test_event_referral_1234",
  client_id:"test_client_id_123456",occurred_at:"2026-11-04T17:55:00Z",
  click_id:"test_referral_123456",
};
function mockPool(){
  const calls=[];
  const pool={async connect(){return {
    async query(q,args=[]){
      calls.push({q,args});
      if(q.includes("RETURNING event_hash"))return {rows:[{event_hash:"a".repeat(64)}]};
      if(q.includes("SELECT click_id,clicked_at"))return {rows:[{click_id:input.click_id,clicked_at:input.occurred_at}]};
      return {rows:[]};
    },release(){},
  }}};
  return {pool,calls};
}

test("durable staging path requires both flags and exact staging hostname",()=>{
  const x={WEB_PIXEL_STAGING_RECEIVER_ENABLED:"true",
    WEB_PIXEL_STAGING_PERSISTENCE_ENABLED:"true",
    SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
    WEB_PIXEL_STAGING_HASH_KEY:secret};
  assert.equal(durableStagingEnabled(x),true);
  assert.equal(durableStagingEnabled({...x,WEB_PIXEL_STAGING_PERSISTENCE_ENABLED:"false"}),false);
  assert.equal(durableStagingEnabled({...x,SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com"}),false);
  assert.equal(durableStagingEnabled({}),false);
});

test("durable referral uses hashed identifiers and never returns click or shopper IDs",async()=>{
  const m=mockPool();
  const result=await observeDurableStagingPixel({input,origin,pool:m.pool,secret,nowMs});
  assert.equal(result.httpStatus,202);
  assert.equal(result.body.status,"referral_observed");
  assert.equal(result.body.commission_created,false);
  assert.equal(JSON.stringify(result).includes(input.click_id),false);
  const values=m.calls.flatMap(c=>c.args);
  assert.equal(values.includes(input.client_id),false);
  assert.equal(values.includes(input.event_id),false);
  assert.ok(values.some(v=>typeof v==="string" && /^[a-f0-9]{64}$/.test(v)));
});

test("checkout remains candidate only even with a stored referral",async()=>{
  const m=mockPool();
  const checkout={
    shop,type:"checkout",event_id:"test_event_checkout_1234",
    client_id:input.client_id,occurred_at:"2026-11-04T17:59:00Z",
    order_id:"gid://shopify/Order/123456789",
  };
  const result=await observeDurableStagingPixel({input:checkout,origin,pool:m.pool,secret,nowMs});
  assert.equal(result.body.status,"candidate_only");
  assert.equal(result.body.requires_shopify_paid_order_verification,true);
  assert.equal(result.body.commission_created,false);
  assert.equal(JSON.stringify(result).includes(input.click_id),false);
});

test("rejects PII, wrong store and malformed claims without touching DB",async()=>{
  const m=mockPool();
  for(const bad of [
    {...input,email:"someone@example.com"},
    {...input,shop:"orphan-street-clothing-shop.myshopify.com"},
    {...input,client_id:""},
    {...input,occurred_at:"not-a-date"},
  ]){
    const r=await observeDurableStagingPixel({input:bad,origin,pool:m.pool,secret,nowMs});
    assert.equal(r.httpStatus,400);
  }
  assert.equal((await observeDurableStagingPixel({
    input,origin:"https://evil.example",pool:m.pool,secret,nowMs,
  })).httpStatus,403);
  assert.equal(m.calls.length,0);
});

test("database failure produces a closed, non-commission error",async()=>{
  const pool={async connect(){throw Error("DB unavailable")}};
  const r=await observeDurableStagingPixel({input,origin,pool,secret,nowMs});
  assert.equal(r.httpStatus,503);
  assert.equal(r.body.commission_created,false);
  assert.equal(JSON.stringify(r).includes("DB unavailable"),false);
});
