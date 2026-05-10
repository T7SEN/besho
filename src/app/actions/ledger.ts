"use server";

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import {
  REWARD_CATEGORIES,
  PUNISHMENT_CATEGORIES,
  VIOLATION_SEVERITIES,
  VIOLATION_SEVERITY_LABEL,
  MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN,
  type LedgerEntryType,
  type ViolationSeverity,
} from "@/lib/ledger-constants";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { recordObedienceEvent } from "@/lib/obedience";
import type { Rule } from "@/app/actions/rules";

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  category: string;
  title: string;
  description?: string;
  timestamp: number;
  author: "T7SEN" | "Besho";
  /** Violation-only — references the rule that was violated. Snapshot
   *  of the rule body lives in `ruleSnapshot` so future rule edits or
   *  deletes don't rewrite this entry's display. */
  ruleId?: string;
  /** Violation-only — captured at write time. Mirrors the
   *  reward-emoji snapshot pattern. Body is truncated to
   *  `MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN` chars. */
  ruleSnapshot?: { title: string; body?: string };
  /** Violation-only — typed mirror of the chip displayed in
   *  `category`. Stored separately so code paths branching on severity
   *  don't have to round-trip through the display string. */
  severity?: ViolationSeverity;
  /** Punishment-timer auto-created entries — references back to
   *  `punishment:{id}`. Set by `punishment.completePunishment` and
   *  `bailPunishment` when they write the ledger record inline.
   *  Manual ledger entries created via `createLedgerEntry` never
   *  populate this field. */
  linkedPunishmentId?: string;
}

