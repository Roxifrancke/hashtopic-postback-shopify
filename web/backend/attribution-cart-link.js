/**
 * EXPERIMENT ONLY: Shopify legacy cart permalink attribution.
 *
 * Shopify supports both cart attributes and Base64URL-encoded line-item
 * properties on /cart/{numericVariantId}:{quantity} permalinks. The newer
 * /buy UCP permalinks do NOT yet support these fields.
 *
 * Do not deploy this as a replacement for ordinary creator product links:
 * it adds a product to a NEW cart (and can replace the shopper's existing cart).
 * The link is only suitable for an explicit "Add to cart" / "Buy" action.
 *
 * No API credentials, Shopify Admin access or merchant theme modifications.
 */
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const CLICK_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const VARIANT_RE = /^[1-9][0-9]{0,19}$/;
export const ATTRIBUTION_CART_ATTRIBUTE = "MyStorefront click_id";
export const ATTRIBUTION_LINE_ITEM_PROPERTY = "_MyStorefront click_id";

export function buildShopifyAttributionCartLink({
  shop, variantId, clickId, quantity = 1, toCart = true,
}) {
  if (typeof shop !== "string" || !SHOP_RE.test(shop)) {
    throw new Error("A permanent Shopify store domain is required");
  }
  const variant = String(variantId);
  if (!VARIANT_RE.test(variant)) {
    throw new Error("A numeric Shopify variant ID is required");
  }
  if (typeof clickId !== "string" || !CLICK_RE.test(clickId)) {
    throw new Error("An opaque click ID is required");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
    throw new Error("Quantity must be an integer from 1 to 99");
  }
  const url = new URL(`https://${shop}/cart/${variant}:${quantity}`);
  // Shopify explicitly supports Base64URL-encoded JSON line item properties
  // on the legacy cart permalink format. The property is attached to item 1.
  const properties = JSON.stringify({
    [ATTRIBUTION_LINE_ITEM_PROPERTY]: clickId,
  });
  url.searchParams.set("properties", Buffer.from(properties).toString("base64url"));
  url.searchParams.set(`attributes[${ATTRIBUTION_CART_ATTRIBUTE}]`, clickId);
  if (toCart) url.searchParams.set("storefront", "true");
  return url.toString();
}
