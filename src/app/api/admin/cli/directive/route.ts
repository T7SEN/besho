// src/app/api/admin/cli/directive/route.ts
//
// CLI-only directive issuance + read. Mirrors `issueDirective` from
// `src/app/actions/directive.ts` — same Redis writes, same FCM
// payload, same single-slot guard. Logged with `by: "T7SEN (cli)"`.
// Skips `revalidatePath` calls because the CLI doesn't hit Next
// routes.
//
//   POST /api/admin/cli/directive
//     body: { title, body?, durationSec? }
//     → { ok, id, durationSec, expiresAt }
//
//   GET /api/admin/cli/directive?limit=10
//     → { ok, active, recent: [...] }

import { redis } from "@/lib/redis";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import {
  DIRECTIVE_OPEN_ENDED_TTL_SEC,
  DIRECTIVE_PAYLOAD_KIND,
  MAX_DIRECTIVE_BODY_LEN,
  MAX_DIRECTIVE_DURATION_SEC,
  MAX_DIRECTIVE_TITLE_LEN,
  MIN_DIRECTIVE_DURATION_SEC,
} from "@/lib/directive-constants";
import type { Directive } from "@/app/actions/directive";

const INDEX_KEY = "directives:index";
const ACTIVE_KEY = "directive:active:Besho";
const directiveKey = (id: string) => `directive:${id}`;

interface IssueBody {
  title?: unknown;
  body?: unknown;
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

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";

  if (!title) {
    return Response.json({ error: "Title is required." }, { status: 400 });
  }
  if (title.length > MAX_DIRECTIVE_TITLE_LEN) {
    return Response.json(
      { error: `Title is capped at ${MAX_DIRECTIVE_TITLE_LEN} chars.` },
      { status: 400 },
    );
  }
  if (body && body.length > MAX_DIRECTIVE_BODY_LEN) {
    return Response.json(
      { error: `Body is capped at ${MAX_DIRECTIVE_BODY_LEN} chars.` },
      { status: 400 },
    );
  }

  let durationSec: number | null = null;
  if (payload.durationSec !== undefined && payload.durationSec !== null) {
    const n = Number(payload.durationSec);
    if (!Number.isFinite(n)) {
      return Response.json(
        { error: "durationSec must be a number." },
        { status: 400 },
      );
    }
    if (n < MIN_DIRECTIVE_DURATION_SEC || n > MAX_DIRECTIVE_DURATION_SEC) {
      return Response.json(
        {
          error: `durationSec must be ${MIN_DIRECTIVE_DURATION_SEC}–${MAX_DIRECTIVE_DURATION_SEC}.`,
        },
        { status: 400 },
      );
    }
    durationSec = Math.floor(n);
  }

  // Single-slot guard. Mirrors the server action default — refuse if
  // active. The CLI must cancel first.
  try {
    const existing = await redis.get<string>(ACTIVE_KEY);
    if (existing) {
      return Response.json(
        {
          error:
            "A directive is already active. Cancel it before issuing a new one.",
        },
        { status: 409 },
      );
    }
  } catch (err) {
    logger.warn("[admin/cli] directive active-sentinel read failed", { err });
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

    logger.interaction("[admin/cli] directive issued", {
      id: directive.id,
      title,
      durationSec: durationSec ?? "open-ended",
      by: "T7SEN (cli)",
    });
    return Response.json({
      ok: true,
      id: directive.id,
      durationSec,
      expiresAt: directive.expiresAt,
    });
  } catch (err) {
    logger.error("[admin/cli] directive issue failed", err);
    return Response.json(
      { error: "Failed to issue directive." },
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
    let active: Directive | null = null;
    if (activeId) {
      const record = await redis.get<Directive>(directiveKey(activeId));
      if (
        record &&
        (record.state === "issued" || record.state === "acknowledged")
      ) {
        active = record;
      }
    }
    let recent: Directive[] = [];
    if (idsRaw.length) {
      const records = await redis.mget<(Directive | null)[]>(
        ...idsRaw.map(directiveKey),
      );
      recent = records.filter((r): r is Directive => r !== null);
    }
    return Response.json({ ok: true, active, recent });
  } catch (err) {
    logger.error("[admin/cli] directive read failed", err);
    return Response.json(
      { error: "Directive read failed." },
      { status: 500 },
    );
  }
}
