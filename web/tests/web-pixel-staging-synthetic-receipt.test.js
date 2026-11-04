import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import {
  stagingSyntheticReceiptEnabled,validateSyntheticReferral,
  receiveSyntheticReferral,createStagingSyntheticReceiptRouter,
  SYNTHETIC_RECEIPT_PATH,SYNTHETIC_RECEIPT_SCHEMA,
} from "../backend/routes/web-pixel-staging-synthetic-receipt.js";

const shop="mystorefront-test.myshopify.com";
const now=Date.parse("2026-11-04T18:35:00Z");
const secret="test-synthetic-staging-secret-32-chars-minimum";
const input={
  type:"synthetic_referral",test_only:true,shop,
  event_id:"test_event_abcdefgh12",client_id:"test_client_abcdefgh12",
  click_id:"test_referral_abcdefgh12",observed_at:"2026-11-04T18:35:00Z",
};
function fakePool({duplicate=false,error=false,full=false}={}){
  const calls=[];let releases=0;
  return {
    calls,get releases(){return releases;},
    async connect(){return {
      async query(sql,args=[]){
        calls.push({sql,args});
        if(error && sql.startsWith("INSERT")) throw Error("db down");
        if(sql.startsWith("SELECT count")) return {rows:[{n:full?501:0}]};
        if(sql.startsWith("INSERT"))return {rows:duplicate?[]:[{event_hash:"a".repeat(64)}]};
        return {rows:[],rowCount:0};
      },
      release(){releases++;}
    }}
  };
}

test("receiver stays disabled on production or with missing secret",()=>{
  const env={
    SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
    DATABASE_URL:"postgresql://user:secret@localhost:5432/mystorefront_postback_staging_db",
    WEB_PIXEL_STAGING_SYNTHETIC_RECEIPT_ENABLED:"true",
    WEB_PIXEL_STAGING_RECEIPT_HASH_KEY:secret,
  };
  assert.equal(stagingSyntheticReceiptEnabled(env),true);
  assert.equal(stagingSyntheticReceiptEnabled({...env,WEB_PIXEL_STAGING_SYNTHETIC_RECEIPT_ENABLED:"false"}),false);
  assert.equal(stagingSyntheticReceiptEnabled({...env,DATABASE_URL:"postgresql://user@host/main"}),false);
  assert.equal(stagingSyntheticReceiptEnabled({...env,SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com"}),false);
  assert.equal(stagingSyntheticReceiptEnabled({}),false);
});

test("strict synthetic schema rejects real-looking click, PII, missing flags and stale events",()=>{
  assert.equal(validateSyntheticReferral(input,now),true);
  for(const bad of [
    {...input,test_only:false},
    {...input,type:"referral"},
    {...input,click_id:"actual_affiliate_12345"},
    {...input,client_id:"real_browser_12345"},
    {...input,email:"person@example.com"},
    {...input,observed_at:"2026-10-01T00:00:00Z"},
    {...input,shop:"orphan-street-clothing.myshopify.com"},
    {...input,event_id:"test_event_A"},
  ])assert.equal(validateSyntheticReferral(bad,now),false);
});

test("receipt writes hashed synthetic IDs only and is not a commission",async()=>{
  const pool=fakePool();
  const result=await receiveSyntheticReferral({pool,secret,input,now});
  assert.equal(result.status,202);
  assert.equal(result.body.result,"synthetic_referral_recorded");
  assert.equal(result.body.commission_created,false);
  assert.ok(pool.calls.some(x=>x.sql==="COMMIT"));
  assert.ok(pool.calls.some(x=>x.sql.includes("INTERVAL '24 hours'")));
  const values=pool.calls.flatMap(x=>x.args);
  assert.equal(values.includes(input.client_id),false);
  assert.equal(values.includes(input.click_id),false);
  assert.equal(values.includes(input.event_id),false);
  assert.equal(values.filter(x=>typeof x==="string" && /^[a-f0-9]{64}$/.test(x)).length,3);
  assert.equal(pool.releases,1);
  assert.match(SYNTHETIC_RECEIPT_SCHEMA,/web_pixel_staging_synthetic_receipts/);
});

test("duplicate event does not record second referral",async()=>{
  const pool=fakePool({duplicate:true});
  const result=await receiveSyntheticReferral({pool,secret,input,now});
  assert.equal(result.body.result,"duplicate_ignored");
  assert.equal(result.body.commission_created,false);
});

test("storage errors and capacity exhaustion fail closed and release the client",async()=>{
  for(const flags of [{error:true},{full:true}]){
    const pool=fakePool(flags);
    const result=await receiveSyntheticReferral({pool,secret,input,now});
    assert.equal(result.status,503);
    assert.equal(result.body.commission_created,false);
    assert.ok(pool.calls.some(x=>x.sql==="ROLLBACK"));
    assert.equal(pool.releases,1);
  }
});

test("HTTP route enforces CORS and fails closed without a payload",async()=>{
  const pool=fakePool();
  const app=express();
  app.use(SYNTHETIC_RECEIPT_PATH,createStagingSyntheticReceiptRouter({pool,secret,now:()=>now}));
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const url="http://127.0.0.1:"+server.address().port+SYNTHETIC_RECEIPT_PATH;
  try{
    const pre=await fetch(url,{method:"OPTIONS",headers:{Origin:"null",
      "Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"Content-Type"}});
    assert.equal(pre.status,204);
    assert.equal(pre.headers.get("access-control-allow-origin"),"null");
    const invalid=await fetch(url,{method:"POST",headers:{Origin:"https://evil.example",
      "Content-Type":"application/json"},body:JSON.stringify(input)});
    assert.equal(invalid.status,403);
    const live=await fetch(url,{method:"POST",headers:{Origin:"null",
      "Content-Type":"application/json"},body:JSON.stringify(input)});
    assert.equal(live.status,202);
    assert.equal((await live.json()).result,"synthetic_referral_recorded");
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test("event hashes are deterministic for same staging shop and secret",()=>{
  const h=s=>createHmac("sha256",secret).update(shop+":"+s).digest("hex");
  assert.equal(h(input.event_id),h(input.event_id));
});
