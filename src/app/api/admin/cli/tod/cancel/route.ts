// src/app/api/admin/cli/tod/cancel/route.ts
//
// CLI force-cancel of a Truth or Dare challenge. Mirrors
// `forceCancelTodChallenge` (admin override): no obedience emit, no
// stat increment, captures the optional reason as `adminCancelReason`.
// When called without an `id`, cancels Sir's outgoing if present;
// otherwise cancels whichever single active slot exists. When called
// with `id`, cancels that specific record.
//
//   POST /api/admin/cli/tod/cancel
//     body: { id?: string, reason?: string }
//     → { ok, id, issuer, recipient }

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import {
  ACTIVE_STATUSES,
  MAX_CANCEL_REASON_LEN,
  todActiveKey,
  todChallengeKey,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";

interface CancelBody {
  id?: unknown;
  reason?: unknown;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let payload: CancelBody = {};
  try {
    const text = await req.text();
    if (text.length > 0) payload = JSON.parse(text) as CancelBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const reason =
    typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (reason.length > MAX_CANCEL_REASON_LEN) {
    return Response.json(
      { error: `Reason too long (max ${MAX_CANCEL_REASON_LEN}).` },
      { status: 400 },
    );
  }

  let targetId: string | null = null;
  if (typeof payload.id === "string" && payload.id.trim().length > 0) {
    targetId = payload.id.trim();
  } else {
    // No id supplied — resolve to whichever slot is currently active.
    // Prefers Sir's outgoing when both directions are filled.
    try {
      const [sirId, kittenId] = await Promise.all([
        redis.get<string>(todActiveKey("T7SEN")),
        redis.get<string>(todActiveKey("Besho")),
      ]);
      targetId = sirId || kittenId || null;
    } catch (err) {
      logger.error("[admin/cli] tod cancel active read failed", err);
    }
    if (!targetId) {
      return Response.json(
        { error: "No active TOD challenge to cancel." },
        { status: 404 },
      );
    }
  }

  try {
    const record = await redis.get<TodChallenge>(todChallengeKey(targetId));
    if (!record) {
      return Response.json(
        { error: "Challenge not found." },
        { status: 404 },
      );
    }
    if (!ACTIVE_STATUSES.includes(record.status)) {
      return Response.json(
        { error: "Challenge is already finalized." },
        { status: 409 },
      );
    }

    const closedAt = Date.now();
    const updated: TodChallenge = {
      ...record,
      status: "cancelled",
      closedAt,
      ...(reason.length > 0 && { adminCancelReason: reason }),
    };
    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(targetId), updated);
    pipeline.del(todActiveKey(record.issuer));
    await pipeline.exec();

    logger.warn("[admin/cli] tod challenge force-cancelled", {
      id: targetId,
      issuer: record.issuer,
      recipient: record.recipient,
      reason: reason || undefined,
      by: "T7SEN (cli)",
    });
    return Response.json({
      ok: true,
      id: targetId,
      issuer: record.issuer,
      recipient: record.recipient,
    });
  } catch (err) {
    logger.error("[admin/cli] tod cancel failed", err);
    return Response.json(
      { error: "Cancel failed." },
      { status: 500 },
    );
  }
}
