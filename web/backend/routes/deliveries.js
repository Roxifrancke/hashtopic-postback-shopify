import { Router } from "express";
import {
  getDeliveriesForShop,
  getDeliveryById,
  resetDeliveryForRetry,
  getSettings,
} from "../db.js";
import webhookHandlers from "../webhooks/index.js";

export default function deliveriesRouter(shopify) {
  const router = Router();

  // GET /api/deliveries
  router.get("/", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const rows = getDeliveriesForShop(shop, 50);
      return res.json({ deliveries: rows });
    } catch (err) {
      console.error("GET /api/deliveries error:", err);
      res.status(500).json({ error: "Failed to load deliveries." });
    }
  });

  // POST /api/deliveries/:id/retry
  router.post("/:id/retry", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const delivery = getDeliveryById(Number(req.params.id));

      if (!delivery || delivery.shop !== shop) {
        return res.status(404).json({ error: "Delivery not found." });
      }

      // Reset status to pending so retry worker picks it up, or process immediately
      resetDeliveryForRetry(delivery.id);

      // Try immediately using a minimal session API call
      const settings = getSettings(shop);
      if (!settings?.webhook_url) {
        return res.status(400).json({ error: "Webhook URL not configured." });
      }

      // Attempt to fetch order from Shopify and retry
      try {
        const session = res.locals.shopify.session;
        const client = new shopify.api.clients.Rest({ session });
        const orderRes = await client.get({ path: `orders/${delivery.order_id}` });
        const order = orderRes.body?.order;

        if (order) {
          await webhookHandlers.processOrder(shop, order);
          const updated = getDeliveryById(delivery.id);
          return res.json({ success: true, delivery: updated });
        }
      } catch (shopifyErr) {
        console.error("Could not fetch order from Shopify for retry:", shopifyErr);
      }

      // Fallback: just mark as pending and let worker retry
      return res.json({
        success: true,
        message: "Retry queued.",
        delivery: getDeliveryById(delivery.id),
      });
    } catch (err) {
      console.error("POST /api/deliveries/:id/retry error:", err);
      res.status(500).json({ error: "Retry failed: " + err.message });
    }
  });

  return router;
}
