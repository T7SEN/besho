// src/app/api/admin/cli/punish/cancel/route.ts
//
// CLI-only punishment cancel. Mirrors `cancelPunishment` — same Redis
// writes (state → "cancelled", active-sentinel cleared). Logged with
// `by: "T7SEN (cli)"`. Body is optional: `{ id? }`. Omit to cancel the
// currently-active punishment against Besho.

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import type { Punishment } from "@/app/actions/punishment";

const ACTIVE_KEY = "punishment:active:Besho";
const punishmentKey = (id: string) => `punishment:${id}`;

interface CancelBody {
  id?: unknown;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let payload: CancelBody = {};
  try {
    const text = await req.text();
    if (text.trim().length > 0) {
      payload = JSON.parse(text) as CancelBody;
    }
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!id) {
    const activeId = await redis.get<string>(ACTIVE_KEY);
    if (!activeId) {
      return Response.json(
        { error: "No active punishment to cancel." },
        { status: 404 },
      );
    }
    id = activeId;
  }

  try {
    const record = await redis.get<Punishment>(punishmentKey(id));
    if (!record) {
      return Response.json(
        { error: "Punishment not found." },
        { status: 404 },
      );
    }
    if (
      record.state === "completed" ||
      record.state === "bailed" ||
      record.state === "cancelled"
    ) {
      return Response.json(
        { error: "Punishment is already finalized." },
        { status: 409 },
      );
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

    logger.interaction("[admin/cli] punishment cancelled", {
      id,
      reason: record.reason,
      by: "T7SEN (cli)",
    });
    return Response.json({ ok: true, id, reason: record.reason });
  } catch (err) {
    logger.error("[admin/cli] punishment cancel failed", err);
    return Response.json(
      { error: "Failed to cancel punishment." },
      { status: 500 },
    );
  }
}
