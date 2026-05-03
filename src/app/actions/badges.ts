// src/app/actions/badges.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import type { Task } from "@/app/actions/tasks";
import type { Rule } from "@/app/actions/rules";
import type { Ritual, RitualOwner } from "@/app/actions/rituals";
import type { PermissionRequest } from "@/app/actions/permissions";
import { computeRitualTodayState } from "@/lib/rituals";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export interface NavBadges {
  pendingTasks: number;
  unacknowledgedRules: number;
  openRituals: number;
  pendingPermissions: number;
}

const EMPTY: NavBadges = {
  pendingTasks: 0,
  unacknowledgedRules: 0,
  openRituals: 0,
  pendingPermissions: 0,
};

/**
 * Returns unread badge counts for the floating navbar.
 *
 * - `pendingTasks` and `unacknowledgedRules`: Besho-only obligations.
 *   Always 0 for T7SEN.
 * - `openRituals`: per-viewer count of rituals where the viewer is the
 *   owner AND the current state is `open` (window open, no submission).
 *   Computed for both authors because rituals can be owned by either.
 * - `pendingPermissions`: T7SEN-only count of pending permission
 *   requests awaiting Sir's decision. Always 0 for Besho — she gets
 *   FCM pushes when Sir decides, no badge needed.
 */
export async function getNavBadges(): Promise<NavBadges> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return EMPTY;

  const session = await decrypt(value);
  const author = session?.author;
  if (author !== "T7SEN" && author !== "Besho") return EMPTY;

  const isBesho = author === "Besho";
  const isT7SEN = author === "T7SEN";

  try {
    // Phase 1: parallel ZRANGE for all relevant indices. Tasks/rules
    // only pulled for Besho; permissions only pulled for T7SEN.
    const [taskIds, ruleIds, ritualIds, permissionIds] = await Promise.all([
      isBesho
        ? (redis.zrange("tasks:index", 0, -1) as Promise<string[]>)
        : Promise.resolve([] as string[]),
      isBesho
        ? (redis.zrange("rules:index", 0, -1) as Promise<string[]>)
        : Promise.resolve([] as string[]),
      redis.zrange("rituals:index", 0, -1) as Promise<string[]>,
      isT7SEN
        ? (redis.zrange("permissions:index", 0, -1) as Promise<string[]>)
        : Promise.resolve([] as string[]),
    ]);

    // Phase 2: parallel MGET for the records we just enumerated.
    const [tasks, rules, rituals, permissions] = await Promise.all([
      taskIds.length
        ? redis.mget<(Pick<Task, "completed"> | null)[]>(
            ...taskIds.map((id) => `task:${id}`),
          )
        : Promise.resolve([]),
      ruleIds.length
        ? redis.mget<(Pick<Rule, "status"> | null)[]>(
            ...ruleIds.map((id) => `rule:${id}`),
          )
        : Promise.resolve([]),
      ritualIds.length
        ? redis.mget<(Ritual | null)[]>(
            ...ritualIds.map((id) => `ritual:${id}`),
          )
        : Promise.resolve([] as (Ritual | null)[]),
      permissionIds.length
        ? redis.mget<(Pick<PermissionRequest, "status"> | null)[]>(
            ...permissionIds.map((id) => `permission:${id}`),
          )
        : Promise.resolve([]),
    ]);

    // Phase 3 (rituals only): for owned-by-viewer rituals whose nominal
    // state is `open`, EXISTS the occurrence key to filter out already-
    // submitted ones. Skipping the EXISTS for non-`open` rituals keeps
    // the pipeline tight at typical load (most rituals are upcoming or
    // off-day at any given moment).
    const now = Date.now();
    const ownerLiteral = author as RitualOwner;
    const candidates = (rituals ?? []).filter(
      (r): r is Ritual => r !== null && r.owner === ownerLiteral,
    );

    type Candidate = { ritualId: string; owningDateKey: string };
    const openCandidates: Candidate[] = [];
    for (const r of candidates) {
      const todayInfo = computeRitualTodayState({
        active: r.active,
        pausedUntilMs: r.pausedUntil ?? null,
        cadence: r.cadence,
        weekdays: r.weekdays,
        everyNDays: r.everyNDays,
        anchorDateKey: r.anchorDateKey,
        windowStart: r.windowStart,
        durationMinutes: r.windowDurationMinutes,
        now,
        hasOccurrenceForOwningDate: () => false,
      });
      if (todayInfo.state === "open") {
        openCandidates.push({
          ritualId: r.id,
          owningDateKey: todayInfo.owningDateKey,
        });
      }
    }

    let openRituals = 0;
    if (openCandidates.length > 0) {
      const pipeline = redis.pipeline();
      for (const c of openCandidates) {
        pipeline.exists(`ritual:occurrence:${c.ritualId}:${c.owningDateKey}`);
      }
      const existsResults = (await pipeline.exec()) as (number | null)[];
      for (const result of existsResults) {
        if (result === 0) openRituals += 1;
      }
    }

    return {
      pendingTasks: tasks.filter((t) => t !== null && !t.completed).length,
      unacknowledgedRules: rules.filter(
        (r) => r !== null && r.status === "pending",
      ).length,
      openRituals,
      pendingPermissions: permissions.filter(
        (p) => p !== null && p.status === "pending",
      ).length,
    };
  } catch {
    return EMPTY;
  }
}
