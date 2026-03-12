import { useCallback } from "react";

// Capture shop from initial load as a reliable fallback
const initialParams = new URLSearchParams(window.location.search);
const INITIAL_SHOP = initialParams.get("shop") || "";

export function useAuthenticatedFetch() {
  return useCallback(async (uri, options = {}) => {
    let token = "";
    let shop = INITIAL_SHOP;

    // Preferred: get a fresh session token from App Bridge (never expires mid-request)
    if (window.shopify?.idToken) {
      try {
        token = await window.shopify.idToken();
      } catch (e) {
        console.warn("[HT] App Bridge idToken() failed, falling back to URL params:", e);
      }
    }

    // Fallback: read from current URL params
    if (!token) {
      const params = new URLSearchParams(window.location.search);
      token = params.get("id_token") || "";
    }

    // Extract shop from token if we don't have it yet
    if (!shop && token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        shop = (payload.dest || "").replace("https://", "");
      } catch (e) {}
    }

    return fetch(uri, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token && { "Authorization": `Bearer ${token}` }),
        ...(shop && { "X-Shopify-Shop": shop }),
        ...options.headers,
      },
    });
  }, []);
}