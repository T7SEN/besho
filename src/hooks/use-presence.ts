"use client";

import { useEffect, useRef } from "react";
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
      keepalive: true,
    });
  } catch (err) {
    logger.debug("[presence] setPresence aborted (transient)", {
      error: String(err),
    });
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

function clearPresenceBeacon(): void {
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator;
  if (nav?.sendBeacon) {
    nav.sendBeacon(
      "/api/presence/beacon",
      new Blob(["{}"], { type: "application/json" }),
    );
  } else {
    void clearPresence();
  }
}

/**
 * Tracks the user's current page in Redis with a 10s TTL.
 *
 * ARCHITECTURAL UPGRADE:
 * - Prevents phantom heartbeats when the app is backgrounded.
 * - Secures async native listeners against unmount memory leaks.
 */
export function usePresence(page: string, enabled: boolean) {
  const isActiveRef = useRef(true);

  useEffect(() => {
    if (!enabled) return;

    let mounted = true;
    isActiveRef.current = true;

    void setPresence(page);

    const heartbeatId = setInterval(() => {
      // Architectural Fix 1: The Gatekeeper
      // Completely halts background network execution to save battery.
      if (!mounted || !isActiveRef.current) return;
      void setPresence(page);
    }, HEARTBEAT_INTERVAL_MS);

    type ListenerHandle = { remove: () => void };
    let nativeHandle: ListenerHandle | null = null;
    let removeWebListeners: (() => void) | null = null;

    if (isNative()) {
      void (async () => {
        try {
          const { App } = await import("@capacitor/app");
          const listener = await App.addListener(
            "appStateChange",
            ({ isActive }) => {
              isActiveRef.current = isActive;
              if (!mounted) return;

              if (isActive) {
                void setPresence(page);
              } else {
                void clearPresence();
              }
            },
          );

          // Architectural Fix 2: The Async Race Condition Gate
          if (!mounted) {
            void listener.remove();
          } else {
            nativeHandle = listener;
          }
        } catch (err) {
          logger.error("[presence] Capacitor App listener failed:", err);
        }
      })();
    } else {
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
        isActiveRef.current = doc.visibilityState !== "hidden";
        if (!mounted) return;

        if (doc.visibilityState === "hidden") {
          clearPresenceBeacon();
        } else {
          void setPresence(page);
        }
      };

      const handlePageHide = () => {
        if (!mounted) return;
        clearPresenceBeacon();
      };

      doc.addEventListener("visibilitychange", handleVisibilityChange);
      win.addEventListener("pagehide", handlePageHide);

      removeWebListeners = () => {
        doc.removeEventListener("visibilitychange", handleVisibilityChange);
        win.removeEventListener("pagehide", handlePageHide);
      };
    }

    return () => {
      mounted = false;
      clearInterval(heartbeatId);
      nativeHandle?.remove();
      removeWebListeners?.();
      void clearPresence();
    };
  }, [page, enabled]);
}
