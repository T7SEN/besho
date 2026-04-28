"use client";

import { useEffect, useCallback } from "react";
import { getNavBadges } from "@/app/actions/badges";

const SYNC_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes

function isNative(): boolean {
  const cap = (
    globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return typeof cap !== "undefined" && !!cap.isNativePlatform?.();
}

/**
 * Syncs the Android app icon badge count with the sum of pending tasks
 * and unacknowledged rules via @capawesome/capacitor-badge.
 *
 * - Syncs immediately on mount
 * - Re-syncs every 5 minutes
 * - Re-syncs on app foreground (appStateChange)
 * - Clears badge on unmount
 *
 * Must only be mounted once — place in CapacitorInit.
 */
export function useBadge(): void {
  const sync = useCallback(async () => {
    if (!isNative()) return;
    try {
      const { Badge } = await import("@capawesome/capacitor-badge");
      const { isSupported } = await Badge.isSupported();
      if (!isSupported) return;

      const { pendingTasks, unacknowledgedRules } = await getNavBadges();
      const total = pendingTasks + unacknowledgedRules;

      if (total === 0) {
        await Badge.clear();
      } else {
        await Badge.set({ count: total });
      }
    } catch (err) {
      console.error("[badge] Sync failed:", err);
    }
  }, []);

  useEffect(() => {
    if (!isNative()) return;

    void sync();

    const intervalId = setInterval(() => void sync(), SYNC_INTERVAL_MS);

    let removeAppListener: (() => void) | null = null;

    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const listener = await App.addListener(
          "appStateChange",
          ({ isActive }) => {
            if (isActive) void sync();
          },
        );
        removeAppListener = () => void listener.remove();
      } catch (err) {
        console.error("[badge] App listener failed:", err);
      }
    })();

    return () => {
      clearInterval(intervalId);
      removeAppListener?.();
      // Clear badge on unmount
      void (async () => {
        try {
          const { Badge } = await import("@capawesome/capacitor-badge");
          await Badge.clear();
        } catch {
          /* ignore */
        }
      })();
    };
  }, [sync]);
}
