// src/app/actions/admin/devices.ts
"use server";

import { revalidatePath } from "next/cache";
import {
  readAllSessionEpochs,
  revokeAuthorSessions,
} from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
import type { Author } from "@/lib/constants";
import { type DeviceRecord, DEVICE_FRESH_MS } from "@/lib/device-types";
import {
  readRestraintRaw,
  setRestraintRaw,
} from "@/lib/restraint";
import { recordObedienceEvent } from "@/lib/obedience";
import { OBEDIENCE_NOTE_MAX } from "@/lib/reward-types";
import { readFcmTokens } from "@/lib/fcm-tokens";
import { redis, requireSir, PRESENCE_FRESH_MS } from "./_shared";

// ──────────────────────────────────────────────────────────────────
// Inspector — presence + push state for both authors.
// ──────────────────────────────────────────────────────────────────

export interface PresenceInfo {
  author: Author;
  page: string | null;
  ts: number | null;
  fresh: boolean;
}

export interface PushInfo {
  author: Author;
  /** True iff at least one device has registered. */
  hasToken: boolean;
  /** Total tokens in `push:fcm:{author}` (multi-device after the SET migration). */
  tokenCount: number;
  /** Masked previews of every registered token, in arbitrary set order. */
  previews: string[];
}

export interface InspectorSnapshot {
  presence: PresenceInfo[];
  push: PushInfo[];
  capturedAt: number;
}

export interface InspectorResult {
  snapshot?: InspectorSnapshot;
  error?: string;
}

/** Read-only snapshot of presence + push token state. Sir-only. */
export async function getInspectorSnapshot(): Promise<InspectorResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const authors: Author[] = ["T7SEN", "Besho"];
  const now = Date.now();

  const [presenceRaw, pushTokens] = await Promise.all([
    Promise.all(
      authors.map((a) => redis.get<string | { page: string; ts: number }>(
        `presence:${a}`,
      )),
    ),
    Promise.all(authors.map((a) => readFcmTokens(redis, a))),
  ]);

  const presence: PresenceInfo[] = authors.map((author, i) => {
    const raw = presenceRaw[i];
    let page: string | null = null;
    let ts: number | null = null;
    if (raw) {
      try {
        const obj =
          typeof raw === "string"
            ? (JSON.parse(raw) as { page: string; ts: number })
            : raw;
        page = obj.page ?? null;
        ts = obj.ts ?? null;
      } catch {
        // legacy format — leave null
      }
    }
    return {
      author,
      page,
      ts,
      fresh: ts != null && now - ts < PRESENCE_FRESH_MS,
    };
  });

  const push: PushInfo[] = authors.map((author, i) => {
    const tokens = pushTokens[i] ?? [];
    return {
      author,
      hasToken: tokens.length > 0,
      tokenCount: tokens.length,
      previews: tokens.map((t) =>
        t.length > 12 ? `${t.slice(0, 8)}…${t.slice(-4)}` : t,
      ),
    };
  });

  return { snapshot: { presence, push, capturedAt: now } };
}

// ──────────────────────────────────────────────────────────────────
// Sessions — read epochs + force-logout.
// ──────────────────────────────────────────────────────────────────

export interface SessionEpochsResult {
  epochs?: Record<Author, number>;
  error?: string;
}

export async function getSessionEpochs(): Promise<SessionEpochsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  return { epochs: await readAllSessionEpochs() };
}

