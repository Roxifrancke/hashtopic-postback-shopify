import express from "express";

const router = express.Router();

router.post("/discounts", async (req, res) => {
  try {
    console.log("🔥 Shopify webhook received");

    const topic = req.headers["x-shopify-topic"];
    const shop = req.headers["x-shopify-shop-domain"];

    console.log("Topic:", topic);
    console.log("Shop:", shop);
    console.log("Payload:", req.body);

    res.status(200).send("Webhook received");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

export default router;
