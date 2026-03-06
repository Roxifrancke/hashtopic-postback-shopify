import { useCallback } from "react";

// Capture params once on initial load before React Router clears them
const initialParams = new URLSearchParams(window.location.search);
const INITIAL_TOKEN = initialParams.get("id_token") || "";
const INITIAL_SHOP = initialParams.get("shop") || "";

export function useAuthenticatedFetch() {
  return useCallback((uri, options = {}) => {
    // Use stored initial values so navigation doesn't lose them
    const params = new URLSearchParams(window.location.search);
    const token = params.get("id_token") || INITIAL_TOKEN;
    const shop = params.get("shop") || INITIAL_SHOP;

    return fetch(uri, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Shopify-Shop": shop,
        ...options.headers,
      },
    });
  }, []);
}
