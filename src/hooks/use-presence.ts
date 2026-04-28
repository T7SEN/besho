"use client";

import { useEffect } from "react";
import { isNative } from "@/lib/native";

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
    console.error("[presence] Failed to set presence:", err);
  }
}

async function clearPresence(): Promise<void> {
  try {
    await fetch("/api/presence", {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // Best effort — TTL will expire it anyway
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
          console.error("[presence] Capacitor App listener failed:", err);
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
