import test from "node:test";
import assert from "node:assert/strict";
import { runStagingReadOnlyAudit,stagingAuditConfiguration } from "../scripts/staging-trusted-referral-audit.mjs";

const valid={
  SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
  DATABASE_URL:"postgresql://user:masked@internal/mystorefront_postback_staging_db",
  WEB_PIXEL_STAGING_READONLY_AUDIT_ENABLED:"true",
  WEB_PIXEL_STAGING_AUDIT_CLICK_ID:"11111111-1111-4111-8111-111111111111",
  WEB_PIXEL_STAGING_SUPABASE_URL:"https://exampleproject.supabase.co/",
  WEB_PIXEL_STAGING_SUPABASE_READ_KEY:"test-scoped-credential-only-not-an-actual-key-123456",
};

test("cannot enable audit outside the exact staging host and database",()=>{
  assert.equal(stagingAuditConfiguration({}).ready,false);
  assert.equal(stagingAuditConfiguration(valid).ready,true);
  assert.equal(stagingAuditConfiguration({...valid,SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com"}).ready,false);
  assert.equal(stagingAuditConfiguration({...valid,DATABASE_URL:"postgresql://x:masked@internal/mystorefront_postback_db"}).ready,false);
  assert.equal(stagingAuditConfiguration({...valid,WEB_PIXEL_STAGING_READONLY_AUDIT_ENABLED:"false"}).ready,false);
  assert.equal(stagingAuditConfiguration({...valid,WEB_PIXEL_STAGING_AUDIT_CLICK_ID:"test_referral_123456"}).ready,false);
});

test("missing configuration never contacts MyStorefront",async()=>{
  let invoked=false;
  const result=await runStagingReadOnlyAudit({env:{},lookupFactory:()=>{
    invoked=true;
    throw Error("should not happen");
  }});
  assert.equal(result.status,"blocked");
  assert.equal(result.commission_created,false);
  assert.equal(invoked,false);
});

test("verified referral returns only sanitized, nonpayable decision",async()=>{
  let called=false;
  const outcome=await runStagingReadOnlyAudit({
    env:valid,
    lookupFactory:({supabaseUrl,serviceKey})=>{
      assert.equal(supabaseUrl,valid.WEB_PIXEL_STAGING_SUPABASE_URL);
      assert.equal(serviceKey,valid.WEB_PIXEL_STAGING_SUPABASE_READ_KEY);
      return async ({shop,clickId})=>{
        called=true;
        assert.equal(shop,"mystorefront-test.myshopify.com");
        assert.equal(clickId,valid.WEB_PIXEL_STAGING_AUDIT_CLICK_ID);
        return {status:"click_record_verified_pending_consent",clicked_at:"2026-11-04T18:00:00.000Z"};
      };
    },
  });
  assert.equal(called,true);
  assert.deepEqual(outcome,{
    status:"verified_pending_consent",reason:null,
    commission_created:false,can_send_postback:false,
  });
  assert.equal(JSON.stringify(outcome).includes(valid.WEB_PIXEL_STAGING_AUDIT_CLICK_ID),false);
  assert.equal(JSON.stringify(outcome).includes(valid.WEB_PIXEL_STAGING_SUPABASE_READ_KEY),false);
});

test("lookup fails closed with no sensitive details",async()=>{
  for(const lookupFactory of [
    ()=>async()=>({status:"blocked",reason:"click_invalid"}),
    ()=>async()=>{throw Error("SECRET_ADMIN_TOKEN_SHOULD_NOT_LEAK");},
  ]){
    const r=await runStagingReadOnlyAudit({env:valid,lookupFactory});
    assert.equal(r.status,"blocked");
    assert.equal(r.commission_created,false);
    assert.equal(r.can_send_postback,false);
    assert.equal(JSON.stringify(r).includes("SECRET_ADMIN_TOKEN"),false);
  }
});
