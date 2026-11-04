/**
 * STAGING ONLY. Web Pixel events are UNSIGNED, UNTRUSTED browser observations.
 * Never use these events directly to issue a commission or mark an order paid.
 * No secrets belong in a Web Pixel extension.
 */
import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeShopifyOrderId } from "../web-pixel-order-verification.js";

const TEST_SHOP = "mystorefront-test.myshopify.com";
const MAX_AGE = 30 * 86400000;
const MAX_EVENTS = 2500;
const MAX_REQUESTS_PER_MINUTE = 30;
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_RE = /^[A-Za-z0-9_-]{8,200}$/;

const jsonResponse = (res, status, payload) => res.status(status)
  .set("Cache-Control","no-store").json(payload);

export function isStagingPixelReceiverEnabled(env = process.env) {
  return env.WEB_PIXEL_STAGING_RECEIVER_ENABLED === "true" &&
    env.SHOPIFY_APP_URL === "https://hashtopic-postback-shopify-staging.onrender.com" &&
    typeof env.WEB_PIXEL_STAGING_HASH_KEY === "string" &&
    env.WEB_PIXEL_STAGING_HASH_KEY.length >= 32;
}

export function createStagingPixelHandler({
  now = () => Date.now(), secret, allowedOrigin = "https://mystorefront-test.myshopify.com",
} = {}) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("Staging pixel requires a strong secret");
  const records = new Map();
  const seen = new Map();
  const rates = new Map();
  const digest = value => createHmac("sha256",secret).update(value).digest("hex");
  const sameHash = (a,b) => {
    const x=Buffer.from(a,"hex"), y=Buffer.from(b,"hex");
    return x.length === y.length && timingSafeEqual(x,y);
  };
  function prune(t) {
    for(const [k,v] of records) if (t-v.seenAt>MAX_AGE) records.delete(k);
    for(const [k,v] of seen) if (t-v>MAX_AGE) seen.delete(k);
    for(const [k,v] of rates) if (t-v.since>60000) rates.delete(k);
    while (records.size>MAX_EVENTS) records.delete(records.keys().next().value);
    while (seen.size>MAX_EVENTS*2) seen.delete(seen.keys().next().value);
  }

  function observe(input, origin, ip = "unknown") {
    const t=now();
    prune(t);
    // Origin is an abuse filter, NOT trusted authentication. Even accepted
    // browser events must be corroborated by Shopify's independently fetched order.
    if (origin !== allowedOrigin) return { code:403, body:{status:"origin_not_allowed"} };
    const ipHash=digest(ip);
    const rate=rates.get(ipHash);
    if(rate && t-rate.since<60000) {
      if(rate.count>=MAX_REQUESTS_PER_MINUTE) return {code:429,body:{status:"rate_limited"}};
      rate.count++;
    } else rates.set(ipHash,{since:t,count:1});
    if (!input || input.shop !== TEST_SHOP || !["referral","checkout"].includes(input.type) ||
      typeof input.event_id !== "string" || !EVENT_RE.test(input.event_id) ||
      typeof input.client_id !== "string" || !ID_RE.test(input.client_id) ||
      typeof input.occurred_at !== "string" ||
      Object.keys(input).some(k=>!["shop","type","event_id","client_id","occurred_at","click_id","order_id"].includes(k)))
      return {code:400,body:{status:"invalid_observation"}};
    const at=Date.parse(input.occurred_at);
    if(!Number.isFinite(at) || at>t+60000 || t-at>MAX_AGE)
      return {code:400,body:{status:"invalid_time"}};
    if(input.type==="referral" && (typeof input.click_id !== "string" || !ID_RE.test(input.click_id) || input.order_id != null))
      return {code:400,body:{status:"invalid_referral"}};
    const orderId=input.type==="checkout" ? normalizeShopifyOrderId(input.order_id) : null;
    if(input.type==="checkout" && (!orderId || input.click_id != null))
      return {code:400,body:{status:"invalid_order"}};
    const eventHash=digest(TEST_SHOP+":"+input.event_id);
    if(seen.has(eventHash)) return {code:202,body:{status:"duplicate_ignored",commission_created:false}};
    seen.set(eventHash,t);
    const browserHash=digest(TEST_SHOP+":"+input.client_id);
    if(input.type==="referral") {
      const previous=records.get(browserHash);
      // Arrival order must not override a newer referral with an older replay.
      if(!previous || at>=previous.at) records.set(browserHash,{
        clickId:input.click_id, at, seenAt:t,
      });
      return {code:202,body:{status:"referral_observed",commission_created:false}};
    }
    const referral=records.get(browserHash);
    if(!referral || at<referral.at || at-referral.at>MAX_AGE)
      return {code:202,body:{status:"checkout_unmatched",commission_created:false}};
    // Response deliberately excludes browser ID, customer/order payload and
    // click ID. This is an UNVERIFIED candidate, not a webhook or sale.
    return {code:202,body:{
      status:"candidate_unverified", order_id:orderId,
      commission_created:false,requires_shopify_paid_order_verification:true,
    }};
  }

  function router() {
    const r=express.Router();
    r.options("/", (req,res)=>{
      if(req.headers.origin!==allowedOrigin)return res.sendStatus(403);
      return res.set({
        "Access-Control-Allow-Origin":allowedOrigin,
        "Access-Control-Allow-Methods":"POST, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type",
        "Access-Control-Max-Age":"600",
        "Vary":"Origin",
      }).sendStatus(204);
    });
    r.post("/",express.json({limit:"2kb",strict:true}), (req,res)=>{
      const result=observe(req.body,req.headers.origin,req.ip);
      if(req.headers.origin===allowedOrigin)
        res.set({"Access-Control-Allow-Origin":allowedOrigin,"Vary":"Origin"});
      return jsonResponse(res,result.code,result.body);
    });
    return r;
  }
  return { observe, router };
}
