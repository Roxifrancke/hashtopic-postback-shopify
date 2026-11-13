import { Router } from "express";
import { randomBytes, timingSafeEqual } from "crypto";
import { getSettings, saveSettings, getLastPostbackAt } from "../db.js";
import { buildTestPayload, sendPayload } from "../postback-sender.js";
import { getValidAccessToken } from "../shopify-auth.js";
import { ensureWebPixel } from "../web-pixel-activation.js";
import { connectToMystorefront } from "../mystorefront-connect.js";

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function logConnect(shop, result) {
  if (!result) return;
  console.log(`[MS CONNECT] ${shop}: ${result.status}`, result.error || "");
}

export default function settingsRouter(shopify) {
  const router = Router();

  // ── GET /api/settings/ping — unauthenticated connection check ───────────
  router.get("/ping", async (req, res) => {
    const shop = req.query.shop || req.headers["x-shopify-shop"];
    if (!shop)
      return res.status(400).json({ error: "shop parameter required" });

    const settings = await getSettings(shop);
    const storedKey = settings?.mystorefront_api_key || "";
    const providedKey = req.headers["x-mystorefront-key"] || "";

    if (!storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res
        .status(401)
        .json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    return res.json({ ok: true });
  });

  // ── GET /api/settings ───────────────────────────────────────────────────
  router.get("/", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;

      // Make sure the MyStorefront Web Pixel is switched on for this shop.
      // Runs in the background every time the merchant opens the app, so no
      // theme toggle is needed. Never blocks or fails the settings load.
      getValidAccessToken(shopify, shop)
        .then((token) => ensureWebPixel({ shop, token }))
        .then((result) => console.log(`[MS PIXEL] Activation for ${shop}: ${result.status}`, result.errors || ""))
        .catch((err) => console.warn(`[MS PIXEL] Activation for ${shop} failed:`, err?.message || err));

      // Link this shop to its MyStorefront brand in the background (at most
      // once an hour while it is linked). Never blocks the settings load.
      connectToMystorefront(shop, { onlyIfStale: true })
        .then((result) => logConnect(shop, result))
        .catch((err) => console.warn(`[MS CONNECT] ${shop} failed:`, err?.message || err));

      const s = await getSettings(shop);
      const lastPostbackAt = await getLastPostbackAt(shop);

      if (!s) {
        return res.json({
          webhook_url: "",
          has_secret: false,
          paid_statuses: ["paid"],
          param_names: "click_id",
          cookie_name: "click_id",
          cookie_days: 30,
          debug: false,
          test_mode: false,
          has_mystorefront_api_key: false,
          mystorefront_api_key: "",
          // Admin token is set automatically via OAuth — never exposed to frontend
          has_shopify_admin_token: false,
          mystorefront_linked_at: null,
          mystorefront_link_error: "",
          last_postback_at: lastPostbackAt,
        });
      }

      return res.json({
        webhook_url: s.webhook_url,
        has_secret: Boolean(s.webhook_secret),
        paid_statuses: s.paid_statuses,
        param_names: s.param_names,
        cookie_name: s.cookie_name,
        cookie_days: s.cookie_days,
        debug: s.debug,
        test_mode: s.test_mode,
        has_mystorefront_api_key: Boolean(s.mystorefront_api_key),
        mystorefront_api_key: s.mystorefront_api_key || "",
        // Admin token is set automatically via OAuth — never exposed to frontend
        has_shopify_admin_token: Boolean(s.shopify_admin_token),
        mystorefront_linked_at: s.mystorefront_linked_at || null,
        mystorefront_link_error: s.mystorefront_link_error || "",
        last_postback_at: lastPostbackAt,
      });
    } catch (err) {
      console.error("GET /api/settings error:", err);
      res.status(500).json({ error: "Failed to load settings." });
    }
  });

  // ── POST /api/settings ──────────────────────────────────────────────────
  router.post("/", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;

      // Strip shopify_admin_token from body — it must never be set via the frontend.
      // It is set automatically when the merchant installs/reinstalls the app via OAuth.
      const { shopify_admin_token: _ignored, ...body } = req.body;

      if (body.webhook_url && !body.webhook_url.startsWith("https://")) {
        return res
          .status(400)
          .json({ error: "Webhook URL must start with https://" });
      }

      await saveSettings(shop, body);

      // Link this shop to its MyStorefront brand now that the secret is saved.
      // A failed link never fails the save; the status is returned instead.
      try {
        logConnect(shop, await connectToMystorefront(shop));
      } catch (err) {
        console.warn(`[MS CONNECT] ${shop} failed:`, err?.message || err);
      }

      const saved = await getSettings(shop);

      // Webhooks are registered declaratively via the app config (see
      // shopify.app.*.toml), so there is nothing to register here.

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
          has_mystorefront_api_key: Boolean(saved.mystorefront_api_key),
          mystorefront_api_key: saved.mystorefront_api_key || "",
          has_shopify_admin_token: Boolean(saved.shopify_admin_token),
          mystorefront_linked_at: saved.mystorefront_linked_at || null,
          mystorefront_link_error: saved.mystorefront_link_error || "",
        },
      });
    } catch (err) {
      console.error("POST /api/settings error:", err);
      res.status(500).json({ error: "Failed to save settings." });
    }
  });

  // ── POST /api/settings/generate-api-key ─────────────────────────────────
  router.post("/generate-api-key", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const newKey = randomBytes(16).toString("hex");
      await saveSettings(shop, { mystorefront_api_key: newKey });

      // Push the new key to MyStorefront so discount sync keeps working.
      try {
        logConnect(shop, await connectToMystorefront(shop));
      } catch (err) {
        console.warn(`[MS CONNECT] ${shop} failed:`, err?.message || err);
      }

      return res.json({ success: true, key: newKey });
    } catch (err) {
      console.error("POST /api/settings/generate-api-key error:", err);
      res.status(500).json({ error: "Failed to generate API key." });
    }
  });

  // ── POST /api/settings/test ─────────────────────────────────────────────
  router.post("/test", async (req, res) => {
    try {
      const shop = res.locals.shopify.session.shop;
      const settings = await getSettings(shop);

      if (!settings?.webhook_url) {
        return res
          .status(400)
          .json({ error: "Webhook URL not configured. Save settings first." });
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
