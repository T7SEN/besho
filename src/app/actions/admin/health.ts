// src/app/actions/admin/health.ts
"use server";

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/logger";
import type { Author } from "@/lib/constants";
import { addDaysCairo } from "@/lib/cairo-time";
import {
  repairAllObedienceZsetDrift,
  type ObedienceDriftRepairResult,
} from "@/lib/obedience";
import {
  readAllCronTelemetry,
  type CronTelemetrySnapshot,
} from "@/lib/cron-telemetry";
import { redis, requireSir } from "./_shared";

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
  cron: {
    /** Whether `CRON_SECRET` is set in the runtime env. Without it,
     *  every `/api/cron/*` route refuses to run (returns 401), which
     *  is silent from cron-job.org's perspective and easy to miss
     *  until telemetry goes stale. */
    secretSet: boolean;
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
    cron: {
      secretSet: typeof process.env.CRON_SECRET === "string" &&
        process.env.CRON_SECRET.length > 0,
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
// One-time bucket migration: the rewards system used to bucket events
// by the just-completed week (via `currentReviewWeekDate`) instead of
// the containing week. After fixing `currentWeekKey` to use the
// correct semantic, every existing bucket is shifted back by one
// week relative to its actual content. This action shifts each
// bucket forward by 7 days so labels match content.
//
// Idempotent: gated by `obedience:bucket-shift-migration:done`
// sentinel. Re-runs are no-ops once the sentinel is set.
//
// Patterns migrated (all suffixed with `{author}:{weekKey}`):
//   - obedience:events:*       (ZSET — score = points, member = type:eventId)
//   - obedience:audit:*        (ZSET — score = ts, member = type:eventId)
//   - obedience:finalized:*    (STRING — "1")
//   - obedience:multiplier:*   (NUMBER — frozen multiplier)
//   - obedience:tier-notified:*(NUMBER — highest threshold notified)
//
// Scope: scans up to 1000 keys per pattern via SCAN. Two-user app
// realistic count is ~tens.
// ──────────────────────────────────────────────────────────────────

const BUCKET_SHIFT_SENTINEL = "obedience:bucket-shift-migration:done";
const BUCKET_KEY_PREFIXES = [
  "obedience:events:",
  "obedience:audit:",
  "obedience:finalized:",
  "obedience:multiplier:",
  "obedience:tier-notified:",
] as const;

export interface BucketShiftMigrationResult {
  success?: boolean;
  error?: string;
  alreadyDone?: boolean;
  scannedKeys?: number;
  migratedKeys?: number;
  skippedKeys?: number;
  perPattern?: Record<string, { scanned: number; migrated: number; skipped: number }>;
}

/** Match `{prefix}{author}:{YYYY-MM-DD}` and split. */
function parseBucketKey(
  key: string,
  prefix: string,
): { author: Author; weekKey: string } | null {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const author = rest.slice(0, colon);
  const weekKey = rest.slice(colon + 1);
  if (author !== "T7SEN" && author !== "Besho") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return null;
  return { author: author as Author, weekKey };
}

async function scanByPrefix(prefix: string): Promise<string[]> {
  const seen = new Set<string>();
  let cursor: string | number = 0;
  let safety = 0;
  do {
    const [next, keys] = (await redis.scan(cursor, {
      match: `${prefix}*`,
      count: 200,
    })) as [string | number, string[]];
    for (const k of keys ?? []) seen.add(k);
    cursor = next;
    safety++;
    if (seen.size >= 1000 || safety > 100) break;
  } while (cursor !== 0 && cursor !== "0");
  return Array.from(seen);
}

/**
 * Copy a single key to a new key name, regardless of type. Returns
 * true if the source existed and was copied successfully. Uses
 * `redis.type` to dispatch.
 */
async function copyKey(src: string, dst: string): Promise<boolean> {
  const type = await redis.type(src);
  if (type === "none") return false;
  if (type === "string") {
    const value = await redis.get(src);
    if (value === null || value === undefined) return false;
    await redis.set(dst, value);
    return true;
  }
  if (type === "zset") {
    const raw =
      ((await redis.zrange<(string | number)[]>(src, 0, -1, {
        withScores: true,
      })) ?? []) as (string | number)[];
    if (raw.length === 0) return false;
    const members: { score: number; member: string }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      members.push({
        score: Number(raw[i + 1]) || 0,
        member: String(raw[i]),
      });
    }
    if (members.length === 0) return false;
    // ZADD batch.
    for (const m of members) {
      await redis.zadd(dst, { score: m.score, member: m.member });
    }
    return true;
  }
  // Other types not used by obedience buckets — skip defensively.
  return false;
}

export async function migrateObedienceBucketShift(): Promise<BucketShiftMigrationResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const sentinel = await redis.get<string>(BUCKET_SHIFT_SENTINEL);
    if (sentinel) {
      return { success: true, alreadyDone: true };
    }

    let totalScanned = 0;
    let totalMigrated = 0;
    let totalSkipped = 0;
    const perPattern: Record<
      string,
      { scanned: number; migrated: number; skipped: number }
    > = {};

    for (const prefix of BUCKET_KEY_PREFIXES) {
      const keys = await scanByPrefix(prefix);
      let migrated = 0;
      let skipped = 0;
      for (const key of keys) {
        const parsed = parseBucketKey(key, prefix);
        if (!parsed) {
          skipped++;
          continue;
        }
        const newWeekKey = addDaysCairo(parsed.weekKey, 7);
        const dst = `${prefix}${parsed.author}:${newWeekKey}`;
        if (dst === key) {
          skipped++;
          continue;
        }
        // Don't overwrite an existing destination — bail loudly.
        const dstType = await redis.type(dst);
        if (dstType !== "none") {
          logger.warn("[admin] bucket shift: destination exists, skipping", {
            src: key,
            dst,
            dstType,
          });
          skipped++;
          continue;
        }
        const copied = await copyKey(key, dst);
        if (copied) {
          await redis.del(key);
          migrated++;
        } else {
          skipped++;
        }
      }
      perPattern[prefix] = {
        scanned: keys.length,
        migrated,
        skipped,
      };
      totalScanned += keys.length;
      totalMigrated += migrated;
      totalSkipped += skipped;
    }

    await redis.set(BUCKET_SHIFT_SENTINEL, String(Date.now()));
    logger.interaction("[admin] obedience bucket shift completed", {
      by: guard.session.author,
      scanned: totalScanned,
      migrated: totalMigrated,
      skipped: totalSkipped,
    });
    revalidatePath("/admin/health");
    revalidatePath("/admin/rewards");
    revalidatePath("/rewards");
    return {
      success: true,
      alreadyDone: false,
      scannedKeys: totalScanned,
      migratedKeys: totalMigrated,
      skippedKeys: totalSkipped,
      perPattern,
    };
  } catch (err) {
    logger.error("[admin] obedience bucket shift failed", err);
    return { error: "Bucket shift failed." };
  }
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
  const pkg = (await import("../../../../package.json")) as {
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
