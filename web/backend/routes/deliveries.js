import { Router } from "express";
import {
  getDeliveriesForShop,
  getDeliveryById,
  resetDeliveryForRetry,
  getSettings,
  getAccessToken,
} from "../db.js";
import webhookHandlers from "../webhooks/index.js";

const SHOPIFY_API_VERSION = "2024-01";

export default function deliveriesRouter(shopify) {
  const router = Router();

  // GET /api/deliveries
  router.get("/", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const rows = await getDeliveriesForShop(shop, 50);
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
      const delivery = await getDeliveryById(Number(req.params.id));

      if (!delivery || delivery.shop !== shop) {
        return res.status(404).json({ error: "Delivery not found." });
      }

      // Reset status to pending so retry worker picks it up, or process immediately
      await resetDeliveryForRetry(delivery.id);

      // Try immediately using a minimal session API call
      const settings = await getSettings(shop);
      if (!settings?.webhook_url) {
        return res.status(400).json({ error: "Webhook URL not configured." });
      }

      // Attempt to fetch order from Shopify and retry.
      // The session middleware only populates { shop } — no access token —
      // so we load the offline token persisted at OAuth callback and call the
      // Admin REST API directly.
      try {
        const accessToken = await getAccessToken(shop);
        if (!accessToken) {
          console.error(`Could not fetch order from Shopify for retry: no access token stored for ${shop}`);
        } else {
          const orderUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${delivery.order_id}.json`;
          const orderRes = await fetch(orderUrl, {
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
          });

          if (!orderRes.ok) {
            console.error(
              `Could not fetch order ${delivery.order_id} from Shopify for retry: HTTP ${orderRes.status}`
            );
          } else {
            const { order } = await orderRes.json();
            if (order) {
              await webhookHandlers.processOrder(shop, order);
              const updated = await getDeliveryById(delivery.id);
              return res.json({ success: true, delivery: updated });
            }
          }
        }
      } catch (shopifyErr) {
        console.error("Could not fetch order from Shopify for retry:", shopifyErr);
      }

      // Fallback: just mark as pending and let worker retry
      return res.json({
        success: true,
        message: "Retry queued.",
        delivery: await getDeliveryById(delivery.id),
      });
    } catch (err) {
      console.error("POST /api/deliveries/:id/retry error:", err);
      res.status(500).json({ error: "Retry failed: " + err.message });
    }
  });

  return router;
}
