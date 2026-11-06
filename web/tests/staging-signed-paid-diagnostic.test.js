import test from "node:test";
import assert from "node:assert/strict";
import {
  stagingPaidOrderEvidence,logStagingSignedPaidOrderDiagnostic,
} from "../backend/staging-signed-paid-diagnostic.js";

const click="6b04d055-3f51-4a01-8064-ad869892b0d3";
const shop="mystorefront-test.myshopify.com";
const env={
  WEB_PIXEL_STAGING_ORDER_QUARANTINE:"true",
  SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
  DATABASE_URL:"postgres://masked@localhost/mystorefront_postback_staging_db",
};
const order={
  id:7278367473729,financial_status:"paid",cancelled_at:null,
  note_attributes:[{name:"MyStorefront click_id",value:click}],
  line_items:[{properties:[{name:"_MyStorefront click_id",value:click}]}],
  email:"customer-private@example.invalid",
};
const payload=value=>JSON.stringify(value);
test("signed test order is reported only as redacted agreement booleans",()=>{
  const logs=[];
  const verdict=logStagingSignedPaidOrderDiagnostic({
    shop,rawBody:payload(order),env,logger:{info:s=>logs.push(s)},
  });
  assert.deepEqual(verdict,{
    status:"signed_paid_referrals_consistent",paid:true,
    note_referral_present:true,line_referral_present:true,
    values_consistent:true,consent_eligible:false,
    can_send_postback:false,commission_created:false,
  });
  assert.equal(logs.length,1);
  assert.equal(logs[0].includes(click),false);
  assert.equal(logs[0].includes("customer-private"),false);
  assert.equal(logs[0].includes("7278367473729"),false);
});
test("conflicting or missing order referral cannot be reported as consistent",()=>{
  for(const change of [
    {note_attributes:[{name:"MyStorefront click_id",value:"00000000-0000-4000-8000-000000000000"}]},
    {note_attributes:[]},
    {financial_status:"pending"},
    {line_items:[]},
  ]){
    const verdict=stagingPaidOrderEvidence({shop,rawBody:payload({...order,...change}),env});
    assert.equal(verdict.status,"signed_paid_referrals_not_confirmed");
    assert.equal(verdict.can_send_postback,false);
    assert.equal(verdict.commission_created,false);
  }
});
test("fail closed for non-test order, another shop, or disabled quarantine",()=>{
  assert.equal(stagingPaidOrderEvidence({shop,rawBody:payload({...order,id:7278367473730}),env}),null);
  assert.equal(stagingPaidOrderEvidence({shop:"another.myshopify.com",rawBody:payload(order),env}),null);
  assert.equal(stagingPaidOrderEvidence({shop,rawBody:payload(order),
    env:{...env,WEB_PIXEL_STAGING_ORDER_QUARANTINE:"false"}}),null);
  assert.equal(stagingPaidOrderEvidence({shop,rawBody:"invalid-json",env}),null);
});
