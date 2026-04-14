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

/**
 * Check if a discount code already exists by searching price rules with the same title.
 * Returns the existing price rule and discount code if found, null otherwise.
 */
async function findExistingDiscountCode(shop, adminToken, code) {
  const upperCode = code.toUpperCase();

  // Fetch price rules and look for one with a matching title
  const priceRulesRes = await shopifyAdminFetch(
    shop, adminToken,
    "price_rules.json?limit=250&fields=id,title"
  );

  if (!priceRulesRes.ok) return null;

  const { price_rules: priceRules } = await priceRulesRes.json();
  const matchingRules = priceRules.filter(
    (rule) => rule.title.toUpperCase() === upperCode
  );

  if (matchingRules.length === 0) return null;

  // Check each matching rule for a discount code with the same code
  for (const rule of matchingRules) {
    const codesRes = await shopifyAdminFetch(
      shop, adminToken,
      `price_rules/${rule.id}/discount_codes.json?limit=250`
    );
    if (!codesRes.ok) continue;

    const { discount_codes: codes } = await codesRes.json();
    const match = codes.find((dc) => dc.code.toUpperCase() === upperCode);

    if (match) {
      return { price_rule_id: rule.id, discount_code: match };
    }
  }

  return null;
}

export default function discountCodesRouter() {
  const router = Router();

  // Resolve {shop, settings} from either ?shop=... or the API key alone.
  // Falls back to API-key lookup if the shop string doesn't match a row,
  // which handles custom domains vs .myshopify.com aliases.
  async function resolveShop(req) {
    const providedKey =
      req.headers["x-mystorefront-key"] ||
      req.headers["x-hashtopic-key"] ||
      "";
    const shopParam = req.query.shop || req.headers["x-shopify-shop"];

    if (shopParam) {
      const settings = await getSettings(String(shopParam));
      if (settings) return { shop: String(shopParam), settings, providedKey };
    }
    const settings = await getSettingsByApiKey(providedKey);
    return { shop: settings?.shop || null, settings, providedKey };
  }

  // ── GET /api/discount-codes/ping — public connection check ─────────────
  router.get("/ping", async (req, res) => {
    const { settings, providedKey } = await resolveShop(req);
    const storedKey = settings?.mystorefront_api_key || "";

    if (!storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res.status(401).json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }
    return res.json({ ok: true });
  });

  // ── Auth middleware: validate shop + API key ────────────────────────────
  router.use(async (req, res, next) => {
    const { shop, settings, providedKey } = await resolveShop(req);
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

  // ── GET /api/discount-codes  (and /coupons alias) — list all codes ─────
  router.get(["/", "/coupons"], async (req, res) => {
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

      return res.json({ codes, coupons: codes, total: codes.length });
    } catch (err) {
      console.error("[MS] GET /api/discount-codes error:", err);
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
      // ── Deduplication check: see if this code already exists ──────────
      const existing = await findExistingDiscountCode(shop, adminToken, code);
      if (existing) {
        return res.status(409).json({
          error: "Coupon already exists",
          code: code.toUpperCase(),
          discount_code_id: String(existing.discount_code.id),
          price_rule_id: String(existing.price_rule_id),
        });
      }

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
      console.error("[MS] POST /api/discount-codes error:", err);
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
        // Already gone — treat as success for idempotent sync
        return res.json({ success: true, already_deleted: true });
      }

      if (!deleteRes.ok && deleteRes.status !== 204) {
        return res.status(502).json({ error: `Shopify returned HTTP ${deleteRes.status}` });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[MS] DELETE /api/discount-codes error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── PATCH /api/discount-codes/:id — update a code's fields ─────────────
  // Accepts: discount_type, discount_value, minimum_order_value, expiry_date,
  // usage_limit, is_active. Missing fields are left unchanged.
  router.patch("/:id", async (req, res) => {
    const shop = res.locals.shop;
    const adminToken = res.locals.adminToken;

    if (!adminToken) {
      return res.status(400).json({ error: "Shopify Admin API token not configured." });
    }

    const priceRuleId = req.params.id;
    if (!/^\d+$/.test(priceRuleId)) {
      return res.status(400).json({ error: "Invalid price rule ID." });
    }

    const {
      discount_type,
      discount_value,
      minimum_order_value,
      expiry_date,
      usage_limit,
      is_active,
    } = req.body || {};

    try {
      // Fetch existing rule so we don't wipe fields we aren't updating
      const getRes = await shopifyAdminFetch(
        shop, adminToken,
        `price_rules/${priceRuleId}.json`
      );
      if (getRes.status === 404) {
        return res.status(404).json({ error: "Price rule not found." });
      }
      if (!getRes.ok) {
        return res.status(502).json({ error: `Shopify returned HTTP ${getRes.status}` });
      }
      const { price_rule: existing } = await getRes.json();

      const patch = { id: existing.id };

      if (discount_type !== undefined) {
        const mapped = DISCOUNT_TYPE_MAP[discount_type];
        if (!mapped) {
          return res.status(400).json({ error: "Invalid discount_type." });
        }
        patch.value_type = mapped;
      }
      if (discount_value !== undefined) {
        patch.value = `-${Math.abs(discount_value)}`;
      }
      if (minimum_order_value !== undefined) {
        patch.prerequisite_subtotal_range =
          minimum_order_value && parseFloat(minimum_order_value) > 0
            ? { greater_than_or_equal_to: String(minimum_order_value) }
            : null;
      }
      if (usage_limit !== undefined) {
        patch.usage_limit = usage_limit ? parseInt(usage_limit, 10) : null;
      }

      // Handle expiry + active together. Active=false ⇒ ends_at=now (past).
      // Active=true with no expiry_date ⇒ clear ends_at.
      if (is_active === false) {
        patch.ends_at = new Date().toISOString();
      } else if (is_active === true && expiry_date === undefined) {
        // Reactivating without an explicit new expiry — clear any past ends_at
        if (existing.ends_at && new Date(existing.ends_at) <= new Date()) {
          patch.ends_at = null;
        }
      }
      if (expiry_date !== undefined && is_active !== false) {
        patch.ends_at = expiry_date ? new Date(expiry_date).toISOString() : null;
      }

      const updateRes = await shopifyAdminFetch(
        shop, adminToken,
        `price_rules/${priceRuleId}.json`,
        { method: "PUT", body: JSON.stringify({ price_rule: patch }) }
      );

      if (!updateRes.ok) {
        const errBody = await updateRes.json().catch(() => ({}));
        return res.status(502).json({
          error: `Shopify update failed (HTTP ${updateRes.status})`,
          details: errBody,
        });
      }

      const { price_rule: updated } = await updateRes.json();
      return res.json({
        success: true,
        price_rule_id: String(updated.id),
        is_active: !updated.ends_at || new Date(updated.ends_at) > new Date(),
      });
    } catch (err) {
      console.error("[MS] PATCH /api/discount-codes error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}
