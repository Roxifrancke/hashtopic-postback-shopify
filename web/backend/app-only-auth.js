// Application-only Shopify Admin API token acquisition (opt-in helper).
// Does not replace existing merchant session OAuth or mutate stored OAuth credentials.
// Uses the public key registered in Shopify Dev Dashboard and the matching private PEM
// supplied only via Render environment variables.
import { createPrivateKey, randomUUID, sign } from "node:crypto";

const GRANT = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const cache = new Map();
const pending = new Map();

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function settings() {
  const clientId = process.env.SHOPIFY_API_KEY;
  const kid = process.env.SHOPIFY_APP_ONLY_KEY_ID;
  const pem = process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!clientId || !kid || !pem) throw new Error("Application-only authentication is not configured");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ec" ||
      privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Application-only key must be an EC P-256 private key");
  }
  return { clientId, kid, privateKey };
}

export function applicationOnlyConfigured() {
  return Boolean(process.env.SHOPIFY_API_KEY &&
    process.env.SHOPIFY_APP_ONLY_KEY_ID &&
    process.env.SHOPIFY_APP_ONLY_PRIVATE_KEY);
}

export function validateShopDomain(shop) {
  if (typeof shop !== "string" || !SHOP_PATTERN.test(shop)) {
    throw new Error("A permanent .myshopify.com shop domain is required");
  }
  return shop;
}

export function createClientAssertion(shop, config = settings()) {
  validateShopDomain(shop);
  const now = Math.floor(Date.now() / 1000);
  const endpoint = `https://${shop}/admin/oauth/access_token`;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: config.clientId, sub: config.clientId, aud: endpoint,
    iat: now, exp: now + 60, jti: randomUUID(),
  }));
  const message = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(message), {
    key: config.privateKey, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${message}.${signature}`;
}

export function invalidateApplicationOnlyToken(shop) {
  cache.delete(shop);
}

export async function getApplicationOnlyToken(shop, fetchImpl = fetch) {
  validateShopDomain(shop);
  const entry = cache.get(shop);
  // Leave 5 minutes of lifetime to avoid tokens expiring in-flight.
  if (entry && Date.now() < entry.refreshAt) return entry.token;
  if (pending.has(shop)) return pending.get(shop);

  const request = (async () => {
    const config = settings();
    const endpoint = `https://${shop}/admin/oauth/access_token`;
    const assertion = createClientAssertion(shop, config);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_assertion_type: GRANT,
        client_assertion: assertion,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Don't log tokens/assertions. A 4xx may mean app is uninstalled or unauthorised.
      throw new Error(`Application-only token request failed for ${shop}: HTTP ${response.status} (${String(json.error || "unknown_error")})`);
    }
    if (typeof json.access_token !== "string" ||
        !Number.isFinite(json.expires_in) || json.expires_in <= 0) {
      throw new Error("Shopify returned an invalid application-only token response");
    }
    const refreshAt = Date.now() + Math.max(0, json.expires_in - 300) * 1000;
    cache.set(shop, { token: json.access_token, refreshAt });
    return json.access_token;
  })().finally(() => pending.delete(shop));
  pending.set(shop, request);
  return request;
}

/**
 * Read-only GraphQL diagnostic helper. Never returns the access token.
 * Shopify application-only tokens are GraphQL-only.
 */
export async function queryShopifyGraphQL(shop, query, variables = {}, fetchImpl = fetch) {
  validateShopDomain(shop);
  if (typeof query !== "string" || !/^\s*(query\b|\{)/.test(query)) {
    throw new Error("Only read-only GraphQL queries are allowed");
  }
  const token = await getApplicationOnlyToken(shop, fetchImpl);
  const response = await fetchImpl(`https://${shop}/admin/api/2026-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors) {
    throw new Error(`Shopify GraphQL query failed for ${shop}: HTTP ${response.status}`);
  }
  return data.data;
}
