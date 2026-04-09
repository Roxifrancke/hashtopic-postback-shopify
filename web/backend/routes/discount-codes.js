import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { getSettings, getSettingsByApiKey } from "../db.js";

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

const DISCOUNT_TYPE_MAP = {
  percentage: "percentage",
  fixed_amount: "fixed_amount",
};

const SHOPIFY_TYPE_TO_MS = {
  percentage: "percentage",
  fixed_amount: "fixed_amount",
};

async function shopifyAdminFetch(shop, adminToken, path, options = {}) {
  const url = `https://${shop}/admin/api/2024-01/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
      ...(options.headers || {}),
    },
  });
  return res;
}

export default function discountCodesRouter() {
  const router = Router();

  // Resolve {shop, settings} from either ?shop=... or the API key alone.
  // Falls back to API-key lookup if the shop string doesn't match a row,
  // which handles custom domains vs .myshopify.com aliases.
  function resolveShop(req) {
    const providedKey = req.headers["x-mystorefront-key"] || "";
    const shopParam = req.query.shop || req.headers["x-shopify-shop"];

    if (shopParam) {
      const settings = getSettings(String(shopParam));
      if (settings) return { shop: String(shopParam), settings, providedKey };
      // Fall through to API-key lookup if shop string didn't match
    }
    const settings = getSettingsByApiKey(providedKey);
    return { shop: settings?.shop || null, settings, providedKey };
  }

  // ── GET /api/discount-codes/ping — public connection check ─────────────
  router.get("/ping", (req, res) => {
    const { settings, providedKey } = resolveShop(req);
    const storedKey = settings?.mystorefront_api_key || "";

    if (!storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }
    return res.json({ ok: true });
  });

  // ── Auth middleware: validate shop + X-Mystorefront-Key ─────────────────
  router.use((req, res, next) => {
    const { shop, settings, providedKey } = resolveShop(req);
    if (!shop || !settings) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    const storedKey = settings.mystorefront_api_key || "";
    if (!storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    res.locals.shop = shop;
    res.locals.adminToken = settings.shopify_admin_token || "";
    next();
  });

  // ── GET /api/discount-codes — list all codes ────────────────────────────
  router.get("/", async (req, res) => {
    const shop = res.locals.shop;
    const adminToken = res.locals.adminToken;

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    try {
      const priceRulesRes = await shopifyAdminFetch(
        shop, adminToken,
        "price_rules.json?limit=250&fields=id,title,value_type,value,customer_selection,prerequisite_subtotal_range,ends_at,usage_limit"
      );

      if (!priceRulesRes.ok) {
        return res.status(502).json({ error: `Shopify returned HTTP ${priceRulesRes.status}` });
      }

      const { price_rules: priceRules } = await priceRulesRes.json();
      const codes = [];

      for (const rule of priceRules) {
        const codesRes = await shopifyAdminFetch(
          shop, adminToken,
          `price_rules/${rule.id}/discount_codes.json?limit=250&fields=id,code,usage_count`
        );

        if (!codesRes.ok) continue;

        const { discount_codes: ruleCodes } = await codesRes.json();

        for (const dc of ruleCodes) {
          codes.push({
            id: String(dc.id),
            price_rule_id: String(rule.id),
            code: dc.code.toUpperCase(),
            discount_type: SHOPIFY_TYPE_TO_MS[rule.value_type] || "percentage",
            discount_value: Math.abs(parseFloat(rule.value)),
            minimum_order_value:
              parseFloat(rule.prerequisite_subtotal_range?.greater_than_or_equal_to || 0) || null,
            expiry_date: rule.ends_at ? rule.ends_at.split("T")[0] : null,
            usage_limit: rule.usage_limit || null,
            usage_count: dc.usage_count || 0,
          });
        }
      }

      return res.json({ codes, total: codes.length });
    } catch (err) {
      console.error("[HT] GET /api/discount-codes error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/discount-codes — create a new code ────────────────────────
  router.post("/", async (req, res) => {
    const shop = res.locals.shop;
    const adminToken = res.locals.adminToken;

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    const {
      code,
      discount_type,
      discount_value,
      minimum_order_value,
      expiry_date,
      usage_limit,
    } = req.body;

    if (!code || !discount_type || discount_value == null) {
      return res.status(400).json({ error: "Missing required fields: code, discount_type, discount_value" });
    }

    const shopifyValueType = DISCOUNT_TYPE_MAP[discount_type];
    if (!shopifyValueType) {
      return res.status(400).json({ error: "Invalid discount_type. Use: percentage, fixed_amount" });
    }

    try {
      const priceRuleBody = {
        price_rule: {
          title: code.toUpperCase(),
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: shopifyValueType,
          value: `-${Math.abs(discount_value)}`,
          customer_selection: "all",
          starts_at: new Date().toISOString(),
          ...(expiry_date && { ends_at: new Date(expiry_date).toISOString() }),
          ...(minimum_order_value && parseFloat(minimum_order_value) > 0 && {
            prerequisite_subtotal_range: {
              greater_than_or_equal_to: String(minimum_order_value),
            },
          }),
          ...(usage_limit && { usage_limit: parseInt(usage_limit, 10) }),
        },
      };

      const priceRuleRes = await shopifyAdminFetch(
        shop, adminToken,
        "price_rules.json",
        { method: "POST", body: JSON.stringify(priceRuleBody) }
      );

      if (!priceRuleRes.ok) {
        const errBody = await priceRuleRes.json().catch(() => ({}));
        return res.status(502).json({
          error: `Shopify price rule creation failed (HTTP ${priceRuleRes.status})`,
          details: errBody,
        });
      }

      const { price_rule } = await priceRuleRes.json();

      const discountCodeRes = await shopifyAdminFetch(
        shop, adminToken,
        `price_rules/${price_rule.id}/discount_codes.json`,
        {
          method: "POST",
          body: JSON.stringify({ discount_code: { code: code.toUpperCase() } }),
        }
      );

      if (!discountCodeRes.ok) {
        await shopifyAdminFetch(shop, adminToken, `price_rules/${price_rule.id}.json`, {
          method: "DELETE",
        });

        const errBody = await discountCodeRes.json().catch(() => ({}));

        if (discountCodeRes.status === 422) {
          return res.status(409).json({ error: "Coupon already exists", code: code.toUpperCase() });
        }

        return res.status(502).json({
          error: `Shopify discount code creation failed (HTTP ${discountCodeRes.status})`,
          details: errBody,
        });
      }

      const { discount_code } = await discountCodeRes.json();

      return res.status(201).json({
        success: true,
        discount_code_id: String(discount_code.id),
        price_rule_id: String(price_rule.id),
        code: discount_code.code.toUpperCase(),
      });
    } catch (err) {
      console.error("[HT] POST /api/discount-codes error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/discount-codes/:id — delete by price_rule_id ───────────
  router.delete("/:id", async (req, res) => {
    const shop = res.locals.shop;
    const adminToken = res.locals.adminToken;

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    const priceRuleId = req.params.id;

    if (!/^\d+$/.test(priceRuleId)) {
      return res.status(400).json({ error: "Invalid price rule ID." });
    }

    try {
      const deleteRes = await shopifyAdminFetch(
        shop, adminToken,
        `price_rules/${priceRuleId}.json`,
        { method: "DELETE" }
      );

      if (deleteRes.status === 404) {
        return res.status(404).json({ error: "Price rule not found." });
      }

      if (!deleteRes.ok && deleteRes.status !== 204) {
        return res.status(502).json({ error: `Shopify returned HTTP ${deleteRes.status}` });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[HT] DELETE /api/discount-codes error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}
