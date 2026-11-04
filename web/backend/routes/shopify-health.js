import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { getSettings } from "../db.js";
import {
  applicationOnlyConfigured,
  queryShopifyGraphQL,
  validateShopDomain,
} from "../app-only-auth.js";

// An authenticated and read-only connection probe for the MyStorefront server.
// This checks application-only Shopify GraphQL access; it does not prove that
// storefront click capture, order webhook delivery or commissions are healthy.
const PROBE_QUERY = "query MyStorefrontConnectionCheck { shop { myshopifyDomain } }";

export function secureKeyEquals(stored, provided) {
  if (typeof stored !== "string" || typeof provided !== "string" ||
      !stored || !provided) return false;
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function probeShopifyConnection(shop, query = queryShopifyGraphQL,
  configured = applicationOnlyConfigured) {
  if (!configured()) {
    return { api_auth: "unknown", reason: "application_only_not_configured" };
  }
  try {
    const data = await query(shop, PROBE_QUERY);
    if (data?.shop?.myshopifyDomain?.toLowerCase() !== shop.toLowerCase()) {
      return { api_auth: "unknown", reason: "shop_identity_not_confirmed" };
    }
    return { api_auth: "verified", reason: "app_only_graphql_success" };
  } catch (err) {
    // Avoid echoing Shopify error bodies or credentials to clients.
    // 403 may indicate missing scopes; 401 invalid credentials; transient
    // problems must be distinguished from a definitive disconnected store.
    const message = String(err?.message || "");
    const reason = /HTTP 401|HTTP 403|invalid_grant|not installed/i.test(message)
      ? "shopify_auth_or_permissions_rejected" : "shopify_probe_unavailable";
    return { api_auth: "unknown", reason };
  }
}

export function shopifyHealthRouter(options = {}) {
  const router = Router();
  const loadSettings = options.getSettings || getSettings;
  const probe = options.probe || probeShopifyConnection;

  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const shop = req.query.shop;
    // Never accept the shop from an unverified header or from API key alone.
    // Brand-bound key authentication prevents querying other merchants.
    try {
      validateShopDomain(shop);
    } catch {
      return res.status(400).json({ error: "Valid shop parameter required" });
    }

    const provided = req.get("x-mystorefront-key") || "";
    if (!provided) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let settings;
    try {
      settings = await loadSettings(shop);
    } catch {
      return res.status(503).json({ error: "Connection check unavailable" });
    }
    if (!secureKeyEquals(settings?.mystorefront_api_key, provided)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const result = await probe(shop);
      return res.json({
        shop,
        api_auth: result.api_auth,
        reason: result.reason,
        checked_at: new Date().toISOString(),
        webhook_delivery: "unverified",
        storefront_capture: "unverified",
        end_to_end: "unverified",
      });
    } catch {
      return res.status(503).json({ error: "Connection check unavailable" });
    }
  });
  return router;
}
