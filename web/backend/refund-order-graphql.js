// Read-only parent order lookup for refund attribution via Shopify GraphQL.
// Converts GraphQL customAttributes to the legacy note_attributes / line_items
// representation used by extractClickId and buildRefundPayload.
import { queryShopifyGraphQL, validateShopDomain } from "./app-only-auth.js";

const ORDER_ATTRIBUTES_QUERY = `
  query MyStorefrontRefundOrder($id: ID!) {
    order(id: $id) {
      id
      name
      currencyCode
      customAttributes { key value }
      lineItems(first: 100) {
        nodes { customAttributes { key value } }
        pageInfo { hasNextPage }
      }
    }
  }
`;

export function mapGraphQLRefundOrder(order, numericOrderId) {
  if (!order) return null;
  if (order.lineItems?.pageInfo?.hasNextPage) {
    // Reject incomplete attribution data rather than silently skipping.
    throw new Error("Refund parent order has more than 100 line items; paginate before processing");
  }
  const toLegacyAttrs = (attrs) => (attrs || []).map(({ key, value }) => ({
    name: key, value,
  }));
  return {
    id: String(numericOrderId),
    name: order.name || String(numericOrderId),
    currency: order.currencyCode || "USD",
    note_attributes: toLegacyAttrs(order.customAttributes),
    line_items: (order.lineItems?.nodes || []).map((line) => ({
      properties: toLegacyAttrs(line.customAttributes),
    })),
  };
}

export async function fetchRefundOrderGraphQL(shop, numericOrderId, query = queryShopifyGraphQL) {
  validateShopDomain(shop);
  if (!/^\d+$/.test(String(numericOrderId))) {
    throw new Error("Invalid numeric Shopify order ID");
  }
  const data = await query(shop, ORDER_ATTRIBUTES_QUERY, {
    id: `gid://shopify/Order/${numericOrderId}`,
  });
  return mapGraphQLRefundOrder(data?.order, numericOrderId);
}
