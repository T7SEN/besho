// src/hooks/use-nav-badges.ts
"use client";

import { useState, useEffect, useRef } from "react";
import { getNavBadges, type NavBadges } from "@/app/actions/badges";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

const POLL_INTERVAL_MS = 30_000;
const INITIAL: NavBadges = {
  pendingTasks: 0,
  unacknowledgedRules: 0,
  openRituals: 0,
  pendingPermissions: 0,
};

/**
 * Polls UI navigation badge counts.
 *
 * ARCHITECTURAL UPGRADE: Battery-Aware Mobile Polling
 * - Completely halts network requests when the app is backgrounded.
 * - Instantly fetches fresh data when the app returns to the foreground,
 *   bypassing the interval wait time.
 */
export function useNavBadges(): NavBadges {
  const [badges, setBadges] = useState<NavBadges>(INITIAL);
  const isActiveRef = useRef(true);

  useEffect(() => {
    let mounted = true;

    const fetchBadges = async () => {
      if (!isActiveRef.current) return;

      try {
        const result = await getNavBadges();
        if (mounted) {
          requestAnimationFrame(() => setBadges(result));
        }
      } catch (err) {
        logger.error("[nav-badges] Fetch failed:", err);
      }
    };

    void fetchBadges();

    // The Linter Fix: Declared instantly as a const
    const intervalId = setInterval(() => void fetchBadges(), POLL_INTERVAL_MS);

    let removeAppListener: (() => void) | null = null;

    if (isNative()) {
      void (async () => {
        try {
          const { App } = await import("@capacitor/app");
          const listener = await App.addListener(
            "appStateChange",
            ({ isActive }) => {
              isActiveRef.current = isActive;
              if (isActive) {
                void fetchBadges();
              }
            },
          );
          removeAppListener = () => void listener.remove();
        } catch (err) {
          logger.error("[nav-badges] App listener failed:", err);
        }
      })();
    }

    return () => {
      mounted = false;
      clearInterval(intervalId);
      removeAppListener?.();
    };
  }, []);

  return badges;
}
