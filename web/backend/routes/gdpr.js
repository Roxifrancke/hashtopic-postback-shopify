import express from "express";
import crypto from "crypto";

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

// Customer data request
router.post("/customers_data_request", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");

  console.log("[GDPR] customers_data_request received");
  res.status(200).send("OK");
});

// Customer redact
router.post("/customers_redact", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");

  console.log("[GDPR] customers_redact received");
  res.status(200).send("OK");
});

// Shop redact
router.post("/shop_redact", rawBody, (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send("Unauthorized");

  console.log("[GDPR] shop_redact received");
  res.status(200).send("OK");
});

export default router;