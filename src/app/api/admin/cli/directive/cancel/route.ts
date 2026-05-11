// src/app/api/admin/cli/directive/cancel/route.ts
//
// CLI-only directive cancel. Mirrors `cancelDirective` — same Redis
// writes (state → "cancelled", active-sentinel cleared). Logged with
// `by: "T7SEN (cli)"`. Body is optional: `{ id? }`. Omit to cancel the
// currently-active directive against Besho.

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import type { Directive } from "@/app/actions/directive";

const ACTIVE_KEY = "directive:active:Besho";
const directiveKey = (id: string) => `directive:${id}`;

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
        { error: "No active directive to cancel." },
        { status: 404 },
      );
    }
    id = activeId;
  }

  try {
    const record = await redis.get<Directive>(directiveKey(id));
    if (!record) {
      return Response.json(
        { error: "Directive not found." },
        { status: 404 },
      );
    }
    if (
      record.state === "completed" ||
      record.state === "expired" ||
      record.state === "cancelled"
    ) {
      return Response.json(
        { error: "Directive is already finalized." },
        { status: 409 },
      );
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

    logger.interaction("[admin/cli] directive cancelled", {
      id,
      title: record.title,
      by: "T7SEN (cli)",
    });
    return Response.json({ ok: true, id, title: record.title });
  } catch (err) {
    logger.error("[admin/cli] directive cancel failed", err);
    return Response.json(
      { error: "Failed to cancel directive." },
      { status: 500 },
    );
  }
}
