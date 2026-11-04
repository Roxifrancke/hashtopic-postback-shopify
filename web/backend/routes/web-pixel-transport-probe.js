/**
 * Inert test-only CORS handshake. This route does not parse a body or record
 * any customer, checkout, attribution or payment information.
 *
 * The string "null" in Origin is allowed only for this harmless probe. It is
 * NOT authentication and MUST NOT be copied to ingestion or order routes.
 */
import { Router } from "express";

export const STAGING_PIXEL_PROBE_PATH="/api/staging/web-pixel-transport-probe";
const STAGING_APP_URL="https://hashtopic-postback-shopify-staging.onrender.com";
const ALLOWED=new Set(["null","https://mystorefront-test.myshopify.com"]);

export function stagingPixelProbeEnabled(env=process.env){
  return env.SHOPIFY_APP_URL===STAGING_APP_URL &&
    env.WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED==="true";
}

export function createStagingPixelTransportProbe(){
  const router=Router();
  router.use((req,res,next)=>{
    const origin=req.get("Origin");
    res.set({"Cache-Control":"no-store","Vary":"Origin"});
    if(!ALLOWED.has(origin))return res.sendStatus(403);
    res.set({
      "Access-Control-Allow-Origin":origin,
      "Access-Control-Allow-Methods":"POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Max-Age":"60",
    });
    return next();
  });
  router.options("/",(_req,res)=>res.status(204).end());
  router.post("/",(req,res)=>{
    // Zero-payload requests only. Reject body-bearing framed requests
    // without buffering them, including chunked transfer encoding.
    const length=req.headers["content-length"];
    if((length!==undefined && length!=="0") || req.headers["transfer-encoding"])
      return res.status(400).json({status:"no_payload_allowed"});
    return res.status(204).end();
  });
  return router;
}
