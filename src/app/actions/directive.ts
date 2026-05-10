"use server";

// src/app/actions/directive.ts
//
// Server actions for the real-time directive overlay. Sir issues a
// short-lived directive (1–60 min, optional countdown) targeting Besho;
// she sees a full-screen overlay if foregrounded or an OS heads-up
// banner if not. She acknowledges → completes (or expires via cron).
// Logs to the obedience score; no ledger entry — directives are
// operational, not corrective.
//
// Single-slot model: only one directive is "active" against Besho at a
// time. `directive:active:Besho` STRING is the sentinel; reissuing
// while active refuses (Sir cancels first). Mirrors the locked-in
// default from Plan #1 open-question 1.

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
  DIRECTIVE_OPEN_ENDED_TTL_SEC,
  DIRECTIVE_PAYLOAD_KIND,
  MAX_DIRECTIVE_BODY_LEN,
  MAX_DIRECTIVE_DURATION_SEC,
  MAX_DIRECTIVE_TITLE_LEN,
  MIN_DIRECTIVE_DURATION_SEC,
  type DirectiveState,
} from "@/lib/directive-constants";
import { TITLE_BY_AUTHOR } from "@/lib/constants";

export interface Directive {
  id: string;
  /** Always "T7SEN" — only Sir issues. */
  issuedBy: "T7SEN";
  /** Always "Besho" — single-target by design (locked-in default). */
  target: "Besho";
  title: string;
  body?: string;
  /** Countdown in seconds (1–60 min) OR null for open-ended. */
  durationSec: number | null;
  issuedAt: number;
  /** `issuedAt + durationSec * 1000` when duration is set; else null.
   *  The cron only expires directives where this is set. Open-ended
   *  directives stay active until Sir cancels OR the 24h sentinel
   *  TTL fires (kicks the active sentinel only — record stays
   *  "issued" until cron / cancel). */
  expiresAt: number | null;
  acknowledgedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  state: DirectiveState;
}

