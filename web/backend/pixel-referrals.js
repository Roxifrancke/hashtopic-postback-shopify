// Web Pixel referral store.
//
// The MyStorefront Web Pixel (extensions/mystorefront-affiliate-pixel) reads
// click_id from the landing URL and, at checkout, posts it here together with
// Shopify's checkout token. We store the pair so the paid-order webhook can
// find the click_id even when the theme app embed is switched off.
//
// Matching is done on order.checkout_token, which comes from Shopify's
// HMAC-signed webhook (or the Admin API), never from the browser. The
// order_id the pixel sends is only used as a hint to fetch that order early,
// and is ignored unless the fetched order's checkout_token matches.
import { Router, json, text } from "express";
import pool, { getSettings } from "./db.js";
import { validateReferral, CHECKOUT_TOKEN } from "./pixel-referral-input.js";

export { validateReferral, parseOrderId } from "./pixel-referral-input.js";
const RETENTION_DAYS = 60;

const tableReady = pool
  .query(`
    CREATE TABLE IF NOT EXISTS pixel_referrals (
      shop            TEXT NOT NULL,
      checkout_token  TEXT NOT NULL,
      click_id        TEXT NOT NULL,
      order_id        TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (shop, checkout_token)
    );
    CREATE INDEX IF NOT EXISTS idx_pixel_referrals_created ON pixel_referrals(created_at);
  `)
  .then(() => true)
  .catch((err) => {
    console.error("[MS PIXEL] Could not create pixel_referrals table:", err.message);
    return false;
  });

export async function saveReferral({ shop, checkoutToken, clickId, orderId }) {
  if (!(await tableReady)) return false;
  // First click wins for a given checkout. Only fill order_id in later.
  await pool.query(
    `INSERT INTO pixel_referrals (shop, checkout_token, click_id, order_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shop, checkout_token)
     DO UPDATE SET order_id = COALESCE(pixel_referrals.order_id, EXCLUDED.order_id)`,
    [shop, checkoutToken, clickId, orderId]
  );
  return true;
}

/** Look up the click_id for an order using its server-side checkout_token. */
export async function findClickIdForOrder(shop, order) {
  const token = order?.checkout_token;
  if (typeof token !== "string" || !CHECKOUT_TOKEN.test(token)) return null;
  if (!(await tableReady)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT click_id FROM pixel_referrals
       WHERE shop = $1 AND checkout_token = $2
         AND created_at > NOW() - ($3 || ' days')::interval
       LIMIT 1`,
      [shop, token, String(RETENTION_DAYS)]
    );
    return rows[0]?.click_id || null;
  } catch (err) {
    console.error("[MS PIXEL] Lookup failed:", err.message);
    return null;
  }
}

export async function purgeOldReferrals(days = RETENTION_DAYS) {
  if (!(await tableReady)) return;
  await pool.query(
    `DELETE FROM pixel_referrals WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
}

/**
 * Public receiver for the Web Pixel. The pixel runs in Shopify's sandbox, so
 * requests arrive with Origin "null" (or the shop's own domain). We accept the
 * body as JSON or text so the pixel can send a simple request without a
 * CORS preflight.
 *
 * onReferral(referral) is called after saving, so the caller can try to send
 * the postback straight away if the order is already paid.
 */
export function pixelReferralRouter({ onReferral } = {}) {
  const router = Router();

  router.use((req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    next();
  });

  router.options("/", (_req, res) => res.status(204).end());

  router.post(
    "/",
    json({ limit: "2kb" }),
    text({ type: "text/*", limit: "2kb" }),
    async (req, res) => {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
      }

      const referral = validateReferral(body);
      if (!referral) return res.status(400).json({ result: "invalid" });

      try {
        // Only accept referrals for shops that have this app installed.
        const settings = await getSettings(referral.shop);
        if (!settings) return res.status(404).json({ result: "unknown_shop" });

        const saved = await saveReferral(referral);
        if (!saved) return res.status(503).json({ result: "unavailable" });

        if (settings.debug) {
          console.log(`[MS PIXEL] Referral saved for ${referral.shop} (order hint: ${referral.orderId || "none"})`);
        }

        res.status(202).json({ result: "saved" });

        if (onReferral) {
          Promise.resolve(onReferral(referral)).catch((err) =>
            console.error("[MS PIXEL] Follow-up processing failed:", err?.message || err)
          );
        }
      } catch (err) {
        console.error("[MS PIXEL] Receiver error:", err?.message || err);
        if (!res.headersSent) res.status(503).json({ result: "unavailable" });
      }
    }
  );

  return router;
}
