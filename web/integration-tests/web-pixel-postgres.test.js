/**
 * Real Postgres staging-ledger integration tests. Not run by the regular unit
 * tests and NEVER pointed at Render. Run in GitHub Actions ephemeral database.
 *
 * npm: WEB_PIXEL_TEST_DATABASE_URL=postgresql://pixel_test:pixel_test_password@127.0.0.1:5432/mystorefront_pixel_ci node --test integration-tests/web-pixel-postgres.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  persistStagingReferral,lookupStagingCheckoutCandidate,reserveStagingReview,
} from "../backend/web-pixel-staging-ledger.js";
import {
  cleanExpiredStagingPixelRecords,eraseStagingPixelClient,
} from "../backend/web-pixel-staging-retention.js";

const uri=process.env.WEB_PIXEL_TEST_DATABASE_URL;
if (!uri) throw Error("Refusing to run without WEB_PIXEL_TEST_DATABASE_URL");
const parsed=new URL(uri);
if (parsed.hostname!=="127.0.0.1" || parsed.pathname!=="/mystorefront_pixel_ci")
  throw Error("Refusing any non-local or non-CI PostgreSQL database");
const pool=new Pool({connectionString:uri,max:8,ssl:false});
const shop="mystorefront-test.myshopify.com";
const fixedNow=Date.parse("2026-11-04T18:00:00Z");
const h=(c)=>c.repeat(64);
let next=0;
const event=()=> (++next).toString(16).padStart(64,"0");
const referral=(overrides={})=>({
  pool,shop,clientHash:h("a"),eventHash:event(),
  clickId:"test_referral_123456",occurredAt:"2026-11-04T17:50:00Z",
  nowMs:fixedNow,...overrides,
});
const checkout=(overrides={})=>({
  pool,shop,clientHash:h("a"),eventHash:event(),
  orderId:"123456789",occurredAt:"2026-11-04T17:55:00Z",
  nowMs:fixedNow,...overrides,
});

async function reset(){
  await pool.query("TRUNCATE web_pixel_staging_referrals, web_pixel_staging_event_ids, web_pixel_staging_order_review, deliveries");
}

test.before(async()=>{
  const sql=await readFile(new URL("../prototypes/shopify-web-pixel/staging-ledger.schema.sql",import.meta.url),"utf8");
  // Test migration is intentionally read from reference file. It never runs
  // on Render or any externally accessible database.
  await pool.query(sql);
  await pool.query(`CREATE TABLE IF NOT EXISTS deliveries (
    shop TEXT NOT NULL, order_id TEXT NOT NULL
  )`);
});
test.after(async()=>{await pool.end()});

test("real PostgreSQL: event replay is idempotent and newest referral wins",async()=>{
  await reset();
  const first=referral();
  assert.equal((await persistStagingReferral(first)).status,"referral_observed");
  assert.equal((await persistStagingReferral(first)).status,"duplicate_ignored");
  const older=referral({clickId:"test_referral_OLDER",occurredAt:"2026-11-04T17:45:00Z"});
  await persistStagingReferral(older);
  const current=await pool.query("SELECT click_id FROM web_pixel_staging_referrals WHERE shop=$1",[shop]);
  assert.equal(current.rows[0].click_id,"test_referral_123456");
  const newer=referral({clickId:"test_referral_NEWER",occurredAt:"2026-11-04T17:52:00Z"});
  await persistStagingReferral(newer);
  const d=await lookupStagingCheckoutCandidate(checkout());
  assert.equal(d.status,"candidate_only");
  assert.equal(d.click_id,"test_referral_NEWER");
  assert.equal(d.commission_created,false);
});

test("real PostgreSQL: concurrent duplicate referral submissions store one event",async()=>{
  await reset();
  const input=referral();
  const results=await Promise.all(Array.from({length:12},()=>persistStagingReferral(input)));
  assert.equal(results.filter(x=>x.status==="referral_observed").length,1);
  assert.equal(results.filter(x=>x.status==="duplicate_ignored").length,11);
  const count=await pool.query("SELECT count(*)::int AS n FROM web_pixel_staging_event_ids");
  assert.equal(count.rows[0].n,1);
});

test("real PostgreSQL: checkout cannot match missing, future or expired referrals",async()=>{
  await reset();
  assert.equal((await lookupStagingCheckoutCandidate(checkout())).status,"checkout_unmatched");
  await persistStagingReferral(referral());
  assert.equal((await lookupStagingCheckoutCandidate(checkout({
    occurredAt:"2026-11-04T17:49:00Z",
  }))).status,"checkout_unmatched");
  assert.equal((await lookupStagingCheckoutCandidate(checkout({
    nowMs:Date.parse("2026-12-10T17:55:00Z"),
    occurredAt:"2026-12-10T17:55:00Z",
  }))).status,"checkout_unmatched");
});

test("real PostgreSQL: unique manual review and legacy delivery block",async()=>{
  await reset();
  const input={pool,shop,orderId:"123456789",clickId:"test_referral_123456",confirmedTrustedChecks:true};
  const answers=await Promise.all(Array.from({length:8},()=>reserveStagingReview(input)));
  assert.equal(answers.filter(x=>x.status==="pending_manual_review").length,1);
  assert.equal(answers.filter(x=>x.status==="duplicate_review_ignored").length,7);
  const count=await pool.query("SELECT count(*)::int AS n FROM web_pixel_staging_order_review");
  assert.equal(count.rows[0].n,1);
  await pool.query("INSERT INTO deliveries(shop,order_id) VALUES($1,$2)",[shop,"987654321"]);
  const blocked=await reserveStagingReview({...input,orderId:"987654321"});
  assert.equal(blocked.status,"blocked_existing_delivery");
  assert.equal(blocked.commission_created,false);
});

test("real PostgreSQL: erasure and retention delete only expected staging rows",async()=>{
  await reset();
  await persistStagingReferral(referral());
  const erased=await eraseStagingPixelClient({pool,clientHash:h("a")});
  assert.equal(erased.referrals_removed,1);
  await pool.query(`INSERT INTO web_pixel_staging_referrals
    (shop,client_hash,click_id,clicked_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`,[
    shop,h("b"),"test_referral_expired",
    new Date("2026-09-01T00:00:00Z"),new Date("2026-10-01T00:00:00Z"),
  ]);
  await pool.query(`INSERT INTO web_pixel_staging_order_review(shop,order_id,click_id,reviewed_at)
    VALUES($1,$2,$3,$4)`,[shop,"222222222","test_referral_expired",new Date("2026-10-01T00:00:00Z")]);
  const cleaned=await cleanExpiredStagingPixelRecords({
    pool,now:new Date("2026-11-04T18:00:00Z"),batchSize:100,
  });
  assert.equal(cleaned.referrals,1);
  assert.equal(cleaned.reviews,1);
  assert.equal(cleaned.commission_created,false);
});