const INDEX_KEY = "directives:index";
const ACTIVE_KEY = "directive:active:Besho";
const directiveKey = (id: string) => `directive:${id}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getActiveDirective(
  author: "T7SEN" | "Besho",
): Promise<Directive | null> {
  if (author !== "Besho") return null;
  try {
    const id = await redis.get<string>(ACTIVE_KEY);
    if (!id) return null;
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return null;
    // The sentinel can outlive a state transition during a half-failed
    // pipeline. Treat any non-active state as "no active directive"
    // and let the next cron tick (or Sir's cancel) clean up.
    if (record.state !== "issued" && record.state !== "acknowledged") {
      return null;
    }
    return record;
  } catch (err) {
    logger.error("[directive] getActiveDirective failed", err);
    return null;
  }
}

export async function getDirectiveHistory(
  limit = 50,
): Promise<Directive[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, Math.max(0, limit - 1), {
      rev: true,
    })) as string[];
    if (!ids.length) return [];
    const records = await redis.mget<(Directive | null)[]>(
      ...ids.map(directiveKey),
    );
    return records.filter((r): r is Directive => r !== null);
  } catch (err) {
    logger.error("[directive] getDirectiveHistory failed", err);
    return [];
  }
}

// ─── Issue (Sir-only) ─────────────────────────────────────────────────────────

export async function issueDirective(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string; id?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can issue directives." };

  const title = (formData.get("title") as string)?.trim();
  const body = (formData.get("body") as string)?.trim();
  const durationStr = (formData.get("durationSec") as string)?.trim();

  if (!title) return { error: "Title is required." };
  if (title.length > MAX_DIRECTIVE_TITLE_LEN)
    return { error: `Title is capped at ${MAX_DIRECTIVE_TITLE_LEN} chars.` };
  if (body && body.length > MAX_DIRECTIVE_BODY_LEN)
    return { error: `Body is capped at ${MAX_DIRECTIVE_BODY_LEN} chars.` };

  let durationSec: number | null = null;
  if (durationStr) {
    const n = Number(durationStr);
    if (!Number.isFinite(n))
      return { error: "Duration must be a number (seconds)." };
    if (n < MIN_DIRECTIVE_DURATION_SEC || n > MAX_DIRECTIVE_DURATION_SEC)
      return {
        error: `Duration must be ${MIN_DIRECTIVE_DURATION_SEC}–${MAX_DIRECTIVE_DURATION_SEC} seconds.`,
      };
    durationSec = Math.floor(n);
  }

  // Single-slot guard. Plan #1 default: refuse if active. Sir cancels
  // first via cancelDirective. The sentinel TTL bounds deadlock if a
  // record gets stuck in `issued` — but normal flow is explicit cancel.
  try {
    const existing = await redis.get<string>(ACTIVE_KEY);
    if (existing) {
      return {
        error:
          "A directive is already active. Cancel it before issuing a new one.",
      };
    }
  } catch (err) {
    logger.warn("[directive] active-sentinel read failed", { err });
    // Fall through — a transient Redis hiccup shouldn't block Sir
    // permanently. The pipeline write below will still succeed; in the
    // rare case of a true active overlap, the cron + cancel flow
    // recovers within one tick.
  }

  const issuedAt = Date.now();
  const directive: Directive = {
    id: crypto.randomUUID(),
    issuedBy: "T7SEN",
    target: "Besho",
    title,
    ...(body && { body }),
    durationSec,
    issuedAt,
    expiresAt: durationSec ? issuedAt + durationSec * 1000 : null,
    acknowledgedAt: null,
    completedAt: null,
    cancelledAt: null,
    state: "issued",
  };

  try {
    const sentinelTtl = durationSec ?? DIRECTIVE_OPEN_ENDED_TTL_SEC;
    const pipeline = redis.pipeline();
    pipeline.set(directiveKey(directive.id), directive);
    pipeline.zadd(INDEX_KEY, { score: issuedAt, member: directive.id });
    pipeline.set(ACTIVE_KEY, directive.id, { ex: sentinelTtl });
    await pipeline.exec();

    // Presence-aware FCM. `bypassPresence: false` — directives respect
    // the presence rules. Foreground-on-/ → data-only payload, the
    // foreground listener routes via `data.kind === "directive"` to
    // `<DirectiveDialog>`. Background → full notification banner.
    await sendNotification(
      "Besho",
      {
        title: "🎯 New directive",
        body: title,
        url: "/",
      },
      {
        bypassPresence: false,
        extraData: {
          kind: DIRECTIVE_PAYLOAD_KIND,
          directiveId: directive.id,
        },
      },
    );

    logger.interaction("[directive] issued", {
      id: directive.id,
      title,
      durationSec: durationSec ?? "open-ended",
      by: session.author,
    });
    revalidatePath("/admin/directive");
    revalidatePath("/");
    return { success: true, id: directive.id };
  } catch (err) {
    logger.error("[directive] issueDirective failed", err);
    return { error: "Failed to issue directive." };
  }
}

// ─── Acknowledge (Besho-only) ─────────────────────────────────────────────────

export async function acknowledgeDirective(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can acknowledge a directive." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return { error: "Directive not found." };
    if (record.state === "acknowledged") return { success: true };
    if (record.state !== "issued")
      return { error: "Directive is no longer pending acknowledgement." };
    if (record.expiresAt && record.expiresAt < Date.now())
      return { error: "Directive has expired." };

    const ackedAt = Date.now();
    const updated: Directive = {
      ...record,
      state: "acknowledged",
      acknowledgedAt: ackedAt,
    };
    await redis.set(directiveKey(id), updated);

    logger.interaction("[directive] acknowledged", {
      id,
      title: record.title,
    });
    revalidatePath("/admin/directive");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[directive] acknowledgeDirective failed", err);
    return { error: "Failed to acknowledge directive." };
  }
}

// ─── Complete (Besho-only) ────────────────────────────────────────────────────

export async function completeDirective(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can complete a directive." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return { error: "Directive not found." };
    if (record.state === "completed") return { success: true };
    if (record.state === "expired" || record.state === "cancelled")
      return { error: "Directive can no longer be completed." };
    if (record.expiresAt && record.expiresAt < Date.now())
      return { error: "Directive has expired." };

    const completedAt = Date.now();
    const updated: Directive = {
      ...record,
      state: "completed",
      // Auto-acknowledge if completion happens before explicit ack
      // (e.g. Sir's directive lands while kitten is on the dialog and
      // she taps "complete" without first tapping "acknowledge").
      acknowledgedAt: record.acknowledgedAt ?? completedAt,
      completedAt,
    };

    const pipeline = redis.pipeline();
    pipeline.set(directiveKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    void recordObedienceEvent(
      "Besho",
      "directive_completed",
      id,
      completedAt,
    );

    // Sir gets a confirmation push so the activity surfaces in his
    // notification drawer too.
    await sendNotification("T7SEN", {
      title: "✓ Directive completed",
      body: `${TITLE_BY_AUTHOR.Besho}: ${record.title}`,
      url: "/admin/directive",
    });

    logger.interaction("[directive] completed", {
      id,
      title: record.title,
      durationSec: record.durationSec ?? "open-ended",
      ackedToCompleteMs:
        record.acknowledgedAt !== null
          ? completedAt - record.acknowledgedAt
          : 0,
    });
    revalidatePath("/admin/directive");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[directive] completeDirective failed", err);
    return { error: "Failed to complete directive." };
  }
}

// ─── Cancel (Sir-only) ────────────────────────────────────────────────────────

export async function cancelDirective(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can cancel a directive." };

  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return { error: "Directive not found." };
    if (
      record.state === "completed" ||
      record.state === "expired" ||
      record.state === "cancelled"
    ) {
      return { error: "Directive is already finalized." };
    }

    const cancelledAt = Date.now();
    const updated: Directive = {
      ...record,
      state: "cancelled",
      cancelledAt,
    };

    const pipeline = redis.pipeline();
    pipeline.set(directiveKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    logger.interaction("[directive] cancelled", {
      id,
      title: record.title,
      by: session.author,
    });
    revalidatePath("/admin/directive");
    revalidatePath("/");
    return { success: true };
  } catch (err) {
    logger.error("[directive] cancelDirective failed", err);
    return { error: "Failed to cancel directive." };
  }
}

// ─── Expire (cron-only) ───────────────────────────────────────────────────────
//
// Called from `/api/cron/timer-expire`. Bearer-auth happens at the
// route layer; the action itself doesn't re-check (no session in the
// cron context). Idempotent — safe to call repeatedly on the same id.

export async function expireDirective(id: string): Promise<void> {
  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return;
    if (record.state !== "issued" && record.state !== "acknowledged") return;
    // Only expire when expiresAt is set AND past. Open-ended directives
    // ride the active-sentinel TTL only — the cron sweeps them up via
    // the same path once expiresAt becomes null-equivalent (their
    // active sentinel is gone, but that's not a state-mutating signal).
    if (!record.expiresAt) return;
    if (record.expiresAt > Date.now()) return;

    const updated: Directive = {
      ...record,
      state: "expired",
    };
    const pipeline = redis.pipeline();
    pipeline.set(directiveKey(id), updated);
    pipeline.del(ACTIVE_KEY);
    await pipeline.exec();

    void recordObedienceEvent(
      "Besho",
      "directive_missed",
      id,
      record.expiresAt,
    );

    logger.warn("[directive] expired", {
      id,
      title: record.title,
      durationSec: record.durationSec,
    });
  } catch (err) {
    logger.error("[directive] expireDirective failed", err, { id });
  }
}

/** Walks the most-recent N directives and expires any past their
 *  `expiresAt`. Single Redis batch on the mget; per-record state
 *  mutations are individual pipelines. Called once per cron tick. */
export async function expireDueDirectives(
  scanLimit = 200,
): Promise<{ scanned: number; expired: number }> {
  let scanned = 0;
  let expired = 0;
  try {
    const ids = (await redis.zrange(
      INDEX_KEY,
      0,
      Math.max(0, scanLimit - 1),
      { rev: true },
    )) as string[];
    if (!ids.length) return { scanned, expired };
    const records = await redis.mget<(Directive | null)[]>(
      ...ids.map(directiveKey),
    );
    const now = Date.now();
    for (const record of records) {
      if (!record) continue;
      scanned++;
      if (record.state !== "issued" && record.state !== "acknowledged")
        continue;
      if (!record.expiresAt) continue;
      if (record.expiresAt > now) continue;
      await expireDirective(record.id);
      expired++;
    }
  } catch (err) {
    logger.error("[directive] expireDueDirectives sweep failed", err);
  }
  return { scanned, expired };
}

// ─── Soft-delete (Sir-only) ───────────────────────────────────────────────────

export async function deleteDirective(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete directives." };

  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) return { error: "Directive not found." };
    if (record.state === "issued" || record.state === "acknowledged") {
      return {
        error: "Cancel the directive before deleting it.",
      };
    }

    const score = await redis.zscore(INDEX_KEY, id);
    await moveToTrash(redis, {
      feature: "directives",
      id,
      label: `🎯 ${record.title}`,
      deletedBy: session.author,
      payload: record,
      indexScore:
        typeof score === "number"
          ? score
          : Number(score) || record.issuedAt,
      recordKey: directiveKey(id),
      indexKey: INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(directiveKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[directive] deleted", { id, title: record.title });
    revalidatePath("/admin/directive");
    return { success: true };
  } catch (err) {
    logger.error("[directive] deleteDirective failed", err);
    return { error: "Failed to delete directive." };
  }
}

export async function purgeAllDirectives(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can purge directives." };

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
        (await redis.mget<Directive[]>(...ids.map(directiveKey))) ?? [];

      // Refuse to purge if any directive is still active — purge is a
      // cleanup tool, not a kill-switch. Sir cancels the active one
      // first.
      const active = records.find(
        (r) => r && (r.state === "issued" || r.state === "acknowledged"),
      );
      if (active) {
        return {
          error:
            "An active directive exists. Cancel it before purging.",
        };
      }

      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const rec = records[i];
          return {
            feature: "directives" as const,
            id: p.id,
            label: rec ? `🎯 ${rec.title}` : p.id,
            deletedBy: session.author,
            payload: rec ?? null,
            indexScore: p.score,
            recordKey: directiveKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(directiveKey(id));
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/admin/directive");
    logger.warn(`[directive] Sir purged ${ids.length} directives.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[directive] purgeAllDirectives failed", err);
    return { error: "Purge failed." };
  }
}
