import test from "node:test";
import assert from "node:assert/strict";
import {
  persistStagingReferral,lookupStagingCheckoutCandidate,reserveStagingReview,
} from "../backend/web-pixel-staging-ledger.js";

const shop="mystorefront-test.myshopify.com";
const clientHash="a".repeat(64);
const eventHash="b".repeat(64);
const time=Date.parse("2026-11-04T18:00:00Z");
function mockPool(handler) {
  const calls=[];
  let released=false;
  const pool={async connect(){return {
    async query(query,args=[]){
      calls.push({query,args});
      if(typeof handler==="function")return handler(query,args);
      return {rows:[]};
    },release(){released=true},
  }}};
  return {pool,calls,released:()=>released};
}

test("referral commits idempotent event and last-click upsert without commission",async()=>{
  const m=mockPool(q=>q.includes("RETURNING event_hash")?{rows:[{event_hash:eventHash}]}:{rows:[]});
  const res=await persistStagingReferral({
    pool:m.pool,shop,clientHash,eventHash,
    clickId:"test_referral_123456",occurredAt:"2026-11-04T17:50:00Z",nowMs:time,
  });
  assert.equal(res.status,"referral_observed");
  assert.equal(res.commission_created,false);
  assert.ok(m.calls.some(x=>x.query==="COMMIT"));
  assert.ok(m.calls.some(x=>x.query.includes("ON CONFLICT (shop,client_hash) DO UPDATE")));
  assert.ok(m.calls.some(x=>x.query.includes("pg_advisory_xact_lock")));
  assert.equal(m.released(),true);
});

test("duplicate event never mutates referral",async()=>{
  const m=mockPool(q=>q.includes("RETURNING event_hash")?{rows:[]}:{rows:[]});
  const d=await persistStagingReferral({
    pool:m.pool,shop,clientHash,eventHash,
    clickId:"test_referral_123456",occurredAt:"2026-11-04T17:50:00Z",nowMs:time,
  });
  assert.equal(d.status,"duplicate_ignored");
  assert.equal(m.calls.some(x=>x.query.includes("web_pixel_staging_referrals")),false);
});

test("matching checkout returns candidate only; missing referral no commission",async()=>{
  const m=mockPool(q=>{
    if(q.includes("RETURNING event_hash"))return {rows:[{event_hash:eventHash}]};
    if(q.includes("SELECT click_id,clicked_at"))return {rows:[{
      click_id:"test_referral_123456",clicked_at:"2026-11-04T17:50:00Z"}]};
    return {rows:[]};
  });
  const result=await lookupStagingCheckoutCandidate({
    pool:m.pool,shop,clientHash,eventHash:"c".repeat(64),
    orderId:"123456789",occurredAt:"2026-11-04T17:55:00Z",nowMs:time,
  });
  assert.equal(result.status,"candidate_only");
  assert.equal(result.commission_created,false);
  assert.equal(result.requires_order_verification,true);
  assert.equal(m.calls.some(x=>x.query.includes("INSERT INTO web_pixel_staging_checkout_candidates")),true);
  const absent=mockPool(q=>q.includes("RETURNING event_hash")?{rows:[{event_hash:eventHash}]}:{rows:[]});
  const none=await lookupStagingCheckoutCandidate({
    pool:absent.pool,shop,clientHash,eventHash:"c".repeat(64),
    orderId:"123456789",occurredAt:"2026-11-04T17:55:00Z",nowMs:time,
  });
  assert.equal(none.status,"checkout_unmatched");
});

test("review reservation checks legacy deliveries and enforces unique row",async()=>{
  const m=mockPool(q=>{
    if(q.includes("SELECT EXISTS"))return {rows:[{present:false}]};
    if(q.includes("RETURNING order_id"))return {rows:[{order_id:"123456789"}]};
    return {rows:[]};
  });
  const x=await reserveStagingReview({
    pool:m.pool,shop,orderId:"123456789",
    clickId:"test_referral_123456",confirmedTrustedChecks:true,
  });
  assert.equal(x.status,"pending_manual_review");
  assert.equal(x.commission_created,false);
  assert.ok(m.calls.some(q=>q.query.includes("ON CONFLICT DO NOTHING")));
  const duplicate=mockPool(q=>{
    if(q.includes("SELECT EXISTS"))return {rows:[{present:true}]};
    return {rows:[]};
  });
  const y=await reserveStagingReview({
    pool:duplicate.pool,shop,orderId:"123456789",
    clickId:"test_referral_123456",confirmedTrustedChecks:true,
  });
  assert.equal(y.status,"blocked_existing_delivery");
  assert.equal(duplicate.calls.some(q=>q.query.includes("INSERT INTO web_pixel_staging_order_review")),false);
});

test("rejects non-staging shops, untrusted review and DB failures fail closed",async()=>{
  const m=mockPool(()=>{throw Error("database unavailable")});
  await assert.rejects(persistStagingReferral({
    pool:m.pool,shop,clientHash,eventHash,
    clickId:"test_referral_123456",occurredAt:"2026-11-04T17:50:00Z",nowMs:time,
  }),/database unavailable/);
  assert.ok(m.calls.some(q=>q.query==="ROLLBACK"));
  assert.equal(m.released(),true);
  await assert.rejects(reserveStagingReview({
    pool:m.pool,shop,orderId:"123456789",clickId:"test_referral_123456",
  }),/Trusted staging verification required/);
  await assert.rejects(lookupStagingCheckoutCandidate({
    pool:m.pool,shop:"orphan-street-clothing-shop.myshopify.com",clientHash,eventHash,
    orderId:"123456789",occurredAt:"2026-11-04T17:55:00Z",nowMs:time,
  }),/Invalid staging checkout/);
});
