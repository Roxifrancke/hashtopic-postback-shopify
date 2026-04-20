import express from "express";
import crypto from "crypto";
import { deleteShopData } from "../db.js";

const router = express.Router();

// Shopify sends raw body for GDPR webhooks
const rawBody = express.text({ type: "*/*" });

function verifyHmac(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const secret = process.env.SHOPIFY_API_SECRET;

  if (!hmac || !secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(req.body, "utf8")
    .digest("base64");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmac)
    );
  } catch {
    return false;
  }
}

// customers/data_request — we do not store customer PII at rest. The deliveries
// table only contains shop domain, Shopify order ID, and delivery status. Any
// customer PII (email, phone) is forwarded in-transit to the merchant's
// configured postback URL and not retained by this app.
router.post("/customers_data_request", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");
  console.log("[GDPR] customers_data_request — no customer PII stored at rest.");
  res.status(200).send("OK");
});

// customers/redact — nothing to redact because no customer PII is stored at rest.
router.post("/customers_redact", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");
  console.log("[GDPR] customers_redact — no customer PII stored at rest.");
  res.status(200).send("OK");
});

// shop/redact — delete all shop data 48h after uninstall, per Shopify policy.
router.post("/shop_redact", rawBody, async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");

  let payload = {};
  try { payload = JSON.parse(req.body || "{}"); } catch {}
  const shop = payload.shop_domain;

  if (!shop) {
    console.warn("[GDPR] shop_redact received without shop_domain");
    return res.status(200).send("OK");
  }

  try {
    const result = await deleteShopData(shop);
    console.log(`[GDPR] shop_redact for ${shop}: removed ${result.deliveries} deliveries, ${result.settings} settings.`);
  } catch (err) {
    console.error(`[GDPR] shop_redact failed for ${shop}:`, err);
  }

  res.status(200).send("OK");
});

export default router;
