import test from "node:test";
import assert from "node:assert/strict";
import {
  runStagingProofStartupOnce,resetStartupAttemptForTests
} from "../backend/staging-proof-startup.js";

const pass={
  status:"provenance_verified_pending_consent",provenance_verified:true,
  consent_eligible:false,can_send_postback:false,commission_created:false,
};
const env={WEB_PIXEL_STAGING_BRIDGE_STARTUP_ONCE:"true"};

test("disabled startup audit does nothing",async()=>{
  resetStartupAttemptForTests();
  let invoked=false;
  const result=await runStagingProofStartupOnce({
    env:{},audit:()=>{invoked=true;},logger:{info:()=>{}},
  });
  assert.equal(result.started,false);
  assert.equal(invoked,false);
});
test("success logs only sanitized provenance verdict and never repeats in same process",async()=>{
  resetStartupAttemptForTests();
  const logs=[];let runs=0;
  const opts={env,audit:async()=>{runs++;return {...pass,token:"must-not-log",click_id:"private"};},
    logger:{info:x=>logs.push(x)}};
  assert.deepEqual(await runStagingProofStartupOnce(opts),{
    started:true,status:"provenance_verified_pending_consent",
  });
  assert.equal((await runStagingProofStartupOnce(opts)).started,false);
  assert.equal(runs,1);
  assert.deepEqual(logs,["[STAGING PROOF AUDIT] provenance_verified_pending_consent"]);
  assert.equal(logs.join("").includes("private"),false);
});
test("all unexpected and thrown responses fail closed without logging secrets",async()=>{
  for(const audit of [
    async()=>({...pass,commission_created:true}),
    async()=>({...pass,consent_eligible:true}),
    async()=>({status:"blocked",reason:"TOKEN_NOT_FOR_LOGGING"}),
    async()=>{throw Error("SECRET_NOT_FOR_LOGGING");},
  ]){
    resetStartupAttemptForTests();
    const logs=[];
    const result=await runStagingProofStartupOnce({
      env,audit,logger:{info:x=>logs.push(x)},
    });
    assert.deepEqual(result,{started:true,status:"blocked"});
    assert.deepEqual(logs,["[STAGING PROOF AUDIT] blocked"]);
  }
});
