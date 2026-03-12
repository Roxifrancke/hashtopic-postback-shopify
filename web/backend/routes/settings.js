import { Router } from "express";
import { getSettings, saveSettings } from "../db.js";
import { buildTestPayload, sendPayload } from "../postback-sender.js";

export default function settingsRouter(shopify) {
  const router = Router();

  // GET /api/settings
  router.get("/", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const s = getSettings(shop);

      if (!s) {
        return res.json({
          webhook_url: "",
          has_secret: false,
          paid_statuses: ["paid"],
          param_names: "click_id",
          cookie_name: "_ht_click_id",
          cookie_days: 30,
          debug: false,
          test_mode: false,
        });
      }

      // Never return the actual secret
      return res.json({
        webhook_url: s.webhook_url,
        has_secret: Boolean(s.webhook_secret),
        paid_statuses: s.paid_statuses,
        param_names: s.param_names,
        cookie_name: s.cookie_name,
        cookie_days: s.cookie_days,
        debug: s.debug,
        test_mode: s.test_mode,
      });
    } catch (err) {
      console.error("GET /api/settings error:", err);
      res.status(500).json({ error: "Failed to load settings." });
    }
  });

// POST /api/settings
router.post("/", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    const body = req.body;
 
    // Validate webhook URL must be https
    if (body.webhook_url && !body.webhook_url.startsWith("https://")) {
      return res.status(400).json({ error: "Webhook URL must start with https://" });
    }
 
    saveSettings(shop, body);
    const saved = getSettings(shop);

    return res.json({
      success: true,
      settings: {
        webhook_url: saved.webhook_url,
        has_secret: Boolean(saved.webhook_secret),
        paid_statuses: saved.paid_statuses,
        param_names: saved.param_names,
        cookie_name: saved.cookie_name,
        cookie_days: saved.cookie_days,
        debug: saved.debug,
        test_mode: saved.test_mode,
      },
    });
  } catch (err) {
    console.error("POST /api/settings error:", err);
    res.status(500).json({ error: "Failed to save settings." });
  }
});

  // POST /api/settings/test
  router.post("/test", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const settings = getSettings(shop);

      if (!settings?.webhook_url) {
        return res.status(400).json({ error: "Webhook URL not configured. Save settings first." });
      }

      const payload = buildTestPayload(shop, settings);
      const result = await sendPayload(payload, settings);

      if (result.success) {
        return res.json({
          success: true,
          message: `Test postback sent successfully (HTTP ${result.httpCode}).`,
          http_code: result.httpCode,
        });
      } else {
        return res.status(200).json({
          success: false,
          message: result.error || `Webhook returned HTTP ${result.httpCode}`,
          http_code: result.httpCode,
        });
      }
    } catch (err) {
      console.error("POST /api/settings/test error:", err);
      res.status(500).json({ error: "Test postback failed: " + err.message });
    }
  });

  return router;
}
