"use client";

import { useEffect } from "react";

/**
 * Listens for the global 'ourspace:refresh' event dispatched by
 * PullToRefresh and calls the provided callback.
 */
export function useRefreshListener(onRefresh: () => void): void {
  useEffect(() => {
    const handleRefresh = () => onRefresh();
    window.addEventListener("ourspace:refresh", handleRefresh);

    return () => {
      window.removeEventListener("ourspace:refresh", handleRefresh);
    };
  }, [onRefresh]);
}
