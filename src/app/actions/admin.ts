// src/app/actions/admin.ts
"use server";

import { revalidatePath } from "next/cache";
import { readAllSessionEpochs } from "@/lib/auth-utils";
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
import { todayKeyCairo } from "@/lib/cairo-time";
import type { AuthFailureRecord } from "./auth";
import type { PermissionRequest } from "./permissions";
import { readAllCronTelemetry } from "@/lib/cron-telemetry";
import { readFcmTokens } from "@/lib/fcm-tokens";
import { redis, requireSir } from "./admin/_shared";

// Local copies of the permissions key constants — used by
// `getAdminLandingSummary` to count pending requests on the landing
// strip without crossing into the permissions bucket. Owned by
// `admin/permissions.ts` / `admin/_shared.ts`; duplicated here as
// non-exported constants so admin.ts stays self-contained.
const PERMISSIONS_INDEX = "permissions:index";
const permissionRecordKey = (id: string) => `permission:${id}`;

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
    revalidatePath("/admin/logs");
    return { success: true, deletedCount: n };
  } catch (err) {
    logger.error("[admin] activity clear failed", err);
    return { error: "Clear failed." };
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
      readFcmTokens(redis, "T7SEN"),
      readFcmTokens(redis, "Besho"),
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
        // Multi-token after the SET migration — both Honor + tablet
        // tokens land in the array on Besho's side.
        push: {
          T7SEN: pushT,
          Besho: pushB,
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
    revalidatePath("/admin/logs");
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
// Admin landing dashboard — at-a-glance summary feeding the dashboard
// strip on `/admin` (pending counts, cron freshness, error count).
// ──────────────────────────────────────────────────────────────────

export interface AdminLandingSummary {
  pendingPermissions: number;
  pendingClaims: number;
  cronStaleCount: number;
  cronTotal: number;
  errorsLast24h: number;
  warningsLast24h: number;
  generatedAt: number;
}

export interface AdminLandingSummaryResult {
  summary?: AdminLandingSummary;
  error?: string;
}

const CRON_FRESH_MS_MAP: Record<string, number> = {
  "ritual-windows": 5 * 60_000,
  "obedience-sweep": 26 * 60 * 60_000,
  "review-window-open": 26 * 60 * 60_000,
};

export async function getAdminLandingSummary(): Promise<AdminLandingSummaryResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const now = Date.now();
  try {
    // Run all reads in parallel — single round-trip-equivalent for the
    // landing strip.
    const [
      permIds,
      pendingClaimIdsRaw,
      cronSnapshots,
      activityRaw,
    ] = await Promise.all([
      redis.zrange<string[]>(PERMISSIONS_INDEX, 0, -1).catch(() => []),
      redis
        .zrange<unknown[]>("rewards:claims:pending", 0, -1)
        .catch(() => [] as unknown[]),
      readAllCronTelemetry().catch(() => []),
      redis
        .zrange<unknown[]>(
          "activity:log",
          now - 86_400_000,
          now,
          { byScore: true },
        )
        .catch(() => [] as unknown[]),
    ]);

    // Pending permissions — mget records and count those still pending.
    let pendingPermissions = 0;
    if (permIds.length > 0) {
      const records = (await redis.mget<PermissionRequest[]>(
        ...permIds.map((id) => permissionRecordKey(id)),
      )) ?? [];
      for (const r of records) {
        if (r && r.status === "pending") pendingPermissions++;
      }
    }

    // Pending claims — the ZSET length is the source-of-truth count.
    const pendingClaims = (pendingClaimIdsRaw ?? []).length;

    // Cron staleness — compare each cron's last-run ts against its
    // expected freshness threshold.
    let cronStaleCount = 0;
    for (const snap of cronSnapshots) {
      const expectedFreshMs = CRON_FRESH_MS_MAP[snap.name] ?? 26 * 60 * 60_000;
      const last = snap.lastRun;
      const fresh =
        !!last &&
        last.ok &&
        now - last.ts <= expectedFreshMs;
      if (!fresh) cronStaleCount++;
    }

    // Severities last 24h — same logic as in getHealthSnapshot.
    let errorsLast24h = 0;
    let warningsLast24h = 0;
    for (const v of activityRaw ?? []) {
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
      if (parsed.level === "error" || parsed.level === "fatal") {
        errorsLast24h++;
      } else if (parsed.level === "warn") {
        warningsLast24h++;
      }
    }

    return {
      summary: {
        pendingPermissions,
        pendingClaims,
        cronStaleCount,
        cronTotal: cronSnapshots.length,
        errorsLast24h,
        warningsLast24h,
        generatedAt: now,
      },
    };
  } catch (err) {
    logger.error("[admin] landing summary read failed", err);
    return { error: "Failed to read summary." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Recent admin actions — filter activity:log to messages prefixed
// with "[admin]". Surfaces on the /admin landing as a "what did I
// just do" timeline.
// ──────────────────────────────────────────────────────────────────

export interface RecentAdminActionsResult {
  records?: ActivityRecord[];
  error?: string;
}

export async function getRecentAdminActions(
  limit: number = 8,
): Promise<RecentAdminActionsResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  try {
    // Pull a wider slice and filter client-side. Activity log is capped
    // at 500 so worst-case 500 records — cheap.
    const candidates = await getActivity(500);
    const filtered = candidates.filter((r) => r.message.startsWith("[admin]"));
    return { records: filtered.slice(0, safeLimit) };
  } catch (err) {
    logger.error("[admin] recent actions read failed", err);
    return { error: "Failed to read recent actions." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Pending claims count — small accessor used by the landing strip.
// (Already implicitly counted in getAdminLandingSummary; this is for
// callers who only need that single number.)
// ──────────────────────────────────────────────────────────────────

export async function getPendingClaimsCount(): Promise<{
  count?: number;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const ids = await redis.zrange<unknown[]>(
      "rewards:claims:pending",
      0,
      -1,
    );
    return { count: (ids ?? []).length };
  } catch (err) {
    logger.error("[admin] pending claims count failed", err);
    return { error: "Failed to count claims." };
  }
}

// ── Re-exports from bucket files ──────────────────────────────────
// Bucket modules own these definitions; admin.ts re-exports so
// existing `@/app/actions/admin` imports keep resolving. Turbopack
// rejects `export {...} from` / `export * from` in 'use server'
// files (syntactic check wants an async function declaration), so
// each function gets a one-line wrapper. Types re-export cleanly via
// `export type {...} from` since interfaces erase at compile time.
import {
  getInspectorSnapshot as _getInspectorSnapshot,
  getSessionEpochs as _getSessionEpochs,
  forceLogoutAuthor as _forceLogoutAuthor,
  listDevices as _listDevices,
  getRestraintState as _getRestraintState,
  setRestraintState as _setRestraintState,
  getRestraintHistory as _getRestraintHistory,
  clearRestraintHistory as _clearRestraintHistory,
} from "./admin/devices";

// devices bucket
export async function getInspectorSnapshot(...args: Parameters<typeof _getInspectorSnapshot>): ReturnType<typeof _getInspectorSnapshot> { return _getInspectorSnapshot(...args); }
export async function getSessionEpochs(...args: Parameters<typeof _getSessionEpochs>): ReturnType<typeof _getSessionEpochs> { return _getSessionEpochs(...args); }
export async function forceLogoutAuthor(...args: Parameters<typeof _forceLogoutAuthor>): ReturnType<typeof _forceLogoutAuthor> { return _forceLogoutAuthor(...args); }
export async function listDevices(...args: Parameters<typeof _listDevices>): ReturnType<typeof _listDevices> { return _listDevices(...args); }
export async function getRestraintState(...args: Parameters<typeof _getRestraintState>): ReturnType<typeof _getRestraintState> { return _getRestraintState(...args); }
export async function setRestraintState(...args: Parameters<typeof _setRestraintState>): ReturnType<typeof _setRestraintState> { return _setRestraintState(...args); }
export async function getRestraintHistory(...args: Parameters<typeof _getRestraintHistory>): ReturnType<typeof _getRestraintHistory> { return _getRestraintHistory(...args); }
export async function clearRestraintHistory(...args: Parameters<typeof _clearRestraintHistory>): ReturnType<typeof _clearRestraintHistory> { return _clearRestraintHistory(...args); }
export type {
  PresenceInfo,
  PushInfo,
  InspectorSnapshot,
  InspectorResult,
  SessionEpochsResult,
  DeviceListItem,
  ListDevicesResult,
  RestraintStateResult,
  RestraintHistoryEntry,
  RestraintHistoryResult,
} from "./admin/devices";

import {
  getPermissionsAdminBundle as _getPermissionsAdminBundle,
  adminSaveAutoRulesJson as _adminSaveAutoRulesJson,
  adminSaveQuotasJson as _adminSaveQuotasJson,
  bulkApprovePendingOlderThan as _bulkApprovePendingOlderThan,
  bulkDenyPendingByCategory as _bulkDenyPendingByCategory,
  simulateAutoRules as _simulateAutoRules,
} from "./admin/permissions";

// permissions bucket
export async function getPermissionsAdminBundle(...args: Parameters<typeof _getPermissionsAdminBundle>): ReturnType<typeof _getPermissionsAdminBundle> { return _getPermissionsAdminBundle(...args); }
export async function adminSaveAutoRulesJson(...args: Parameters<typeof _adminSaveAutoRulesJson>): ReturnType<typeof _adminSaveAutoRulesJson> { return _adminSaveAutoRulesJson(...args); }
export async function adminSaveQuotasJson(...args: Parameters<typeof _adminSaveQuotasJson>): ReturnType<typeof _adminSaveQuotasJson> { return _adminSaveQuotasJson(...args); }
export async function bulkApprovePendingOlderThan(...args: Parameters<typeof _bulkApprovePendingOlderThan>): ReturnType<typeof _bulkApprovePendingOlderThan> { return _bulkApprovePendingOlderThan(...args); }
export async function bulkDenyPendingByCategory(...args: Parameters<typeof _bulkDenyPendingByCategory>): ReturnType<typeof _bulkDenyPendingByCategory> { return _bulkDenyPendingByCategory(...args); }
export async function simulateAutoRules(...args: Parameters<typeof _simulateAutoRules>): ReturnType<typeof _simulateAutoRules> { return _simulateAutoRules(...args); }
export type {
  PermissionsAdminBundle,
  BulkDecideArgs,
  BulkDecideResult,
  SimulateAutoRuleArgs,
  SimulateAutoRuleResult,
} from "./admin/permissions";

import {
  getRewardTiers as _getRewardTiers,
  setRewardTiers as _setRewardTiers,
  getObedienceWeights as _getObedienceWeights,
  setObedienceWeights as _setObedienceWeights,
  getStreakSettings as _getStreakSettings,
  setStreakSettings as _setStreakSettings,
  recomputeWeek as _recomputeWeek,
  getObedienceAdminSnapshot as _getObedienceAdminSnapshot,
  adminSetStreakRaw as _adminSetStreakRaw,
  getObedienceEventLog as _getObedienceEventLog,
  adminAdjustScore as _adminAdjustScore,
  getTestModeState as _getTestModeState,
  setTestModeState as _setTestModeState,
  adminPurgeTestClaims as _adminPurgeTestClaims,
  adminDeleteObedienceEvent as _adminDeleteObedienceEvent,
  adminForceRecomputeWeek as _adminForceRecomputeWeek,
  adminReopenClaimWindow as _adminReopenClaimWindow,
} from "./admin/rewards";

// rewards bucket
export async function getRewardTiers(...args: Parameters<typeof _getRewardTiers>): ReturnType<typeof _getRewardTiers> { return _getRewardTiers(...args); }
export async function setRewardTiers(...args: Parameters<typeof _setRewardTiers>): ReturnType<typeof _setRewardTiers> { return _setRewardTiers(...args); }
export async function getObedienceWeights(...args: Parameters<typeof _getObedienceWeights>): ReturnType<typeof _getObedienceWeights> { return _getObedienceWeights(...args); }
export async function setObedienceWeights(...args: Parameters<typeof _setObedienceWeights>): ReturnType<typeof _setObedienceWeights> { return _setObedienceWeights(...args); }
export async function getStreakSettings(...args: Parameters<typeof _getStreakSettings>): ReturnType<typeof _getStreakSettings> { return _getStreakSettings(...args); }
export async function setStreakSettings(...args: Parameters<typeof _setStreakSettings>): ReturnType<typeof _setStreakSettings> { return _setStreakSettings(...args); }
export async function recomputeWeek(...args: Parameters<typeof _recomputeWeek>): ReturnType<typeof _recomputeWeek> { return _recomputeWeek(...args); }
export async function getObedienceAdminSnapshot(...args: Parameters<typeof _getObedienceAdminSnapshot>): ReturnType<typeof _getObedienceAdminSnapshot> { return _getObedienceAdminSnapshot(...args); }
export async function adminSetStreakRaw(...args: Parameters<typeof _adminSetStreakRaw>): ReturnType<typeof _adminSetStreakRaw> { return _adminSetStreakRaw(...args); }
export async function getObedienceEventLog(...args: Parameters<typeof _getObedienceEventLog>): ReturnType<typeof _getObedienceEventLog> { return _getObedienceEventLog(...args); }
export async function adminAdjustScore(...args: Parameters<typeof _adminAdjustScore>): ReturnType<typeof _adminAdjustScore> { return _adminAdjustScore(...args); }
export async function getTestModeState(...args: Parameters<typeof _getTestModeState>): ReturnType<typeof _getTestModeState> { return _getTestModeState(...args); }
export async function setTestModeState(...args: Parameters<typeof _setTestModeState>): ReturnType<typeof _setTestModeState> { return _setTestModeState(...args); }
export async function adminPurgeTestClaims(...args: Parameters<typeof _adminPurgeTestClaims>): ReturnType<typeof _adminPurgeTestClaims> { return _adminPurgeTestClaims(...args); }
export async function adminDeleteObedienceEvent(...args: Parameters<typeof _adminDeleteObedienceEvent>): ReturnType<typeof _adminDeleteObedienceEvent> { return _adminDeleteObedienceEvent(...args); }
export async function adminForceRecomputeWeek(...args: Parameters<typeof _adminForceRecomputeWeek>): ReturnType<typeof _adminForceRecomputeWeek> { return _adminForceRecomputeWeek(...args); }
export async function adminReopenClaimWindow(...args: Parameters<typeof _adminReopenClaimWindow>): ReturnType<typeof _adminReopenClaimWindow> { return _adminReopenClaimWindow(...args); }
export type {
  RewardTiersResult,
  ObedienceWeightsResult,
  StreakSettingsResult,
  RecomputeWeekResult,
  ObedienceAdminSnapshot,
  AdjustScoreArgs,
  ObedienceEventLogResult,
  TestModeResult,
  DeleteObedienceEventArgs,
  AdminForceRecomputeWeekArgs,
  AdminReopenClaimWindowArgs,
} from "./admin/rewards";

import {
  getCooldownState as _getCooldownState,
  getHealthSnapshot as _getHealthSnapshot,
  repairIndexes as _repairIndexes,
  getCronTelemetry as _getCronTelemetry,
  repairObedienceDrift as _repairObedienceDrift,
  reconcileFeatureIndexes as _reconcileFeatureIndexes,
  reconcilePendingRewardClaims as _reconcilePendingRewardClaims,
  pruneOrphanedReactions as _pruneOrphanedReactions,
  pruneOrphanedRitualOccurrences as _pruneOrphanedRitualOccurrences,
  migrateObedienceBucketShift as _migrateObedienceBucketShift,
  getDeployInfo as _getDeployInfo,
  inspectRedisKey as _inspectRedisKey,
} from "./admin/health";

// health bucket
export async function getCooldownState(...args: Parameters<typeof _getCooldownState>): ReturnType<typeof _getCooldownState> { return _getCooldownState(...args); }
export async function getHealthSnapshot(...args: Parameters<typeof _getHealthSnapshot>): ReturnType<typeof _getHealthSnapshot> { return _getHealthSnapshot(...args); }
export async function repairIndexes(...args: Parameters<typeof _repairIndexes>): ReturnType<typeof _repairIndexes> { return _repairIndexes(...args); }
export async function getCronTelemetry(...args: Parameters<typeof _getCronTelemetry>): ReturnType<typeof _getCronTelemetry> { return _getCronTelemetry(...args); }
export async function repairObedienceDrift(...args: Parameters<typeof _repairObedienceDrift>): ReturnType<typeof _repairObedienceDrift> { return _repairObedienceDrift(...args); }
export async function reconcileFeatureIndexes(...args: Parameters<typeof _reconcileFeatureIndexes>): ReturnType<typeof _reconcileFeatureIndexes> { return _reconcileFeatureIndexes(...args); }
export async function reconcilePendingRewardClaims(...args: Parameters<typeof _reconcilePendingRewardClaims>): ReturnType<typeof _reconcilePendingRewardClaims> { return _reconcilePendingRewardClaims(...args); }
export async function pruneOrphanedReactions(...args: Parameters<typeof _pruneOrphanedReactions>): ReturnType<typeof _pruneOrphanedReactions> { return _pruneOrphanedReactions(...args); }
export async function pruneOrphanedRitualOccurrences(...args: Parameters<typeof _pruneOrphanedRitualOccurrences>): ReturnType<typeof _pruneOrphanedRitualOccurrences> { return _pruneOrphanedRitualOccurrences(...args); }
export async function migrateObedienceBucketShift(...args: Parameters<typeof _migrateObedienceBucketShift>): ReturnType<typeof _migrateObedienceBucketShift> { return _migrateObedienceBucketShift(...args); }
export async function getDeployInfo(...args: Parameters<typeof _getDeployInfo>): ReturnType<typeof _getDeployInfo> { return _getDeployInfo(...args); }
export async function inspectRedisKey(...args: Parameters<typeof _inspectRedisKey>): ReturnType<typeof _inspectRedisKey> { return _inspectRedisKey(...args); }
export type {
  ReaskBlockEntry,
  SafewordCooldownEntry,
  CooldownState,
  CooldownResult,
  HealthSnapshot,
  HealthResult,
  RepairResult,
  CronTelemetryResult,
  ObedienceDriftRepairSummary,
  RepairObedienceDriftResult,
  FeatureIndexDrift,
  ReconcileFeatureIndexesResult,
  PendingClaimDriftEntry,
  ReconcilePendingClaimsResult,
  PruneOrphansResult,
  BucketShiftMigrationResult,
  DeployInfo,
  RedisKeyType,
  RedisInspectResult,
} from "./admin/health";

import {
  summonKitten as _summonKitten,
  sendTestPushAction as _sendTestPushAction,
  getOutboundNotificationAudit as _getOutboundNotificationAudit,
  resendNotification as _resendNotification,
  clearOutboundNotificationAudit as _clearOutboundNotificationAudit,
} from "./admin/notifications";

// notifications bucket
export async function summonKitten(...args: Parameters<typeof _summonKitten>): ReturnType<typeof _summonKitten> { return _summonKitten(...args); }
export async function sendTestPushAction(...args: Parameters<typeof _sendTestPushAction>): ReturnType<typeof _sendTestPushAction> { return _sendTestPushAction(...args); }
export async function getOutboundNotificationAudit(...args: Parameters<typeof _getOutboundNotificationAudit>): ReturnType<typeof _getOutboundNotificationAudit> { return _getOutboundNotificationAudit(...args); }
export async function resendNotification(...args: Parameters<typeof _resendNotification>): ReturnType<typeof _resendNotification> { return _resendNotification(...args); }
export async function clearOutboundNotificationAudit(...args: Parameters<typeof _clearOutboundNotificationAudit>): ReturnType<typeof _clearOutboundNotificationAudit> { return _clearOutboundNotificationAudit(...args); }
export type {
  SummonResult,
  SendTestPushResult,
  OutboundNotificationAuditEntry,
  NotificationAuditPair,
  NotificationAuditResult,
} from "./admin/notifications";
