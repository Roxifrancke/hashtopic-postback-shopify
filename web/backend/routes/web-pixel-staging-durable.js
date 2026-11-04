/**
 * Experimental durable Shopify Pixel staging receiver.
 *
 * Must be explicitly enabled by the STAGING service (never production).
 * Browser observations are untrusted and are never proof of a paid order.
 * Does not send postbacks, modify existing deliveries or issue commissions.
 */
import { Router, json } from "express";
import { createHmac } from "node:crypto";
import {
  persistStagingReferral, lookupStagingCheckoutCandidate,
} from "../web-pixel-staging-ledger.js";
import { normalizeShopifyOrderId } from "../web-pixel-order-verification.js";

const SHOP="mystorefront-test.myshopify.com";
const ORIGIN="https://mystorefront-test.myshopify.com";
const RX=/^[A-Za-z0-9_-]{8,128}$/;
const EVENT_RX=/^[A-Za-z0-9_-]{8,200}$/;
const MAX_AGE_MS=30*86400000;

export function durableStagingEnabled(env=process.env){
  return env.WEB_PIXEL_STAGING_RECEIVER_ENABLED==="true" &&
    env.WEB_PIXEL_STAGING_PERSISTENCE_ENABLED==="true" &&
    env.SHOPIFY_APP_URL==="https://hashtopic-postback-shopify-staging.onrender.com" &&
    typeof env.WEB_PIXEL_STAGING_HASH_KEY==="string" &&
    env.WEB_PIXEL_STAGING_HASH_KEY.length>=32;
}

export async function observeDurableStagingPixel({
  input,origin,pool,secret,nowMs=Date.now(),
}) {
  const reject=(status,reason)=>({httpStatus:status,body:{status:reason,commission_created:false}});
  if(origin!==ORIGIN)return reject(403,"origin_not_allowed");
  if(!pool || typeof pool.connect!=="function" || typeof secret!=="string"||secret.length<32)
    return reject(503,"staging_not_configured");
  // The Origin header is NOT authentication. Untrusted browser claims can at
  // most create candidate records, never verified orders or commissions.
  if(!input || Object.getPrototypeOf(input)!==Object.prototype ||
     input.shop!==SHOP || !["referral","checkout"].includes(input.type) ||
     typeof input.event_id!=="string" || !EVENT_RX.test(input.event_id) ||
     typeof input.client_id!=="string" || !RX.test(input.client_id) ||
     typeof input.occurred_at!=="string" ||
     Object.keys(input).some(k=>!["shop","type","event_id","client_id","occurred_at","click_id","order_id"].includes(k)))
    return reject(400,"invalid_observation");
  const at=Date.parse(input.occurred_at);
  if(!Number.isFinite(at)||!Number.isFinite(nowMs)||at>nowMs+60000||nowMs-at>MAX_AGE_MS)
    return reject(400,"invalid_event_time");
  if(input.type==="referral" &&
    (typeof input.click_id!=="string"||!RX.test(input.click_id)||input.order_id!==undefined))
    return reject(400,"invalid_referral");
  const orderId=input.type==="checkout"?normalizeShopifyOrderId(input.order_id):null;
  if(input.type==="checkout"&&(!orderId||input.click_id!==undefined))
    return reject(400,"invalid_checkout");
  const hash=(s)=>createHmac("sha256",secret).update(SHOP+":"+s).digest("hex");
  try {
    const args={
      pool,shop:SHOP,clientHash:hash(input.client_id),
      eventHash:hash(input.event_id),
      occurredAt:input.occurred_at,nowMs,
    };
    const result=input.type==="referral"
      ?await persistStagingReferral({...args,clickId:input.click_id})
      :await lookupStagingCheckoutCandidate({...args,orderId});
    // Do not return client hashes or click IDs to browser, even on matching.
    return {httpStatus:202,body:{
      status:result.status,
      commission_created:false,
      requires_shopify_paid_order_verification:result.status==="candidate_only",
    }};
  } catch {
    return reject(503,"staging_ledger_unavailable");
  }
}

export function createDurableStagingPixelRouter({pool,secret,now=()=>Date.now()}){
  const router=Router();
  // Development-only endpoint. The staging app's existing global CORS
  // middleware must also include the test origin in its staging allowlist.
  router.options("/",(req,res)=>{
    if(req.headers.origin!==ORIGIN)return res.sendStatus(403);
    return res.set({
      "Access-Control-Allow-Origin":ORIGIN,
      "Access-Control-Allow-Methods":"POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      "Vary":"Origin",
    }).sendStatus(204);
  });
  router.post("/",json({limit:"2kb",strict:true}),async(req,res)=>{
    const result=await observeDurableStagingPixel({
      input:req.body,origin:req.headers.origin,pool,secret,nowMs:now(),
    });
    if(req.headers.origin===ORIGIN)res.set({
      "Access-Control-Allow-Origin":ORIGIN,"Vary":"Origin",
    });
    return res.status(result.httpStatus).set("Cache-Control","no-store").json(result.body);
  });
  return router;
}
