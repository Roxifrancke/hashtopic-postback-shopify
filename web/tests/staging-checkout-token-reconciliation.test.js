import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStagingCheckoutToken } from '../backend/staging-checkout-token-reconciliation.js';

const shop='mystorefront-test.myshopify.com';
const token='aabbccddeeff00112233445566778899';
const order='7278367473729';
const baseRow={
  verified_order_id:order,
  paid_seen_at:'2026-11-06T10:00:00Z',
  untrusted_click_id:'6b04d055-3f51-4a01-8064-ad869892b0d3',
  untrusted_order_id:null,
  candidate_seen_at:'2026-11-06T09:59:00Z',
};
const nowMs=Date.parse('2026-11-06T10:05:00Z');
function db(row){return {query:async(sql,args)=>{
  assert.match(sql,/affiliate_pixel_staging_paid_orders/);
  assert.match(sql,/LEFT JOIN affiliate_pixel_staging_candidates/);
  assert.match(sql,/c.checkout_token = p.checkout_token/); // correspondence must be exact
  assert.deepEqual(args,[shop,token]);
  return {rows:row?[row]:[]};
}};}
async function run(row,opts={}) {
  const pool=db(row);
  return reconcileStagingCheckoutToken({pool,shop,checkoutToken:token,signedOrderId:order,nowMs,...opts});
}
test('a signed paid order and pixel candidate can be correlated by checkout token without order note attributes',async()=>{
  const out=await run(baseRow);
  assert.equal(out.status,'checkout_token_correlated_untrusted');
  assert.equal(out.can_send_postback,false);
  assert.equal(out.commission_created,false);
  assert.equal('click_id' in out,false);
});
test('missing signed paid order never matches',async()=>assert.equal((await run(null)).status,'signed_paid_order_not_recorded'));
test('signed paid order ID mismatch is blocked',async()=>{
  assert.equal((await run({...baseRow,verified_order_id:'7278367473730'})).status,'paid_order_conflict');
});
test('candidate reported order ID mismatch is blocked',async()=>{
  assert.equal((await run({...baseRow,untrusted_order_id:'7278367473730'})).status,'candidate_order_conflict');
});
test('missing candidate is not treated as a referral',async()=>{
  assert.equal((await run({...baseRow,untrusted_click_id:null})).status,'pixel_candidate_not_recorded');
});
test('expired evidence is not correlated',async()=>{
  assert.equal((await run({...baseRow,candidate_seen_at:'2026-09-01T00:00:00Z'})).status,'stale_or_invalid_evidence');
});
test('other store or invalid token cannot query database',async()=>{
  let queried=false;
  const pool={query:async()=>{queried=true;throw Error('should not query');}};
  const r=await reconcileStagingCheckoutToken({pool,shop:'brand.myshopify.com',checkoutToken:token,signedOrderId:order,nowMs});
  assert.equal(r.status,'invalid_input');
  assert.equal(queried,false);
});
test('database errors fail closed',async()=>{
  const r=await run(baseRow,{pool:{query:async()=>{throw Error('down');}}});
  assert.equal(r.status,'database_unavailable');
});
