import test from 'node:test';
import assert from 'node:assert/strict';
import { recordStagingSignedCheckoutToken } from '../backend/staging-pixel-paid-token.js';

const SHOP='mystorefront-test.myshopify.com';
const env={
  SHOPIFY_APP_URL:'https://hashtopic-postback-shopify-staging.onrender.com',
  DATABASE_URL:'postgres://user:password@localhost/mystorefront_postback_staging_db',
  WEB_PIXEL_STAGING_CANDIDATES_ENABLED:'true',
  WEB_PIXEL_STAGING_ORDER_QUARANTINE:'true',
};
const paid={id:7278367473729,checkout_token:'aabbccddeeff00112233445566778899',
  financial_status:'paid',cancelled_at:null};
test('HMAC-route helper stores only order and checkout token when fully quarantined',async()=>{
  const queries=[];
  const pool={query:async(sql,values)=>{
    queries.push({sql,values});
    return {rowCount:1};
  }};
  const result=await recordStagingSignedCheckoutToken({
    shop:SHOP,rawBody:JSON.stringify(paid),pool,env,
  });
  assert.equal(result.status,'recorded');
  assert.equal(queries.length,1);
  assert.deepEqual(queries[0].values,[SHOP,paid.checkout_token,String(paid.id)]);
  assert.doesNotMatch(queries[0].sql,/affiliate_orders|deliveries|commissions/);
});
test('rejects live stores, non-staging environments, unpaid and cancelled orders',async()=>{
  let writes=0;
  const pool={query:async()=>{writes++;return {rowCount:1};}};
  const cases=[
    {shop:'merchant.myshopify.com',rawBody:JSON.stringify(paid),env},
    {shop:SHOP,rawBody:JSON.stringify(paid),env:{...env,WEB_PIXEL_STAGING_ORDER_QUARANTINE:'false'}},
    {shop:SHOP,rawBody:JSON.stringify({...paid,financial_status:'pending'}),env},
    {shop:SHOP,rawBody:JSON.stringify({...paid,cancelled_at:'2026-11-06T11:00:00Z'}),env},
    {shop:SHOP,rawBody:JSON.stringify({...paid,checkout_token:null}),env},
  ];
  for(const c of cases){
    const response=await recordStagingSignedCheckoutToken({...c,pool});
    assert.ok(response.status==='disabled'||response.status==='invalid_order');
  }
  assert.equal(writes,0);
});
test('duplicate signed paid webhook is idempotent; conflicting checkout token rejected',async()=>{
  const pool={query:async(sql)=>sql.startsWith('INSERT')?
    {rowCount:0}:{rows:[{order_id:String(paid.id)}]}};
  assert.equal((await recordStagingSignedCheckoutToken({shop:SHOP,rawBody:JSON.stringify(paid),pool,env})).status,'duplicate');
  const conflict={query:async(sql)=>sql.startsWith('INSERT')?
    {rowCount:0}:{rows:[{order_id:'9999999999'}]}};
  assert.equal((await recordStagingSignedCheckoutToken({shop:SHOP,rawBody:JSON.stringify(paid),pool:conflict,env})).status,'conflict');
});
