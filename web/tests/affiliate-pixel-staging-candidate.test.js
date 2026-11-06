import test from 'node:test';
import assert from 'node:assert/strict';
import {
 validatePixelCandidate, acceptStagingPixelCandidate,
 stagingAffiliatePixelCandidateEnabled
} from '../backend/routes/affiliate-pixel-staging-candidate.js';

const shop='mystorefront-test.myshopify.com';
const id='6b04d055-3f51-4a01-8064-ad869892b0d3';
const checkout='aabbccddeeff00112233445566778899';
const candidate={shop,click_id:id,checkout_token:checkout,order_id:null,event_id:'event_101',type:'pixel_candidate'};
test('candidate endpoint is restricted to exact staging host, database and switch',()=>{
  const env={SHOPIFY_APP_URL:'https://hashtopic-postback-shopify-staging.onrender.com',DATABASE_URL:'postgres://x:y@localhost/mystorefront_postback_staging_db',WEB_PIXEL_STAGING_CANDIDATES_ENABLED:'true'};
  assert.equal(stagingAffiliatePixelCandidateEnabled(env),true);
  assert.equal(stagingAffiliatePixelCandidateEnabled({...env,DATABASE_URL:'postgres://x:y@localhost/production'}),false);
  assert.equal(stagingAffiliatePixelCandidateEnabled({...env,WEB_PIXEL_STAGING_CANDIDATES_ENABLED:'false'}),false);
});
test('rejects invented shop or malformed referral, checkout, order and event IDs',()=>{
  assert.equal(validatePixelCandidate(candidate),true);
  assert.equal(validatePixelCandidate({...candidate,order_id:'7278367473729'}),true);
  for(const c of [
    {...candidate,shop:'merchant.myshopify.com'},
    {...candidate,click_id:'bad'},
    {...candidate,checkout_token:'bad'},
    {...candidate,order_id:'gid://shopify/Order/12'},
    {...candidate,order_id:'0'},
    {...candidate,event_id:'bad event'},
    {...candidate,commission:100},
  ])assert.equal(validatePixelCandidate(c),false);
});
test('records only an unverified token candidate, never a delivery or commission',async()=>{
  const calls=[];
  const pool={query:async(sql,args)=>{
    calls.push({sql,args});
    return {rowCount:1,rows:[{checkout_token:checkout}]};
  }};
  const res=await acceptStagingPixelCandidate({pool,input:candidate});
  assert.equal(res.status,202);
  assert.equal(res.body.result,'unverified_candidate_recorded');
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/affiliate_pixel_staging_candidates/);
  assert.doesNotMatch(calls[0].sql,/affiliate_orders|deliveries|commissions/);
});
test('same checkout and click is idempotent and checkout_completed can add order ID',async()=>{
  const calls=[];
  const pool={query:async(sql,args)=>{
    calls.push({sql,args});
    return sql.startsWith('INSERT') ? {rowCount:0} :
      sql.startsWith('SELECT')?{rows:[{click_id:id,order_id:null}]}:{rowCount:1};
  }};
  const res=await acceptStagingPixelCandidate({pool,input:{...candidate,order_id:'7278367473729'}});
  assert.equal(res.body.result,'duplicate_ignored');
  assert.equal(calls.length,3);
  assert.match(calls[2].sql,/UPDATE affiliate_pixel_staging_candidates/);
});
test('conflicting browser event cannot rewrite checkout attribution',async()=>{
  const pool={query:async(sql)=>sql.startsWith('INSERT')?
    {rowCount:0}:{rows:[{click_id:id,order_id:null}]}};
  const conflict={...candidate,click_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
  assert.equal((await acceptStagingPixelCandidate({pool,input:conflict})).body.result,'conflicting_candidate_quarantined');
});
