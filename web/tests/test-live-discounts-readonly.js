// Read-only live diagnostic for GraphQL discount-list parity.
// Run locally with a private key path; never prints credentials or JWTs.
// Does not create, update or delete Shopify discounts.
import { readFileSync } from "node:fs";
import { listDiscountsGraphQL } from "../backend/discounts-graphql.js";

const pemPath = process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY_PATH;
if (!pemPath) throw new Error("SHOPIFY_APP_ONLY_PRIVATE_KEY_PATH is required");
process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY = readFileSync(pemPath,"utf8");
const shop = process.argv[2] || "mystorefront-test-2.myshopify.com";
try {
  const discounts = await listDiscountsGraphQL(shop);
  console.log(JSON.stringify({
    ok: true,
    shop,
    total: discounts.length,
    discounts: discounts.map(d => ({
      code: d.code,
      price_rule_id: d.price_rule_id,
      id: d.id,
      shopify_discount_type: d.shopify_discount_type,
      discount_type: d.discount_type,
      discount_value: d.discount_value,
      is_active: d.is_active,
      supported_for_write: d.supported_for_write,
    }))
  },null,2));
} catch (err) {
  console.error(JSON.stringify({ok:false,message:err.message}));
  process.exitCode=1;
} finally {
  delete process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY;
}
