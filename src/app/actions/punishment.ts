"use server";

// src/app/actions/punishment.ts
//
// Server actions for the punishment timer. Sir issues a duration-
// bounded corrective timer; kitten's app FCM-routes to a full-screen
// kneel-timer view that engages immediately (`bypassPresence: true`).
// Completion (after `endsAt`) creates a `ledger:{id}` `punishment`
// entry and emits `punishment_completed` (+2 default). Bail — manual
// two-tap, app-background past 60s grace, or cron sweep past `endsAt
// + grace` — creates a "bailed" ledger entry and emits
// `punishment_bailed` (−20 default).
//
// The auto-created ledger entry is written INLINE here (not via
// `createLedgerEntry`) because that helper would emit the standard
// `ledger_punishment` obedience event — which would double-count
// against the typed `punishment_completed` / `punishment_bailed`
// events. Inline write is intentional, not a refactor candidate.
//
// Single-slot via `punishment:active:Besho` STRING with TTL of
// `durationSec + PUNISHMENT_ACTIVE_TTL_BUFFER_SEC`. The buffer gives
// the cron a window to finalize a bail without the slot reopening
// before the bail entry is written.

import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { recordObedienceEvent } from "@/lib/obedience";
import { assertWriteAllowed } from "@/lib/restraint";
import {
  BACKGROUND_GRACE_SEC,
  MAX_PUNISHMENT_DURATION_SEC,
  MAX_PUNISHMENT_REASON_LEN,
  MIN_PUNISHMENT_DURATION_SEC,
  PUNISHMENT_ACTIVE_TTL_BUFFER_SEC,
  PUNISHMENT_PAYLOAD_KIND,
  type PunishmentState,
} from "@/lib/punishment-constants";
import type { LedgerEntry } from "@/app/actions/ledger";
import type { LedgerEntryType } from "@/lib/ledger-constants";
import { TITLE_BY_AUTHOR } from "@/lib/constants";

export interface Punishment {
  id: string;
  /** Always "T7SEN" — only Sir issues. */
  issuedBy: "T7SEN";
  /** Always "Besho" — single-target by design. */
  target: "Besho";
  /** Sir's note on why. Surfaces in the auto-created ledger entry. */
  reason: string;
  /** Duration is required (no open-ended punishments). 1–120 min. */
  durationSec: number;
  issuedAt: number;
  /** Set when kitten taps Begin. Until then, the timer is paused
   *  in the ISSUED state — she has to consent to start the clock. */
  startsAt: number | null;
  /** `startsAt + durationSec * 1000` once running. Null in ISSUED. */
  endsAt: number | null;
  completedAt: number | null;
  bailedAt: number | null;
  cancelledAt: number | null;
  state: PunishmentState;
  /** id of the auto-created `ledger:{id}` entry, set on completion
   *  or bail. Null while the punishment is still active. */
  linkedLedgerId: string | null;
}

const INDEX_KEY = "punishments:index";
const ACTIVE_KEY = "punishment:active:Besho";
const punishmentKey = (id: string) => `punishment:${id}`;

