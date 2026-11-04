import { Router } from "express";
import {
  getDeliveriesForShop,
  getDeliveryById,
  resetDeliveryForRetry,
  getSettings,
} from "../db.js";
import {
  getValidAccessToken,
  refreshShopifyAccessToken,
} from "../shopify-auth.js";
import webhookHandlers from "../webhooks/index.js";

const SHOPIFY_API_VERSION = "2025-04";

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
      // so we load the offline token (refreshing it via the refresh-token
      // grant if it's near expiry) and call the Admin REST API directly.
      try {
        let accessToken = await getValidAccessToken(shopify, shop);
        if (!accessToken) {
          console.error(
            `Could not fetch order from Shopify for retry: no access token stored for ${shop}`,
          );
        } else {
          const orderUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${delivery.order_id}.json`;
          const callOrder = (token) =>
            fetch(orderUrl, {
              headers: {
                "X-Shopify-Access-Token": token,
                "Content-Type": "application/json",
              },
            });

          let orderRes = await callOrder(accessToken);

          // 401 → try one refresh + retry before giving up. Covers the case
          // where the token expired between getValidAccessToken() and the
          // HTTP call (rare but possible under latency).
          if (orderRes.status === 401) {
            const refreshed = await refreshShopifyAccessToken(shopify, shop);
            if (refreshed && refreshed !== accessToken) {
              accessToken = refreshed;
              orderRes = await callOrder(accessToken);
            }
          }

          if (!orderRes.ok) {
            console.error(
              `Could not fetch order ${delivery.order_id} from Shopify for retry: HTTP ${orderRes.status}`,
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


  // Staging order recovery: Shopify can omit a webhook delivery (for example,
  // while a service is unavailable). Recover ONLY an explicit numeric order ID
  // through the merchant's authenticated Shopify session. The normal
  // processOrder path handles referral checks, idempotency and postback retries.
  router.post("/recover", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const orderId = String(req.body?.order_id ?? "");
      if (!/^[1-9][0-9]{0,19}$/.test(orderId)) {
        return res.status(400).json({ error: "A valid Shopify order ID is required." });
      }

      const settings = await getSettings(shop);
      if (!settings?.webhook_url) {
        return res.status(400).json({ error: "Webhook URL is not configured." });
      }

      let token = await getValidAccessToken(shopify, shop);
      if (!token) {
        return res.status(503).json({ error: "Shopify access token unavailable. Reopen the app and retry." });
      }

      const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}.json`;
      const fetchOrder = (accessToken) => fetch(url, {
        headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      let shopifyResponse = await fetchOrder(token);
      if (shopifyResponse.status === 401) {
        const refreshedToken = await refreshShopifyAccessToken(shopify, shop);
        if (refreshedToken && refreshedToken !== token) {
          token = refreshedToken;
          shopifyResponse = await fetchOrder(token);
        }
      }
      if (!shopifyResponse.ok) {
        return res.status(502).json({
          error: "Could not retrieve order from Shopify.",
          shopify_status: shopifyResponse.status,
        });
      }
      const { order } = await shopifyResponse.json();
      if (!order || String(order.id) !== orderId) {
        return res.status(502).json({ error: "Shopify returned an unexpected order." });
      }
      if (!settings.paid_statuses.includes(order.financial_status)) {
        return res.status(409).json({ error: "Order is not in an eligible paid status." });
      }

      // Reuse the same extractor as the real webhook, including line-item
      // properties used by express checkout.
      const { extractClickId } = await import("../postback-sender.js");
      if (!extractClickId(order)) {
        return res.status(409).json({ error: "This order has no MyStorefront referral click ID." });
      }

      await webhookHandlers.processOrder(shop, order);
      const deliveries = await getDeliveriesForShop(shop, 50);
      const delivery = deliveries.find((row) => row.order_id === orderId);
      return res.json({
        order_id: orderId,
        delivery_status: delivery?.status || "not_created",
        http_code: delivery?.last_http_code || null,
        attempts: delivery?.attempts || 0,
        recovered: delivery?.status === "sent",
      });
    } catch (err) {
      console.error("Order recovery failed:", err?.message || err);
      return res.status(500).json({ error: "Unable to recover order." });
    }
  });

  return router;
}
