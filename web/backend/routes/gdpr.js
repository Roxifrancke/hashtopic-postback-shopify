import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "crypto";

const router = Router();

// Each GDPR endpoint reads the raw body as text so we can verify Shopify's
// HMAC signature against the original bytes (express.json would mutate them).
const rawBody = express.text({ type: "*/*" });

function verifyHmac(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !process.env.SHOPIFY_API_SECRET) return false;
  const digest = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(req.body || "", "utf8")
    .digest("base64");
  try {
    return timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
  } catch {
    return false;
  }
}

function parsePayload(req) {
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

// Customer requests their data — we don't store any personal customer data
// (only Shopify order IDs in the deliveries table), so there is nothing to export.
router.post("/customers_data_request", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");
  const payload = parsePayload(req);
  console.log("[GDPR] customers/data_request for shop:", payload.shop_domain);
  res.status(200).send("OK");
});

// Customer requests data deletion — same as above, nothing personal stored.
router.post("/customers_redact", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");
  const payload = parsePayload(req);
  console.log("[GDPR] customers/redact for shop:", payload.shop_domain);
  res.status(200).send("OK");
});

// Shop uninstalled / data erasure required — log it. Settings and deliveries
// rows for the shop can be optionally purged here.
router.post("/shop_redact", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");
  const payload = parsePayload(req);
  console.log("[GDPR] shop/redact for shop:", payload.shop_domain);
  res.status(200).send("OK");
});

export default router;
