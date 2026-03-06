import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticatedFetch } from "@shopify/app-bridge-utils";
import { useCallback } from "react";

export function useAuthenticatedFetch() {
  const app = useAppBridge();
  return useCallback(
    (uri, options = {}) => {
      const fetchFunction = authenticatedFetch(app);
      return fetchFunction(uri, options);
    },
    [app]
  );
}
