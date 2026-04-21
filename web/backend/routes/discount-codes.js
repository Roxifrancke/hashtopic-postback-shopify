import { Router } from "express";
import { timingSafeEqual } from "crypto";
import {
  getSettings,
  getSettingsByApiKey,
  saveAccessToken,
} from "../db.js";

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

async function rawShopifyAdminFetch(shop, adminToken, path, options = {}) {
  const url = `https://${shop}/admin/api/2025-04/${path}`;
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": adminToken,
      ...(options.headers || {}),
    },
  });
}

// Look up the newest offline session in Shopify's session storage. Prefer the
// session-storage token over settings.shopify_admin_token because uninstall/
// reinstall leaves the old cached token in `settings` while the new token
// lives only in the session store.
async function lookupSessionToken(shopify, shop) {
  try {
    const sessions = await shopify.config.sessionStorage.findSessionsByShop(shop);
    const offlineSessions = (sessions || []).filter(
      (s) => s && !s.isOnline && s.accessToken,
    );
    if (offlineSessions.length === 0) return "";
    // Pick the newest session — handles the case where reinstall created a
    // new session alongside stale ones from a previous install.
    offlineSessions.sort((a, b) => {
      const aTime = a.expires ? new Date(a.expires).getTime() : 0;
      const bTime = b.expires ? new Date(b.expires).getTime() : 0;
      return bTime - aTime;
    });
    return offlineSessions[0].accessToken || "";
  } catch (err) {
    console.error("[MS] lookupSessionToken failed:", err.message);
    return "";
  }
}

// Resolve the offline admin token. Always prefers session-storage (source of
// truth post-install) and only falls back to the cached settings token when
// storage is empty. Caches successful lookups back into settings.
async function resolveAdminToken(shopify, shop, settings) {
  const fromStorage = await lookupSessionToken(shopify, shop);
  if (fromStorage) {
    if (fromStorage !== settings?.shopify_admin_token) {
      await saveAccessToken(shop, fromStorage).catch(() => {});
    }
    return fromStorage;
  }
  return settings?.shopify_admin_token || "";
}

// Admin fetch with automatic 401 recovery: on 401, clear the cached token,
// re-resolve from session storage, and retry once. Keeps the route handlers
// simple — callers still see either a success response or a real failure.
function makeAdminFetcher(shopify, shop, initialToken) {
  let token = initialToken;
  return async function adminFetch(path, options = {}) {
    let res = await rawShopifyAdminFetch(shop, token, path, options);
    if (res.status !== 401) return res;

    const refreshed = await lookupSessionToken(shopify, shop);
    if (!refreshed || refreshed === token) {
      // Clear the stale cache so the next request doesn't keep retrying this
      // same dead token via the settings fallback.
      await saveAccessToken(shop, "").catch(() => {});
      return res;
    }
    token = refreshed;
    await saveAccessToken(shop, refreshed).catch(() => {});
    res = await rawShopifyAdminFetch(shop, token, path, options);
    return res;
  };
}

/**
 * Check if a discount code already exists by searching price rules with the same title.
 * Returns the existing price rule and discount code if found, null otherwise.
 */
