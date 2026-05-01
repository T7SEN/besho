"use client";

import { useEffect, useCallback } from "react";
import { getNavBadges } from "@/app/actions/badges";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

const SYNC_INTERVAL_MS = 5 * 60 * 1_000;

/**
 * Syncs the Android app icon badge count with the sum of pending tasks
 * and unacknowledged rules via @capawesome/capacitor-badge.
 *
 * - Syncs immediately on mount
 * - Re-syncs every 5 minutes
 * - Re-syncs on app foreground (appStateChange)
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

      // Architectural Fix 1: Android 13+ Permission Gateway
      let permStatus = await Badge.checkPermissions();
      if (permStatus.display === "prompt") {
        permStatus = await Badge.requestPermissions();
      }
      if (permStatus.display !== "granted") {
        logger.warn("[badge] Permission denied.");
        return;
      }

      const { pendingTasks, unacknowledgedRules } = await getNavBadges();
      const total = pendingTasks + unacknowledgedRules;

      if (total === 0) {
        await Badge.clear();
      } else {
        await Badge.set({ count: total });
      }
    } catch (err) {
      logger.error("[badge] Sync failed:", err);
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
        logger.error("[badge] App listener failed:", err);
      }
    })();

    return () => {
      clearInterval(intervalId);
      removeAppListener?.();
      // Architectural Fix 2: Badges must persist when the app is killed.
      // Do not call Badge.clear() here.
    };
  }, [sync]);
}
