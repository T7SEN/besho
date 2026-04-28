"use client";

import { useEffect, useState } from "react";
import { isNative } from "@/lib/native";

export type ConnectionType = "wifi" | "cellular" | "none" | "unknown";

export interface NetworkStatus {
  connected: boolean;
  connectionType: ConnectionType;
}

const INITIAL: NetworkStatus = { connected: true, connectionType: "unknown" };

/**
 * Returns real-time network connectivity status.
 *
 * On native Android: uses @capacitor/network which reads from
 * ConnectivityManager — accurate even when the device has WiFi but
 * no actual internet (captive portal, etc.).
 *
 * On web: falls back to navigator.onLine with online/offline events.
 */
export function useNetwork(): NetworkStatus {
  const [status, setStatus] = useState<NetworkStatus>(INITIAL);

  useEffect(() => {
    type ListenerHandle = { remove: () => void };
    let handle: ListenerHandle | null = null;

    const applyStatus = (connected: boolean, type: string) => {
      setTimeout(
        () =>
          setStatus({
            connected,
            connectionType: type as ConnectionType,
          }),
        0,
      );
    };

    const initNative = async () => {
      try {
        const { Network } = await import("@capacitor/network");
        const current = await Network.getStatus();
        applyStatus(current.connected, current.connectionType);

        const listener = await Network.addListener("networkStatusChange", (s) =>
          applyStatus(s.connected, s.connectionType),
        );
        handle = listener;
      } catch (err) {
        console.error("[network] Capacitor init failed, using fallback:", err);
        initWeb();
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
      handle?.remove();
    };
  }, []);

  return status;
}
