import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { classifyStoredOAuthTokens } from "../oauth-token-status.js";
import {
  applicationOnlyConfigured,
  queryShopifyGraphQL,
  validateShopDomain,
} from "../app-only-auth.js";

// An authenticated and read-only connection probe for the MyStorefront server.
// This checks application-only Shopify GraphQL access; it does not prove that
// storefront click capture, order webhook delivery or commissions are healthy.
const PROBE_QUERY = "query MyStorefrontConnectionCheck { shop { myshopifyDomain } }";
// Read-only query scoped to the currently authenticated app installation.
// Never return pixel settings or Shopify credentials to MyStorefront.
const WEB_PIXEL_QUERY = "query MyStorefrontPixelHealth { webPixel { id } }";

export async function probeWebPixel(shop, query = queryShopifyGraphQL, configured = applicationOnlyConfigured) {
  if (!configured()) return { status: "unavailable", reason: "application_only_not_configured" };
  try {
    const data = await query(shop, WEB_PIXEL_QUERY);
    if (data?.webPixel?.id) return { status: "registered", reason: "pixel_record_found" };
    if (data && Object.hasOwn(data, "webPixel") && data.webPixel === null) {
      return { status: "not_registered", reason: "no_pixel_record_for_app" };
    }
    return { status: "unavailable", reason: "pixel_result_not_confirmed" };
  } catch (err) {
    // Shopify can reject this query if the merchant hasn't approved read_pixels.
    // Report missing scope separately from an absent pixel, never as proof of
    // a merchant failing to approve updated permissions.
    const message = String(err?.message || "");
    const missingScope = /read_pixels|access denied for webpixel|access denied.*webpixel|not approved.*scope|missing.*scope/i.test(message);
    return { status: missingScope ? "scope_missing" : "unavailable",
      reason: missingScope ? "read_pixels_not_granted" : "pixel_query_unavailable" };
  }
}

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
  const loadSettings = options.getSettings || (async (shop) => {
    const { getSettings } = await import("../db.js");
    return getSettings(shop);
  });
  const probe = options.probe || probeShopifyConnection;
  const probePixel = options.probePixel || probeWebPixel;
  const loadOAuthTokens = options.getOAuthTokens || (async (shop) => {
    const { getShopifyTokenSet } = await import("../db.js");
    return getShopifyTokenSet(shop);
  });

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
      const [result, oauth, pixel] = await Promise.all([
        probe(shop),
        loadOAuthTokens(shop).then(
          tokens => classifyStoredOAuthTokens(tokens),
          () => ({ status: "unknown", reason: "stored_oauth_check_unavailable" }),
        ),
        probePixel(shop),
      ]);
      return res.json({
        shop,
        api_auth: result.api_auth,
        reason: result.reason,
        stored_oauth: oauth,
        web_pixel: pixel,
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