async function findExistingDiscountCode(adminFetch, code) {
  const upperCode = code.toUpperCase();

  // Fetch price rules and look for one with a matching title
  const priceRulesRes = await adminFetch(
    "price_rules.json?limit=250&fields=id,title",
  );

  if (!priceRulesRes.ok) return null;

  const { price_rules: priceRules } = await priceRulesRes.json();
  const matchingRules = priceRules.filter(
    (rule) => rule.title.toUpperCase() === upperCode,
  );

  if (matchingRules.length === 0) return null;

  // Check each matching rule for a discount code with the same code
  for (const rule of matchingRules) {
    const codesRes = await adminFetch(
      `price_rules/${rule.id}/discount_codes.json?limit=250`,
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

export default function discountCodesRouter(shopify) {
  const router = Router();

  // Resolve {shop, settings} from either ?shop=... or the API key alone.
  // Falls back to API-key lookup if the shop string doesn't match a row,
  // which handles custom domains vs .myshopify.com aliases.
  async function resolveShop(req) {
    const providedKey =
      req.headers["x-mystorefront-key"] || req.headers["x-hashtopic-key"] || "";
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
      return res
        .status(401)
        .json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }
    return res.json({ ok: true });
  });

  // ── Auth middleware: validate shop + API key ────────────────────────────
  router.use(async (req, res, next) => {
    // ✅ CRITICAL: allow preflight requests (CORS)
    if (req.method === "OPTIONS") {
      return next();
    }

    const { shop, settings, providedKey } = await resolveShop(req);
    if (!shop || !settings) {
      return res
        .status(401)
        .json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    const storedKey = settings.mystorefront_api_key || "";
    if (!storedKey || !providedKey || !safeCompare(providedKey, storedKey)) {
      return res
        .status(401)
        .json({ error: "Invalid or missing X-Mystorefront-Key header." });
    }

    res.locals.shop = shop;
    const adminToken = await resolveAdminToken(shopify, shop, settings);
    res.locals.adminToken = adminToken;
    res.locals.adminFetch = adminToken
      ? makeAdminFetcher(shopify, shop, adminToken)
      : null;
    next();
  });

  // ── GET /api/discount-codes  (and /coupons alias) — list all codes ─────
  router.get(["/", "/coupons"], async (req, res) => {
    const adminFetch = res.locals.adminFetch;

    if (!adminFetch) {
      return res
        .status(400)
        .json({ error: "Shopify Admin API token not configured." });
    }

    try {
      const priceRulesRes = await adminFetch(
        "price_rules.json?limit=250&fields=id,title,value_type,value,customer_selection,prerequisite_subtotal_range,ends_at,usage_limit",
      );

      if (!priceRulesRes.ok) {
        return res
          .status(502)
          .json({ error: `Shopify returned HTTP ${priceRulesRes.status}` });
      }

      const { price_rules: priceRules } = await priceRulesRes.json();
      const codes = [];
      const now = new Date();

      for (const rule of priceRules) {
        const codesRes = await adminFetch(
          `price_rules/${rule.id}/discount_codes.json?limit=250&fields=id,code,usage_count`,
        );

        if (!codesRes.ok) continue;

        const { discount_codes: ruleCodes } = await codesRes.json();

        // A rule is "active" iff it has no ends_at or ends_at is in the future.
        const isActive = !rule.ends_at || new Date(rule.ends_at) > now;

        for (const dc of ruleCodes) {
          codes.push({
            id: String(dc.id),
            price_rule_id: String(rule.id),
            code: dc.code.toUpperCase(),
            discount_type: SHOPIFY_TYPE_TO_MS[rule.value_type] || "percentage",
            discount_value: Math.abs(parseFloat(rule.value)),
            minimum_order_value:
              parseFloat(
                rule.prerequisite_subtotal_range?.greater_than_or_equal_to || 0,
              ) || null,
            expiry_date: rule.ends_at ? rule.ends_at.split("T")[0] : null,
            ends_at: rule.ends_at || null,
            is_active: isActive,
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

  // ── POST /api/discount-codes — create, update, or delete ───────────────
  // Accepts an optional `price_rule_id` (fast-path, skips title lookup) and
  // recognises `is_active` / `active` / `published` / `ends_at` so the
  // upstream edge function can sync activation state without a separate route.
  // Pass `action: "delete"` to remove the price rule entirely (idempotent).
  router.post("/", async (req, res) => {
    const adminFetch = res.locals.adminFetch;

    if (!adminFetch) {
      return res
        .status(400)
        .json({ error: "Shopify Admin API token not configured." });
    }

    const {
      code,
      discount_type,
      discount_value,
      minimum_order_value,
      expiry_date,
      usage_limit,
      price_rule_id: priceRuleIdFromBody,
      is_active,
      active,
      published,
      ends_at,
      action,
    } = req.body || {};

    if (!code) {
      return res.status(400).json({ error: "Missing required field: code" });
    }

    // Explicit activation flag, if the caller provided one. undefined = no change.
    const activeExplicit =
      typeof is_active === "boolean" ? is_active :
      typeof active === "boolean" ? active :
      typeof published === "boolean" ? published :
      undefined;

    try {
      const upperCode = String(code).toUpperCase();

      // ── Resolve the existing price rule (fast-path via body id) ──────────
      let existing = null;
      if (priceRuleIdFromBody && /^\d+$/.test(String(priceRuleIdFromBody))) {
        existing = { price_rule_id: String(priceRuleIdFromBody) };
      } else {
        existing = await findExistingDiscountCode(adminFetch, upperCode);
      }

      // ── Action: delete — remove the price rule (idempotent) ─────────────
      if (action === "delete") {
        if (!existing) {
          return res.json({ success: true, already_deleted: true, code: upperCode });
        }
        const deleteRes = await adminFetch(
          `price_rules/${existing.price_rule_id}.json`,
          { method: "DELETE" },
        );
        if (deleteRes.status === 404) {
          return res.json({ success: true, already_deleted: true, code: upperCode });
        }
        if (!deleteRes.ok && deleteRes.status !== 204) {
          return res
            .status(502)
            .json({ error: `Shopify DELETE returned HTTP ${deleteRes.status}` });
        }
        return res.json({
          success: true,
          deleted: true,
          price_rule_id: String(existing.price_rule_id),
          code: upperCode,
        });
      }

      // ── Compute the ends_at we want the rule to have after the write ────
      // undefined ⇒ don't touch. null ⇒ clear. string ⇒ set.
      // Shopify rejects ends_at <= starts_at, so deactivation also rewinds
      // starts_at to an even earlier historic date.
      const DEACTIVATE_STARTS_AT = "1999-12-31T00:00:00Z";
      const DEACTIVATE_ENDS_AT = "2000-01-01T00:00:00Z";
      let resolvedEndsAt;
      let resolvedStartsAt; // undefined ⇒ don't touch
      if (activeExplicit === false) {
        // Deactivate — force historic starts_at AND ends_at so the rule is
        // both "ended" and consistent with Shopify's ordering constraint.
        resolvedStartsAt = DEACTIVATE_STARTS_AT;
        resolvedEndsAt =
          ends_at && new Date(ends_at) <= new Date(DEACTIVATE_STARTS_AT)
            ? null // malformed past ends_at; fall back to default below
            : DEACTIVATE_ENDS_AT;
        if (!resolvedEndsAt) resolvedEndsAt = DEACTIVATE_ENDS_AT;
      } else if (activeExplicit === true) {
        // Activate — clear end date (or use future expiry_date) and
        // reset starts_at to "now" so the rule is immediately usable.
        resolvedEndsAt = expiry_date ? new Date(expiry_date).toISOString() : null;
        resolvedStartsAt = new Date().toISOString();
      } else if (expiry_date !== undefined) {
        resolvedEndsAt = expiry_date ? new Date(expiry_date).toISOString() : null;
      } else if (ends_at !== undefined) {
        resolvedEndsAt = ends_at;
      }

      // ── Update path ─────────────────────────────────────────────────────
      if (existing) {
        const shopifyValueType = discount_type
          ? DISCOUNT_TYPE_MAP[discount_type]
          : undefined;
        if (discount_type && !shopifyValueType) {
          return res.status(400).json({ error: "Invalid discount_type." });
        }

        const patch = { id: existing.price_rule_id };
        if (shopifyValueType) patch.value_type = shopifyValueType;
        if (discount_value != null) {
          patch.value = `-${Math.abs(Number(discount_value))}`;
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
        // Order matters here: starts_at must be written alongside ends_at so
        // Shopify evaluates the pair atomically and never sees ends_at <= starts_at.
        if (resolvedStartsAt !== undefined) {
          patch.starts_at = resolvedStartsAt;
        }
        if (resolvedEndsAt !== undefined) {
          patch.ends_at = resolvedEndsAt;
        }

        const updateRes = await adminFetch(
          `price_rules/${existing.price_rule_id}.json`,
          { method: "PUT", body: JSON.stringify({ price_rule: patch }) },
        );

        // If the rule vanished upstream, fall through to create.
        if (updateRes.status !== 404) {
          if (!updateRes.ok) {
            const err = await updateRes.json().catch(() => ({}));
            return res.status(502).json({ error: "Update failed", details: err });
          }
          const updated = await updateRes.json().catch(() => ({}));
          const finalEndsAt = updated?.price_rule?.ends_at || null;
          const computedActive =
            !finalEndsAt || new Date(finalEndsAt) > new Date();
          return res.json({
            success: true,
            updated: true,
            price_rule_id: String(existing.price_rule_id),
            code: upperCode,
            is_active: computedActive,
            ends_at: finalEndsAt,
          });
        }
        existing = null; // fall through to create
      }

      // ── Create path — require full payload ──────────────────────────────
      if (discount_type == null || discount_value == null) {
        return res.status(400).json({
          error:
            "Missing required fields for create: discount_type, discount_value",
        });
      }
      const shopifyValueTypeCreate = DISCOUNT_TYPE_MAP[discount_type];
      if (!shopifyValueTypeCreate) {
        return res.status(400).json({ error: "Invalid discount_type." });
      }

      // For create, honour activation flag: deactivate-on-create = past ends_at.
      // Creating a rule as "inactive" also needs a historic starts_at so that
      // Shopify accepts ends_at < now.
      let createStartsAt = new Date().toISOString();
      let createEndsAt;
      if (activeExplicit === false) {
        createStartsAt = DEACTIVATE_STARTS_AT;
        createEndsAt = DEACTIVATE_ENDS_AT;
      } else if (expiry_date) {
        createEndsAt = new Date(expiry_date).toISOString();
      }

      const priceRuleBody = {
        price_rule: {
          title: upperCode,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: shopifyValueTypeCreate,
          value: `-${Math.abs(Number(discount_value))}`,
          customer_selection: "all",
          starts_at: createStartsAt,
          ...(createEndsAt && { ends_at: createEndsAt }),
          ...(minimum_order_value && {
            prerequisite_subtotal_range: {
              greater_than_or_equal_to: String(minimum_order_value),
            },
          }),
          ...(usage_limit && { usage_limit: parseInt(usage_limit, 10) }),
        },
      };

      const priceRuleRes = await adminFetch(
        "price_rules.json",
        { method: "POST", body: JSON.stringify(priceRuleBody) },
      );

      if (!priceRuleRes.ok) {
        const errBody = await priceRuleRes.json().catch(() => ({}));
        return res
          .status(502)
          .json({ error: "Create rule failed", details: errBody });
      }

      const { price_rule } = await priceRuleRes.json();

      const discountCodeRes = await adminFetch(
        `price_rules/${price_rule.id}/discount_codes.json`,
        {
          method: "POST",
          body: JSON.stringify({ discount_code: { code: upperCode } }),
        },
      );

      if (!discountCodeRes.ok) {
        await adminFetch(
          `price_rules/${price_rule.id}.json`,
          { method: "DELETE" },
        );
        const errBody = await discountCodeRes.json().catch(() => ({}));
        return res
          .status(502)
          .json({ error: "Create code failed", details: errBody });
      }

      const { discount_code } = await discountCodeRes.json();

      return res.status(201).json({
        success: true,
        created: true,
        discount_code_id: String(discount_code.id),
        price_rule_id: String(price_rule.id),
        code: discount_code.code,
        is_active: activeExplicit !== false,
        ends_at: createEndsAt || null,
      });
    } catch (err) {
      console.error("[MS] POST error:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── DELETE /api/discount-codes/:id — delete by price_rule_id ───────────
  router.delete("/:id", async (req, res) => {
    const adminFetch = res.locals.adminFetch;

    if (!adminFetch) {
      return res
        .status(400)
        .json({ error: "Shopify Admin API token not configured." });
    }

    const priceRuleId = req.params.id;

    if (!/^\d+$/.test(priceRuleId)) {
      return res.status(400).json({ error: "Invalid price rule ID." });
    }

    try {
      const deleteRes = await adminFetch(
        `price_rules/${priceRuleId}.json`,
        { method: "DELETE" },
      );

      if (deleteRes.status === 404) {
        // Already gone — treat as success for idempotent sync
        return res.json({ success: true, already_deleted: true });
      }

      if (!deleteRes.ok && deleteRes.status !== 204) {
        return res
          .status(502)
          .json({ error: `Shopify returned HTTP ${deleteRes.status}` });
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
    const adminFetch = res.locals.adminFetch;

    if (!adminFetch) {
      return res
        .status(400)
        .json({ error: "Shopify Admin API token not configured." });
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
      const getRes = await adminFetch(`price_rules/${priceRuleId}.json`);
      if (getRes.status === 404) {
        return res.status(404).json({ error: "Price rule not found." });
      }
      if (!getRes.ok) {
        return res
          .status(502)
          .json({ error: `Shopify returned HTTP ${getRes.status}` });
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
        patch.ends_at = expiry_date
          ? new Date(expiry_date).toISOString()
          : null;
      }

      const updateRes = await adminFetch(
        `price_rules/${priceRuleId}.json`,
        { method: "PUT", body: JSON.stringify({ price_rule: patch }) },
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
