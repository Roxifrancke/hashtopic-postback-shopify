import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  createStagingPixelTransportProbe,
  stagingPixelProbeEnabled,STAGING_PIXEL_PROBE_PATH,
} from "../backend/routes/web-pixel-transport-probe.js";

test("probe must match exact staging URL and explicit feature flag",()=>{
  assert.equal(stagingPixelProbeEnabled({}),false);
  assert.equal(stagingPixelProbeEnabled({
    SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com",
    WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED:"true",
  }),false);
  assert.equal(stagingPixelProbeEnabled({
    SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
    WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED:"true",
  }),true);
});

test("probe accepts empty sandbox-origin requests but nothing with a payload",async()=>{
  const app=express();
  app.use(STAGING_PIXEL_PROBE_PATH,createStagingPixelTransportProbe());
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const url="http://127.0.0.1:"+server.address().port+STAGING_PIXEL_PROBE_PATH;
  try{
    const options=await fetch(url,{method:"OPTIONS",headers:{
      Origin:"null","Access-Control-Request-Method":"POST",
      "Access-Control-Request-Headers":"Content-Type",
    }});
    assert.equal(options.status,204);
    assert.equal(options.headers.get("access-control-allow-origin"),"null");
    const valid=await fetch(url,{method:"POST",headers:{Origin:"null"}});
    assert.equal(valid.status,204);
    const storefront=await fetch(url,{method:"POST",headers:{
      Origin:"https://mystorefront-test.myshopify.com",
    }});
    assert.equal(storefront.status,204);
    const evil=await fetch(url,{method:"POST",headers:{Origin:"https://evil.example"}});
    assert.equal(evil.status,403);
    const noOrigin=await fetch(url,{method:"POST"});
    assert.equal(noOrigin.status,403);
    const payload=await fetch(url,{method:"POST",headers:{
      Origin:"null", "Content-Type":"text/plain",
    },body:"client_id=should-not-be-collected"});
    assert.equal(payload.status,400);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
