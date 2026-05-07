"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { isNative } from "@/lib/native";
import { logger } from "@/lib/logger";
import { buildFingerprint, getOrCreateDeviceId } from "@/lib/device-id";
import { pingDevice } from "@/app/actions/devices";
import type {
  DeviceInfoInput,
  DeviceLocationInput,
  DevicePlatform,
  PingDeviceInput,
} from "@/lib/device-types";

const HEARTBEAT_MS = 60_000;

/**
 * Mounts once per session and keeps the server-side device record warm:
 *
 * 1. Mints / reads a stable device id (Capacitor `Device.getId()` on
 *    native, localStorage UUID on web).
 * 2. On first ping, sends full device info + (native-only) coarse coords.
 * 3. Heartbeats every 60s with the current pathname so the admin page
 *    sees fresh `lastSeenAt` and `lastPage`.
 *
 * Pure side-effect — renders nothing.
 */
export function DeviceTracker() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      try {
        const deviceId = await getOrCreateDeviceId();
        const info = await collectDeviceInfo(deviceId);
        const location = await tryGetCoords();

        if (cancelled) return;

        const initial: PingDeviceInput = {
          id: deviceId,
          info,
          page: pathnameRef.current,
        };
        if (location) initial.location = location;

        const result = await pingDevice(initial);
        if (result?.error) {
          logger.warn("[device-tracker] initial ping rejected", {
            error: result.error,
          });
          return;
        }

        intervalId = setInterval(() => {
          if (cancelled) return;
          // Best-effort heartbeat. Rejections happen on bad URLs (the
          // server-action POST 404s when the user is on a path with no
          // matching handler), network drops, etc. Swallow them — the
          // next interval self-heals, and an uncaught rejection here
          // surfaces as a Sentry issue with no signal value.
          pingDevice({ id: deviceId, page: pathnameRef.current }).catch(
            () => {
              // intentionally ignored
            },
          );
        }, HEARTBEAT_MS);
      } catch (err) {
        logger.error("[device-tracker] init failed", err);
      }
    })();

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  return null;
}

async function collectDeviceInfo(
  deviceId: string,
): Promise<DeviceInfoInput> {
  if (isNative()) {
    try {
      const { Device } = await import("@capacitor/device");
      const { App } = await import("@capacitor/app");
      const [d, a] = await Promise.all([Device.getInfo(), App.getInfo()]);
      const platform: DevicePlatform =
        d.platform === "ios" ? "ios" : "android";
      return {
        id: deviceId,
        platform,
        manufacturer: d.manufacturer,
        model: d.model,
        osVersion: d.osVersion,
        appVersion: a.version,
        fingerprint: buildFingerprint({
          platform,
          manufacturer: d.manufacturer,
          model: d.model,
          osVersion: d.osVersion,
          appVersion: a.version,
        }),
      };
    } catch (err) {
      logger.error("[device-tracker] capacitor info failed", err);
    }
  }
  const ua = (
    globalThis as unknown as { navigator?: { userAgent?: string } }
  ).navigator?.userAgent;
  return {
    id: deviceId,
    platform: "web",
    fingerprint: buildFingerprint({
      platform: "web",
      webUserAgent: ua,
    }),
  };
}

async function tryGetCoords(): Promise<DeviceLocationInput | null> {
  if (!isNative()) return null;
  try {
    const { Geolocation } = await import("@capacitor/geolocation");
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      maximumAge: 5 * 60 * 1000,
      timeout: 10_000,
    });
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
    };
  } catch {
    return null;
  }
}
