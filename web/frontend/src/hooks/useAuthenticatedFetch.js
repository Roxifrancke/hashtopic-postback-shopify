import { useCallback } from "react";

export function useAuthenticatedFetch() {
  return useCallback((uri, options = {}) => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("id_token") || params.get("session") || "";
    const shop = params.get("shop") || "";

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
