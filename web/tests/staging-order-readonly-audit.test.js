import test from "node:test";
import assert from "node:assert/strict";
import {
  auditEnabled,auditOnePaidOrder,
  runStagingOrderAuditAtStartupOnce,resetOrderAuditForTests
} from "../backend/staging-order-readonly-audit.js";

const shop="mystorefront-test.myshopify.com";
const orderId="7276986433601";
const clickId="c84cc8f8-787a-40f2-8b3c-3e79e51e3001";
const now=()=>Date.parse("2026-11-05T08:15:00Z");
const env={
  WEB_PIXEL_STAGING_ORDER_AUDIT_ENABLED:"true",
  WEB_PIXEL_STAGING_ORDER_AUDIT_ONCE:"true",
  WEB_PIXEL_STAGING_ORDER_AUDIT_ID:orderId,
  SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
  DATABASE_URL:"postgres://user:masked@localhost/mystorefront_postback_staging_db",
  WEB_PIXEL_STAGING_BRIDGE_TOKEN:"test-only-random-credential-longer-than-forty-eight-characters",
  WEB_PIXEL_STAGING_BRIDGE_ENDPOINT:"https://lhzqnkrjqaebcfxcmlgd.supabase.co/functions/v1/staging-referral-proof-verify",
};
const token={
  accessToken:"test-only-not-real-token",
  accessTokenExpiresAt:new Date("2026-11-05T08:45:00Z"),
};
const order={
  id:Number(orderId),financial_status:"paid",cancelled_at:null,
  note_attributes:[{name:"MyStorefront click_id",value:clickId}],
  line_items:[{properties:[{name:"_MyStorefront click_id",value:clickId}]}],
};
const proof={
  status:"blocked",reason:"click_not_found",
  provenance_verified:false,can_send_postback:false,commission_created:false,
};
function adapters({
  shopifyOrder=order,tokenResponse=token,proofResult=proof,
  deliveryFound=false,shopifyResponseCode=200,
}={}){
  let count={admin:0,delivery:0,proof:0};
  return {
    count,
    getToken:async name=>{assert.equal(name,shop);return tokenResponse;},
    fetchImpl:async(url,request)=>{
      count.admin++;
      assert.equal(request.method,"GET");
      assert.equal(url,"https://"+shop+"/admin/api/2026-10/orders/"+orderId+".json");
      assert.equal(request.headers["X-Shopify-Access-Token"],token.accessToken);
      return {ok:shopifyResponseCode===200,status:shopifyResponseCode,json:async()=>({order:shopifyOrder})};
    },
    queryDelivery:async(name,id)=>{
      count.delivery++;
      assert.equal(name,shop);assert.equal(id,orderId);
      return deliveryFound;
    },
    createProofLookup:()=>async({shop:targetShop,clickId:targetClick})=>{
      count.proof++;
      assert.equal(targetShop,shop);assert.equal(targetClick,clickId);
      return proofResult;
    },
  };
}

