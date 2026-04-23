import { useCallback } from "react";

// App Bridge v4 exposes window.shopify.idToken(), which returns a fresh
// Shopify session JWT (expiry ~1 minute). Shopify's embedded-app checks
// require that authenticated fetches use a session token obtained this
// way — NOT a stale id_token cached from the initial URL.
//
// We call it on every request so the backend's JWT middleware always sees
// a valid, unexpired token. If App Bridge is not yet initialised (edge
// case on very first paint), we fall back to the id_token query param so
// the first request still works; subsequent requests get fresh tokens.
async function getFreshSessionToken() {
  if (
    typeof window !== "undefined" &&
    window.shopify &&
    typeof window.shopify.idToken === "function"
  ) {
    try {
      const token = await window.shopify.idToken();
      if (token) return token;
    } catch (err) {
      console.warn("[auth] window.shopify.idToken() failed:", err);
    }
  }
  // Fallback: initial URL id_token — valid only for the first ~60 seconds
  // after embed load. Used only until App Bridge is ready.
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("id_token") || "";
  } catch {
    return "";
  }
}

export function useAuthenticatedFetch() {
  return useCallback(async (uri, options = {}) => {
    const token = await getFreshSessionToken();

    return fetch(uri, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
    });
  }, []);
}
