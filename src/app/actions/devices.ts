// src/app/actions/devices.ts
"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
import type {
  DeviceRecord,
  PingDeviceInput,
} from "@/lib/device-types";

const deviceKey = (id: string) => `device:${id}`;
const deviceListKey = (author: "T7SEN" | "Besho") =>
  `device:list:${author}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

/**
 * Idempotent device-state ping. First call carries `info` (full device
 * profile) so the server can mint a record; subsequent pings can be
 * info-less and just bump `lastSeenAt`. Both authors call this from
 * `<DeviceTracker />`.
 *
 * Security: callers can only register / refresh devices owned by their
 * own session. If a device id was previously claimed by the other
 * author, we refuse — IDs are sticky per device install.
 */
export async function pingDevice(
  input: PingDeviceInput,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (!input?.id) return { error: "Missing device id." };

  try {
    const existing = await redis.get<DeviceRecord>(deviceKey(input.id));
    if (existing && existing.author !== session.author) {
      logger.warn("[devices] ping rejected — author mismatch", {
        deviceId: input.id,
        existingAuthor: existing.author,
        sessionAuthor: session.author,
      });
      return { error: "Device claimed by another author." };
    }

    const now = Date.now();
    const updated: DeviceRecord = {
      id: input.id,
      author: session.author,
      platform:
        input.info?.platform ?? existing?.platform ?? "unknown",
      manufacturer:
        input.info?.manufacturer ?? existing?.manufacturer,
      model: input.info?.model ?? existing?.model,
      osVersion: input.info?.osVersion ?? existing?.osVersion,
      appVersion: input.info?.appVersion ?? existing?.appVersion,
      fingerprint:
        input.info?.fingerprint ??
        existing?.fingerprint ??
        "Unknown device",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      lastPage: input.page ?? existing?.lastPage,
      lastLat: input.location?.lat ?? existing?.lastLat,
      lastLng: input.location?.lng ?? existing?.lastLng,
      lastLocationAt: input.location ? now : existing?.lastLocationAt,
    };

    const pipeline = redis.pipeline();
    pipeline.set(deviceKey(input.id), JSON.stringify(updated));
    pipeline.zadd(deviceListKey(session.author), {
      score: now,
      member: input.id,
    });
    await pipeline.exec();

    return { success: true };
  } catch (err) {
    logger.error("[devices] ping failed", err, { deviceId: input.id });
    return { error: "Ping failed." };
  }
}

/**
 * Sir-only — drop a device record entirely. Useful for old web sessions
 * or devices Sir no longer wants surfaced. The author of the device is
 * removed from `device:list:{author}` regardless of which Sir signed in.
 */
export async function forgetDevice(
  deviceId: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Forbidden." };
  if (!deviceId) return { error: "Missing device id." };

  try {
    const existing = await redis.get<DeviceRecord>(deviceKey(deviceId));
    const pipeline = redis.pipeline();
    pipeline.del(deviceKey(deviceId));
    if (existing?.author) {
      pipeline.zrem(deviceListKey(existing.author), deviceId);
    } else {
      pipeline.zrem(deviceListKey("T7SEN"), deviceId);
      pipeline.zrem(deviceListKey("Besho"), deviceId);
    }
    await pipeline.exec();
    logger.interaction("[admin] device forgotten", {
      deviceId,
      by: session.author,
    });
    return { success: true };
  } catch (err) {
    logger.error("[devices] forget failed", err, { deviceId });
    return { error: "Forget failed." };
  }
}