const LEDGER_INDEX_KEY = "ledger:index";
const ledgerKey = (id: string) => `ledger:${id}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getActivePunishment(
  author: "T7SEN" | "Besho",
): Promise<Punishment | null> {
  if (author !== "Besho") return null;
  try {
    const id = await redis.get<string>(ACTIVE_KEY);
    if (!id) return null;
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return null;
    if (record.state !== "issued" && record.state !== "running") return null;
    return record;
  } catch (err) {
    logger.error("[punishment] getActivePunishment failed", err);
    return null;
  }
}

export async function getPunishmentHistory(
  limit = 50,
): Promise<Punishment[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, Math.max(0, limit - 1), {
      rev: true,
    })) as string[];
    if (!ids.length) return [];
    const records = await redis.mget<(Punishment | null)[]>(
      ...ids.map(punishmentKey),
    );
    return records.filter((r): r is Punishment => r !== null);
  } catch (err) {
    logger.error("[punishment] getPunishmentHistory failed", err);
    return [];
  }
}

// ─── Issue (Sir-only) ─────────────────────────────────────────────────────────

export async function issuePunishment(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string; id?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can issue punishments." };

  const reason = (formData.get("reason") as string)?.trim();
  const durationStr = (formData.get("durationSec") as string)?.trim();

  if (!reason) return { error: "Reason is required." };
  if (reason.length > MAX_PUNISHMENT_REASON_LEN)
    return { error: `Reason is capped at ${MAX_PUNISHMENT_REASON_LEN} chars.` };

  const n = Number(durationStr);
  if (!Number.isFinite(n))
    return { error: "Duration must be a number (seconds)." };
  if (n < MIN_PUNISHMENT_DURATION_SEC || n > MAX_PUNISHMENT_DURATION_SEC)
    return {
      error: `Duration must be ${MIN_PUNISHMENT_DURATION_SEC}–${MAX_PUNISHMENT_DURATION_SEC} seconds.`,
    };
  const durationSec = Math.floor(n);

  // Single-slot guard.
  try {
    const existing = await redis.get<string>(ACTIVE_KEY);
    if (existing) {
      return {
        error:
          "A punishment is already active. Cancel it before issuing a new one.",
      };
    }
  } catch (err) {
    logger.warn("[punishment] active-sentinel read failed", { err });
  }

  const issuedAt = Date.now();
  const punishment: Punishment = {
    id: crypto.randomUUID(),
    issuedBy: "T7SEN",
    target: "Besho",
    reason,
    durationSec,
    issuedAt,
    startsAt: null,
    endsAt: null,
    completedAt: null,
    bailedAt: null,
    cancelledAt: null,
    state: "issued",
    linkedLedgerId: null,
  };

  try {
    const sentinelTtl = durationSec + PUNISHMENT_ACTIVE_TTL_BUFFER_SEC;
    const pipeline = redis.pipeline();
    pipeline.set(punishmentKey(punishment.id), punishment);
    pipeline.zadd(INDEX_KEY, { score: issuedAt, member: punishment.id });
    pipeline.set(ACTIVE_KEY, punishment.id, { ex: sentinelTtl });
    await pipeline.exec();

    // bypassPresence: true — the timer must engage immediately
    // regardless of which page kitten is on. high-priority + default
    // channel so the heads-up banner surfaces on a backgrounded app.
    await sendNotification(
      "Besho",
      {
        title: "🔔 Punishment timer",
        body: reason,
        url: "/",
      },
      {
        bypassPresence: true,
        android: { priority: "high" },
        extraData: {
          kind: PUNISHMENT_PAYLOAD_KIND,
          punishmentId: punishment.id,
        },
      },
    );

    logger.interaction("[punishment] issued", {
      id: punishment.id,
      reason,
      durationSec,
      by: session.author,
    });
    revalidatePath("/admin/punishment-timer");
    revalidatePath("/");
    return { success: true, id: punishment.id };
  } catch (err) {
    logger.error("[punishment] issuePunishment failed", err);
    return { error: "Failed to issue punishment." };
  }
}

// ─── Start (Besho-only) ───────────────────────────────────────────────────────

export async function startPunishment(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can begin a punishment." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return { error: "Punishment not found." };
    if (record.state === "running") return { success: true };
    if (record.state !== "issued")
      return { error: "Punishment can no longer be started." };

    const startsAt = Date.now();
    const updated: Punishment = {
      ...record,
      state: "running",
      startsAt,
      endsAt: startsAt + record.durationSec * 1000,
    };
    await redis.set(punishmentKey(id), updated);

    logger.interaction("[punishment] started", {
      id,
      durationSec: record.durationSec,
    });
    revalidatePath("/admin/punishment-timer");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[punishment] startPunishment failed", err);
    return { error: "Failed to start punishment." };
  }
}

// ─── Complete (Besho-only) ────────────────────────────────────────────────────

export async function completePunishment(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can complete a punishment." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return { error: "Punishment not found." };
    if (record.state === "completed") return { success: true };
    if (record.state !== "running")
      return { error: "Punishment is not running." };
    if (!record.endsAt)
      return { error: "Punishment has no end time." };

    const completedAt = Date.now();
    if (completedAt < record.endsAt) {
      const remainingSec = Math.ceil((record.endsAt - completedAt) / 1000);
      return {
        error: `${remainingSec}s left. Wait until the timer finishes.`,
      };
    }

    // Inline ledger write + obedience emit. Skipping createLedgerEntry
    // because it fires the standard `ledger_punishment` emit, which
    // would double-count against the typed `punishment_completed`.
    const ledgerEntry = await writeLinkedLedgerEntry({
      kind: "completed",
      punishmentId: record.id,
      reason: record.reason,
      timestamp: completedAt,
    });

    const updated: Punishment = {
      ...record,
      state: "completed",
      completedAt,
      linkedLedgerId: ledgerEntry.id,
    };

    const pipeline = redis.pipeline();
    pipeline.set(punishmentKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    void recordObedienceEvent(
      "Besho",
      "punishment_completed",
      id,
      completedAt,
    );

    // Sir confirmation push.
    await sendNotification("T7SEN", {
      title: "✓ Punishment completed",
      body: `${TITLE_BY_AUTHOR.Besho}: ${record.reason}`,
      url: "/admin/punishment-timer",
    });

    logger.interaction("[punishment] completed", {
      id,
      durationSec: record.durationSec,
      ledgerId: ledgerEntry.id,
    });
    revalidatePath("/admin/punishment-timer");
    revalidatePath("/ledger");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[punishment] completePunishment failed", err);
    return { error: "Failed to complete punishment." };
  }
}

// ─── Bail (Besho-only OR cron-internal) ───────────────────────────────────────

export async function bailPunishment(
  id: string,
  reasonTag: "user-bail" | "background-grace" | "timeout" = "user-bail",
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  // user-bail flows MUST be authenticated by Besho. background-grace
  // is also user-driven (the overlay calls bailPunishment from the
  // grace-timeout effect) so it also requires session. timeout is
  // cron-only and skips the session check (the cron has no session).
  if (reasonTag !== "timeout") {
    if (!session?.author) return { error: "Not authenticated." };
    if (session.author !== "Besho")
      return { error: "Only kitten can bail a punishment." };
    const block = await assertWriteAllowed(session.author);
    if (block) return block;
  }

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return { error: "Punishment not found." };
    if (record.state === "bailed") return { success: true };
    if (record.state !== "running" && record.state !== "issued")
      return { error: "Punishment is no longer active." };

    const bailedAt = Date.now();
    const ledgerEntry = await writeLinkedLedgerEntry({
      kind: "bailed",
      punishmentId: record.id,
      reason: record.reason,
      timestamp: bailedAt,
      bailReason: reasonTag,
    });

    const updated: Punishment = {
      ...record,
      state: "bailed",
      bailedAt,
      linkedLedgerId: ledgerEntry.id,
    };

    const pipeline = redis.pipeline();
    pipeline.set(punishmentKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    void recordObedienceEvent("Besho", "punishment_bailed", id, bailedAt);

    // Sir gets the bail notification regardless of trigger source —
    // it's a behavior signal he wants to know about.
    try {
      await sendNotification("T7SEN", {
        title: "⚠️ Punishment bailed",
        body: `${TITLE_BY_AUTHOR.Besho} (${reasonTag}): ${record.reason}`,
        url: "/admin/punishment-timer",
      });
    } catch {
      // best-effort
    }

    logger.warn("[punishment] bailed", {
      id,
      reasonTag,
      durationSec: record.durationSec,
      ledgerId: ledgerEntry.id,
    });
    revalidatePath("/admin/punishment-timer");
    revalidatePath("/ledger");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[punishment] bailPunishment failed", err);
    return { error: "Failed to bail punishment." };
  }
}

// ─── Cancel (Sir-only) ────────────────────────────────────────────────────────

export async function cancelPunishment(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can cancel a punishment." };

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return { error: "Punishment not found." };
    if (
      record.state === "completed" ||
      record.state === "bailed" ||
      record.state === "cancelled"
    ) {
      return { error: "Punishment is already finalized." };
    }

    const cancelledAt = Date.now();
    const updated: Punishment = {
      ...record,
      state: "cancelled",
      cancelledAt,
    };

    const pipeline = redis.pipeline();
    pipeline.set(punishmentKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    logger.interaction("[punishment] cancelled", {
      id,
      reason: record.reason,
      by: session.author,
    });
    revalidatePath("/admin/punishment-timer");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[punishment] cancelPunishment failed", err);
    return { error: "Failed to cancel punishment." };
  }
}

// ─── Cron-only sweep ──────────────────────────────────────────────────────────

/** Walks the most-recent N punishments and bails any that are
 *  `running` past `endsAt + BACKGROUND_GRACE_SEC` without completion.
 *  Called once per cron tick from `/api/cron/timer-expire`. */
export async function expireDuePunishments(
  scanLimit = 200,
): Promise<{ scanned: number; bailed: number }> {
  let scanned = 0;
  let bailed = 0;
  try {
    const ids = (await redis.zrange(
      INDEX_KEY,
      0,
      Math.max(0, scanLimit - 1),
      { rev: true },
    )) as string[];
    if (!ids.length) return { scanned, bailed };
    const records = await redis.mget<(Punishment | null)[]>(
      ...ids.map(punishmentKey),
    );
    const now = Date.now();
    const graceMs = BACKGROUND_GRACE_SEC * 1000;
    for (const record of records) {
      if (!record) continue;
      scanned++;
      if (record.state !== "running") continue;
      if (!record.endsAt) continue;
      if (record.endsAt + graceMs > now) continue;

      const result = await bailPunishment(record.id, "timeout");
      if (result.success) bailed++;
    }
  } catch (err) {
    logger.error("[punishment] expireDuePunishments sweep failed", err);
  }
  return { scanned, bailed };
}

// ─── Soft-delete (Sir-only) ───────────────────────────────────────────────────

export async function deletePunishment(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete punishments." };

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) return { error: "Punishment not found." };
    if (record.state === "issued" || record.state === "running") {
      return { error: "Cancel the punishment before deleting it." };
    }

    const score = await redis.zscore(INDEX_KEY, id);
    await moveToTrash(redis, {
      feature: "punishments",
      id,
      label: `🔔 ${record.reason.slice(0, 40)}`,
      deletedBy: session.author,
      payload: record,
      indexScore:
        typeof score === "number"
          ? score
          : Number(score) || record.issuedAt,
      recordKey: punishmentKey(id),
      indexKey: INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(punishmentKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[punishment] deleted", { id, reason: record.reason });
    revalidatePath("/admin/punishment-timer");
    return { success: true };
  } catch (err) {
    logger.error("[punishment] deletePunishment failed", err);
    return { error: "Failed to delete punishment." };
  }
}

export async function purgeAllPunishments(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can purge punishments." };

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
        (await redis.mget<Punishment[]>(...ids.map(punishmentKey))) ?? [];

      const active = records.find(
        (r) => r && (r.state === "issued" || r.state === "running"),
      );
      if (active) {
        return {
          error: "An active punishment exists. Cancel it before purging.",
        };
      }

      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const rec = records[i];
          return {
            feature: "punishments" as const,
            id: p.id,
            label: rec ? `🔔 ${rec.reason.slice(0, 40)}` : p.id,
            deletedBy: session.author,
            payload: rec ?? null,
            indexScore: p.score,
            recordKey: punishmentKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(punishmentKey(id));
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/admin/punishment-timer");
    logger.warn(`[punishment] Sir purged ${ids.length} punishments.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[punishment] purgeAllPunishments failed", err);
    return { error: "Purge failed." };
  }
}

