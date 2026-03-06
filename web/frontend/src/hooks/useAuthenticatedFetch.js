import { useCallback } from "react";

export function useAuthenticatedFetch() {
  return useCallback((uri, options = {}) => {
    return fetch(uri, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }, []);
}
