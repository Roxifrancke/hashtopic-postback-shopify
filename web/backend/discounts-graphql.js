// Read-only Shopify discount-code listing through the GraphQL Admin API.
// Intentionally separate from the production REST routes until IDs, pagination
// and behaviour are validated against the HashTopic test shop.
import { queryShopifyGraphQL, validateShopDomain } from "./app-only-auth.js";

export const LIST_DISCOUNT_NODES = `
query MyStorefrontDiscountCodes($after: String) {
  codeDiscountNodes(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          title status endsAt usageLimit asyncUsageCount
          customerGets { value {
            ... on DiscountPercentage { percentage }
            ... on DiscountAmount { amount { amount currencyCode } }
          } }
          minimumRequirement {
            ... on DiscountMinimumSubtotal {
              greaterThanOrEqualToSubtotal { amount }
            }
          }
          codes(first: 100) {
            pageInfo { hasNextPage }
            nodes { id code asyncUsageCount }
          }
        }
        ... on DiscountCodeBxgy {
          title status endsAt
          codes(first: 100) {
            pageInfo { hasNextPage }
            nodes { id code asyncUsageCount }
          }
        }
        ... on DiscountCodeFreeShipping {
          title status endsAt
          codes(first: 100) {
            pageInfo { hasNextPage }
            nodes { id code asyncUsageCount }
          }
        }
      }
    }
  }
}
`;

export function numericShopifyId(gid, expectedType) {
  if (typeof gid !== "string") return null;
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(gid);
  return match && (!expectedType || match[1] === expectedType) ? match[2] : null;
}

export function normalizeDiscountNode(node) {
  const d = node?.codeDiscount;
  if (!d) return [];
  const ruleId = numericShopifyId(node.id, "DiscountCodeNode");
  if (!ruleId) throw new Error("Shopify returned an unrecognised discount node ID");
  if (d.codes?.pageInfo?.hasNextPage) {
    throw new Error("Discount has over 100 redeem codes; additional pagination required");
  }
  const basic = d.__typename === "DiscountCodeBasic";
  const value = d.customerGets?.value;
  const percentage = value?.percentage;
  const amount = value?.amount?.amount;
  const discountType = !basic ? null : Number.isFinite(percentage)
    ? "percentage" : amount != null ? "fixed_amount" : null;
  const discountValue = discountType === "percentage"
    ? percentage * 100 : discountType === "fixed_amount"
    ? Number(amount) : null;
  return (d.codes?.nodes || []).map(code => ({
    id: numericShopifyId(code.id, "DiscountRedeemCode"),
    price_rule_id: ruleId,
    code: String(code.code || "").toUpperCase(),
    discount_type: discountType,
    discount_value: discountValue,
    minimum_order_value: d.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount != null
      ? Number(d.minimumRequirement.greaterThanOrEqualToSubtotal.amount) : null,
    expiry_date: d.endsAt ? d.endsAt.split("T")[0] : null,
    ends_at: d.endsAt || null,
    is_active: d.status === "ACTIVE",
    usage_limit: d.usageLimit ?? null,
    usage_count: code.asyncUsageCount ?? d.asyncUsageCount ?? 0,
    shopify_discount_type: d.__typename,
    supported_for_write: basic && discountType !== null,
  }));
}

export async function listDiscountsGraphQL(shop, query = queryShopifyGraphQL) {
  validateShopDomain(shop);
  const rows = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const data = await query(shop, LIST_DISCOUNT_NODES, { after });
    const connection = data?.codeDiscountNodes;
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
      throw new Error("Shopify returned an incomplete discount connection");
    }
    for (const node of connection.nodes) rows.push(...normalizeDiscountNode(node));
    if (!connection.pageInfo.hasNextPage) return rows;
    if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === after) {
      throw new Error("Shopify discount pagination stalled");
    }
    after = connection.pageInfo.endCursor;
  }
  throw new Error("Shopify discount listing exceeded page safety limit");
}