export async function forceLogoutAuthor(
  author: Author,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  try {
    await revokeAuthorSessions(author);
    logger.interaction("[admin] sessions revoked", {
      author,
      by: guard.session.author,
    });
    revalidatePath("/admin/devices");
    return { success: true };
  } catch (err) {
    logger.error("[admin] revoke failed", err, { author });
    return { error: "Revoke failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Devices — Sir-only enumeration of registered devices per author.
// ──────────────────────────────────────────────────────────────────

export interface DeviceListItem extends DeviceRecord {
  isOnline: boolean;
}

export interface ListDevicesResult {
  devices?: DeviceListItem[];
  generatedAt?: number;
  error?: string;
}

/**
 * Walk both per-author device ZSETs (newest-first), mget the records,
 * and decorate each with a runtime `isOnline` flag based on
 * `DEVICE_FRESH_MS`. Sir-only.
 */
export async function listDevices(): Promise<ListDevicesResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const [t7senIds, beshoIds] = await Promise.all([
      redis.zrange<unknown[]>("device:list:T7SEN", 0, -1, { rev: true }),
      redis.zrange<unknown[]>("device:list:Besho", 0, -1, { rev: true }),
    ]);
    const ids = [...(t7senIds ?? []), ...(beshoIds ?? [])].map(String);
    if (!ids.length) return { devices: [], generatedAt: Date.now() };

    const records =
      (await redis.mget<DeviceRecord[]>(
        ...ids.map((id) => `device:${id}`),
      )) ?? [];
    const now = Date.now();
    const devices: DeviceListItem[] = [];
    for (let i = 0; i < ids.length; i++) {
      const r = records[i];
      if (!r) continue;
      devices.push({
        ...r,
        isOnline: now - r.lastSeenAt < DEVICE_FRESH_MS,
      });
    }
    devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return { devices, generatedAt: now };
  } catch (err) {
    logger.error("[admin] device list failed", err);
    return { error: "Failed to load devices." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Restraint mode — Besho's read-only flag.
// ──────────────────────────────────────────────────────────────────

// Internal — `'use server'` files can only export async functions, so
// these constants are kept private here. External callers go through
// the `getRestraintHistory` action.
const RESTRAINT_HISTORY_KEY = "restraint:history";
const RESTRAINT_HISTORY_CAP = 200;

export interface RestraintStateResult {
  on?: boolean;
  error?: string;
}

export async function getRestraintState(): Promise<RestraintStateResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  return { on: await readRestraintRaw() };
}

export async function setRestraintState(
  on: boolean,
  note?: string,
): Promise<{ success?: boolean; error?: string; on?: boolean }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const trimmedNote =
    typeof note === "string" ? note.trim().slice(0, OBEDIENCE_NOTE_MAX) : "";
  try {
    const previous = await readRestraintRaw();
    await setRestraintRaw(on);

    // Obedience: -10 per restraint engagement (off → on transition).
    // Lifting (on → off) does NOT credit — that's not earned. Each
    // engagement gets a unique eventId so re-engagements within the
    // same week stack the penalty. Optional note rides into the
    // activity log only — never onto the ZSET member.
    if (on && !previous) {
      void recordObedienceEvent(
        "Besho",
        "restraint_engaged",
        crypto.randomUUID(),
        Date.now(),
        undefined,
        trimmedNote || undefined,
      );
    }

    // Restraint history — ZSET capped at 200, every engage AND lift
    // becomes an entry. Reason text only persists on engage; lift
    // entries are timestamp + by only. Pipeline ZADD + ZREMRANGEBYRANK
    // for the cap.
    const ts = Date.now();
    const historyEntry: RestraintHistoryEntry = {
      action: on ? "engage" : "lift",
      by: guard.session.author,
      ts,
      ...(on && trimmedNote ? { reason: trimmedNote } : {}),
    };
    try {
      const pipeline = redis.pipeline();
      pipeline.zadd(RESTRAINT_HISTORY_KEY, {
        score: ts,
        member: JSON.stringify(historyEntry),
      });
      pipeline.zremrangebyrank(
        RESTRAINT_HISTORY_KEY,
        0,
        -RESTRAINT_HISTORY_CAP - 1,
      );
      await pipeline.exec();
    } catch (err) {
      // Best-effort — history is observability, not load-bearing.
      logger.error("[admin] restraint history write failed", err);
    }

    logger.interaction("[admin] restraint toggled", {
      on,
      by: guard.session.author,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    });
    revalidatePath("/admin");
    revalidatePath("/admin/logs");
    return { success: true, on };
  } catch (err) {
    logger.error("[admin] restraint toggle failed", err);
    return { error: "Toggle failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Restraint history — small ZSET log of engage/lift transitions.
// ──────────────────────────────────────────────────────────────────

export interface RestraintHistoryEntry {
  action: "engage" | "lift";
  /** Always Sir at the moment — only Sir can toggle. Kept generic for
   *  future-proofing if the toggle ever moves. */
  by: Author;
  ts: number;
  /** Engage entries may carry the optional reason note; lift entries
   *  never do. */
  reason?: string;
}

export interface RestraintHistoryResult {
  entries?: RestraintHistoryEntry[];
  generatedAt?: number;
  error?: string;
}

/**
 * Reads the restraint history ZSET newest-first up to `limit`.
 * Sir-only — the audit is private. Limit is clamped to 1..200.
 */
export async function getRestraintHistory(
  limit: number = 50,
): Promise<RestraintHistoryResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const safeLimit = Math.max(1, Math.min(RESTRAINT_HISTORY_CAP, Math.floor(limit)));
  try {
    const raws = (await redis.zrange<unknown[]>(
      RESTRAINT_HISTORY_KEY,
      0,
      safeLimit - 1,
      { rev: true },
    )) ?? [];
    const entries: RestraintHistoryEntry[] = [];
    for (const raw of raws) {
      let parsed: RestraintHistoryEntry | null = null;
      if (typeof raw === "string") {
        try {
          parsed = JSON.parse(raw) as RestraintHistoryEntry;
        } catch {
          parsed = null;
        }
      } else if (raw && typeof raw === "object") {
        parsed = raw as RestraintHistoryEntry;
      }
      if (
        parsed &&
        (parsed.action === "engage" || parsed.action === "lift") &&
        typeof parsed.ts === "number"
      ) {
        entries.push(parsed);
      }
    }
    return { entries, generatedAt: Date.now() };
  } catch (err) {
    logger.error("[admin] restraint history read failed", err);
    return { error: "Failed to read history." };
  }
}
