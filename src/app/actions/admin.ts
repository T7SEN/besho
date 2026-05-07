// src/app/actions/admin.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  decrypt,
  readAllSessionEpochs,
  revokeAuthorSessions,
  type SessionPayload,
} from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
import { getActivity, clearActivity, type ActivityRecord } from "@/lib/activity";
import {
  listTrash,
  restoreFromTrash,
  deleteTrashEntry,
  purgeTrash,
  getTrashRetentionDays,
  setTrashRetentionDays,
  MIN_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  type TrashEntry,
  type TrashFeature,
} from "@/lib/trash";
import type { Author } from "@/lib/constants";
import { type DeviceRecord, DEVICE_FRESH_MS } from "@/lib/device-types";
import {
  readRestraintRaw,
  setRestraintRaw,
} from "@/lib/restraint";
import { todayKeyCairo } from "@/lib/cairo-time";
import { sendNotification } from "./notifications";
import type { NotificationRecord } from "./notifications";
import type { AuthFailureRecord } from "./auth";
import type {
  PermissionRequest,
  PermissionQuotas,
} from "./permissions";
import {
  PERMISSION_CATEGORIES,
  DENIAL_REASONS,
  DENIAL_REASON_COOLDOWN_HOURS,
  type AutoDecideRule,
  type DenialReason,
  type PermissionCategory,
  MAX_AUTO_RULES,
  MAX_RULE_KEYWORDS,
  MAX_RULE_KEYWORD_LENGTH,
} from "@/lib/permissions-constants";
import {
  recordObedienceEvent,
  recordObedienceEventForWeek,
  getTiers as readTiers,
  setTiersRaw,
  getWeights as readObedienceWeights,
  setWeightsRaw,
  getStreakThreshold as readStreakThreshold,
  setStreakThresholdRaw,
  getStreakRiskMinDeficit as readStreakRiskMinDeficit,
  setStreakRiskMinDeficitRaw,
  getMultipliers as readMultipliers,
  setMultipliersRaw,
  getStreak,
  setStreakRaw,
  finalizeWeek,
  computeWeekScore,
  currentWeekKey,
  getEventLog,
  deleteObedienceEvent,
  getTestMode,
  setTestModeRaw,
  repairAllObedienceZsetDrift,
  type ObedienceAuditEntry,
  type ObedienceDriftRepairResult,
} from "@/lib/obedience";
import {
  readAllCronTelemetry,
  type CronTelemetrySnapshot,
} from "@/lib/cron-telemetry";
import {
  type RewardTier,
  type RewardItem,
  type ObedienceWeights,
  type ObedienceEventType,
  REWARD_TIER_COUNT,
  TUNABLE_EVENT_TYPES,
  OBEDIENCE_EVENT_TYPES,
  REWARD_LABEL_MAX,
  REWARD_BODY_MAX,
  REWARD_EMOJI_MAX,
  TIER_EMOJI_MAX,
  TIER_NAME_MAX,
  MAX_REWARDS_PER_TIER,
  MAX_TIER_THRESHOLD,
  MAX_MULTIPLIER,
  MAX_STREAK_RISK_MIN_DEFICIT,
  MANUAL_ADJUST_MIN,
  MANUAL_ADJUST_MAX,
  MANUAL_ADJUST_REASON_MAX,
  OBEDIENCE_NOTE_MAX,
} from "@/lib/reward-types";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const PRESENCE_FRESH_MS = 12_000;

async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

async function requireSir(): Promise<
  | { ok: true; session: SessionPayload }
  | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session?.author) return { ok: false, error: "Not authenticated." };
  if (session.author !== "T7SEN") return { ok: false, error: "Forbidden." };
  return { ok: true, session };
}

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
  hasToken: boolean;
  preview: string | null;
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

  const [presenceRaw, pushRaw] = await Promise.all([
    Promise.all(
      authors.map((a) => redis.get<string | { page: string; ts: number }>(
        `presence:${a}`,
      )),
    ),
    Promise.all(authors.map((a) => redis.get<string>(`push:fcm:${a}`))),
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
    const v = pushRaw[i];
    return {
      author,
      hasToken: typeof v === "string" && v.length > 0,
      preview:
        typeof v === "string" && v.length > 12
          ? `${v.slice(0, 8)}…${v.slice(-4)}`
          : null,
    };
  });

  return { snapshot: { presence, push, capturedAt: now } };
}

// ──────────────────────────────────────────────────────────────────
// Summon kitten — bypass presence + safeword channel + max priority.
// Possessive, dominant copy. Mirrors the safeword delivery shape but
// fires from Sir to Besho instead of the other way around.
// ──────────────────────────────────────────────────────────────────

export interface SummonResult {
  success?: boolean;
  error?: string;
}