const INDEX_KEY = "ledger:index";
const entryKey = (id: string) => `ledger:${id}`;
const violationsByRuleKey = (ruleId: string) =>
  `ledger:violations:by-rule:${ruleId}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function getLedgerEntries(): Promise<LedgerEntry[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];
    if (!ids.length) return [];
    const entries = await redis.mget<(LedgerEntry | null)[]>(
      ...ids.map(entryKey),
    );
    return entries.filter((e): e is LedgerEntry => e !== null);
  } catch (error) {
    logger.error("[ledger] Failed to fetch:", error);
    return [];
  }
}

/** Read all violation entries for a given rule, newest first. Both
 *  authors can read (transparency). Returns `[]` if the rule has no
 *  violations or on error. */
export async function getViolationsByRule(
  ruleId: string,
  limit?: number,
): Promise<LedgerEntry[]> {
  if (!ruleId) return [];
  try {
    const stop = typeof limit === "number" && limit > 0 ? limit - 1 : -1;
    const ids = (await redis.zrange(
      violationsByRuleKey(ruleId),
      0,
      stop,
      { rev: true },
    )) as string[];
    if (!ids.length) return [];
    const entries = await redis.mget<(LedgerEntry | null)[]>(
      ...ids.map(entryKey),
    );
    return entries.filter((e): e is LedgerEntry => e !== null);
  } catch (error) {
    logger.error("[ledger] Failed to fetch violations by rule:", error);
    return [];
  }
}

/** Per-rule violation counts. Used by the rules page to render the
 *  "N violations logged" line on each card. Single pipeline; one
 *  ZCARD per id. Returns an empty record on error. */
export async function getViolationCountsForRules(
  ruleIds: string[],
): Promise<Record<string, number>> {
  if (!ruleIds.length) return {};
  try {
    const pipeline = redis.pipeline();
    for (const id of ruleIds) pipeline.zcard(violationsByRuleKey(id));
    const results = (await pipeline.exec()) as unknown as Array<number | null>;
    const out: Record<string, number> = {};
    ruleIds.forEach((id, i) => {
      const v = results[i];
      out[id] = typeof v === "number" && v > 0 ? v : 0;
    });
    return out;
  } catch (error) {
    logger.error("[ledger] Failed to fetch violation counts:", error);
    return {};
  }
}

export async function createLedgerEntry(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Only Sir can log entries." };

  const type = formData.get("type") as LedgerEntryType;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const timestampStr = formData.get("timestamp") as string;

  if (type !== "reward" && type !== "punishment" && type !== "violation")
    return { error: "Invalid type." };
  if (!title) return { error: "Title is required." };

  const timestamp = timestampStr
    ? new Date(timestampStr).getTime()
    : Date.now();
  if (isNaN(timestamp)) return { error: "Invalid date." };

  // ── Type-specific branching ──────────────────────────────────────────────
  let category: string;
  let ruleId: string | undefined;
  let ruleSnapshot: LedgerEntry["ruleSnapshot"];
  let severity: ViolationSeverity | undefined;

  if (type === "violation") {
    const ruleIdRaw = (formData.get("ruleId") as string)?.trim();
    const severityRaw = (
      formData.get("severity") as string
    )?.trim() as ViolationSeverity;

    if (!ruleIdRaw) return { error: "Rule is required for a violation." };
    if (!(VIOLATION_SEVERITIES as readonly string[]).includes(severityRaw))
      return { error: "Invalid severity." };

    // Snapshot the rule body so future edits/deletes don't rewrite
    // history. If the rule is missing (already deleted before logging),
    // refuse — Sir should pick from the active rules list.
    const rule = await redis.get<Rule>(`rule:${ruleIdRaw}`);
    if (!rule) return { error: "Rule not found." };

    ruleId = ruleIdRaw;
    severity = severityRaw;
    category = VIOLATION_SEVERITY_LABEL[severityRaw];

    const snapshotBody = rule.description
      ? rule.description.slice(0, MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN)
      : undefined;
    ruleSnapshot = {
      title: rule.title,
      ...(snapshotBody && { body: snapshotBody }),
    };
  } else {
    const categoryRaw = (formData.get("category") as string)?.trim();
    if (!categoryRaw) return { error: "Category is required." };

    const validCategories =
      type === "reward" ? REWARD_CATEGORIES : PUNISHMENT_CATEGORIES;
    if (!(validCategories as readonly string[]).includes(categoryRaw))
      return { error: "Invalid category." };

    category = categoryRaw;
  }

  const entry: LedgerEntry = {
    id: crypto.randomUUID(),
    type,
    category,
    title,
    ...(description && { description }),
    timestamp,
    author: session.author,
    ...(ruleId && { ruleId }),
    ...(ruleSnapshot && { ruleSnapshot }),
    ...(severity && { severity }),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(entryKey(entry.id), entry);
    pipeline.zadd(INDEX_KEY, { score: timestamp, member: entry.id });
    if (entry.type === "violation" && entry.ruleId) {
      pipeline.zadd(violationsByRuleKey(entry.ruleId), {
        score: timestamp,
        member: entry.id,
      });
    }
    await pipeline.exec();

    // Obedience emit — branched by type:
    //  - reward: no obedience event (manual log only).
    //  - punishment: -10 default via `ledger_punishment`.
    //  - violation: severity-scaled `rule_violation_${severity}`.
    //               The `ledger_punishment` emit is intentionally
    //               suppressed so the score isn't double-counted.
    if (entry.type === "punishment") {
      void recordObedienceEvent(
        "Besho",
        "ledger_punishment",
        entry.id,
        timestamp,
      );
    } else if (entry.type === "violation" && entry.severity) {
      void recordObedienceEvent(
        "Besho",
        `rule_violation_${entry.severity}` as const,
        entry.id,
        timestamp,
      );
    }

    const notifTitle =
      entry.type === "reward"
        ? "🏆 You earned a reward"
        : entry.type === "violation"
          ? "⚠️ Rule violation logged"
          : "⚠️ Punishment logged";
    const notifBody =
      entry.type === "violation" && entry.ruleSnapshot
        ? `${VIOLATION_SEVERITY_LABEL[entry.severity!]} · ${entry.ruleSnapshot.title}: ${title}`
        : `${entry.category}: ${title}`;
    await sendNotification("Besho", {
      title: notifTitle,
      body: notifBody,
      url: "/ledger",
    });

    logger.interaction("[ledger] Entry created", {
      id: entry.id,
      type: entry.type,
      category: entry.category,
      title: entry.title,
      ...(entry.ruleId && { ruleId: entry.ruleId }),
      ...(entry.severity && { severity: entry.severity }),
      by: session.author,
    });
    revalidatePath("/ledger");
    if (entry.type === "violation") revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[ledger] Failed to create:", error);
    return { error: "Failed to save entry." };
  }
}

export async function deleteLedgerEntry(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete entries." };

  try {
    const existing = await redis.get<LedgerEntry>(entryKey(id));
    if (!existing) return { error: "Entry not found." };

    const score = await redis.zscore(INDEX_KEY, id);
    await moveToTrash(redis, {
      feature: "ledger",
      id,
      label: trashLabelFor(existing),
      deletedBy: session.author,
      payload: existing,
      indexScore:
        typeof score === "number" ? score : Number(score) || existing.timestamp,
      recordKey: entryKey(id),
      indexKey: INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(entryKey(id));
    pipeline.zrem(INDEX_KEY, id);
    if (existing.type === "violation" && existing.ruleId) {
      // Auxiliary index is NOT preserved on restore (mirrors the
      // reactions/occurrences pattern from the soft-delete docs); a
      // restored violation will not re-appear in `getViolationsByRule`
      // until manually reconciled. Acceptable for this feature.
      pipeline.zrem(violationsByRuleKey(existing.ruleId), id);
    }
    await pipeline.exec();

    logger.interaction("[ledger] Entry deleted", {
      id,
      type: existing.type,
      category: existing.category,
      title: existing.title,
      ...(existing.ruleId && { ruleId: existing.ruleId }),
      by: session.author,
    });
    revalidatePath("/ledger");
    if (existing.type === "violation") revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[ledger] Failed to delete:", error);
    return { error: "Failed to delete entry." };
  }
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function purgeAllLedgerEntries(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can purge the ledger." };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(INDEX_KEY, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { id: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ id: String(raw[i]), score: Number(raw[i + 1]) || 0 });
    }
    const ids = pairs.map((p) => p.id);

    if (ids.length > 0) {
      const records =
        (await redis.mget<LedgerEntry[]>(...ids.map(entryKey))) ?? [];
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const entry = records[i];
          return {
            feature: "ledger" as const,
            id: p.id,
            label: entry ? trashLabelFor(entry) : p.id,
            deletedBy: session.author,
            payload: entry ?? null,
            indexScore: p.score,
            recordKey: entryKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );

      // Wipe the per-rule violation indexes touched by purged entries.
      // Collect unique ruleIds first so we issue one DEL per index key.
      const violatedRuleIds = new Set<string>();
      records.forEach((entry) => {
        if (entry?.type === "violation" && entry.ruleId) {
          violatedRuleIds.add(entry.ruleId);
        }
      });
      if (violatedRuleIds.size > 0) {
        const wipePipeline = redis.pipeline();
        for (const ruleId of violatedRuleIds) {
          wipePipeline.del(violationsByRuleKey(ruleId));
        }
        await wipePipeline.exec();
      }
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(entryKey(id));
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/ledger");
    revalidatePath("/rules");
    logger.warn(`[ledger] Sir purged ${ids.length} entries.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[ledger] purgeAllLedgerEntries failed:", err);
    return { error: "Purge failed." };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trashLabelFor(entry: LedgerEntry): string {
  if (entry.type === "reward") return `+ ${entry.title}`;
  if (entry.type === "violation") return `⚠ ${entry.title}`;
  return `− ${entry.title}`;
}
