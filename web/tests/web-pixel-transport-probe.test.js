import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  stagingPixelProbeEnabled,probeOriginAllowed,
  createStagingPixelTransportProbe,STAGING_PIXEL_PROBE_PATH,
} from "../backend/routes/web-pixel-transport-probe.js";

test("transport probe is off unless exact staging URL and flag are present",()=>{
  assert.equal(stagingPixelProbeEnabled({}),false);
  assert.equal(stagingPixelProbeEnabled({
    SHOPIFY_APP_URL:"https://mystorefront-postback.onrender.com",
    WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED:"true",
  }),false);
  assert.equal(stagingPixelProbeEnabled({
    SHOPIFY_APP_URL:"https://hashtopic-postback-shopify-staging.onrender.com",
    WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED:"true",
  }),true);
  assert.equal(probeOriginAllowed("null"),true);
  assert.equal(probeOriginAllowed("https://mystorefront-test.myshopify.com"),true);
  assert.equal(probeOriginAllowed("https://evil.example"),false);
});

test("HTTP preflight and empty POST test sandbox transport, deny untrusted origins",async()=>{
  const app=express();
  app.use(STAGING_PIXEL_PROBE_PATH,createStagingPixelTransportProbe());
  const server=app.listen(0,"127.0.0.1");
  await new Promise(resolve=>server.once("listening",resolve));
  const url="http://127.0.0.1:"+server.address().port+STAGING_PIXEL_PROBE_PATH;
  try {
    const preflight=await fetch(url,{method:"OPTIONS",headers:{
      Origin:"null",
      "Access-Control-Request-Method":"POST",
      "Access-Control-Request-Headers":"Content-Type",
    }});
    assert.equal(preflight.status,204);
    assert.equal(preflight.headers.get("access-control-allow-origin"),"null");
    const posted=await fetch(url,{method:"POST",headers:{Origin:"null"}});
    assert.equal(posted.status,204);
    const bad=await fetch(url,{method:"POST",headers:{Origin:"https://evil.example"}});
    assert.equal(bad.status,403);
    const body=await fetch(url,{method:"POST",headers:{
      Origin:"null","Content-Type":"text/plain",
    },body:"email=do-not-collect"});
    assert.equal(body.status,400);
    const noOrigin=await fetch(url,{method:"POST"});
    assert.equal(noOrigin.status,403);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