// ─── Internal: inline ledger writer ───────────────────────────────────────────
//
// Writes a `ledger:{id}` record + index ZSET entry directly. NOT a
// re-export of `createLedgerEntry` because that helper emits the
// standard `ledger_punishment` obedience event, which would double-
// count against the typed `punishment_completed` /
// `punishment_bailed` events emitted at the call site.

interface LinkedLedgerInput {
  kind: "completed" | "bailed";
  punishmentId: string;
  reason: string;
  timestamp: number;
  bailReason?: "user-bail" | "background-grace" | "timeout";
}

async function writeLinkedLedgerEntry(
  input: LinkedLedgerInput,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  const titlePrefix =
    input.kind === "completed" ? "Auto: completed" : "Auto: bailed";
  const description =
    input.kind === "bailed" && input.bailReason
      ? `${titlePrefix} punishment timer (${input.bailReason}) — ${input.reason}`
      : `${titlePrefix} punishment timer — ${input.reason}`;

  const entry: LedgerEntry = {
    id,
    type: "punishment" satisfies LedgerEntryType,
    category: "Other",
    title: input.reason.slice(0, 80),
    description,
    timestamp: input.timestamp,
    author: "T7SEN",
    linkedPunishmentId: input.punishmentId,
  };

  const pipeline = redis.pipeline();
  pipeline.set(ledgerKey(id), entry);
  pipeline.zadd(LEDGER_INDEX_KEY, {
    score: input.timestamp,
    member: id,
  });
  await pipeline.exec();
  return { id };
}
