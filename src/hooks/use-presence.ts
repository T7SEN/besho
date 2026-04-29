"use client";

import { useEffect } from "react";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

const HEARTBEAT_INTERVAL_MS = 4_000;

async function setPresence(page: string): Promise<void> {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page }),
      credentials: "same-origin",
    });
  } catch (err) {
    logger.error("[presence] Failed to set presence:", err);
  }
}

async function clearPresence(): Promise<void> {
  try {
    const response = await fetch("/api/presence", {
      method: "DELETE",
      keepalive: true,
      credentials: "same-origin",
    });

    if (response.status === 401) {
      logger.debug(
        "[presence] Session already cleared, skipping presence delete.",
      );
      return;
    }

    if (!response.ok) {
      logger.warn("[presence] Unexpected response during clear:", {
        status: response.status,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Failed to fetch") || msg.includes("aborted")) {
      logger.debug("[presence] Clear aborted during navigation.");
    } else {
      logger.warn("[presence] Failed to clear presence:", { error: err });
    }
  }
}

/**
 * Tracks the user's current page in Redis with a 10s TTL.
 * On native Android: uses Capacitor App state for reliable background detection.
 * On PWA: uses visibilitychange + pagehide browser events.
 */
export function usePresence(page: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    void setPresence(page);

    const heartbeatId = setInterval(() => {
      void setPresence(page);
    }, HEARTBEAT_INTERVAL_MS);

    let removeCapacitorListener: (() => void) | null = null;

    if (isNative()) {
      void (async () => {
        try {
          const { App } = await import("@capacitor/app");
          const listener = await App.addListener(
            "appStateChange",
            ({ isActive }) => {
              if (isActive) {
                void setPresence(page);
              } else {
                void clearPresence();
              }
            },
          );
          removeCapacitorListener = () => void listener.remove();
        } catch (err) {
          logger.error("[presence] Capacitor App listener failed:", err);
        }
      })();
    } else {
      // ── PWA — browser events ───────────────────────────────────────────
      const doc = globalThis as unknown as {
        addEventListener: (type: string, fn: () => void) => void;
        removeEventListener: (type: string, fn: () => void) => void;
        visibilityState?: string;
      };
      const win = globalThis as unknown as {
        addEventListener: (type: string, fn: () => void) => void;
        removeEventListener: (type: string, fn: () => void) => void;
      };

      const handleVisibilityChange = () => {
        if (doc.visibilityState === "hidden") {
          void clearPresence();
        } else {
          void setPresence(page);
        }
      };

      const handlePageHide = () => {
        void clearPresence();
      };

      doc.addEventListener("visibilitychange", handleVisibilityChange);
      win.addEventListener("pagehide", handlePageHide);

      removeCapacitorListener = () => {
        doc.removeEventListener("visibilitychange", handleVisibilityChange);
        win.removeEventListener("pagehide", handlePageHide);
      };
    }

    return () => {
      clearInterval(heartbeatId);
      removeCapacitorListener?.();
      void clearPresence();
    };
  }, [page, enabled]);
}
