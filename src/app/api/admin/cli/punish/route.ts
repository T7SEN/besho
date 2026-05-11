// src/app/api/admin/cli/punish/route.ts
//
// CLI-only punishment-timer issuance + read. Mirrors `issuePunishment`
// from `src/app/actions/punishment.ts` — same Redis writes, same FCM
// payload (`bypassPresence: true`, high priority), same single-slot
// guard. Logged with `by: "T7SEN (cli)"`.
//
//   POST /api/admin/cli/punish
//     body: { reason, durationSec }
//     → { ok, id, durationSec, issuedAt }
//
//   GET /api/admin/cli/punish?limit=10
//     → { ok, active, recent: [...] }

import { redis } from "@/lib/redis";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import {
  MAX_PUNISHMENT_DURATION_SEC,
  MAX_PUNISHMENT_REASON_LEN,
  MIN_PUNISHMENT_DURATION_SEC,
  PUNISHMENT_ACTIVE_TTL_BUFFER_SEC,
  PUNISHMENT_PAYLOAD_KIND,
} from "@/lib/punishment-constants";
import type { Punishment } from "@/app/actions/punishment";

const INDEX_KEY = "punishments:index";
const ACTIVE_KEY = "punishment:active:Besho";
const punishmentKey = (id: string) => `punishment:${id}`;

interface IssueBody {
  reason?: unknown;
  durationSec?: unknown;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let payload: IssueBody;
  try {
    payload = (await req.json()) as IssueBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const reason =
    typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (!reason) {
    return Response.json({ error: "Reason is required." }, { status: 400 });
  }
  if (reason.length > MAX_PUNISHMENT_REASON_LEN) {
    return Response.json(
      { error: `Reason is capped at ${MAX_PUNISHMENT_REASON_LEN} chars.` },
      { status: 400 },
    );
  }

  const n = Number(payload.durationSec);
  if (!Number.isFinite(n)) {
    return Response.json(
      { error: "durationSec is required and must be a number." },
      { status: 400 },
    );
  }
  if (n < MIN_PUNISHMENT_DURATION_SEC || n > MAX_PUNISHMENT_DURATION_SEC) {
    return Response.json(
      {
        error: `durationSec must be ${MIN_PUNISHMENT_DURATION_SEC}–${MAX_PUNISHMENT_DURATION_SEC}.`,
      },
      { status: 400 },
    );
  }
  const durationSec = Math.floor(n);

  // Single-slot guard.
  try {
    const existing = await redis.get<string>(ACTIVE_KEY);
    if (existing) {
      return Response.json(
        {
          error:
            "A punishment is already active. Cancel it before issuing a new one.",
        },
        { status: 409 },
      );
    }
  } catch (err) {
    logger.warn("[admin/cli] punish active-sentinel read failed", { err });
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

    // bypassPresence: true — the overlay must engage regardless of
    // what page she's on. high-priority so backgrounded apps still get
    // the heads-up banner.
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

    logger.interaction("[admin/cli] punishment issued", {
      id: punishment.id,
      reason,
      durationSec,
      by: "T7SEN (cli)",
    });
    return Response.json({
      ok: true,
      id: punishment.id,
      durationSec,
      issuedAt,
    });
  } catch (err) {
    logger.error("[admin/cli] punishment issue failed", err);
    return Response.json(
      { error: "Failed to issue punishment." },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam
    ? Math.max(1, Math.min(100, Number(limitParam) || 10))
    : 10;

  try {
    const [activeId, idsRaw] = await Promise.all([
      redis.get<string>(ACTIVE_KEY),
      redis.zrange(INDEX_KEY, 0, limit - 1, { rev: true }) as Promise<
        string[]
      >,
    ]);
    let active: Punishment | null = null;
    if (activeId) {
      const record = await redis.get<Punishment>(punishmentKey(activeId));
      if (
        record &&
        (record.state === "issued" || record.state === "running")
      ) {
        active = record;
      }
    }
    let recent: Punishment[] = [];
    if (idsRaw.length) {
      const records = await redis.mget<(Punishment | null)[]>(
        ...idsRaw.map(punishmentKey),
      );
      recent = records.filter((r): r is Punishment => r !== null);
    }
    return Response.json({ ok: true, active, recent });
  } catch (err) {
    logger.error("[admin/cli] punishment read failed", err);
    return Response.json(
      { error: "Punishment read failed." },
      { status: 500 },
    );
  }
}
