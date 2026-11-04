/**
 * Strictly synthetic Web Pixel referral RECEIPT for the HashTopic test shop.
 * This route cannot receive real affiliate clicks or customer information,
 * create deliveries, notify MyStorefront, verify payments, or award commission.
 *
 * 'Origin: null' is a Shopify strict-sandbox transport allowance only;
 * it is NEVER an authentication mechanism. The only accepted payload is
 * namespaced synthetic test IDs with a short-lived staging database ledger.
 */
import { Router, json } from "express";
import { createHmac } from "node:crypto";

export const SYNTHETIC_RECEIPT_PATH="/api/staging/web-pixel-synthetic-referral";
const HOST="https://hashtopic-postback-shopify-staging.onrender.com";
const SHOP="mystorefront-test.myshopify.com";
const ORIGINS=new Set(["null","https://mystorefront-test.myshopify.com"]);
const ID_RX=/^test_(?:event|client)_[A-Za-z0-9_-]{6,64}$/;
const CLICK_RX=/^test_referral_[A-Za-z0-9_-]{6,64}$/;
const DAY_MS=86400000;

export function stagingSyntheticReceiptEnabled(env=process.env){
  try {
    const database=new URL(env.DATABASE_URL);
    return env.SHOPIFY_APP_URL===HOST &&
      database.pathname==="/mystorefront_postback_staging_db" &&
      env.WEB_PIXEL_STAGING_SYNTHETIC_RECEIPT_ENABLED==="true" &&
      typeof env.WEB_PIXEL_STAGING_RECEIPT_HASH_KEY==="string" &&
      env.WEB_PIXEL_STAGING_RECEIPT_HASH_KEY.length>=32;
  }catch{return false;}
}

export function validateSyntheticReferral(input,now=Date.now()){
  if(!input || typeof input!=="object" || Array.isArray(input) ||
     Object.keys(input).sort().join(",")!==
     "click_id,client_id,event_id,observed_at,shop,test_only,type")
    return false;
  const at=Date.parse(input.observed_at);
  return input.type==="synthetic_referral" && input.test_only===true &&
    input.shop===SHOP &&
    typeof input.client_id==="string" && ID_RX.test(input.client_id) &&
    input.client_id.startsWith("test_client_") &&
    typeof input.event_id==="string" && ID_RX.test(input.event_id) &&
    input.event_id.startsWith("test_event_") &&
    typeof input.click_id==="string" && CLICK_RX.test(input.click_id) &&
    typeof input.observed_at==="string" &&
    Number.isFinite(at) && Math.abs(now-at)<5*60000;
}

export const SYNTHETIC_RECEIPT_SCHEMA=`
CREATE TABLE IF NOT EXISTS web_pixel_staging_synthetic_receipts (
 shop TEXT NOT NULL CHECK(shop='mystorefront-test.myshopify.com'),
 event_hash CHAR(64) NOT NULL,
 client_hash CHAR(64) NOT NULL,
 click_hash CHAR(64) NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(shop,event_hash)
);
CREATE INDEX IF NOT EXISTS idx_staging_synthetic_receipts_received
 ON web_pixel_staging_synthetic_receipts(received_at);`;

export async function receiveSyntheticReferral({pool,secret,input,now=Date.now()}){
  if(!validateSyntheticReferral(input,now))return {status:400,body:{result:"invalid_test_payload",commission_created:false}};
  if(!pool || typeof pool.connect!=="function" || typeof secret!=="string"||secret.length<32)
    return {status:503,body:{result:"staging_unavailable",commission_created:false}};
  const digest=value=>createHmac("sha256",secret).update(SHOP+":"+value).digest("hex");
  let client;
  try{
    client=await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",[SHOP+":synthetic"]);
    await client.query(
      "DELETE FROM web_pixel_staging_synthetic_receipts WHERE shop=$1 AND received_at < NOW()-INTERVAL '24 hours'",
      [SHOP]);
    const {rows:counts}=await client.query(
      "SELECT count(*)::int AS n FROM web_pixel_staging_synthetic_receipts WHERE shop=$1",[SHOP]);
    if(!Number.isInteger(counts?.[0]?.n) || counts[0].n>=500)
      throw Error("synthetic_receipt_capacity");
    const {rows}=await client.query(
      `INSERT INTO web_pixel_staging_synthetic_receipts
       (shop,event_hash,client_hash,click_hash)
       VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING RETURNING event_hash`,
      [SHOP,digest(input.event_id),digest(input.client_id),digest(input.click_id)]);
    await client.query("COMMIT");
    return {status:202,body:{
      result:rows?.length===1?"synthetic_referral_recorded":"duplicate_ignored",
      commission_created:false,
    }};
  }catch{
    if(client)try{await client.query("ROLLBACK");}catch{}
    return {status:503,body:{result:"staging_unavailable",commission_created:false}};
  }finally{if(client)client.release();}
}

export function createStagingSyntheticReceiptRouter({pool,secret,now=()=>Date.now()}){
  const router=Router();
  const rates=new Map();
  // Staging-only, gated table creation. No production connection can pass
  // stagingSyntheticReceiptEnabled's exact app URL and DB-name checks.
  const ready=Promise.resolve().then(()=>pool.query(SYNTHETIC_RECEIPT_SCHEMA))
    .then(()=>true).catch(()=>false);
  router.use(async(_req,res,next)=>{
    if(!await ready)return res.status(503).json({
      result:"staging_unavailable",commission_created:false,
    });
    next();
  });
  router.use((req,res,next)=>{
    res.set({"Cache-Control":"no-store","Vary":"Origin"});
    const origin=req.get("Origin");
    if(!ORIGINS.has(origin))return res.sendStatus(403);
    res.set({
      "Access-Control-Allow-Origin":origin,
      "Access-Control-Allow-Methods":"POST, OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type",
      "Access-Control-Max-Age":"60",
    });
    next();
  });
  router.options("/",(_req,res)=>res.status(204).end());
  router.post("/",json({limit:"1kb",strict:true}),async(req,res)=>{
    const t=now();
    const ipHash=createHmac("sha256",secret).update(String(req.ip)).digest("hex");
    for(const [key,v] of rates)if(t-v.start>60000)rates.delete(key);
    const prior=rates.get(ipHash);
    if(prior && t-prior.start<60000){
      if(prior.count>=12)return res.status(429).json({result:"rate_limited",commission_created:false});
      prior.count++;
    }else rates.set(ipHash,{start:t,count:1});
    const result=await receiveSyntheticReferral({pool,secret,input:req.body,now:t});
    return res.status(result.status).json(result.body);
  });
  return router;
}
