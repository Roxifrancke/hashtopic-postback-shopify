// ── Shopify token lifecycle ─────────────────────────────────────────────────
//
// Shopify now issues *expiring* offline access tokens (1 h access + 90 d
// refresh) when the token-exchange request includes `expiring: "1"`. This
// module centralises:
//
//   - persistShopifyTokens(...)       — save a freshly-exchanged token set
//                                        to both session storage and our
//                                        custom settings columns
//   - refreshShopifyAccessToken(...)  — use the stored refresh token to
//                                        obtain a new access token when the
//                                        old one is near expiry or a 401
//                                        comes back from the Admin API
//   - getValidAccessToken(...)        — return a known-good access token for
//                                        the shop, refreshing if necessary
//
// A single in-process mutex per shop prevents two concurrent callers from
// both attempting to use the same refresh token (refresh tokens are single-
// use — the second call would 400).

import { Session } from "@shopify/shopify-api";

import { saveShopifyTokenSet, getShopifyTokenSet } from "./db.js";

// Refresh the access token when within this many ms of its expiry. 60 s gives
// in-flight requests headroom before the token actually dies.
const PROACTIVE_REFRESH_MS = 60 * 1000;

// In-memory per-shop lock. Maps shop → Promise<string|null>. If a refresh
// is in flight, other callers await the same promise.
const refreshInFlight = new Map();

function addSecondsToNow(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(Date.now() + seconds * 1000);
}

function prefix(t) {
  return t ? `${String(t).slice(0, 8)}…` : null;
}

/**
 * Save a token-exchange (or refresh) response across session storage +
 * settings. The session's `expires` field is what the SDK reads when it
 * decides whether the stored session is still valid.
 */
export async function persistShopifyTokens(shopify, shop, tokenResponse) {
  const accessToken = tokenResponse.access_token;
  if (!accessToken) throw new Error("persistShopifyTokens: missing access_token");

  const accessTokenExpiresAt = addSecondsToNow(tokenResponse.expires_in);
  const refreshTokenExpiresAt = addSecondsToNow(
    tokenResponse.refresh_token_expires_in,
  );

  const session = new Session({
    id: shopify.api.session.getOfflineId(shop),
    shop,
    state: "",
    isOnline: false,
    accessToken,
    scope: tokenResponse.scope,
    ...(accessTokenExpiresAt && { expires: accessTokenExpiresAt }),
  });
  await shopify.config.sessionStorage.storeSession(session);

  await saveShopifyTokenSet(shop, {
    accessToken,
    refreshToken: tokenResponse.refresh_token || "",
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
  });

  return { session, accessTokenExpiresAt, refreshTokenExpiresAt };
}

async function doRefresh(shopify, shop) {
  const tokens = await getShopifyTokenSet(shop);
  if (!tokens?.refreshToken) {
    console.warn(
      `[MS] refresh: no refresh_token stored for ${shop}; user must reopen the embedded app`,
    );
    return null;
  }

  if (
    tokens.refreshTokenExpiresAt &&
    tokens.refreshTokenExpiresAt.getTime() <= Date.now()
  ) {
    console.warn(
      `[MS] refresh: refresh_token expired for ${shop} (at ${tokens.refreshTokenExpiresAt.toISOString()}); user must reopen the embedded app`,
    );
    return null;
  }

  const body = {
    client_id: process.env.SHOPIFY_API_KEY,
    client_secret: process.env.SHOPIFY_API_SECRET,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  };

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok || !json.access_token) {
    console.error(
      `[MS] refresh failed for ${shop} (status=${res.status}):`,
      JSON.stringify({ error: json.error, error_description: json.error_description }),
    );
    return null;
  }

  console.log(
    `[MS] refresh succeeded for ${shop}: access_token=${prefix(json.access_token)}, refresh_token=${prefix(json.refresh_token)}, expires_in=${json.expires_in}, refresh_token_expires_in=${json.refresh_token_expires_in}`,
  );

  await persistShopifyTokens(shopify, shop, json);
  return json.access_token;
}

/**
 * Use the stored refresh token to get a new access token. Concurrent callers
 * for the same shop share a single in-flight refresh so we never burn two
 * refresh tokens against one access-token expiry.
 *
 * Returns the new access token string, or null if refresh is impossible
 * (no refresh token, refresh token expired, Shopify rejected the call).
 */
export async function refreshShopifyAccessToken(shopify, shop) {
  const pending = refreshInFlight.get(shop);
  if (pending) return pending;

  const p = doRefresh(shopify, shop).finally(() => {
    refreshInFlight.delete(shop);
  });
  refreshInFlight.set(shop, p);
  return p;
}

/**
 * Return a known-good access token for the shop. If the stored token is
 * within PROACTIVE_REFRESH_MS of its expiry (or already expired), refresh
 * first. Returns null if no usable token can be produced — callers should
 * treat this like a 401 and surface an auth error.
 */
export async function getValidAccessToken(shopify, shop) {
  const tokens = await getShopifyTokenSet(shop);
  if (!tokens) return null;

  const expiresAt = tokens.accessTokenExpiresAt;
  const nearExpiry =
    expiresAt && expiresAt.getTime() - Date.now() <= PROACTIVE_REFRESH_MS;

  if (nearExpiry) {
    const refreshed = await refreshShopifyAccessToken(shopify, shop);
    return refreshed || tokens.accessToken || null;
  }

  return tokens.accessToken || null;
}
