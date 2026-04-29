/// <reference lib="dom" />
"use client";

import { useEffect } from "react";
import { logger } from "@/lib/logger";

export function GlobalLogger() {
  useEffect(() => {
    // Safety check for SSR/Build time
    if (typeof window === "undefined") return;

    const handleError = (event: ErrorEvent) => {
      logger.fatal("Uncaught Browser Error", event.error, {
        file: event.filename,
        line: event.lineno,
      });
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      logger.error("Unhandled Promise Rejection", event.reason);
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  return null;
}
