// Diagnostic only: run locally with your existing private.pem file.
// Never logs an access token, the client assertion, or the private key.
import { readFileSync } from "node:fs";
import { queryShopifyGraphQL } from "../backend/app-only-auth.js";
const path = process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY_PATH;
if (!path) throw new Error("Set SHOPIFY_APP_ONLY_PRIVATE_KEY_PATH to an existing private.pem path");
process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY = readFileSync(path, "utf8");
const shop = process.argv[2] || "mystorefront-test-2.myshopify.com";
try {
  const result = await queryShopifyGraphQL(shop, "{ shop { name myshopifyDomain } }");
  console.log(JSON.stringify({ ok: true, shop: result?.shop?.myshopifyDomain, name: result?.shop?.name }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  process.exitCode = 1;
} finally {
  delete process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY;
}
