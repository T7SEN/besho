"use client";

import { useEffect, useState } from "react";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";

export type ConnectionType = "wifi" | "cellular" | "none" | "unknown";

export interface NetworkStatus {
  connected: boolean;
  connectionType: ConnectionType;
}

const INITIAL: NetworkStatus = { connected: true, connectionType: "unknown" };

/**
 * Returns real-time network connectivity status.
 *
 * ARCHITECTURAL UPGRADE:
 * - Prevents async zombie listener memory leaks on native.
 * - Syncs React state updates with browser paint frames for zero-layout-shift.
 */
export function useNetwork(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(INITIAL);

  useEffect(() => {
    let mounted = true;
    type ListenerHandle = { remove: () => void };
    let handle: ListenerHandle | null = null;

    const applyStatus = (connected: boolean, type: string) => {
      if (!mounted) return;

      // Sync with browser painting cycle instead of arbitrary setTimeout
      requestAnimationFrame(() => {
        setStatus({
          connected,
          connectionType: type as ConnectionType,
        });
      });
    };

    const initNative = async () => {
      try {
        const { Network } = await import("@capacitor/network");
        const current = await Network.getStatus();

        if (!mounted) return;
        applyStatus(current.connected, current.connectionType);

        const listener = await Network.addListener("networkStatusChange", (s) =>
          applyStatus(s.connected, s.connectionType),
        );

        // Architectural Fix: The Async Race Condition Gate
        // If the component was unmounted while we were awaiting the listener,
        // we must immediately destroy the listener we just created.
        if (!mounted) {
          void listener.remove();
        } else {
          handle = listener;
        }
      } catch (err) {
        logger.error("[network] Capacitor init failed, using fallback:", err);
        if (mounted) initWeb();
      }
    };

    const initWeb = () => {
      const win = globalThis as unknown as {
        navigator?: { onLine?: boolean };
        addEventListener: (type: string, fn: () => void) => void;
        removeEventListener: (type: string, fn: () => void) => void;
      };
      const update = () =>
        applyStatus(win.navigator?.onLine ?? true, "unknown");

      update();
      win.addEventListener("online", update);
      win.addEventListener("offline", update);

      handle = {
        remove: () => {
          win.removeEventListener("online", update);
          win.removeEventListener("offline", update);
        },
      };
    };

    if (isNative()) {
      void initNative();
    } else {
      initWeb();
    }

    return () => {
      mounted = false;
      handle?.remove();
    };
  }, []);

  return status;
}