export async function summonKitten(): Promise<SummonResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    await sendNotification(
      "Besho",
      {
        title: "Heel, kitten.",
        body: "You're mine. Drop everything and come to me — now.",
        url: "/",
      },
      {
        bypassPresence: true,
        android: {
          channelId: "safeword",
          priority: "max",
          sound: "default",
        },
      },
    );
    logger.interaction("[admin] kitten summoned", {
      by: guard.session.author,
    });
    return { success: true };
  } catch (err) {
    logger.error("[admin] summon failed", err, {
      by: guard.session.author,
    });
    return { error: "Summon failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Send test push — wrap sendNotification with a Sir-only form.
// ──────────────────────────────────────────────────────────────────

export interface SendTestPushResult {
  success?: boolean;
  error?: string;
}

export async function sendTestPushAction(
  _prevState: unknown,
  formData: FormData,
): Promise<SendTestPushResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const to = formData.get("to");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const urlRaw = String(formData.get("url") ?? "").trim();
  const url = urlRaw.length > 0 ? urlRaw : "/";

  if (to !== "T7SEN" && to !== "Besho") {
    return { error: "Pick a recipient." };
  }
  if (title.length === 0) return { error: "Title is required." };
  if (title.length > 80) return { error: "Title is too long (max 80)." };
  if (body.length === 0) return { error: "Body is required." };
  if (body.length > 240) return { error: "Body is too long (max 240)." };
  if (url.length > 200) return { error: "URL is too long (max 200)." };

  try {
    await sendNotification(
      to,
      { title, body, url },
      { bypassPresence: true },
    );
    logger.interaction("[admin] test push sent", {
      to,
      title,
      url,
      by: guard.session.author,
    });
    return { success: true };
  } catch (err) {
    logger.error("[admin] test push failed", err, { to, by: guard.session.author });
    return { error: "Send failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Activity feed — read + clear.
// ──────────────────────────────────────────────────────────────────

export interface ActivityResult {
  records?: ActivityRecord[];
  error?: string;
}

export async function getActivityFeed(
  limit = 200,
): Promise<ActivityResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { records: await getActivity(limit) };
  } catch (err) {
    logger.error("[admin] activity read failed", err);
    return { error: "Failed to load activity." };
  }
}

export async function clearActivityFeed(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const n = await clearActivity();
    logger.interaction("[admin] activity cleared", {
      by: guard.session.author,
      deletedCount: n,
    });
    revalidatePath("/admin/activity");
    return { success: true, deletedCount: n };
  } catch (err) {
    logger.error("[admin] activity clear failed", err);
    return { error: "Clear failed." };
  }
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
    revalidatePath("/admin/sessions");
    return { success: true };
  } catch (err) {
    logger.error("[admin] revoke failed", err, { author });
    return { error: "Revoke failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// JSON export — dump every feature's index + records.
// ──────────────────────────────────────────────────────────────────

export interface ExportFeatureBlock {
  ids: string[];
  records: Record<string, unknown>;
  extras?: Record<string, unknown>;
}

export interface ExportPayload {
  generatedAt: number;
  generatedBy: Author;
  features: Record<string, ExportFeatureBlock>;
  system: Record<string, unknown>;
}

export interface ExportResult {
  payload?: ExportPayload;
  error?: string;
}

async function dumpZsetIndex(
  indexKey: string,
  recordKeyFn: (id: string) => string,
): Promise<ExportFeatureBlock> {
  const ids = ((await redis.zrange<unknown[]>(indexKey, 0, -1)) ?? []).map(
    String,
  );
  if (!ids.length) return { ids: [], records: {} };
  const values = (await redis.mget<unknown[]>(
    ...ids.map(recordKeyFn),
  )) ?? [];
  const records: Record<string, unknown> = {};
  for (let i = 0; i < ids.length; i++) {
    records[ids[i]] = values[i] ?? null;
  }
  return { ids, records };
}

export async function exportSnapshot(): Promise<ExportResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const [
      notes,
      rules,
      tasks,
      ledger,
      timeline,
      permissions,
      rituals,
    ] = await Promise.all([
      dumpZsetIndex("notes:index", (id) => `note:${id}`),
      dumpZsetIndex("rules:index", (id) => `rule:${id}`),
      dumpZsetIndex("tasks:index", (id) => `task:${id}`),
      dumpZsetIndex("ledger:index", (id) => `ledger:${id}`),
      dumpZsetIndex("milestones:index", (id) => `milestone:${id}`),
      dumpZsetIndex("permissions:index", (id) => `permission:${id}`),
      dumpZsetIndex("rituals:index", (id) => `ritual:${id}`),
    ]);

    // Notes extras: reactions per note + pinned set + per-author counts.
    if (notes.ids.length) {
      const reactions = await Promise.all(
        notes.ids.map((id) => redis.hgetall(`reactions:${id}`)),
      );
      const reactionMap: Record<string, unknown> = {};
      for (let i = 0; i < notes.ids.length; i++) {
        reactionMap[notes.ids[i]] = reactions[i] ?? null;
      }
      notes.extras = { reactions: reactionMap };
    }
    const [t7senCount, beshoCount] = await Promise.all([
      redis.get("notes:count:T7SEN"),
      redis.get("notes:count:Besho"),
    ]);
    notes.extras = {
      ...(notes.extras ?? {}),
      counts: { T7SEN: t7senCount ?? 0, Besho: beshoCount ?? 0 },
    };

    // Permissions extras: audits, quotas, auto-rules, denied-hashes.
    if (permissions.ids.length) {
      const audits = (await redis.mget<unknown[]>(
        ...permissions.ids.map((id) => `permission:audit:${id}`),
      )) ?? [];
      const auditMap: Record<string, unknown> = {};
      for (let i = 0; i < permissions.ids.length; i++) {
        auditMap[permissions.ids[i]] = audits[i] ?? null;
      }
      permissions.extras = { audits: auditMap };
    }
    const [quotas, autoRules, deniedHashes] = await Promise.all([
      redis.get("permissions:quotas"),
      redis.get("permissions:auto-rules"),
      redis.get("permissions:denied-hashes"),
    ]);
    permissions.extras = {
      ...(permissions.extras ?? {}),
      quotas: quotas ?? null,
      autoRules: autoRules ?? null,
      deniedHashes: deniedHashes ?? null,
    };

    // Rituals extras: occurrence indexes per ritual + streak keys.
    if (rituals.ids.length) {
      const occurrences = await Promise.all(
        rituals.ids.map((id) =>
          redis.zrange<unknown[]>(`ritual:occurrences:${id}`, 0, -1),
        ),
      );
      const streaks = await Promise.all(
        rituals.ids.map((id) =>
          Promise.all([
            redis.get(`ritual:streak:${id}`),
            redis.get(`ritual:streak:${id}:longest`),
          ]),
        ),
      );
      const occurrenceMap: Record<string, unknown> = {};
      const streakMap: Record<string, unknown> = {};
      for (let i = 0; i < rituals.ids.length; i++) {
        occurrenceMap[rituals.ids[i]] = occurrences[i] ?? [];
        streakMap[rituals.ids[i]] = {
          current: streaks[i][0] ?? 0,
          longest: streaks[i][1] ?? 0,
        };
      }
      rituals.extras = { occurrences: occurrenceMap, streaks: streakMap };
    }

    // Reviews — different shape (composite keys).
    const reviewWeeks = ((await redis.zrange<unknown[]>(
      "reviews:revealed",
      0,
      -1,
    )) ?? []).map(String);
    const reviewIds: string[] = [];
    const reviewRecords: Record<string, unknown> = {};
    if (reviewWeeks.length) {
      const keys: string[] = [];
      for (const week of reviewWeeks) {
        for (const author of ["T7SEN", "Besho"] as const) {
          keys.push(`review:${week}:${author}`);
          reviewIds.push(`${week}:${author}`);
        }
      }
      const values = (await redis.mget<unknown[]>(...keys)) ?? [];
      for (let i = 0; i < reviewIds.length; i++) {
        reviewRecords[reviewIds[i]] = values[i] ?? null;
      }
    }
    const reviews: ExportFeatureBlock = {
      ids: reviewIds,
      records: reviewRecords,
      extras: { weeks: reviewWeeks },
    };

    const [presenceT, presenceB, pushT, pushB, epochs] = await Promise.all([
      redis.get("presence:T7SEN"),
      redis.get("presence:Besho"),
      redis.get<string>("push:fcm:T7SEN"),
      redis.get<string>("push:fcm:Besho"),
      readAllSessionEpochs(),
    ]);

    const payload: ExportPayload = {
      generatedAt: Date.now(),
      generatedBy: guard.session.author,
      features: {
        notes,
        rules,
        tasks,
        ledger,
        timeline,
        permissions,
        rituals,
        reviews,
      },
      system: {
        presence: { T7SEN: presenceT ?? null, Besho: presenceB ?? null },
        // Push tokens are masked in the inspector but retained in full
        // here so a backup can re-seed FCM. The export is Sir-only.
        push: {
          T7SEN: pushT ?? null,
          Besho: pushB ?? null,
        },
        sessionEpochs: epochs,
      },
    };

    logger.interaction("[admin] export generated", {
      by: guard.session.author,
      bytes: JSON.stringify(payload).length,
    });
    return { payload };
  } catch (err) {
    logger.error("[admin] export failed", err);
    return { error: "Export failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Restraint mode — Besho's read-only flag.
// ──────────────────────────────────────────────────────────────────

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
    revalidatePath("/admin/restraint-history");
    return { success: true, on };
  } catch (err) {
    logger.error("[admin] restraint toggle failed", err);
    return { error: "Toggle failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Permissions admin — auto-rules + quotas read/write via JSON, plus
// bulk force-decide for the pending queue. The /permissions modals
// stay; this is an additional path for power-user editing.
// ──────────────────────────────────────────────────────────────────

const PERMISSIONS_INDEX = "permissions:index";
const QUOTAS_KEY = "permissions:quotas";
const AUTO_RULES_KEY = "permissions:auto-rules";
const DENIED_HASHES_KEY = "permissions:denied-hashes";
const permissionRecordKey = (id: string) => `permission:${id}`;
const reaskBlockKey = (bodyHash: string) =>
  `permission:reask-block:${bodyHash}`;

function permissionBodyHash(body: string): string {
  const normalized = body.toLowerCase().trim().replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export interface PermissionsAdminBundle {
  autoRules: AutoDecideRule[];
  quotas: PermissionQuotas;
  pendingCount: number;
  pendingByCategory: Partial<Record<PermissionCategory, number>>;
}

export async function getPermissionsAdminBundle(): Promise<{
  bundle?: PermissionsAdminBundle;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [rules, quotas, ids] = await Promise.all([
      redis.get<AutoDecideRule[]>(AUTO_RULES_KEY),
      redis.get<PermissionQuotas>(QUOTAS_KEY),
      redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, { rev: true }),
    ]);
    const idStrs = (ids ?? []).map(String);
    const records = idStrs.length
      ? ((await redis.mget<PermissionRequest[]>(
          ...idStrs.map((id) => permissionRecordKey(id)),
        )) ?? [])
      : [];
    let pendingCount = 0;
    const pendingByCategory: Partial<Record<PermissionCategory, number>> = {};
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      pendingCount++;
      if (r.category) {
        pendingByCategory[r.category] =
          (pendingByCategory[r.category] ?? 0) + 1;
      }
    }
    return {
      bundle: {
        autoRules: rules ?? [],
        quotas: quotas ?? { monthlyLimits: {} },
        pendingCount,
        pendingByCategory,
      },
    };
  } catch (err) {
    logger.error("[admin] permissions bundle read failed", err);
    return { error: "Failed to load permissions admin bundle." };
  }
}

/**
 * Validates and saves a JSON-encoded auto-rules array. Mirrors the
 * inline validator in `permissions.saveAutoRules` but operates on a
 * raw JSON string so the `/admin/permissions` page can offer a
 * power-user textarea + import path.
 */
export async function adminSaveAutoRulesJson(
  json: string,
): Promise<{ success?: boolean; error?: string; count?: number }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (typeof json !== "string" || json.trim().length === 0) {
    return { error: "JSON payload required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      error: `Invalid JSON: ${err instanceof Error ? err.message : "parse error"}.`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { error: "Top-level value must be an array." };
  }
  if (parsed.length > MAX_AUTO_RULES) {
    return { error: `Too many rules (max ${MAX_AUTO_RULES}).` };
  }
  for (const rawRule of parsed) {
    const rule = rawRule as AutoDecideRule;
    if (!rule || typeof rule !== "object") {
      return { error: "Every rule must be an object." };
    }
    if (!rule.id || typeof rule.id !== "string") {
      return { error: "Every rule needs a string id." };
    }
    if (typeof rule.enabled !== "boolean") {
      return { error: `Rule ${rule.id} missing 'enabled' boolean.` };
    }
    if (rule.decision !== "approved" && rule.decision !== "denied") {
      return { error: `Rule ${rule.id} decision must be approved or denied.` };
    }
    if (
      rule.category !== undefined &&
      !PERMISSION_CATEGORIES.includes(rule.category)
    ) {
      return { error: `Rule ${rule.id} has invalid category.` };
    }
    if (rule.priceMax !== undefined) {
      if (
        typeof rule.priceMax !== "number" ||
        !Number.isFinite(rule.priceMax) ||
        rule.priceMax < 0
      ) {
        return { error: `Rule ${rule.id} priceMax must be non-negative number.` };
      }
    }
    if (rule.bodyContainsAny !== undefined) {
      if (!Array.isArray(rule.bodyContainsAny)) {
        return { error: `Rule ${rule.id} bodyContainsAny must be an array.` };
      }
      if (rule.bodyContainsAny.length > MAX_RULE_KEYWORDS) {
        return {
          error: `Rule ${rule.id} has too many keywords (max ${MAX_RULE_KEYWORDS}).`,
        };
      }
      for (const kw of rule.bodyContainsAny) {
        if (typeof kw !== "string" || kw.length === 0) {
          return { error: `Rule ${rule.id} keywords must be non-empty strings.` };
        }
        if (kw.length > MAX_RULE_KEYWORD_LENGTH) {
          return {
            error: `Rule ${rule.id} keyword too long (max ${MAX_RULE_KEYWORD_LENGTH}).`,
          };
        }
      }
    }
    if (
      rule.denialReason !== undefined &&
      !DENIAL_REASONS.includes(rule.denialReason)
    ) {
      return { error: `Rule ${rule.id} has invalid denial reason.` };
    }
    if (typeof rule.createdAt !== "number") {
      return { error: `Rule ${rule.id} missing createdAt number.` };
    }
  }
  try {
    await redis.set(AUTO_RULES_KEY, parsed);
    logger.interaction("[admin] auto-rules saved via JSON", {
      by: guard.session.author,
      count: (parsed as AutoDecideRule[]).length,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, count: (parsed as AutoDecideRule[]).length };
  } catch (err) {
    logger.error("[admin] auto-rules JSON save failed", err);
    return { error: "Save failed." };
  }
}

/**
 * Validates and saves a JSON-encoded quotas object. Same shape as
 * `PermissionQuotas`. Empty `monthlyLimits` is valid (clears every cap).
 */
export async function adminSaveQuotasJson(
  json: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (typeof json !== "string" || json.trim().length === 0) {
    return { error: "JSON payload required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      error: `Invalid JSON: ${err instanceof Error ? err.message : "parse error"}.`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Top-level value must be an object." };
  }
  const obj = parsed as Partial<PermissionQuotas>;
  const monthlyLimits = obj.monthlyLimits ?? {};
  if (typeof monthlyLimits !== "object" || Array.isArray(monthlyLimits)) {
    return { error: "monthlyLimits must be an object." };
  }
  const cleanLimits: Partial<Record<PermissionCategory, number>> = {};
  for (const [k, v] of Object.entries(monthlyLimits)) {
    if (!PERMISSION_CATEGORIES.includes(k as PermissionCategory)) {
      return { error: `Unknown category: ${k}.` };
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 999) {
      return { error: `Limit for ${k} must be integer 0-999.` };
    }
    if (v > 0) cleanLimits[k as PermissionCategory] = v;
  }
  let maxPending: number | undefined;
  if (obj.maxPending !== undefined) {
    if (
      typeof obj.maxPending !== "number" ||
      !Number.isInteger(obj.maxPending) ||
      obj.maxPending < 0 ||
      obj.maxPending > 99
    ) {
      return { error: "maxPending must be integer 0-99." };
    }
    if (obj.maxPending > 0) maxPending = obj.maxPending;
  }
  try {
    const next: PermissionQuotas = {
      monthlyLimits: cleanLimits,
      ...(maxPending !== undefined && { maxPending }),
    };
    await redis.set(QUOTAS_KEY, next);
    logger.interaction("[admin] quotas saved via JSON", {
      by: guard.session.author,
      monthlyLimits: cleanLimits,
      maxPending,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true };
  } catch (err) {
    logger.error("[admin] quotas JSON save failed", err);
    return { error: "Save failed." };
  }
}

export interface BulkDecideArgs {
  /** Approve: minimum age in hours; pending requests older than this
   *  get approved. Deny: ignored. */
  olderThanHours?: number;
  /** Deny only — narrows to a single category. */
  category?: PermissionCategory;
  /** Optional reply applied to every approved/denied record. */
  reply?: string;
  /** Deny only — drives re-ask cooldown via DENIAL_REASON_COOLDOWN_HOURS. */
  reason?: DenialReason;
}

export interface BulkDecideResult {
  success?: boolean;
  error?: string;
  approved?: number;
  denied?: number;
}

/**
 * Walks pending permission requests older than `olderThanHours`,
 * mutates each to approved in a single pipeline. Optional reply
 * applied verbatim. Auto-emit obedience event +1 per record (idempotent
 * on id). One summary FCM to Besho instead of N per-claim FCMs.
 */
export async function bulkApprovePendingOlderThan(
  args: BulkDecideArgs,
): Promise<BulkDecideResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const hours = Number(args.olderThanHours);
  if (!Number.isFinite(hours) || hours < 1) {
    return { error: "olderThanHours must be ≥ 1." };
  }
  const reply = (args.reply ?? "").trim().slice(0, 1000);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  try {
    const ids =
      ((await redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return { success: true, approved: 0 };
    const records =
      (await redis.mget<PermissionRequest[]>(
        ...ids.map((id) => permissionRecordKey(id)),
      )) ?? [];
    const targets: PermissionRequest[] = [];
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      if (r.requestedAt > cutoff) continue;
      targets.push(r);
    }
    if (targets.length === 0) return { success: true, approved: 0 };

    const decidedAt = Date.now();
    const pipeline = redis.pipeline();
    for (const r of targets) {
      const updated: PermissionRequest = {
        ...r,
        status: "approved",
        decidedAt,
        decidedBy: "T7SEN",
      };
      delete updated.reply;
      delete updated.terms;
      delete updated.denialReason;
      if (reply) updated.reply = reply;
      pipeline.set(permissionRecordKey(r.id), updated);
    }
    await pipeline.exec();

    // Obedience: +1 per approval, fire-and-forget. eventId = request id
    // so retries are idempotent at the ZSET layer.
    for (const r of targets) {
      void recordObedienceEvent(
        "Besho",
        "permission_approved",
        r.id,
        decidedAt,
      );
    }

    // Single summary FCM.
    const noun = targets.length === 1 ? "request" : "requests";
    void sendNotification("Besho", {
      title: `✓ ${targets.length} ${noun} approved`,
      body: reply
        ? `${targets.length} pending ${noun} bulk-approved. Sir's note: "${reply.slice(0, 120)}"`
        : `${targets.length} pending ${noun} bulk-approved by Sir.`,
      url: "/permissions",
    }).catch(() => {});

    logger.interaction("[admin] bulk approved pending permissions", {
      by: guard.session.author,
      count: targets.length,
      olderThanHours: hours,
      withReply: reply.length > 0,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, approved: targets.length };
  } catch (err) {
    logger.error("[admin] bulk approve failed", err);
    return { error: "Bulk approve failed." };
  }
}

/**
 * Denies every pending request matching `category`. Optional `reason`
 * drives the re-ask cooldown per `DENIAL_REASON_COOLDOWN_HOURS`. One
 * summary FCM to Besho.
 */
export async function bulkDenyPendingByCategory(
  args: BulkDecideArgs,
): Promise<BulkDecideResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (!args.category || !PERMISSION_CATEGORIES.includes(args.category)) {
    return { error: "Valid category required." };
  }
  let reason: DenialReason | undefined;
  if (args.reason) {
    if (!DENIAL_REASONS.includes(args.reason)) {
      return { error: "Invalid denial reason." };
    }
    reason = args.reason;
  }
  const reply = (args.reply ?? "").trim().slice(0, 1000);
  try {
    const ids =
      ((await redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return { success: true, denied: 0 };
    const records =
      (await redis.mget<PermissionRequest[]>(
        ...ids.map((id) => permissionRecordKey(id)),
      )) ?? [];
    const targets: PermissionRequest[] = [];
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      if (r.category !== args.category) continue;
      targets.push(r);
    }
    if (targets.length === 0) return { success: true, denied: 0 };

    const decidedAt = Date.now();
    const cooldownHours =
      DENIAL_REASON_COOLDOWN_HOURS[reason ?? "default"] ?? 12;
    const pipeline = redis.pipeline();
    for (const r of targets) {
      const updated: PermissionRequest = {
        ...r,
        status: "denied",
        decidedAt,
        decidedBy: "T7SEN",
      };
      delete updated.reply;
      delete updated.terms;
      delete updated.denialReason;
      if (reply) updated.reply = reply;
      if (reason) updated.denialReason = reason;
      pipeline.set(permissionRecordKey(r.id), updated);
      const bodyHash = permissionBodyHash(r.body);
      pipeline.sadd(DENIED_HASHES_KEY, bodyHash);
      if (cooldownHours > 0) {
        pipeline.set(reaskBlockKey(bodyHash), "1", {
          ex: cooldownHours * 3600,
        });
      }
    }
    await pipeline.exec();

    const noun = targets.length === 1 ? "request" : "requests";
    void sendNotification("Besho", {
      title: `✗ ${targets.length} ${args.category} ${noun} denied`,
      body: reply
        ? `${targets.length} ${args.category} ${noun} denied by Sir. "${reply.slice(0, 120)}"`
        : `${targets.length} ${args.category} ${noun} denied in bulk by Sir.`,
      url: "/permissions",
    }).catch(() => {});

    logger.interaction("[admin] bulk denied pending by category", {
      by: guard.session.author,
      count: targets.length,
      category: args.category,
      reason,
      withReply: reply.length > 0,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, denied: targets.length };
  } catch (err) {
    logger.error("[admin] bulk deny failed", err);
    return { error: "Bulk deny failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Cooldown / rate-limit viewer — read-only diagnostic surface for
// the TTL'd state that's invisible in normal UIs:
//  - `permission:reask-block:{bodyHash}` — denial-cooldown blocks
//  - `safeword:cooldown:{author}` — 5-minute safeword spam-shield
//  - `permissions:denied-hashes` — SET cardinality (lifetime denials)
//
// Pre-curated for the common cases that matter when debugging "why
// can't kitten re-submit this?" or "is the safeword guard armed?"
// Pairs with /admin/redis (general-purpose), but doesn't replace it.
// ──────────────────────────────────────────────────────────────────

export interface ReaskBlockEntry {
  /** Suffix of `permission:reask-block:{bodyHash}` — body-hash only. */
  bodyHash: string;
  /** Remaining TTL in seconds; -1 = no expire (shouldn't happen for
   *  reask blocks in practice, but surfaced honestly). */
  ttlSeconds: number;
}

export interface SafewordCooldownEntry {
  author: Author;
  ttlSeconds: number | null; // null = not currently set
}

export interface CooldownState {
  reaskBlocks: ReaskBlockEntry[];
  safewordCooldowns: SafewordCooldownEntry[];
  deniedHashesCount: number;
  generatedAt: number;
}

export interface CooldownResult {
  state?: CooldownState;
  error?: string;
}

/** Hard cap on how many reask-block keys we'll surface in one call.
 *  At realistic two-user scale the active count is in the single
 *  digits — the cap is defensive, not a real bound. */
const REASK_SCAN_CAP = 200;

export async function getCooldownState(): Promise<CooldownResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    // 1. SCAN `permission:reask-block:*` — paginate until exhausted or
    //    we hit the cap. Upstash returns [cursor, keys].
    const blockKeys = new Set<string>();
    let cursor: string | number = 0;
    let safety = 0;
    do {
      const [next, keys] = (await redis.scan(cursor, {
        match: "permission:reask-block:*",
        count: 200,
      })) as [string | number, string[]];
      for (const k of keys ?? []) blockKeys.add(k);
      cursor = next;
      safety++;
      if (blockKeys.size >= REASK_SCAN_CAP) break;
      if (safety > 50) break;
    } while (
      cursor !== 0 &&
      cursor !== "0" &&
      blockKeys.size < REASK_SCAN_CAP
    );

    // 2. PTTL each block key (Upstash exposes `ttl` in seconds).
    const blockKeyArr = Array.from(blockKeys);
    const ttls = blockKeyArr.length
      ? await Promise.all(
          blockKeyArr.map((k) =>
            redis.ttl(k).catch(() => -2 as number),
          ),
        )
      : [];
    const reaskBlocks: ReaskBlockEntry[] = [];
    for (let i = 0; i < blockKeyArr.length; i++) {
      const ttl = ttls[i];
      if (typeof ttl !== "number" || ttl <= -2) continue;
      const k = blockKeyArr[i];
      const bodyHash = k.replace(/^permission:reask-block:/, "");
      reaskBlocks.push({ bodyHash, ttlSeconds: ttl });
    }
    reaskBlocks.sort((a, b) => b.ttlSeconds - a.ttlSeconds);

    // 3. Safeword cooldowns — known author keys, GET-with-TTL pattern.
    const authors: Author[] = ["T7SEN", "Besho"];
    const safewordTtls = await Promise.all(
      authors.map((a) =>
        redis.ttl(`safeword:cooldown:${a}`).catch(() => -2 as number),
      ),
    );
    const safewordCooldowns: SafewordCooldownEntry[] = authors.map(
      (author, i) => {
        const ttl = safewordTtls[i];
        return {
          author,
          // ttl returns -2 if key doesn't exist, -1 if no expire.
          ttlSeconds: typeof ttl === "number" && ttl >= 0 ? ttl : null,
        };
      },
    );

    // 4. denied-hashes set size — SCARD.
    let deniedHashesCount = 0;
    try {
      deniedHashesCount = await redis.scard("permissions:denied-hashes");
    } catch {
      deniedHashesCount = 0;
    }

    return {
      state: {
        reaskBlocks,
        safewordCooldowns,
        deniedHashesCount,
        generatedAt: Date.now(),
      },
    };
  } catch (err) {
    logger.error("[admin] cooldown viewer read failed", err);
    return { error: "Failed to read cooldown state." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Cross-feature search — single substring search across the four
// primary feature indexes (notes / rules / tasks / ledger).
// ──────────────────────────────────────────────────────────────────

export type CrossFeatureKind = "note" | "rule" | "task" | "ledger";

export interface CrossFeatureHit {
  kind: CrossFeatureKind;
  id: string;
  /** Short label — title for rules/tasks/ledger, content excerpt for notes. */
  label: string;
  /** Body excerpt highlighting the match context. */
  preview: string;
  /** ms timestamp the record sorted on (createdAt or equivalent). */
  ts: number;
  /** Path to navigate the user to the source page. */
  href: string;
}

export interface CrossFeatureSearchResult {
  query?: string;
  hits?: CrossFeatureHit[];
  scanned?: { notes: number; rules: number; tasks: number; ledger: number };
  /** Set when the query was empty/too short. */
  error?: string;
}

const SEARCH_INDEX_LIMIT = 500;
const SEARCH_HIT_CAP = 50;
const SEARCH_PREVIEW_LEN = 140;

function buildExcerpt(haystack: string, needle: string): string {
  const lower = haystack.toLowerCase();
  const i = lower.indexOf(needle.toLowerCase());
  if (i < 0) {
    return haystack.length > SEARCH_PREVIEW_LEN
      ? `${haystack.slice(0, SEARCH_PREVIEW_LEN - 1)}…`
      : haystack;
  }
  const radius = Math.floor(SEARCH_PREVIEW_LEN / 2);
  const start = Math.max(0, i - radius);
  const end = Math.min(haystack.length, i + needle.length + radius);
  const slice = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < haystack.length ? "…" : ""}`;
}

export async function searchAcrossFeatures(
  query: string,
): Promise<CrossFeatureSearchResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const q = (query ?? "").trim();
  if (q.length < 2) return { error: "Query must be at least 2 characters." };
  if (q.length > 200) return { error: "Query too long (max 200)." };

  try {
    const [noteIds, ruleIds, taskIds, ledgerIds] = await Promise.all([
      redis.zrange<unknown[]>("notes:index", 0, SEARCH_INDEX_LIMIT - 1, {
        rev: true,
      }),
      redis.zrange<unknown[]>("rules:index", 0, SEARCH_INDEX_LIMIT - 1, {
        rev: true,
      }),
      redis.zrange<unknown[]>("tasks:index", 0, SEARCH_INDEX_LIMIT - 1, {
        rev: true,
      }),
      redis.zrange<unknown[]>("ledger:index", 0, SEARCH_INDEX_LIMIT - 1, {
        rev: true,
      }),
    ]);
    const nIds = (noteIds ?? []).map(String);
    const rIds = (ruleIds ?? []).map(String);
    const tIds = (taskIds ?? []).map(String);
    const lIds = (ledgerIds ?? []).map(String);

    const [notes, rules, tasks, ledgers] = await Promise.all([
      nIds.length
        ? redis.mget<({ id?: string; content?: string; createdAt?: number } | null)[]>(
            ...nIds.map((id) => `note:${id}`),
          )
        : Promise.resolve([]),
      rIds.length
        ? redis.mget<
            ({
              id?: string;
              title?: string;
              description?: string;
              createdAt?: number;
            } | null)[]
          >(...rIds.map((id) => `rule:${id}`))
        : Promise.resolve([]),
      tIds.length
        ? redis.mget<
            ({
              id?: string;
              title?: string;
              description?: string;
              createdAt?: number;
            } | null)[]
          >(...tIds.map((id) => `task:${id}`))
        : Promise.resolve([]),
      lIds.length
        ? redis.mget<
            ({
              id?: string;
              title?: string;
              description?: string;
              category?: string;
              timestamp?: number;
            } | null)[]
          >(...lIds.map((id) => `ledger:${id}`))
        : Promise.resolve([]),
    ]);

    const lower = q.toLowerCase();
    const hits: CrossFeatureHit[] = [];

    for (let i = 0; i < (notes ?? []).length; i++) {
      const n = notes![i];
      if (!n) continue;
      const content = n.content ?? "";
      if (!content.toLowerCase().includes(lower)) continue;
      const label = content.slice(0, 60).replace(/\s+/g, " ").trim();
      hits.push({
        kind: "note",
        id: nIds[i],
        label: label || "(empty note)",
        preview: buildExcerpt(content, q),
        ts: n.createdAt ?? 0,
        href: "/notes",
      });
    }
    for (let i = 0; i < (rules ?? []).length; i++) {
      const r = rules![i];
      if (!r) continue;
      const haystack = `${r.title ?? ""}\n${r.description ?? ""}`;
      if (!haystack.toLowerCase().includes(lower)) continue;
      hits.push({
        kind: "rule",
        id: rIds[i],
        label: r.title ?? "(untitled rule)",
        preview: buildExcerpt(haystack, q),
        ts: r.createdAt ?? 0,
        href: "/rules",
      });
    }
    for (let i = 0; i < (tasks ?? []).length; i++) {
      const t = tasks![i];
      if (!t) continue;
      const haystack = `${t.title ?? ""}\n${t.description ?? ""}`;
      if (!haystack.toLowerCase().includes(lower)) continue;
      hits.push({
        kind: "task",
        id: tIds[i],
        label: t.title ?? "(untitled task)",
        preview: buildExcerpt(haystack, q),
        ts: t.createdAt ?? 0,
        href: "/tasks",
      });
    }
    for (let i = 0; i < (ledgers ?? []).length; i++) {
      const l = ledgers![i];
      if (!l) continue;
      const haystack = `${l.title ?? ""}\n${l.description ?? ""}\n${l.category ?? ""}`;
      if (!haystack.toLowerCase().includes(lower)) continue;
      hits.push({
        kind: "ledger",
        id: lIds[i],
        label: l.title ?? "(untitled entry)",
        preview: buildExcerpt(haystack, q),
        ts: l.timestamp ?? 0,
        href: "/ledger",
      });
    }

    hits.sort((a, b) => b.ts - a.ts);
    return {
      query: q,
      hits: hits.slice(0, SEARCH_HIT_CAP),
      scanned: {
        notes: nIds.length,
        rules: rIds.length,
        tasks: tIds.length,
        ledger: lIds.length,
      },
    };
  } catch (err) {
    logger.error("[admin] cross-feature search failed", err);
    return { error: "Search failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Outbound notification audit — Sir reads BOTH authors' drawer
// histories side-by-side. Lets him verify "did my recent push
// actually land in her drawer?" Currently each author only sees
// their own drawer via getNotificationHistory.
// ──────────────────────────────────────────────────────────────────

export interface NotificationAuditPair {
  author: Author;
  records: NotificationRecord[];
}

export interface NotificationAuditResult {
  pairs?: NotificationAuditPair[];
  generatedAt?: number;
  error?: string;
}

const NOTIFICATION_HISTORY_MAX = 50;
const notificationHistoryKey = (author: Author) => `notifications:${author}`;

export async function getOutboundNotificationAudit(): Promise<NotificationAuditResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const authors: Author[] = ["T7SEN", "Besho"];
    const lists = await Promise.all(
      authors.map((a) =>
        redis.lrange<NotificationRecord>(
          notificationHistoryKey(a),
          0,
          NOTIFICATION_HISTORY_MAX - 1,
        ),
      ),
    );
    const pairs: NotificationAuditPair[] = authors.map((author, i) => ({
      author,
      records: lists[i] ?? [],
    }));
    return { pairs, generatedAt: Date.now() };
  } catch (err) {
    logger.error("[admin] notification audit read failed", err);
    return { error: "Failed to read notification history." };
  }
}

/**
 * Re-fires a notification by id from the target author's drawer.
 * Calls `sendNotification` with the recorded title/body/url, which
 * lpushes a fresh entry and attempts FCM. The original entry isn't
 * removed — the new fire is additive. Sir-only.
 */
export async function resendNotification(
  author: Author,
  notificationId: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!notificationId || typeof notificationId !== "string") {
    return { error: "Invalid notification id." };
  }
  try {
    const records = await redis.lrange<NotificationRecord>(
      notificationHistoryKey(author),
      0,
      NOTIFICATION_HISTORY_MAX - 1,
    );
    const target = (records ?? []).find((r) => r?.id === notificationId);
    if (!target) {
      return { error: "Notification not found in recent history." };
    }
    await sendNotification(author, {
      title: target.title,
      body: target.body,
      url: target.url,
    });
    logger.interaction("[admin] notification re-sent", {
      by: guard.session.author,
      to: author,
      originalId: notificationId,
    });
    return { success: true };
  } catch (err) {
    logger.error("[admin] notification re-send failed", err);
    return { error: "Re-send failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Restraint history — small ZSET log of engage/lift transitions.
// ──────────────────────────────────────────────────────────────────

// Internal — `'use server'` files can only export async functions, so
// the key is kept private here. External callers go through the
// `getRestraintHistory` action.
const RESTRAINT_HISTORY_KEY = "restraint:history";
const RESTRAINT_HISTORY_CAP = 200;

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

// ──────────────────────────────────────────────────────────────────
// Auth failure log — Sir-only reader / clearer.
// ──────────────────────────────────────────────────────────────────

export interface AuthFailuresResult {
  records?: AuthFailureRecord[];
  error?: string;
}

export async function getAuthFailures(
  limit = 100,
): Promise<AuthFailuresResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const raw = ((await redis.zrange<unknown[]>(
      "auth:failures",
      0,
      limit - 1,
      { rev: true },
    )) ?? []) as unknown[];
    const out: AuthFailureRecord[] = [];
    for (const v of raw) {
      if (typeof v === "string") {
        try {
          out.push(JSON.parse(v) as AuthFailureRecord);
        } catch {
          // skip malformed
        }
      } else if (v && typeof v === "object") {
        out.push(v as AuthFailureRecord);
      }
    }
    return { records: out };
  } catch (err) {
    logger.error("[admin] auth failures read failed", err);
    return { error: "Failed to read auth log." };
  }
}

export async function clearAuthFailures(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const count = (await redis.zcard("auth:failures")) ?? 0;
    await redis.del("auth:failures");
    logger.interaction("[admin] auth log cleared", {
      by: guard.session.author,
      deletedCount: count,
    });
    revalidatePath("/admin/auth-log");
    return {
      success: true,
      deletedCount: typeof count === "number" ? count : 0,
    };
  } catch (err) {
    logger.error("[admin] auth log clear failed", err);
    return { error: "Clear failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Relationship dates — start date + per-author birthdays.
// ──────────────────────────────────────────────────────────────────

export interface RelationshipDatesResult {
  dates?: {
    relationshipStart: string | null;
    birthdayT7SEN: string | null;
    birthdayBesho: string | null;
  };
  error?: string;
}

export async function getRelationshipDates(): Promise<RelationshipDatesResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [start, t, b] = await Promise.all([
      redis.get<string>("relationship:start"),
      redis.get<string>("birthday:T7SEN"),
      redis.get<string>("birthday:Besho"),
    ]);
    return {
      dates: {
        relationshipStart: start ?? null,
        birthdayT7SEN: t ?? null,
        birthdayBesho: b ?? null,
      },
    };
  } catch (err) {
    logger.error("[admin] dates read failed", err);
    return { error: "Failed to read dates." };
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function setRelationshipDates(
  _prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const start = String(formData.get("relationshipStart") ?? "").trim();
  const t = String(formData.get("birthdayT7SEN") ?? "").trim();
  const b = String(formData.get("birthdayBesho") ?? "").trim();

  for (const v of [start, t, b]) {
    if (v && !ISO_DATE.test(v)) {
      return { error: "Dates must be in YYYY-MM-DD format." };
    }
  }

  try {
    const pipeline = redis.pipeline();
    if (start) pipeline.set("relationship:start", start);
    else pipeline.del("relationship:start");
    if (t) pipeline.set("birthday:T7SEN", t);
    else pipeline.del("birthday:T7SEN");
    if (b) pipeline.set("birthday:Besho", b);
    else pipeline.del("birthday:Besho");
    await pipeline.exec();

    logger.interaction("[admin] dates updated", {
      by: guard.session.author,
    });
    revalidatePath("/");
    revalidatePath("/admin/dates");
    return { success: true };
  } catch (err) {
    logger.error("[admin] dates write failed", err);
    return { error: "Save failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Mood override — Sir sets / clears either author's mood for any date.
// ──────────────────────────────────────────────────────────────────

export async function adminSetMoodForAuthor(
  author: Author,
  mood: string,
  dateKey?: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const trimmed = mood.trim();
  if (!trimmed) return { error: "Mood is required." };
  if (trimmed.length > 16) return { error: "Mood is too long." };

  const date = dateKey?.trim() || todayKeyCairo();
  if (!ISO_DATE.test(date)) return { error: "Invalid date." };

  try {
    await redis.set(`mood:${date}:${author}`, trimmed);
    logger.interaction("[admin] mood override set", {
      author,
      mood: trimmed,
      date,
      by: guard.session.author,
    });
    revalidatePath("/");
    revalidatePath("/admin/mood");
    return { success: true };
  } catch (err) {
    logger.error("[admin] mood override set failed", err);
    return { error: "Set failed." };
  }
}

export async function adminClearMoodForAuthor(
  author: Author,
  dateKey?: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const date = dateKey?.trim() || todayKeyCairo();
  if (!ISO_DATE.test(date)) return { error: "Invalid date." };

  try {
    await redis.del(`mood:${date}:${author}`);
    logger.interaction("[admin] mood override cleared", {
      author,
      date,
      by: guard.session.author,
    });
    revalidatePath("/");
    revalidatePath("/admin/mood");
    return { success: true };
  } catch (err) {
    logger.error("[admin] mood override clear failed", err);
    return { error: "Clear failed." };
  }
}

export async function adminSetStateForAuthor(
  author: Author,
  state: string,
  dateKey?: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const trimmed = state.trim();
  if (!trimmed) return { error: "State is required." };
  if (trimmed.length > 16) return { error: "State is too long." };

  const date = dateKey?.trim() || todayKeyCairo();
  if (!ISO_DATE.test(date)) return { error: "Invalid date." };

  try {
    await redis.set(`state:${date}:${author}`, trimmed);
    logger.interaction("[admin] state override set", {
      author,
      state: trimmed,
      date,
      by: guard.session.author,
    });
    revalidatePath("/");
    revalidatePath("/admin/mood");
    return { success: true };
  } catch (err) {
    logger.error("[admin] state override set failed", err);
    return { error: "Set failed." };
  }
}

export async function adminClearStateForAuthor(
  author: Author,
  dateKey?: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const date = dateKey?.trim() || todayKeyCairo();
  if (!ISO_DATE.test(date)) return { error: "Invalid date." };

  try {
    await redis.del(`state:${date}:${author}`);
    logger.interaction("[admin] state override cleared", {
      author,
      date,
      by: guard.session.author,
    });
    revalidatePath("/");
    revalidatePath("/admin/mood");
    return { success: true };
  } catch (err) {
    logger.error("[admin] state override clear failed", err);
    return { error: "Clear failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Stats dashboard — read-heavy roll-up across every feature.
// ──────────────────────────────────────────────────────────────────

interface RuleLite { status?: string }
interface TaskLite { status?: string }
interface PermissionLite {
  status?: string;
  requestedAt?: number;
  decidedAt?: number;
}
interface LedgerLite { type?: string }
interface RitualLite { active?: boolean; pausedUntil?: number }

export interface StatsSnapshot {
  notes: {
    total: number;
    byAuthor: Record<Author, number>;
    pinnedByAuthor: Record<Author, number>;
  };
  rules: {
    total: number;
    pending: number;
    active: number;
    completed: number;
  };
  tasks: {
    total: number;
    pending: number;
    inReview: number;
    completed: number;
    completionRate: number;
  };
  ledger: { total: number; rewards: number; punishments: number };
  permissions: {
    total: number;
    pending: number;
    approved: number;
    denied: number;
    queued: number;
    withdrawn: number;
    avgDecideLatencyMs: number | null;
  };
  rituals: { total: number; active: number; paused: number };
  reviews: { revealedWeeks: number };
  safeword: {
    total: number;
    last30d: number;
    lastTriggeredAt: number | null;
  };
  devices: { total: number; online: number };
  activity: { last24h: number };
  generatedAt: number;
}

export interface StatsResult {
  stats?: StatsSnapshot;
  error?: string;
}

export async function getStats(): Promise<StatsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const now = Date.now();
    const day30Ago = now - 30 * 86_400_000;
    const day1Ago = now - 86_400_000;

    // Index ids in parallel.
    const [
      noteIds,
      ruleIds,
      taskIds,
      permIds,
      ledgerIds,
      ritualIds,
      reviewWeeks,
      safewordHistory,
      countT,
      countB,
      countPinT,
      countPinB,
      activity24h,
      deviceIdsT,
      deviceIdsB,
    ] = await Promise.all([
      redis.zrange<unknown[]>("notes:index", 0, -1),
      redis.zrange<unknown[]>("rules:index", 0, -1),
      redis.zrange<unknown[]>("tasks:index", 0, -1),
      redis.zrange<unknown[]>("permissions:index", 0, -1),
      redis.zrange<unknown[]>("ledger:index", 0, -1),
      redis.zrange<unknown[]>("rituals:index", 0, -1),
      redis.zrange<unknown[]>("reviews:revealed", 0, -1),
      redis.lrange<{ timestamp?: number }>("safeword:history", 0, -1),
      redis.get<number | string>("notes:count:T7SEN"),
      redis.get<number | string>("notes:count:Besho"),
      // Pinned: counted from per-author pin chips. We count notes that
      // have `pinned: true` after the rules read, so leave 0 here and
      // fill after the mget below.
      Promise.resolve(0),
      Promise.resolve(0),
      redis.zcount("activity:log", day1Ago, "+inf"),
      redis.zrange<unknown[]>("device:list:T7SEN", 0, -1),
      redis.zrange<unknown[]>("device:list:Besho", 0, -1),
    ]);

    // Rules detail — mget records for status counts.
    const ruleIdList = (ruleIds ?? []).map(String);
    const rulesByStatus = { pending: 0, active: 0, completed: 0 };
    if (ruleIdList.length) {
      const recs =
        (await redis.mget<RuleLite[]>(
          ...ruleIdList.map((id) => `rule:${id}`),
        )) ?? [];
      for (const r of recs) {
        const s = r?.status;
        if (s === "pending") rulesByStatus.pending++;
        else if (s === "active") rulesByStatus.active++;
        else if (s === "completed") rulesByStatus.completed++;
      }
    }

    // Tasks detail.
    const taskIdList = (taskIds ?? []).map(String);
    const tasksByStatus = { pending: 0, inReview: 0, completed: 0 };
    if (taskIdList.length) {
      const recs =
        (await redis.mget<TaskLite[]>(
          ...taskIdList.map((id) => `task:${id}`),
        )) ?? [];
      for (const r of recs) {
        const s = r?.status;
        if (s === "pending") tasksByStatus.pending++;
        else if (s === "in_review") tasksByStatus.inReview++;
        else if (s === "completed") tasksByStatus.completed++;
      }
    }

    // Permissions detail — count by status + decide latency average.
    const permIdList = (permIds ?? []).map(String);
    const permsByStatus = {
      pending: 0,
      approved: 0,
      denied: 0,
      queued: 0,
      withdrawn: 0,
    };
    let latencyTotal = 0;
    let latencyCount = 0;
    if (permIdList.length) {
      const recs =
        (await redis.mget<PermissionLite[]>(
          ...permIdList.map((id) => `permission:${id}`),
        )) ?? [];
      for (const r of recs) {
        if (!r) continue;
        const s = r.status;
        if (s === "pending") permsByStatus.pending++;
        else if (s === "approved") permsByStatus.approved++;
        else if (s === "denied") permsByStatus.denied++;
        else if (s === "queued") permsByStatus.queued++;
        else if (s === "withdrawn") permsByStatus.withdrawn++;
        if (
          typeof r.requestedAt === "number" &&
          typeof r.decidedAt === "number" &&
          r.decidedAt > r.requestedAt
        ) {
          latencyTotal += r.decidedAt - r.requestedAt;
          latencyCount++;
        }
      }
    }

    // Ledger detail.
    const ledgerIdList = (ledgerIds ?? []).map(String);
    const ledgerByType = { rewards: 0, punishments: 0 };
    if (ledgerIdList.length) {
      const recs =
        (await redis.mget<LedgerLite[]>(
          ...ledgerIdList.map((id) => `ledger:${id}`),
        )) ?? [];
      for (const r of recs) {
        if (r?.type === "reward") ledgerByType.rewards++;
        else if (r?.type === "punishment") ledgerByType.punishments++;
      }
    }

    // Rituals detail.
    const ritualIdList = (ritualIds ?? []).map(String);
    const ritualState = { active: 0, paused: 0 };
    if (ritualIdList.length) {
      const recs =
        (await redis.mget<RitualLite[]>(
          ...ritualIdList.map((id) => `ritual:${id}`),
        )) ?? [];
      for (const r of recs) {
        if (!r) continue;
        const isPaused =
          typeof r.pausedUntil === "number" && r.pausedUntil > now;
        if (isPaused) ritualState.paused++;
        else if (r.active !== false) ritualState.active++;
      }
    }

    // Notes pinned counts — read all notes (paginated mget).
    const noteIdList = (noteIds ?? []).map(String);
    const pinnedByAuthor: Record<Author, number> = { T7SEN: 0, Besho: 0 };
    if (noteIdList.length) {
      const recs =
        (await redis.mget<{ pinned?: boolean; author?: string }[]>(
          ...noteIdList.map((id) => `note:${id}`),
        )) ?? [];
      for (const r of recs) {
        if (r?.pinned && (r.author === "T7SEN" || r.author === "Besho")) {
          pinnedByAuthor[r.author]++;
        }
      }
    }

    // Safeword detail — list capped at 50 by writer.
    const sw = safewordHistory ?? [];
    const swLast30 = sw.filter(
      (e) => typeof e?.timestamp === "number" && e.timestamp >= day30Ago,
    ).length;
    const swLast = sw.length > 0 ? (sw[0]?.timestamp ?? null) : null;

    // Devices.
    const deviceIds = [
      ...((deviceIdsT ?? []) as unknown[]),
      ...((deviceIdsB ?? []) as unknown[]),
    ].map(String);
    let devicesOnline = 0;
    if (deviceIds.length) {
      const drecs =
        (await redis.mget<DeviceRecord[]>(
          ...deviceIds.map((id) => `device:${id}`),
        )) ?? [];
      for (const d of drecs) {
        if (d && now - d.lastSeenAt < DEVICE_FRESH_MS) devicesOnline++;
      }
    }

    const stats: StatsSnapshot = {
      notes: {
        total: noteIdList.length,
        byAuthor: {
          T7SEN: Number(countT) || 0,
          Besho: Number(countB) || 0,
        },
        pinnedByAuthor,
      },
      rules: {
        total: ruleIdList.length,
        pending: rulesByStatus.pending,
        active: rulesByStatus.active,
        completed: rulesByStatus.completed,
      },
      tasks: {
        total: taskIdList.length,
        pending: tasksByStatus.pending,
        inReview: tasksByStatus.inReview,
        completed: tasksByStatus.completed,
        completionRate:
          taskIdList.length > 0
            ? tasksByStatus.completed / taskIdList.length
            : 0,
      },
      ledger: {
        total: ledgerIdList.length,
        rewards: ledgerByType.rewards,
        punishments: ledgerByType.punishments,
      },
      permissions: {
        total: permIdList.length,
        ...permsByStatus,
        avgDecideLatencyMs:
          latencyCount > 0 ? latencyTotal / latencyCount : null,
      },
      rituals: {
        total: ritualIdList.length,
        active: ritualState.active,
        paused: ritualState.paused,
      },
      reviews: { revealedWeeks: (reviewWeeks ?? []).length },
      safeword: {
        total: sw.length,
        last30d: swLast30,
        lastTriggeredAt:
          typeof swLast === "number" ? swLast : null,
      },
      devices: { total: deviceIds.length, online: devicesOnline },
      activity: {
        last24h: typeof activity24h === "number" ? activity24h : 0,
      },
      generatedAt: now,
    };

    // Suppress unused-fixed-zero placeholders.
    void countPinT;
    void countPinB;

    return { stats };
  } catch (err) {
    logger.error("[admin] stats failed", err);
    return { error: "Stats failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Activity heatmap — per-day event counts over a window.
// ──────────────────────────────────────────────────────────────────

const HEATMAP_SOURCES = [
  { label: "notes", key: "notes:index" },
  { label: "ledger", key: "ledger:index" },
  { label: "permissions", key: "permissions:index" },
  { label: "tasks", key: "tasks:index" },
  { label: "rules", key: "rules:index" },
  { label: "milestones", key: "milestones:index" },
  { label: "rituals", key: "rituals:index" },
  { label: "reviews", key: "reviews:revealed" },
] as const;

export interface HeatmapDay {
  date: string;
  ts: number;
  count: number;
  bySource: Record<string, number>;
}

export interface HeatmapResult {
  days?: HeatmapDay[];
  windowDays?: number;
  generatedAt?: number;
  error?: string;
}

export async function getActivityHeatmap(
  windowDays = 30,
): Promise<HeatmapResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const days = Math.max(7, Math.min(180, Math.floor(windowDays)));

  try {
    const now = Date.now();
    const dayStartMs = (ts: number) =>
      Math.floor(ts / 86_400_000) * 86_400_000;
    const todayStart = dayStartMs(now);
    const windowStart = todayStart - (days - 1) * 86_400_000;

    const buckets: HeatmapDay[] = [];
    for (let i = 0; i < days; i++) {
      const ts = windowStart + i * 86_400_000;
      buckets.push({
        date: new Date(ts).toISOString().slice(0, 10),
        ts,
        count: 0,
        bySource: {},
      });
    }
    const indexByTs = new Map(buckets.map((b) => [b.ts, b]));

    // Read every source's scored entries in the window in parallel.
    const reads = await Promise.all(
      HEATMAP_SOURCES.map((src) =>
        redis.zrange<unknown[]>(
          src.key,
          windowStart,
          now,
          { byScore: true },
        ),
      ),
    );

    for (let i = 0; i < HEATMAP_SOURCES.length; i++) {
      const src = HEATMAP_SOURCES[i];
      const members = (reads[i] ?? []) as unknown[];
      if (!members.length) continue;
      // To bucket we need scores; fetch them via zscore in a pipeline.
      const p = redis.pipeline();
      for (const m of members) p.zscore(src.key, String(m));
      const scores = (await p.exec<(number | string | null)[]>()) ?? [];
      for (let j = 0; j < members.length; j++) {
        const raw = scores[j];
        const score =
          typeof raw === "number" ? raw : Number(raw ?? 0);
        if (!Number.isFinite(score)) continue;
        const bucketTs = dayStartMs(score);
        const b = indexByTs.get(bucketTs);
        if (!b) continue;
        b.count++;
        b.bySource[src.label] = (b.bySource[src.label] ?? 0) + 1;
      }
    }

    return { days: buckets, windowDays: days, generatedAt: now };
  } catch (err) {
    logger.error("[admin] heatmap failed", err);
    return { error: "Heatmap failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Health snapshot + index repair.
// ──────────────────────────────────────────────────────────────────

export interface HealthSnapshot {
  redis: {
    ok: boolean;
    latencyMs: number | null;
  };
  fcm: {
    credentialsPresent: boolean;
    tokensRegistered: Record<Author, boolean>;
  };
  errorsLast24h: number;
  warningsLast24h: number;
  pinnedSetSize: number;
  countKeysVsIndex: {
    indexTotal: number;
    storedT7SEN: number;
    storedBesho: number;
    expectedT7SEN: number;
    expectedBesho: number;
    drift: number;
  };
  generatedAt: number;
}

export interface HealthResult {
  health?: HealthSnapshot;
  error?: string;
}

export async function getHealthSnapshot(): Promise<HealthResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const now = Date.now();
  let redisOk = false;
  let redisLatency: number | null = null;
  try {
    const t0 = performance.now();
    await redis.get("__health_probe__");
    redisLatency = Math.round(performance.now() - t0);
    redisOk = true;
  } catch {
    redisOk = false;
  }

  const credsPresent = !!(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );

  let tokensT = false;
  let tokensB = false;
  let errorsLast24h = 0;
  let warningsLast24h = 0;
  let pinnedSetSize = 0;
  let indexTotal = 0;
  let storedT = 0;
  let storedB = 0;
  let expectedT = 0;
  let expectedB = 0;
  try {
    const day1Ago = now - 86_400_000;
    const [tT, tB, pinned, indexIds, ctT, ctB] = await Promise.all([
      redis.get<string>("push:fcm:T7SEN"),
      redis.get<string>("push:fcm:Besho"),
      redis.smembers("notes:pinned"),
      redis.zrange<unknown[]>("notes:index", 0, -1),
      redis.get<number | string>("notes:count:T7SEN"),
      redis.get<number | string>("notes:count:Besho"),
    ]);
    tokensT = typeof tT === "string" && tT.length > 0;
    tokensB = typeof tB === "string" && tB.length > 0;
    pinnedSetSize = (pinned ?? []).length;
    const ids = (indexIds ?? []).map(String);
    indexTotal = ids.length;
    storedT = Number(ctT) || 0;
    storedB = Number(ctB) || 0;
    if (ids.length) {
      const recs =
        (await redis.mget<{ author?: string }[]>(
          ...ids.map((id) => `note:${id}`),
        )) ?? [];
      for (const r of recs) {
        if (r?.author === "T7SEN") expectedT++;
        else if (r?.author === "Besho") expectedB++;
      }
    }

    // Recent activity log severities.
    const recent =
      (await redis.zrange<unknown[]>(
        "activity:log",
        day1Ago,
        now,
        { byScore: true },
      )) ?? [];
    for (const v of recent) {
      let parsed: { level?: string } | null = null;
      if (typeof v === "string") {
        try {
          parsed = JSON.parse(v) as { level?: string };
        } catch {
          parsed = null;
        }
      } else if (v && typeof v === "object") {
        parsed = v as { level?: string };
      }
      if (!parsed) continue;
      if (parsed.level === "error" || parsed.level === "fatal")
        errorsLast24h++;
      else if (parsed.level === "warn") warningsLast24h++;
    }
  } catch (err) {
    logger.error("[admin] health probe partial failure", err);
  }

  const health: HealthSnapshot = {
    redis: { ok: redisOk, latencyMs: redisLatency },
    fcm: {
      credentialsPresent: credsPresent,
      tokensRegistered: { T7SEN: tokensT, Besho: tokensB },
    },
    errorsLast24h,
    warningsLast24h,
    pinnedSetSize,
    countKeysVsIndex: {
      indexTotal,
      storedT7SEN: storedT,
      storedBesho: storedB,
      expectedT7SEN: expectedT,
      expectedBesho: expectedB,
      drift:
        Math.abs(storedT - expectedT) + Math.abs(storedB - expectedB),
    },
    generatedAt: now,
  };
  return { health };
}

export interface RepairResult {
  success?: boolean;
  error?: string;
  repaired?: {
    countT7SEN: { before: number; after: number };
    countBesho: { before: number; after: number };
    pinnedRemoved: number;
  };
}

/**
 * Recompute `notes:count:{author}` from the actual note records in the
 * index, and prune `notes:pinned` set members whose underlying note
 * has gone away (e.g. after a manual purge that bypassed the helpers).
 */
export async function repairIndexes(): Promise<RepairResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  try {
    const [indexIds, beforeT, beforeB, pinnedMembers] = await Promise.all([
      redis.zrange<unknown[]>("notes:index", 0, -1),
      redis.get<number | string>("notes:count:T7SEN"),
      redis.get<number | string>("notes:count:Besho"),
      redis.smembers("notes:pinned"),
    ]);
    const ids = (indexIds ?? []).map(String);
    let nT = 0;
    let nB = 0;
    const existingIds = new Set<string>();
    if (ids.length) {
      const recs =
        (await redis.mget<{ author?: string }[]>(
          ...ids.map((id) => `note:${id}`),
        )) ?? [];
      for (let i = 0; i < ids.length; i++) {
        const r = recs[i];
        if (!r) continue;
        existingIds.add(ids[i]);
        if (r.author === "T7SEN") nT++;
        else if (r.author === "Besho") nB++;
      }
    }

    const stalePinned = (pinnedMembers ?? []).filter(
      (m) => !existingIds.has(String(m)),
    );

    const pipeline = redis.pipeline();
    pipeline.set("notes:count:T7SEN", nT);
    pipeline.set("notes:count:Besho", nB);
    if (stalePinned.length) {
      pipeline.srem("notes:pinned", ...(stalePinned as string[]));
    }
    await pipeline.exec();

    logger.interaction("[admin] indexes repaired", {
      by: guard.session.author,
      countT: { before: Number(beforeT) || 0, after: nT },
      countB: { before: Number(beforeB) || 0, after: nB },
      stalePinnedRemoved: stalePinned.length,
    });
    revalidatePath("/notes");
    revalidatePath("/admin/health");

    return {
      success: true,
      repaired: {
        countT7SEN: { before: Number(beforeT) || 0, after: nT },
        countBesho: { before: Number(beforeB) || 0, after: nB },
        pinnedRemoved: stalePinned.length,
      },
    };
  } catch (err) {
    logger.error("[admin] repair failed", err);
    return { error: "Repair failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Cron telemetry — Sir-only read of `cron:last-run:{name}` for the
// three cron-job.org-driven routes. Closes the visibility hole that
// made the earlier FCM-spam debug feel blind.
// ──────────────────────────────────────────────────────────────────

export interface CronTelemetryResult {
  snapshots?: CronTelemetrySnapshot[];
  generatedAt?: number;
  error?: string;
}

export async function getCronTelemetry(): Promise<CronTelemetryResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const snapshots = await readAllCronTelemetry();
    return { snapshots, generatedAt: Date.now() };
  } catch (err) {
    logger.error("[admin] cron telemetry read failed", err);
    return { error: "Failed to read cron telemetry." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Obedience ZSET drift repair — events vs audit reconciliation.
// Parallel to `repairIndexes` for notes. Sweeps both authors over the
// current week + the prior 4 weeks. Cheap insurance against half-
// failed `recordObedienceEvent` writes (one ZADD landed, the other
// didn't).
// ──────────────────────────────────────────────────────────────────

export interface ObedienceDriftRepairSummary {
  totals: {
    eventsToAuditAdded: number;
    auditOrphansRemoved: number;
    weeksScanned: number;
  };
  perWeek: Array<
    { author: Author; weekKey: string } & ObedienceDriftRepairResult
  >;
}

export interface RepairObedienceDriftResult {
  success?: boolean;
  error?: string;
  summary?: ObedienceDriftRepairSummary;
}

export async function repairObedienceDrift(): Promise<RepairObedienceDriftResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const summary = await repairAllObedienceZsetDrift(4);
    logger.interaction("[admin] obedience drift repaired", {
      by: guard.session.author,
      eventsToAuditAdded: summary.totals.eventsToAuditAdded,
      auditOrphansRemoved: summary.totals.auditOrphansRemoved,
      weeksScanned: summary.totals.weeksScanned,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/admin/health");
    revalidatePath("/rewards");
    return { success: true, summary };
  } catch (err) {
    logger.error("[admin] obedience drift repair failed", err);
    return { error: "Repair failed." };
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
// Trash — list / restore / permanently delete / purge.
// ──────────────────────────────────────────────────────────────────

export interface TrashListResult {
  entries?: TrashEntry[];
  error?: string;
}

export async function getTrashList(
  feature?: TrashFeature,
): Promise<TrashListResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const entries = await listTrash(redis, { feature, limit: 200 });
    return { entries };
  } catch (err) {
    logger.error("[admin] trash list failed", err);
    return { error: "Failed to load trash." };
  }
}

export async function restoreTrashEntryAction(
  feature: TrashFeature,
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const entry = await restoreFromTrash(redis, feature, id);
    if (!entry) return { error: "Already gone or expired." };
    logger.interaction("[admin] trash restored", {
      feature,
      id,
      by: guard.session.author,
    });
    revalidatePath("/admin/trash");
    revalidatePath(`/${feature}`);
    return { success: true };
  } catch (err) {
    logger.error("[admin] restore failed", err, { feature, id });
    return { error: "Restore failed." };
  }
}

export async function deleteTrashEntryAction(
  feature: TrashFeature,
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    await deleteTrashEntry(redis, feature, id);
    logger.interaction("[admin] trash entry deleted", {
      feature,
      id,
      by: guard.session.author,
    });
    revalidatePath("/admin/trash");
    return { success: true };
  } catch (err) {
    logger.error("[admin] trash delete failed", err, { feature, id });
    return { error: "Delete failed." };
  }
}

export interface TrashRetentionResult {
  days?: number;
  min?: number;
  max?: number;
  error?: string;
}

export async function getTrashRetention(): Promise<TrashRetentionResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const days = await getTrashRetentionDays(redis);
    return {
      days,
      min: MIN_TRASH_RETENTION_DAYS,
      max: MAX_TRASH_RETENTION_DAYS,
    };
  } catch (err) {
    logger.error("[admin] retention read failed", err);
    return { error: "Read failed." };
  }
}

export async function setTrashRetention(
  days: number,
): Promise<{ success?: boolean; error?: string; days?: number }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    await setTrashRetentionDays(redis, days);
    logger.interaction("[admin] trash retention updated", {
      by: guard.session.author,
      days,
    });
    revalidatePath("/admin/trash");
    return { success: true, days: Math.floor(Number(days)) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Save failed.";
    return { error: msg };
  }
}

export async function purgeTrashAction(
  feature?: TrashFeature,
): Promise<{ success?: boolean; error?: string; deletedCount?: number }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const n = await purgeTrash(redis, feature);
    logger.warn("[admin] trash purged", {
      feature: feature ?? "*",
      by: guard.session.author,
      deletedCount: n,
    });
    revalidatePath("/admin/trash");
    return { success: true, deletedCount: n };
  } catch (err) {
    logger.error("[admin] trash purge failed", err, {
      feature: feature ?? "*",
    });
    return { error: "Purge failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Rewards / obedience tunables — Sir-only catalog + weight editor.
// ──────────────────────────────────────────────────────────────────

export interface RewardTiersResult {
  tiers?: RewardTier[];
  error?: string;
}

export async function getRewardTiers(): Promise<RewardTiersResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { tiers: await readTiers() };
  } catch (err) {
    logger.error("[admin] tiers read failed", err);
    return { error: "Failed to read tiers." };
  }
}

function validateTiers(tiers: unknown): RewardTier[] | { error: string } {
  if (!Array.isArray(tiers)) return { error: "Tiers must be an array." };
  if (tiers.length !== REWARD_TIER_COUNT) {
    return {
      error: `Tier count is fixed at ${REWARD_TIER_COUNT}.`,
    };
  }
  const seenTierIds = new Set<string>();
  let lastThreshold = -Infinity;
  const out: RewardTier[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] as Partial<RewardTier> | null | undefined;
    if (!t || typeof t !== "object") {
      return { error: `Tier ${i + 1} is malformed.` };
    }
    const id = typeof t.id === "string" ? t.id.trim() : "";
    if (!id) return { error: `Tier ${i + 1} is missing an id.` };
    if (seenTierIds.has(id)) {
      return { error: `Duplicate tier id: ${id}.` };
    }
    seenTierIds.add(id);

    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return { error: `Tier ${i + 1} needs a name.` };
    if (name.length > TIER_NAME_MAX) {
      return { error: `Tier name too long (max ${TIER_NAME_MAX}).` };
    }

    const tierEmoji = typeof t.emoji === "string" ? t.emoji.trim() : "";
    if (tierEmoji.length > TIER_EMOJI_MAX) {
      return {
        error: `Tier emoji too long (max ${TIER_EMOJI_MAX} chars).`,
      };
    }

    const threshold = Number(t.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > MAX_TIER_THRESHOLD) {
      return {
        error: `Tier ${i + 1} threshold must be 0-${MAX_TIER_THRESHOLD}.`,
      };
    }
    if (threshold < lastThreshold) {
      return { error: "Tier thresholds must be ascending." };
    }
    lastThreshold = threshold;

    if (!Array.isArray(t.rewards)) {
      return { error: `Tier ${i + 1} rewards must be an array.` };
    }
    if (t.rewards.length > MAX_REWARDS_PER_TIER) {
      return {
        error: `Too many rewards in ${name} (max ${MAX_REWARDS_PER_TIER}).`,
      };
    }
    const seenRewardIds = new Set<string>();
    const rewards: RewardItem[] = [];
    for (let j = 0; j < t.rewards.length; j++) {
      const r = t.rewards[j] as Partial<RewardItem> | null | undefined;
      if (!r || typeof r !== "object") {
        return { error: `Reward ${j + 1} in ${name} is malformed.` };
      }
      const rid = typeof r.id === "string" ? r.id.trim() : "";
      if (!rid) {
        return { error: `Reward ${j + 1} in ${name} is missing an id.` };
      }
      if (seenRewardIds.has(rid)) {
        return { error: `Duplicate reward id in ${name}: ${rid}.` };
      }
      seenRewardIds.add(rid);

      const label = typeof r.label === "string" ? r.label.trim() : "";
      if (!label) {
        return { error: `Reward ${j + 1} in ${name} needs a label.` };
      }
      if (label.length > REWARD_LABEL_MAX) {
        return {
          error: `Reward label too long (max ${REWARD_LABEL_MAX}).`,
        };
      }
      const body = typeof r.body === "string" ? r.body.trim() : "";
      if (body.length > REWARD_BODY_MAX) {
        return {
          error: `Reward body too long (max ${REWARD_BODY_MAX}).`,
        };
      }
      const emoji = typeof r.emoji === "string" ? r.emoji.trim() : "";
      if (emoji.length > REWARD_EMOJI_MAX) {
        return {
          error: `Reward emoji too long (max ${REWARD_EMOJI_MAX} chars).`,
        };
      }
      rewards.push({
        id: rid,
        label,
        ...(body.length > 0 && { body }),
        ...(emoji.length > 0 && { emoji }),
      });
    }

    out.push({
      id,
      name,
      threshold,
      rewards,
      ...(tierEmoji.length > 0 && { emoji: tierEmoji }),
    });
  }
  return out;
}

export async function setRewardTiers(
  tiers: RewardTier[],
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  const validated = validateTiers(tiers);
  if ("error" in validated) return { error: validated.error };

  try {
    await setTiersRaw(validated);
    logger.interaction("[admin] reward tiers updated", {
      by: guard.session.author,
      count: validated.length,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] tiers write failed", err);
    return { error: "Save failed." };
  }
}

export interface ObedienceWeightsResult {
  weights?: ObedienceWeights;
  error?: string;
}

export async function getObedienceWeights(): Promise<ObedienceWeightsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { weights: await readObedienceWeights() };
  } catch (err) {
    logger.error("[admin] weights read failed", err);
    return { error: "Failed to read weights." };
  }
}

export async function setObedienceWeights(
  weights: ObedienceWeights,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (!weights || typeof weights !== "object") {
    return { error: "Invalid weights." };
  }
  const sanitized = {} as ObedienceWeights;
  for (const type of TUNABLE_EVENT_TYPES) {
    const v = Number((weights as Record<string, unknown>)[type]);
    if (!Number.isFinite(v) || v < -100 || v > 100) {
      return { error: `Weight for ${type} must be -100..100.` };
    }
    sanitized[type] = Math.round(v);
  }
  // manual_adjust is non-tunable; the stored default is 0 and unused
  // (every emit supplies its points value explicitly).
  sanitized.manual_adjust = 0;
  try {
    await setWeightsRaw(sanitized);
    logger.interaction("[admin] obedience weights updated", {
      by: guard.session.author,
    });
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] weights write failed", err);
    return { error: "Save failed." };
  }
}

export interface StreakSettingsResult {
  threshold?: number;
  multipliers?: readonly number[];
  error?: string;
}

export async function getStreakSettings(): Promise<StreakSettingsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [threshold, multipliers] = await Promise.all([
      readStreakThreshold(),
      readMultipliers(),
    ]);
    return { threshold, multipliers };
  } catch (err) {
    logger.error("[admin] streak settings read failed", err);
    return { error: "Failed to read streak settings." };
  }
}

export async function setStreakSettings(
  threshold: number,
  multipliers: number[],
  streakRiskMinDeficit?: number,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > MAX_TIER_THRESHOLD
  ) {
    return { error: `Threshold must be 0-${MAX_TIER_THRESHOLD}.` };
  }
  if (!Array.isArray(multipliers) || multipliers.length === 0) {
    return { error: "Multipliers must be a non-empty array." };
  }
  if (multipliers.length > 10) {
    return { error: "Too many multiplier steps (max 10)." };
  }
  for (const m of multipliers) {
    if (!Number.isFinite(m) || m < 0 || m > MAX_MULTIPLIER) {
      return { error: `Each multiplier must be 0-${MAX_MULTIPLIER}.` };
    }
  }
  let normalizedDeficit: number | undefined;
  if (streakRiskMinDeficit !== undefined) {
    if (
      !Number.isFinite(streakRiskMinDeficit) ||
      streakRiskMinDeficit < 1 ||
      streakRiskMinDeficit > MAX_STREAK_RISK_MIN_DEFICIT
    ) {
      return {
        error: `Streak-risk min deficit must be 1-${MAX_STREAK_RISK_MIN_DEFICIT}.`,
      };
    }
    normalizedDeficit = Math.round(streakRiskMinDeficit);
  }
  try {
    const writes: Promise<unknown>[] = [
      setStreakThresholdRaw(Math.round(threshold)),
      setMultipliersRaw(multipliers.map((m) => Number(m.toFixed(2)))),
    ];
    if (normalizedDeficit !== undefined) {
      writes.push(setStreakRiskMinDeficitRaw(normalizedDeficit));
    }
    await Promise.all(writes);
    logger.interaction("[admin] streak settings updated", {
      by: guard.session.author,
      threshold,
      multipliers,
      ...(normalizedDeficit !== undefined
        ? { streakRiskMinDeficit: normalizedDeficit }
        : {}),
    });
    revalidatePath("/admin/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] streak settings write failed", err);
    return { error: "Save failed." };
  }
}

export interface RecomputeWeekResult {
  success?: boolean;
  error?: string;
  finalized?: boolean;
  reason?: string;
  displayedScore?: number;
}

export async function recomputeWeek(
  author: Author,
  weekKey: string,
): Promise<RecomputeWeekResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) {
    return { error: "Invalid week key." };
  }
  try {
    const result = await finalizeWeek(author, weekKey);
    logger.interaction("[admin] week recomputed", {
      by: guard.session.author,
      author,
      weekKey,
      ...result,
    });
    revalidatePath("/rewards");
    revalidatePath("/admin/rewards");
    return { success: true, ...result };
  } catch (err) {
    logger.error("[admin] recompute failed", err);
    return { error: "Recompute failed." };
  }
}

export interface ObedienceAdminSnapshot {
  besho: {
    currentWeek: { weekKey: string; rawScore: number; displayedScore: number };
    streak: number;
  };
  weights: ObedienceWeights;
  tiers: RewardTier[];
  streakThreshold: number;
  /** Minimum displayed-pts deficit before the Friday streak-at-risk
   *  FCM fires. Default 1; raise to suppress trivial nudges. */
  streakRiskMinDeficit: number;
  multipliers: readonly number[];
  generatedAt: number;
}

export async function getObedienceAdminSnapshot(): Promise<{
  snapshot?: ObedienceAdminSnapshot;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [tiers, weights, threshold, mults, streak, streakRiskMinDeficit] =
      await Promise.all([
        readTiers(),
        readObedienceWeights(),
        readStreakThreshold(),
        readMultipliers(),
        getStreak("Besho"),
        readStreakRiskMinDeficit(),
      ]);
    const weekKey = currentWeekKey();
    const score = await computeWeekScore("Besho", weekKey);
    return {
      snapshot: {
        besho: {
          currentWeek: {
            weekKey,
            rawScore: score.rawScore,
            displayedScore: score.displayedScore,
          },
          streak,
        },
        weights,
        tiers,
        streakThreshold: threshold,
        streakRiskMinDeficit,
        multipliers: mults,
        generatedAt: Date.now(),
      },
    };
  } catch (err) {
    logger.error("[admin] obedience snapshot failed", err);
    return { error: "Snapshot failed." };
  }
}

export async function adminSetStreakRaw(
  author: Author,
  value: number,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const n = Math.max(0, Math.floor(Number(value)));
  if (!Number.isFinite(n)) return { error: "Invalid streak value." };
  try {
    await setStreakRaw(author, n);
    logger.interaction("[admin] streak override", {
      by: guard.session.author,
      author,
      value: n,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true };
  } catch (err) {
    logger.error("[admin] streak override failed", err);
    return { error: "Override failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Manual obedience adjustment — Sir grants ad-hoc points or penalty.
// Lands as a `manual_adjust` event with the supplied points value.
// ──────────────────────────────────────────────────────────────────

export interface AdjustScoreArgs {
  author: Author;
  points: number;
  reason: string;
  /** Optional override; defaults to the current week. */
  weekKey?: string;
}

// ──────────────────────────────────────────────────────────────────
// Deploy info — version, commit, branch, env, server time.
// Vercel injects VERCEL_GIT_* env vars at build; local dev gets nulls.
// ──────────────────────────────────────────────────────────────────

export interface DeployInfo {
  version: string;
  commitSha: string | null;
  /** Short SHA — first 7 chars of `commitSha`, or null. */
  commitShaShort: string | null;
  branch: string | null;
  env: string;
  deployId: string | null;
  serverTime: number;
}

export async function getDeployInfo(): Promise<{
  info?: DeployInfo;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  // Imported lazily so a malformed package.json never blocks the bundle.
  const pkg = (await import("../../../package.json")) as {
    version?: string;
  };
  const sha = process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  return {
    info: {
      version: pkg.version ?? "0.0.0",
      commitSha: sha,
      commitShaShort: sha ? sha.slice(0, 7) : null,
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      env:
        process.env.VERCEL_ENV ??
        process.env.NODE_ENV ??
        "unknown",
      deployId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      serverTime: Date.now(),
    },
  };
}

// ──────────────────────────────────────────────────────────────────
// Redis key inspector — read-only probe by exact key.
// ──────────────────────────────────────────────────────────────────

export type RedisKeyType =
  | "string"
  | "list"
  | "set"
  | "zset"
  | "hash"
  | "none";

export interface RedisInspectResult {
  key?: string;
  type?: RedisKeyType;
  exists?: boolean;
  /** Seconds; -1 = no TTL, -2 = key missing, ≥0 = remaining seconds. */
  ttl?: number;
  /** Length for collections, character length for strings. */
  size?: number;
  /** Truncation flag — `preview` may be a partial view of a large value. */
  truncated?: boolean;
  /** Type-specific preview shape. */
  stringValue?: string;
  listMembers?: string[];
  setMembers?: string[];
  zsetMembers?: { member: string; score: number }[];
  hashEntries?: Record<string, string>;
  error?: string;
}

const REDIS_INSPECT_PREVIEW_LIMIT = 200;
const REDIS_INSPECT_STRING_LIMIT = 4000;

export async function inspectRedisKey(
  key: string,
): Promise<RedisInspectResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const trimmed = (key ?? "").trim();
  if (!trimmed) return { error: "Key is required." };
  if (trimmed.length > 500) return { error: "Key too long." };

  try {
    const [type, ttl] = await Promise.all([
      redis.type(trimmed) as Promise<RedisKeyType>,
      redis.ttl(trimmed) as Promise<number>,
    ]);
    if (type === "none") {
      return {
        key: trimmed,
        type,
        exists: false,
        ttl: typeof ttl === "number" ? ttl : -2,
      };
    }
    const base: RedisInspectResult = {
      key: trimmed,
      type,
      exists: true,
      ttl: typeof ttl === "number" ? ttl : -1,
    };

    if (type === "string") {
      const v = await redis.get<unknown>(trimmed);
      const s =
        v == null
          ? ""
          : typeof v === "string"
            ? v
            : JSON.stringify(v);
      const truncated = s.length > REDIS_INSPECT_STRING_LIMIT;
      return {
        ...base,
        size: s.length,
        truncated,
        stringValue: truncated ? s.slice(0, REDIS_INSPECT_STRING_LIMIT) : s,
      };
    }
    if (type === "list") {
      const len = (await redis.llen(trimmed)) ?? 0;
      const members =
        ((await redis.lrange<string>(
          trimmed,
          0,
          REDIS_INSPECT_PREVIEW_LIMIT - 1,
        )) ?? []).map((v) =>
          typeof v === "string" ? v : JSON.stringify(v),
        );
      return {
        ...base,
        size: len,
        truncated: len > members.length,
        listMembers: members,
      };
    }
    if (type === "set") {
      const all = (await redis.smembers(trimmed)) ?? [];
      const truncated = all.length > REDIS_INSPECT_PREVIEW_LIMIT;
      return {
        ...base,
        size: all.length,
        truncated,
        setMembers: (truncated
          ? all.slice(0, REDIS_INSPECT_PREVIEW_LIMIT)
          : all
        ).map(String),
      };
    }
    if (type === "zset") {
      const len = (await redis.zcard(trimmed)) ?? 0;
      const raw =
        ((await redis.zrange<(string | number)[]>(
          trimmed,
          0,
          REDIS_INSPECT_PREVIEW_LIMIT - 1,
          { rev: true, withScores: true },
        )) as (string | number)[]) ?? [];
      const members: { member: string; score: number }[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        members.push({
          member: String(raw[i]),
          score: Number(raw[i + 1]) || 0,
        });
      }
      return {
        ...base,
        size: len,
        truncated: len > members.length,
        zsetMembers: members,
      };
    }
    if (type === "hash") {
      const all = (await redis.hgetall<Record<string, unknown>>(trimmed)) ?? {};
      const keys = Object.keys(all);
      const truncated = keys.length > REDIS_INSPECT_PREVIEW_LIMIT;
      const slice = truncated
        ? keys.slice(0, REDIS_INSPECT_PREVIEW_LIMIT)
        : keys;
      const entries: Record<string, string> = {};
      for (const k of slice) {
        const v = all[k];
        entries[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      return {
        ...base,
        size: keys.length,
        truncated,
        hashEntries: entries,
      };
    }
    return { ...base, error: "Unsupported key type." };
  } catch (err) {
    logger.error("[admin] redis inspect failed", err, { key: trimmed });
    return { error: "Inspect failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Obedience event log — Sir-only audit per (author, weekKey).
// ──────────────────────────────────────────────────────────────────

export interface ObedienceEventLogResult {
  entries?: ObedienceAuditEntry[];
  /** Total members in the audit ZSET for this (author, weekKey).
   *  Lets the UI render "showing N of M" + load-more affordance. */
  total?: number;
  /** Echo of the offset applied — useful to detect drift between the
   *  client's accumulated buffer and the server's slice. */
  offset?: number;
  weekKey?: string;
  author?: Author;
  error?: string;
}

// ──────────────────────────────────────────────────────────────────
// Test mode — Sir-only flag that opens current-week claims so the
// full claim → deliver flow can be exercised without ending the week.
// ──────────────────────────────────────────────────────────────────

export interface TestModeResult {
  on?: boolean;
  error?: string;
}

export async function getTestModeState(): Promise<TestModeResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    return { on: await getTestMode() };
  } catch (err) {
    logger.error("[admin] test mode read failed", err);
    return { error: "Read failed." };
  }
}

export async function setTestModeState(
  on: boolean,
): Promise<{ success?: boolean; error?: string; on?: boolean }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    await setTestModeRaw(on);
    logger.interaction("[admin] test mode toggled", {
      on,
      by: guard.session.author,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, on };
  } catch (err) {
    logger.error("[admin] test mode toggle failed", err);
    return { error: "Toggle failed." };
  }
}

export async function adminPurgeTestClaims(): Promise<{
  success?: boolean;
  error?: string;
  removed?: number;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const { purgeTestClaimsRaw } = await import("@/app/actions/rewards");
    const result = await purgeTestClaimsRaw();
    logger.warn("[admin] test claims purged", {
      by: guard.session.author,
      removed: result.removed,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, removed: result.removed };
  } catch (err) {
    logger.error("[admin] test claim purge failed", err);
    return { error: "Purge failed." };
  }
}

export interface DeleteObedienceEventArgs {
  author: Author;
  weekKey: string;
  type: ObedienceEventType;
  eventId: string;
}

export async function adminDeleteObedienceEvent(
  args: DeleteObedienceEventArgs,
): Promise<{
  success?: boolean;
  error?: string;
  pointsRemoved?: number;
  removed?: boolean;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)) {
    return { error: "Invalid week key." };
  }
  if (!OBEDIENCE_EVENT_TYPES.includes(args.type)) {
    return { error: "Invalid event type." };
  }
  if (
    !args.eventId ||
    typeof args.eventId !== "string" ||
    args.eventId.length > 200
  ) {
    return { error: "Invalid event id." };
  }
  try {
    const result = await deleteObedienceEvent(
      args.author,
      args.weekKey,
      args.type,
      args.eventId,
    );
    logger.interaction("[admin] obedience event deleted", {
      by: guard.session.author,
      author: args.author,
      weekKey: args.weekKey,
      type: args.type,
      eventId: args.eventId,
      pointsRemoved: result.pointsRemoved,
      removedFromEvents: result.removedFromEvents,
      removedFromAudit: result.removedFromAudit,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return {
      success: true,
      pointsRemoved: result.pointsRemoved,
      removed: result.removedFromEvents > 0,
    };
  } catch (err) {
    logger.error("[admin] event delete failed", err);
    return { error: "Delete failed." };
  }
}

export async function getObedienceEventLog(
  author: Author,
  weekKey?: string,
  limit: number = 200,
  offset: number = 0,
): Promise<ObedienceEventLogResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (author !== "T7SEN" && author !== "Besho") {
    return { error: "Invalid author." };
  }
  const targetWeek = weekKey?.trim() || currentWeekKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetWeek)) {
    return { error: "Invalid week key." };
  }
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 0)));
  const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
  try {
    const page = await getEventLog(author, targetWeek, safeLimit, safeOffset);
    return {
      entries: page.entries,
      total: page.total,
      offset: safeOffset,
      weekKey: targetWeek,
      author,
    };
  } catch (err) {
    logger.error("[admin] event log read failed", err);
    return { error: "Read failed." };
  }
}

export async function adminAdjustScore(
  args: AdjustScoreArgs,
): Promise<{ success?: boolean; error?: string; eventId?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (args.author !== "T7SEN" && args.author !== "Besho") {
    return { error: "Invalid author." };
  }
  if (
    !Number.isFinite(args.points) ||
    args.points < MANUAL_ADJUST_MIN ||
    args.points > MANUAL_ADJUST_MAX
  ) {
    return {
      error: `Points must be ${MANUAL_ADJUST_MIN}..${MANUAL_ADJUST_MAX}.`,
    };
  }
  const rounded = Math.round(args.points);
  if (rounded === 0) return { error: "Adjustment cannot be zero." };
  const reason = (args.reason ?? "").trim();
  if (!reason) return { error: "Reason is required." };
  if (reason.length > MANUAL_ADJUST_REASON_MAX) {
    return {
      error: `Reason too long (max ${MANUAL_ADJUST_REASON_MAX}).`,
    };
  }
  if (
    args.weekKey !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(args.weekKey)
  ) {
    return { error: "Invalid week key." };
  }
  try {
    const ts = Date.now();
    const eventId = crypto.randomUUID();
    if (args.weekKey) {
      await recordObedienceEventForWeek(
        args.author,
        "manual_adjust",
        eventId,
        args.weekKey,
        rounded,
      );
    } else {
      await recordObedienceEvent(
        args.author,
        "manual_adjust",
        eventId,
        ts,
        rounded,
      );
    }
    logger.interaction("[admin] manual obedience adjust", {
      by: guard.session.author,
      author: args.author,
      points: rounded,
      reason,
      weekKey: args.weekKey ?? "current",
      eventId,
    });
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return { success: true, eventId };
  } catch (err) {
    logger.error("[admin] manual adjust failed", err);
    return { error: "Adjust failed." };
  }
}

