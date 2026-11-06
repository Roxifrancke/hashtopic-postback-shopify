import test from "node:test";
import assert from "node:assert/strict";
import { createStagingProofBridgeLookup } from "../backend/web-pixel-staging-proof-bridge.js";
import { verifyBridgeAuditConfig,runBridgeProofAudit } from "../scripts/staging-proof-bridge-audit.mjs";

const endpoint="https://lhzqnkrjqaebcfxcmlgd.supabase.co/functions/v1/staging-referral-proof-verify";
const token="local-only-test-token-example-000000000000000000000000";
const clickId="11111111-1111-4111-8111-111111111111";
const shop="mystorefront-test.myshopify.com";
const fixedNow=()=>Date.parse("2026-11-05T06:00:00Z");
const verified={
  status:"click_record_verified_pending_consent",
  clicked_at:"2026-11-05T05:00:00Z",
  provenance_verified:true,
  consent_eligible:false,can_send_postback:false,commission_created:false,
};
const validConfig={
  SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
  DATABASE_URL:"postgresql://test:masked@local/mystorefront_postback_staging_db",
  WEB_PIXEL_STAGING_BRIDGE_AUDIT_ENABLED:"true",
  WEB_PIXEL_STAGING_AUDIT_CLICK_ID:clickId,
  WEB_PIXEL_STAGING_BRIDGE_ENDPOINT:endpoint,
  WEB_PIXEL_STAGING_BRIDGE_TOKEN:token,
};

test("bridge client accepts only the designated Supabase function",()=>{
  for(const invalid of [
    "https://other.supabase.co/functions/v1/staging-referral-proof-verify",
    endpoint+"?foo=bar",
    "http://lhzqnkrjqaebcfxcmlgd.supabase.co/functions/v1/staging-referral-proof-verify",
    "https://lhzqnkrjqaebcfxcmlgd.supabase.co/rest/v1/affiliate_click_proofs",
  ])assert.throws(()=>createStagingProofBridgeLookup({endpoint:invalid,token}));
});
test("only a fully consent-blocked proven referral is accepted",async()=>{
  const calls=[];
  const lookup=createStagingProofBridgeLookup({endpoint,token,now:fixedNow,fetchImpl:async(url,req)=>{
    calls.push({url,req});
    return {ok:true,json:async()=>verified};
  }});
  assert.deepEqual(await lookup({shop,clickId}),verified);
  assert.equal(calls.length,1);
  assert.equal(calls[0].req.method,"POST");
  assert.equal(calls[0].req.redirect,"error");
  assert.equal(calls[0].req.headers.Authorization,"Bearer "+token);
  assert.equal(calls[0].url,endpoint);
  assert.equal((await lookup({shop:"wrong.myshopify.com",clickId})).status,"blocked");
  assert.equal(calls.length,1);
});
test("forged eligibility, malformed response, HTTP failure and network errors fail closed",async()=>{
  const cases=[
    {ok:true,json:async()=>({...verified,can_send_postback:true})},
    {ok:true,json:async()=>({...verified,consent_eligible:true})},
    {ok:true,json:async()=>({...verified,provenance_verified:false})},
    {ok:true,json:async()=>({...verified,commission_created:true})},
    {ok:true,json:async()=>({...verified,clicked_at:"not-a-date"})},
    {ok:true,json:async()=>({...verified,clicked_at:"2026-08-01T00:00:00Z"})},
    {ok:true,json:async()=>({...verified,clicked_at:"2099-01-01T00:00:00Z"})},
    {ok:false,json:async()=>verified},
  ];
  for(const response of cases){
    const lookup=createStagingProofBridgeLookup({endpoint,token,now:fixedNow,fetchImpl:async()=>response});
    const result=await lookup({shop,clickId});
    assert.equal(result.status,"blocked");
    assert.equal(result.can_send_postback,false);
    assert.equal(result.commission_created,false);
  }
  const failed=createStagingProofBridgeLookup({endpoint,token,fetchImpl:async()=>{throw Error("secret");}});
  assert.equal((await failed({shop,clickId})).status,"blocked");
});
test("audit is locked to staging service and explicit opt-in",()=>{
  assert.equal(verifyBridgeAuditConfig(validConfig).ready,true);
  assert.equal(verifyBridgeAuditConfig({...validConfig,SHOPIFY_APP_URL:"https://production.onrender.com"}).ready,false);
  assert.equal(verifyBridgeAuditConfig({...validConfig,WEB_PIXEL_STAGING_BRIDGE_AUDIT_ENABLED:"false"}).ready,false);
  assert.equal(verifyBridgeAuditConfig({...validConfig,DATABASE_URL:"postgresql://test@local/production"}).ready,false);
});
test("audit proves issuance only, and never leaks secrets",async()=>{
  const pass=await runBridgeProofAudit({env:validConfig,lookupFactory:()=>async()=>verified});
  assert.equal(pass.status,"provenance_verified_pending_consent");
  assert.equal(pass.consent_eligible,false);
  assert.equal(pass.can_send_postback,false);
  assert.equal(pass.commission_created,false);
  const fail=await runBridgeProofAudit({env:validConfig,lookupFactory:()=>async()=>({status:"blocked"})});
  assert.equal(fail.status,"blocked");
  assert.equal(JSON.stringify(fail).includes(token),false);
  assert.equal(JSON.stringify(pass).includes(clickId),false);
});

test("proof audit preserves only known bridge failure codes",async()=>{
  for(const [inputReason,expected] of [
    ["bridge_unavailable","bridge_unavailable"],
    ["bridge_rejected","bridge_rejected"],
    ["invalid_bridge_response","invalid_bridge_response"],
    ["credential-s3cr3t","verification_failed"],
  ]){
    const result=await runBridgeProofAudit({
      env:validConfig,
      lookupFactory:()=>async()=>({status:"blocked",reason:inputReason,
        can_send_postback:false,commission_created:false}),
    });
    assert.equal(result.status,"blocked");
    assert.equal(result.reason,expected);
    assert.equal(result.can_send_postback,false);
    assert.equal(result.commission_created,false);
  }
});
