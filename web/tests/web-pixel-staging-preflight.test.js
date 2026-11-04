import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePixelStagingReadiness} from "../backend/web-pixel-staging-preflight.js";
const shop="mystorefront-test.myshopify.com";
const matchingBrand={id:"11111111-1111-4111-8111-111111111111",website_url:shop,store_url:null};
const mismatchedBrand={id:"11111111-1111-4111-8111-111111111111",website_url:"mystorefront-test-2.myshopify.com",store_url:null};

test("preflight defaults to blocked and never enables production or commissions",()=>{
  const result=evaluatePixelStagingReadiness();
  assert.equal(result.ready,false);
  assert.ok(result.blockers.includes("brand_shop_matches"));
  assert.equal(result.production_enabled,false);
  assert.equal(result.commissions_enabled,false);
});

test("real HashTopic brand mapping mismatch remains an explicit blocker",()=>{
  const result=evaluatePixelStagingReadiness({shop,brand:mismatchedBrand});
  assert.equal(result.checks.brand_shop_matches,false);
  assert.equal(result.ready,false);
});

test("missing consent or order idempotency prevents activation",()=>{
  const complete={
    shop,brand:matchingBrand,shopifyPixelActivated:true,
    extensionPurposesVerified:true,consentBehaviorVerified:true,
    testDatabaseMigrated:true,retentionJobVerified:true,
    pixelDeliveryTested:true,trustedClickAdapterTested:true,
    signedPaidWebhookTested:true,duplicateOrderPathTested:true,
    destinationIdempotencyTested:true,
  };
  assert.equal(evaluatePixelStagingReadiness(complete).ready,true);
  assert.equal(evaluatePixelStagingReadiness({...complete,consentBehaviorVerified:false}).ready,false);
  assert.equal(evaluatePixelStagingReadiness({...complete,destinationIdempotencyTested:false}).ready,false);
  assert.equal(evaluatePixelStagingReadiness({...complete,shop:"another.myshopify.com"}).ready,false);
});
