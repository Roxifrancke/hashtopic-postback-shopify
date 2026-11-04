import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanExpiredStagingPixelRecords,eraseStagingPixelClient,
} from "../backend/web-pixel-staging-retention.js";

function mockPool(handler){
  const calls=[]; let released=false;
  const pool={async connect(){return {
    async query(sql,args){calls.push({sql,args});return handler(sql,args);},
    release(){released=true;},
  }}};
  return {pool,calls,released:()=>released};
}

test("cleanup deletes only bounded rows from staging tables",async()=>{
  const m=mockPool((sql)=>({rowCount:sql.includes("staging_referrals")?3:sql.includes("event_ids")?5:1}));
  const now=new Date("2026-11-04T18:00:00Z");
  const result=await cleanExpiredStagingPixelRecords({pool:m.pool,now,batchSize:100});
  assert.deepEqual(result,{referrals:3,events:5,reviews:1,commission_created:false});
  assert.equal(m.calls.length,3);
  assert.ok(m.calls.every(c=>c.sql.includes("web_pixel_staging_")));
  assert.ok(m.calls.every(c=>c.args[0]==="mystorefront-test.myshopify.com"));
  assert.ok(m.calls.every(c=>c.args[2]===100));
  assert.equal(m.released(),true);
});

test("cleanup has bounded batch and rejects invalid dates",async()=>{
  const m=mockPool(()=>({rowCount:0}));
  await assert.rejects(cleanExpiredStagingPixelRecords({pool:m.pool,batchSize:10000}),/Invalid/);
  await assert.rejects(cleanExpiredStagingPixelRecords({pool:m.pool,now:new Date("x")}),/Invalid/);
  assert.equal(m.calls.length,0);
});

test("cleanups fail closed if DB fails but release connection",async()=>{
  const m=mockPool(()=>{throw Error("db offline")});
  await assert.rejects(cleanExpiredStagingPixelRecords({pool:m.pool}),/db offline/);
  assert.equal(m.released(),true);
});

test("erasure deletes only a single pseudonymous HashTopic referral",async()=>{
  const m=mockPool(()=>({rowCount:1}));
  const out=await eraseStagingPixelClient({pool:m.pool,clientHash:"a".repeat(64)});
  assert.equal(out.referrals_removed,1);
  assert.equal(out.commission_created,false);
  assert.equal(m.calls.length,1);
  assert.equal(m.calls[0].args[0],"mystorefront-test.myshopify.com");
  assert.equal(m.calls[0].args[1],"a".repeat(64));
  assert.equal(m.released(),true);
  await assert.rejects(eraseStagingPixelClient({
    pool:m.pool,shop:"orphan-street-clothing-shop.myshopify.com",clientHash:"a".repeat(64)
  }),/Invalid/);
});
