import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { getSettings } from "../db.js";
import { getValidAccessToken } from "../shopify-auth.js";
import { tagAllCodes, ensureValidation, ensureRejectDiscount } from "../referral-tagging.js";

// Stores a brand's creator discount code rules on the shop so the checkout
// validation function and the theme embed can read them. MyStorefront sends
// the full rule set on every change, so each save replaces the last one.
//
// Shape: { "block": true, "codes": { "ROXI20": "roxifrancke" } }
//   block  -> brand chose Block for creator-referred carts
//   codes  -> discount code (uppercase) -> creator ref allowed to use it

const API_VERSION = "2025-04";
const SHOP_NAMESPACE = "$app:mystorefront"; // read by the checkout function
const INSTALL_NAMESPACE = "mystorefront"; // read by the theme embed (app.metafields)
const KEY = "referral_rules";
const REF_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CODES = 2000;

function safeCompare(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function normaliseRules(body) {
  if (!body || typeof body !== "object") return null;
  const codes = {};
  const src = body.codes;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const entries = Object.entries(src);
    if (entries.length > MAX_CODES) return null;
    for (const [rawCode, rawRef] of entries) {
      const code = String(rawCode || "").trim().toUpperCase();
      const ref = String(rawRef || "").trim();
      if (!code || code.length > 255 || !REF_RE.test(ref)) continue;
      codes[code] = ref;
    }
  }
  return { block: body.block === true, codes, updated_at: new Date().toISOString() };
}

async function adminGraphql(shop, token, query, variables) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export default function referralRulesRouter(shopify) {
  const router = Router();

  // Same auth as the discount code routes: shop + X-Mystorefront-Key.
  router.use(async (req, res, next) => {
    const shop = String(req.query.shop || req.headers["x-shopify-shop"] || "");
    const providedKey = String(req.headers["x-mystorefront-key"] || "");
    const settings = shop ? await getSettings(shop) : null;
    const storedKey = settings?.mystorefront_api_key || "";
    if (!settings || !storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }
    const token = await getValidAccessToken(shopify, shop);
    if (!token) {
      return res.status(409).json({ error: "token_unavailable", message: "Open the app in Shopify once, then try again." });
    }
    res.locals.shop = shop;
    res.locals.token = token;
    next();
  });

  // POST /api/referral-rules?shop=... body: { block, codes }
  router.post("/", async (req, res) => {
    const rules = normaliseRules(req.body);
    if (!rules) return res.status(400).json({ error: "Invalid rules body." });

    const { shop, token } = res.locals;
    try {
      const ids = await adminGraphql(shop, token, "query { shop { id } currentAppInstallation { id } }");
      const shopId = ids.json?.data?.shop?.id;
      const installId = ids.json?.data?.currentAppInstallation?.id;
      if (!ids.ok || !shopId || !installId) {
        return res.status(502).json({ error: "Could not read shop ids", status: ids.status });
      }

      const value = JSON.stringify(rules);
      const saved = await adminGraphql(
        shop,
        token,
        `mutation($m: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } }
        }`,
        {
          m: [
            { ownerId: shopId, namespace: SHOP_NAMESPACE, key: KEY, type: "json", value },
            { ownerId: installId, namespace: INSTALL_NAMESPACE, key: KEY, type: "json", value },
          ],
        },
      );
      const errors = saved.json?.data?.metafieldsSet?.userErrors || [];
      const gqlErrors = saved.json?.errors || [];
      if (!saved.ok || errors.length || gqlErrors.length) {
        console.error(`[MS RULES] Save failed for ${shop}:`, JSON.stringify({ errors, gqlErrors }));
        return res.status(502).json({ error: "Could not save rules", details: errors.length ? errors : gqlErrors });
      }
      const tagging = await tagAllCodes(shop, token, rules).catch((e) => ({ status: "error", error: e?.message }));
      const validation = await ensureValidation(shop, token).catch((e) => ({ status: "error", error: e?.message }));
      const removal = await ensureRejectDiscount(shop, token, rules.block).catch((e) => ({ status: "error", error: e?.message }));
      return res.json({
        ok: true,
        block: rules.block,
        code_count: Object.keys(rules.codes).length,
        tagging,
        validation,
        removal,
      });
    } catch (err) {
      console.error(`[MS RULES] Save error for ${shop}:`, err?.message || err);
      return res.status(500).json({ error: "Could not save rules" });
    }
  });

  // GET /api/referral-rules?shop=... reads both copies back (for checks)
  router.get("/", async (req, res) => {
    const { shop, token } = res.locals;
    try {
      const out = await adminGraphql(
        shop,
        token,
        `query {
          shop { metafield(namespace: "${SHOP_NAMESPACE}", key: "${KEY}") { value } }
          currentAppInstallation { metafield(namespace: "${INSTALL_NAMESPACE}", key: "${KEY}") { value } }
        }`,
      );
      const parse = (v) => {
        try { return v ? JSON.parse(v) : null; } catch { return null; }
      };
      return res.json({
        shop_copy: parse(out.json?.data?.shop?.metafield?.value),
        embed_copy: parse(out.json?.data?.currentAppInstallation?.metafield?.value),
        errors: out.json?.errors || null,
      });
    } catch (err) {
      return res.status(500).json({ error: "Could not read rules" });
    }
  });

  return router;
}