test("only exact staging service, db, order and explicit flags may run",()=>{
  assert.equal(auditEnabled(env),true);
  for(const changes of [
    {WEB_PIXEL_STAGING_ORDER_AUDIT_ENABLED:"false"},
    {WEB_PIXEL_STAGING_ORDER_AUDIT_ONCE:"false"},
    {SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com"},
    {WEB_PIXEL_STAGING_ORDER_AUDIT_ID:"123456789"},
    {DATABASE_URL:"postgres://localhost/other_db"},
    {WEB_PIXEL_STAGING_BRIDGE_TOKEN:"short"},
  ]) assert.equal(auditEnabled({...env,...changes}),false);
});

test("paid synthetic order contains referral placements but has no trusted provenance",async()=>{
  const d=adapters();
  const result=await auditOnePaidOrder({env,...d,now});
  assert.equal(result.status,"audit_complete");
  assert.equal(result.paid,true);
  assert.equal(result.order_referral_present,true);
  assert.equal(result.provenance_verified,false);
  assert.equal(result.delivery_exists,false);
  assert.equal(result.consent_eligible,false);
  assert.equal(result.can_send_postback,false);
  assert.equal(result.commission_created,false);
  assert.deepEqual(d.count,{admin:1,proof:1,delivery:1});
  assert.equal(JSON.stringify(result).includes(clickId),false);
});

test("missing or unpaid order never consults proof or writes delivery",async()=>{
  for(const bad of [
    {...order,financial_status:"pending"},
    {...order,cancelled_at:"2026-11-05T08:10:00Z"},
    {...order,note_attributes:[]},
    {...order,line_items:[]},
    {...order,line_items:[{properties:[{name:"_MyStorefront click_id",value:"99999999-9999-4999-8999-999999999999"}]}]},
    {...order,id:12},
  ]){
    const d=adapters({shopifyOrder:bad});
    const result=await auditOnePaidOrder({env,...d,now});
    assert.notEqual(result.status,"audit_complete");
    assert.equal(result.can_send_postback,false);
    assert.equal(result.commission_created,false);
    assert.equal(d.count.proof,0);
    assert.equal(d.count.delivery,0);
  }
});

test("unknown or invalid provenance is not treated as verified",async()=>{
  const d=adapters({proofResult:{status:"blocked",provenance_verified:false}});
  const result=await auditOnePaidOrder({env,...d,now});
  assert.equal(result.status,"audit_complete");
  assert.equal(result.provenance_verified,false);
  assert.equal(result.commission_created,false);
});

test("no valid Shopify token or Shopify error fails closed",async()=>{
  const noToken=adapters({tokenResponse:null});
  assert.equal((await auditOnePaidOrder({env,...noToken,now})).status,"shopify_token_unavailable");
  assert.equal(noToken.count.admin,0);
  const failed=adapters({shopifyResponseCode:403});
  assert.equal((await auditOnePaidOrder({env,...failed,now})).status,"shopify_order_unavailable");
  assert.equal(failed.count.proof,0);
});

test("startup executes once and logs only whitelisted non-sensitive status",async()=>{
  resetOrderAuditForTests();
  let calls=0;
  const messages=[];
  const result=await runStagingOrderAuditAtStartupOnce({
    env,
    audit:async()=>{
      calls++;
      return {...await auditOnePaidOrder({env,...adapters(),now}),
        secret:"do-not-log-me",click_id:clickId};
    },
    logger:{info:s=>messages.push(s)},
  });
  assert.equal(result.started,true);
  assert.equal(result.status,"audit_complete");
  assert.equal(calls,1);
  assert.equal((await runStagingOrderAuditAtStartupOnce({env})).started,false);
  assert.equal(messages.length,1);
  assert.equal(messages[0].includes(clickId),false);
  assert.equal(messages[0].includes("do-not-log-me"),false);
});

test("read-only audit distinguishes malformed order attribute from valid line-item referral",async()=>{
  const audit=await auditOnePaidOrder({env,...adapters({shopifyOrder:{
    ...order,
    note_attributes:[{name:"MyStorefront click_id",value:clickId+"2."}],
  }}),now});
  assert.equal(audit.status,"order_referral_placements_inconsistent");
  assert.equal(audit.paid,true);
  assert.equal(audit.note_referral_present,true);
  assert.equal(audit.line_referral_present,true);
  assert.equal(audit.note_referral_uuid_valid,false);
  assert.equal(audit.line_referral_uuid_valid,true);
  assert.equal(audit.order_referral_values_match,false);
  assert.equal(audit.can_send_postback,false);
  assert.equal(audit.commission_created,false);
  assert.equal(JSON.stringify(audit).includes(clickId),false);
});

test("consistent order referral placements remain informational only",async()=>{
  const audit=await auditOnePaidOrder({env,...adapters(),now});
  assert.equal(audit.status,"audit_complete");
  assert.equal(audit.note_referral_uuid_valid,true);
  assert.equal(audit.line_referral_uuid_valid,true);
  assert.equal(audit.order_referral_values_match,true);
  assert.equal(audit.provenance_verified,false);
  assert.equal(audit.can_send_postback,false);
  assert.equal(audit.commission_created,false);
});
