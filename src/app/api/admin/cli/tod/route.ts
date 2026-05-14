// src/app/api/admin/cli/tod/route.ts
//
// CLI-only Truth or Dare admin surface. Mirrors `issueChallenge` from
// `src/app/actions/games/truth-or-dare.ts` for the POST path — same
// Redis writes, same FCM payload, same single-slot guard — and the
// admin bundle reader for the GET path. Logged with `by: "T7SEN (cli)"`.
// Skips `revalidatePath` calls because the CLI doesn't hit Next routes.
//
//   GET /api/admin/cli/tod?limit=10
//     → { ok, active: { sirOutgoing, kittenOutgoing }, recent: [...] }
//
//   POST /api/admin/cli/tod
//     body: { truthPrompt, darePrompt }
//     → { ok, id, recipient, expiresAt }
//
// CLI issuance is always Sir-to-Kitten by design — the CLI is Sir's
// terminal-side tool. Kitten cannot issue via CLI.

import { redis } from "@/lib/redis";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import {
  ACTIVE_STATUSES,
  MAX_PROMPT_LEN,
  TOD_INDEX_KEY,
  TOD_PAYLOAD_KIND,
  TOD_PENDING_TTL_SEC,
  todActiveKey,
  todChallengeKey,
  todStatsKey,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";

interface IssueBody {
  truthPrompt?: unknown;
  darePrompt?: unknown;
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

  const truthPrompt =
    typeof payload.truthPrompt === "string" ? payload.truthPrompt.trim() : "";
  const darePrompt =
    typeof payload.darePrompt === "string" ? payload.darePrompt.trim() : "";

  if (!truthPrompt) {
    return Response.json(
      { error: "truthPrompt is required." },
      { status: 400 },
    );
  }
  if (!darePrompt) {
    return Response.json(
      { error: "darePrompt is required." },
      { status: 400 },
    );
  }
  if (truthPrompt.length > MAX_PROMPT_LEN) {
    return Response.json(
      { error: `truthPrompt is capped at ${MAX_PROMPT_LEN} chars.` },
      { status: 400 },
    );
  }
  if (darePrompt.length > MAX_PROMPT_LEN) {
    return Response.json(
      { error: `darePrompt is capped at ${MAX_PROMPT_LEN} chars.` },
      { status: 400 },
    );
  }

  // CLI is Sir-only by token-auth design. Issuer + recipient are
  // hardcoded — Kitten cannot author challenges from the CLI.
  const issuer = "T7SEN" as const;
  const recipient = "Besho" as const;

  // Single-slot guard on Sir's outgoing direction.
  try {
    const existing = await redis.get<string>(todActiveKey(issuer));
    if (existing) {
      return Response.json(
        {
          error:
            "Sir already has an outgoing TOD challenge. Cancel it first.",
        },
        { status: 409 },
      );
    }
  } catch (err) {
    logger.warn("[admin/cli] tod active-sentinel read failed", { err });
  }

  const createdAt = Date.now();
  const expiresAt = createdAt + TOD_PENDING_TTL_SEC * 1000;
  const record: TodChallenge = {
    id: crypto.randomUUID(),
    issuer,
    recipient,
    truthPrompt,
    darePrompt,
    pick: null,
    status: "pending",
    response: null,
    createdAt,
    pickedAt: null,
    respondedAt: null,
    closedAt: null,
    expiresAt,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(todChallengeKey(record.id), record);
    pipeline.zadd(TOD_INDEX_KEY, { score: createdAt, member: record.id });
    pipeline.set(todActiveKey(issuer), record.id, {
      ex: TOD_PENDING_TTL_SEC,
    });
    pipeline.hincrby(todStatsKey(issuer), "issued", 1);
    await pipeline.exec();

    await sendNotification(
      recipient,
      {
        title: "🎲 New challenge",
        body: "Sir issued a Truth or Dare.",
        url: "/games/truth-or-dare",
      },
      {
        extraData: {
          kind: TOD_PAYLOAD_KIND,
          challengeId: record.id,
        },
      },
    );

    logger.interaction("[admin/cli] tod challenge issued", {
      id: record.id,
      by: "T7SEN (cli)",
    });
    return Response.json({
      ok: true,
      id: record.id,
      recipient,
      expiresAt: record.expiresAt,
    });
  } catch (err) {
    logger.error("[admin/cli] tod issue failed", err);
    return Response.json(
      { error: "Failed to issue challenge." },
      { status: 500 },
    );
  }
}

interface ActiveSnapshot {
  sirOutgoing: TodChallenge | null;
  kittenOutgoing: TodChallenge | null;
}

async function readActiveSlot(
  issuer: "T7SEN" | "Besho",
): Promise<TodChallenge | null> {
  const id = await redis.get<string>(todActiveKey(issuer));
  if (!id) return null;
  const record = await redis.get<TodChallenge>(todChallengeKey(id));
  if (!record) return null;
  if (!ACTIVE_STATUSES.includes(record.status)) return null;
  return record;
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
    const [sirOutgoing, kittenOutgoing, idsRaw] = await Promise.all([
      readActiveSlot("T7SEN"),
      readActiveSlot("Besho"),
      redis.zrange(TOD_INDEX_KEY, 0, limit - 1, { rev: true }) as Promise<
        string[]
      >,
    ]);
    let recent: TodChallenge[] = [];
    if (idsRaw.length) {
      const records = await redis.mget<(TodChallenge | null)[]>(
        ...idsRaw.map(todChallengeKey),
      );
      recent = records.filter((r): r is TodChallenge => r !== null);
    }
    const active: ActiveSnapshot = { sirOutgoing, kittenOutgoing };
    return Response.json({ ok: true, active, recent });
  } catch (err) {
    logger.error("[admin/cli] tod read failed", err);
    return Response.json(
      { error: "TOD read failed." },
      { status: 500 },
    );
  }
}
