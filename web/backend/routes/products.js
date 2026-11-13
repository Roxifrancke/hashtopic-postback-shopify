import { Router } from "express";
import { timingSafeEqual } from "crypto";
import { getSettings } from "../db.js";
import { getValidAccessToken } from "../shopify-auth.js";

// Read-only product catalogue for MyStorefront's per-product commission picker.
// Called server-to-server with shop + X-Mystorefront-Key (same auth as the
// referral rules route). Returns Shopify's numeric product id, which matches
// line_items[].product_id in purchase and refund postbacks.

const API_VERSION = "2025-04";
const PAGE_SIZE = 50;

const PRODUCTS_QUERY = `query MyStorefrontProducts($first: Int!, $after: String, $query: String) {
  products(first: $first, after: $after, query: $query, sortKey: TITLE) {
    edges {
      node {
        legacyResourceId
        title
        handle
        status
        onlineStoreUrl
        featuredMedia { preview { image { url } } }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

function safeCompare(a, b) {
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

// Plain words only. Strips Shopify search syntax so callers can't widen the query.
export function cleanSearch(raw) {
  return String(raw || "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export function mapProduct(node) {
  const amount = Number(node?.priceRangeV2?.minVariantPrice?.amount);
  return {
    id: String(node?.legacyResourceId || ""),
    title: String(node?.title || ""),
    handle: node?.handle || null,
    status: node?.status || null,
    image_url: node?.featuredMedia?.preview?.image?.url || null,
    price: Number.isFinite(amount) ? amount : null,
    currency: node?.priceRangeV2?.minVariantPrice?.currencyCode || null,
    product_url: node?.onlineStoreUrl || null,
  };
}

export default function productsRouter(shopify) {
  const router = Router();

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

  // GET /api/products?shop=...&q=optional words&after=optional cursor
  router.get("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { shop, token } = res.locals;
    const q = cleanSearch(req.query.q);
    const after = typeof req.query.after === "string" && req.query.after.length <= 500 ? req.query.after : null;

    try {
      const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: PRODUCTS_QUERY,
          variables: { first: PAGE_SIZE, after, query: q || null },
        }),
        signal: AbortSignal.timeout(15000),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.errors) {
        const messages = Array.isArray(json.errors)
          ? json.errors.slice(0, 3).map((e) => String(e?.message || "GraphQL error").slice(0, 200))
          : [];
        console.error(`[MS PRODUCTS] Query failed for ${shop}: HTTP ${response.status}`, messages.join("; "));
        return res.status(502).json({ error: "Could not read products", status: response.status, messages });
      }
      const conn = json?.data?.products;
      const products = (conn?.edges || []).map((e) => mapProduct(e?.node)).filter((p) => p.id && p.title);
      return res.json({
        products,
        page_info: {
          has_next_page: Boolean(conn?.pageInfo?.hasNextPage),
          end_cursor: conn?.pageInfo?.endCursor || null,
        },
      });
    } catch (err) {
      console.error(`[MS PRODUCTS] Error for ${shop}:`, err?.message || err);
      return res.status(500).json({ error: "Could not read products" });
    }
  });

  return router;
}
