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
import { validateReferral, CHECKOUT_TOKEN, SHOP } from "./pixel-referral-input.js";

export { validateReferral, parseOrderId } from "./pixel-referral-input.js";
const RETENTION_DAYS = 60;

const tableReady = pool
  .query(`
    CREATE TABLE IF NOT EXISTS pixel_referrals (
      shop            TEXT NOT NULL,
      checkout_token  TEXT NOT NULL,
      click_id        TEXT NOT NULL,
      order_id        TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      history         JSONB NOT NULL DEFAULT '[]'::jsonb,
      journey_id      TEXT,
      history_complete BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (shop, checkout_token)
    );
    ALTER TABLE pixel_referrals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE pixel_referrals ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE pixel_referrals ADD COLUMN IF NOT EXISTS journey_id TEXT;
    ALTER TABLE pixel_referrals ADD COLUMN IF NOT EXISTS history_complete BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_pixel_referrals_created ON pixel_referrals(created_at);
  `)
  .then(() => true)
  .catch(() => {
    console.error("[MS PIXEL] Could not create pixel_referrals table");
    return false;
  });

export async function saveReferral({ shop, checkoutToken, clickId, orderId, history = [], journeyId = null, historyComplete = false }) {
  if (!(await tableReady)) return false;
  // An older observation may arrive after a newer one. Merge browser-seen
  // click history, ordered by event time; last eligible click wins.
  const reported = history.length ? history : [{ click_id: clickId, at: Date.now() }];
  await pool.query(
    `INSERT INTO pixel_referrals
       (shop,checkout_token,click_id,order_id,history,journey_id,history_complete,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,NOW())
     ON CONFLICT (shop,checkout_token) DO UPDATE SET
       history = (
         SELECT coalesce(jsonb_agg(h ORDER BY (h->>'at')::numeric), '[]'::jsonb)
         FROM (
           SELECT DISTINCT ON (h->>'click_id') h
           FROM jsonb_array_elements(pixel_referrals.history || EXCLUDED.history) AS h
           WHERE h ? 'click_id' AND h ? 'at'
           ORDER BY h->>'click_id', (h->>'at')::numeric DESC
           LIMIT 50
         ) newest
       ),
       click_id = CASE WHEN coalesce((SELECT max((h->>'at')::numeric)
           FROM jsonb_array_elements(EXCLUDED.history) AS h),0) >=
           coalesce((SELECT max((h->>'at')::numeric)
           FROM jsonb_array_elements(pixel_referrals.history) AS h),0)
           THEN EXCLUDED.click_id ELSE pixel_referrals.click_id END,
       journey_id = CASE WHEN EXCLUDED.journey_id IS NOT NULL
          THEN EXCLUDED.journey_id ELSE pixel_referrals.journey_id END,
       history_complete = pixel_referrals.history_complete OR EXCLUDED.history_complete,
       order_id = coalesce(pixel_referrals.order_id,EXCLUDED.order_id),
       updated_at = NOW()`,
    [shop,checkoutToken,clickId,orderId,JSON.stringify(reported),journeyId,historyComplete]
  );
  return true;
}

/** Webhook-validated checkout token is the only key used to join pixel data. */
export async function findEvidenceForOrder(shop, order) {
  const token = order?.checkout_token;
  const logLookup = async (found) => {
    try {
      if (!(await getSettings(shop))?.debug) return;
      console.log("[MS PIXEL] Lookup", JSON.stringify({
        shop: SHOP.test(shop) ? shop : null,
        checkout_token_prefix: typeof token === "string" && CHECKOUT_TOKEN.test(token) ? token.slice(0, 8) : null,
        found,
      }));
    } catch {
      console.error("[MS PIXEL] Could not read lookup debug settings");
    }
  };
  if (typeof token !== "string" || !CHECKOUT_TOKEN.test(token) || !(await tableReady)) {
    await logLookup(false);
    return null;
  }
  try {
    const { rows } = await pool.query(
      `SELECT click_id,history,journey_id,history_complete,updated_at
       FROM pixel_referrals WHERE shop=$1 AND checkout_token=$2
         AND created_at > NOW() - ($3 || ' days')::interval LIMIT 1`,
      [shop,token,String(RETENTION_DAYS)]
    );
    await logLookup(Boolean(rows[0]));
    return rows[0] || null;
  } catch {
    await logLookup(false);
    console.error("[MS PIXEL] Lookup failed");
    return null;
  }
}
export async function findClickIdForOrder(shop,order) {
  const row=await findEvidenceForOrder(shop,order);
  return row?.click_id || null;
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
    (req, res, next) => {
      const diagnostic = { result: "invalid", shop: null, checkout_token_prefix: null, history_count: 0, order_id_sent: false };
      req.pixelDiagnostic = diagnostic;
      res.once("finish", () => {
        if (diagnostic.result !== "saved" || req.pixelDebug) {
          console.log("[MS PIXEL] POST", JSON.stringify(diagnostic));
        }
      });
      next();
    },
    json({ limit: "2kb" }),
    text({ type: "text/*", limit: "2kb" }),
    async (req, res) => {
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
      }

      const diagnostic = req.pixelDiagnostic;
      const shop = typeof body?.shop === "string" ? body.shop.toLowerCase() : "";
      const token = body?.checkout_token;
      diagnostic.shop = SHOP.test(shop) ? shop : null;
      diagnostic.checkout_token_prefix = typeof token === "string" && CHECKOUT_TOKEN.test(token) ? token.slice(0, 8) : null;
      diagnostic.history_count = Array.isArray(body?.click_history) ? body.click_history.length : 0;
      diagnostic.order_id_sent = body?.order_id != null;

      const referral = validateReferral(body);
      if (!referral) return res.status(400).json({ result: "invalid" });

      try {
        // Only accept referrals for shops that have this app installed.
        const settings = await getSettings(referral.shop);
        if (!settings) {
          diagnostic.result = "unknown_shop";
          return res.status(404).json({ result: "unknown_shop" });
        }

        req.pixelDebug = Boolean(settings.debug);
        const saved = await saveReferral(referral);
        if (!saved) {
          diagnostic.result = "unavailable";
          return res.status(503).json({ result: "unavailable" });
        }

        diagnostic.result = "saved";

        res.status(202).json({ result: "saved" });

        if (onReferral) {
          Promise.resolve(onReferral(referral)).catch(() =>
            console.error("[MS PIXEL] Follow-up processing failed")
          );
        }
      } catch {
        if (!res.headersSent) diagnostic.result = "error";
        console.error("[MS PIXEL] Receiver error");
        if (!res.headersSent) res.status(503).json({ result: "unavailable" });
      }
    }
  );

  return router;
}
