import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { getSettings } from "../db.js";

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

// Map MyStorefront discount_type to Shopify price rule value_type
const DISCOUNT_TYPE_MAP = {
  percentage: "percentage",
  fixed_amount: "fixed_amount",
};

// Map Shopify value_type back to MyStorefront discount_type
const SHOPIFY_TYPE_TO_MS = {
  percentage: "percentage",
  fixed_amount: "fixed_amount",
};

/**
 * Call the Shopify Admin REST API for a given shop.
 */
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

  // ── Auth middleware: validate X-Mystorefront-Key ────────────────────────
  router.use((req, res, next) => {
    const shop = res.locals.shopify?.session?.shop;
    if (!shop) return res.status(403).json({ error: "No shop identified." });

    const settings = getSettings(shop);
    const storedKey = settings?.mystorefront_api_key || "";

    if (!storedKey) {
      return res.status(401).json({
        error: "MyStorefront API key is not configured on this store.",
      });
    }

    const providedKey = req.headers["x-mystorefront-key"] || "";
    if (!providedKey || !safeCompare(providedKey, storedKey)) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    res.locals.adminToken = settings.shopify_admin_token || "";
    next();
  });

  // ── GET /api/discount-codes — list all codes ────────────────────────────
  router.get("/", async (req, res) => {
    const shop = res.locals.shopify.session.shop;
    const settings = getSettings(shop);
    const adminToken = settings?.shopify_admin_token || "";

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    try {
      // Fetch all price rules
      const priceRulesRes = await shopifyAdminFetch(
        shop, adminToken,
        "price_rules.json?limit=250&fields=id,title,value_type,value,customer_selection,prerequisite_subtotal_range,ends_at,usage_limit"
      );

      if (!priceRulesRes.ok) {
        return res.status(502).json({ error: `Shopify returned HTTP ${priceRulesRes.status}` });
      }

      const { price_rules: priceRules } = await priceRulesRes.json();
      const codes = [];

      // NOTE: This is an N+1 pattern — one request per price rule.
      // Shopify's REST API doesn't support bulk fetching codes across rules.
      // On stores with many price rules this could hit Shopify's rate limit (2 req/s leaky bucket).
      // Consider adding a delay or migrating to the GraphQL bulk operations API for large stores.
      for (const rule of priceRules) {
        // Fetch discount codes for each price rule
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
    const shop = res.locals.shopify.session.shop;
    const settings = getSettings(shop);
    const adminToken = settings?.shopify_admin_token || "";

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
      description,
    } = req.body;

    if (!code || !discount_type || discount_value == null) {
      return res.status(400).json({ error: "Missing required fields: code, discount_type, discount_value" });
    }

    const shopifyValueType = DISCOUNT_TYPE_MAP[discount_type];
    if (!shopifyValueType) {
      return res.status(400).json({ error: "Invalid discount_type. Use: percentage, fixed_amount" });
    }

    try {
      // Step 1: Create the price rule
      const priceRuleBody = {
        price_rule: {
          title: code.toUpperCase(),
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: shopifyValueType,
          value: shopifyValueType === "percentage"
            ? `-${Math.abs(discount_value)}`
            : `-${Math.abs(discount_value)}`,
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

      // Step 2: Create the discount code under the price rule
      const discountCodeRes = await shopifyAdminFetch(
        shop, adminToken,
        `price_rules/${price_rule.id}/discount_codes.json`,
        {
          method: "POST",
          body: JSON.stringify({ discount_code: { code: code.toUpperCase() } }),
        }
      );

      if (!discountCodeRes.ok) {
        // Roll back the price rule
        await shopifyAdminFetch(shop, adminToken, `price_rules/${price_rule.id}.json`, {
          method: "DELETE",
        });

        const errBody = await discountCodeRes.json().catch(() => ({}));

        // 422 usually means duplicate code
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
    const shop = res.locals.shopify.session.shop;
    const settings = getSettings(shop);
    const adminToken = settings?.shopify_admin_token || "";

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    const priceRuleId = req.params.id;

    // Strict numeric validation — prevents path traversal in Shopify API URL
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

  // ── GET /api/discount-codes/ping — connection check ────────────────────
  // Note: registered before the auth middleware fires for this path
  return router;
}
