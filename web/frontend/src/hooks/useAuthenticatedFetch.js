import { useCallback } from "react";

// On every page load, check URL for fresh token/shop and persist to sessionStorage.
// This survives SPA navigation and even full page reloads within the same tab.
(function persistParams() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("id_token");
  const shop = params.get("shop");
  if (token) sessionStorage.setItem("ht_id_token", token);
  if (shop) sessionStorage.setItem("ht_shop", shop);
})();

function getToken() {
  // 1. Check current URL (freshest)
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("id_token");
  if (fromUrl) {
    sessionStorage.setItem("ht_id_token", fromUrl);
    return fromUrl;
  }
  // 2. Fall back to sessionStorage
  return sessionStorage.getItem("ht_id_token") || "";
}

function getShop() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("shop");
  if (fromUrl) {
    sessionStorage.setItem("ht_shop", fromUrl);
    return fromUrl;
  }
  // Try sessionStorage first
  const shop = sessionStorage.getItem("ht_shop");
  if (shop) return shop;

  // Extract from stored token as last resort
  const token = getToken();
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      const dest = (payload.dest || "").replace("https://", "");
      if (dest) {
        sessionStorage.setItem("ht_shop", dest);
        return dest;
      }
    } catch (e) {}
  }
  return "";
}

export function useAuthenticatedFetch() {
  return useCallback((uri, options = {}) => {
    const token = getToken();
    const shop = getShop();

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