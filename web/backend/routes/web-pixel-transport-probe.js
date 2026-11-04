/**
 * Browser CORS transport probe for the HashTopic DEVELOPMENT Web Pixel only.
 * No Shopify customer data, referral IDs, orders, cookies or persistence.
 *
 * This endpoint MUST be mounted before the general CORS middleware because
 * that middleware may answer OPTIONS without a matching ACAO header.
 *
 * A literal Origin: null is permitted only for this inert endpoint. It is NOT
 * an authentication signal, and cannot authorize an attribution event.
 */
import { Router } from "express";

const STAGING_HOST="https://hashtopic-postback-shopify-staging.onrender.com";
const STORE_ORIGIN="https://mystorefront-test.myshopify.com";
const PROBE_PATH="/api/staging/web-pixel-transport-probe";
const ALLOWED_ORIGINS=new Set(["null",STORE_ORIGIN]);

export function stagingPixelProbeEnabled(env=process.env){
  return env.SHOPIFY_APP_URL===STAGING_HOST &&
    env.WEB_PIXEL_STAGING_TRANSPORT_PROBE_ENABLED==="true";
}

export function probeOriginAllowed(value){
  return typeof value==="string" && ALLOWED_ORIGINS.has(value);
}

export function createStagingPixelTransportProbe(){
  const router=Router();
  router.use((req,res,next)=>{
    // This preflight does not issue any cookies or grant any client
    // authorization. It merely tests cross-origin connectivity.
    const origin=req.get("Origin");
    res.set("Cache-Control","no-store");
    res.set("Vary","Origin");
    if(!probeOriginAllowed(origin))return res.sendStatus(403);
    res.set("Access-Control-Allow-Origin",origin);
    res.set("Access-Control-Allow-Methods","POST, OPTIONS");
    res.set("Access-Control-Allow-Headers","Content-Type");
    res.set("Access-Control-Max-Age","60");
    return next();
  });
  router.options("/",(_req,res)=>res.status(204).end());
  router.post("/", (req,res)=>{
    // Require an empty body. No analytics or customer data can be ingested.
    if(req.headers["content-length"] &&
       req.headers["content-length"]!=="0")return res.status(400).json({
         status:"no_payload_allowed",
       });
    // Ignore content-type, do not parse the body, and close promptly.
    return res.status(204).end();
  });
  return router;
}

export const STAGING_PIXEL_PROBE_PATH=PROBE_PATH;
