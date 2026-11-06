// Turns on the MyStorefront Web Pixel for a shop from inside the app.
//
// Unlike the theme app embed, the merchant never has to toggle anything and
// a theme change can't switch it off. Requires the write_pixels and
// read_customer_events scopes and the web pixel extension to be deployed.
//
// Runs when the merchant opens the app (see routes/settings.js). It checks
// the shop's current pixel and creates or updates it so its settings always
// point at this backend (staging and live each use their own SHOPIFY_APP_URL).

const API_VERSION = "2025-04";
const QUERY = "query { webPixel { id settings } }";
const CREATE = `mutation($webPixel: WebPixelInput!) {
  webPixelCreate(webPixel: $webPixel) { webPixel { id } userErrors { code field message } }
}`;
const UPDATE = `mutation($id: ID!, $webPixel: WebPixelInput!) {
  webPixelUpdate(id: $id, webPixel: $webPixel) { webPixel { id } userErrors { code field message } }
}`;

// Shops that already have a correct pixel in this process, so we don't call
// Shopify on every app open. Cleared on restart, which is fine.
const confirmed = new Set();

export function pixelEndpoint(env = process.env) {
  const base = String(env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return base.startsWith("https://") ? `${base}/api/pixel-events` : null;
}

function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

export async function ensureWebPixel({ shop, token, env = process.env, fetchFn = fetch }) {
  if (confirmed.has(shop)) return { status: "already_confirmed" };
  const endpoint = pixelEndpoint(env);
  if (!endpoint) return { status: "app_url_missing" };
  if (typeof token !== "string" || !token) return { status: "token_unavailable" };

  const call = async (query, variables) => {
    const res = await fetchFn(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  };

  const wanted = { shop, endpoint };
  const webPixel = { settings: JSON.stringify(wanted) };

  const existing = await call(QUERY);
  if (!existing.ok) return { status: `shopify_http_${existing.status}` };

  // Shopify returns a "not found" error (not null) when the shop has no pixel yet.
  const current = existing.json?.data?.webPixel;

  if (current?.id) {
    const have = parseSettings(current.settings);
    if (have.shop === wanted.shop && have.endpoint === wanted.endpoint) {
      confirmed.add(shop);
      return { status: "connected" };
    }
    const updated = await call(UPDATE, { id: current.id, webPixel });
    const errors = updated.json?.data?.webPixelUpdate?.userErrors || [];
    if (!updated.ok || errors.length || !updated.json?.data?.webPixelUpdate?.webPixel?.id) {
      return { status: "update_failed", errors: errors.map((e) => e.code || e.message) };
    }
    confirmed.add(shop);
    return { status: "updated" };
  }

  const created = await call(CREATE, { webPixel });
  const errors = created.json?.data?.webPixelCreate?.userErrors || [];
  if (!created.ok || errors.length || !created.json?.data?.webPixelCreate?.webPixel?.id) {
    const graphqlErrors = (created.json?.errors || []).map((e) => e.message);
    return { status: "create_failed", errors: [...errors.map((e) => e.code || e.message), ...graphqlErrors] };
  }
  confirmed.add(shop);
  return { status: "created" };
}
