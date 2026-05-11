// src/app/api/admin/cli/restrain/route.ts
//
// CLI-only restraint toggle. Body: `{ on: boolean, note?: string }`.
// Returns the new state.
//
// Mirrors `admin.setRestraintState` from `src/app/actions/admin/devices.ts`
// — same Redis writes, same obedience emit on off→on transition, same
// restraint-history audit. Logged with `(cli)` marker. Skips the
// activity-feed revalidatePath calls because this is a non-Next-route-
// triggering write.

import {
  readRestraintRaw,
  setRestraintRaw,
} from "@/lib/restraint";
import { redis } from "@/lib/redis";
import { recordObedienceEvent } from "@/lib/obedience";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import { OBEDIENCE_NOTE_MAX } from "@/lib/reward-types";

interface RestraintBody {
  on: boolean;
  note?: string;
}

interface RestraintHistoryEntry {
  action: "engage" | "lift";
  by: "T7SEN (cli)";
  ts: number;
  reason?: string;
}

const RESTRAINT_HISTORY_KEY = "restraint:history";
const RESTRAINT_HISTORY_CAP = 200;

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let body: RestraintBody;
  try {
    body = (await req.json()) as RestraintBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }
  if (typeof body?.on !== "boolean") {
    return Response.json(
      { error: "Body requires { on: boolean }." },
      { status: 400 },
    );
  }
  const trimmedNote =
    typeof body.note === "string"
      ? body.note.trim().slice(0, OBEDIENCE_NOTE_MAX)
      : "";

  try {
    const previous = await readRestraintRaw();
    await setRestraintRaw(body.on);

    // Obedience: −10 on the off→on transition only. Mirrors the
    // existing admin action. Off-to-on with note rides into the
    // activity log via the recordObedienceEvent `note` arg.
    if (body.on && !previous) {
      void recordObedienceEvent(
        "Besho",
        "restraint_engaged",
        crypto.randomUUID(),
        Date.now(),
        undefined,
        trimmedNote || undefined,
      );
    }

    const ts = Date.now();
    const historyEntry: RestraintHistoryEntry = {
      action: body.on ? "engage" : "lift",
      by: "T7SEN (cli)",
      ts,
      ...(body.on && trimmedNote ? { reason: trimmedNote } : {}),
    };
    try {
      const pipeline = redis.pipeline();
      pipeline.zadd(RESTRAINT_HISTORY_KEY, {
        score: ts,
        member: JSON.stringify(historyEntry),
      });
      pipeline.zremrangebyrank(
        RESTRAINT_HISTORY_KEY,
        0,
        -(RESTRAINT_HISTORY_CAP + 1),
      );
      await pipeline.exec();
    } catch (err) {
      logger.warn("[admin/cli] restraint history write failed", { err });
    }

    logger.interaction("[admin] restraint state changed", {
      by: "T7SEN (cli)",
      on: body.on,
      previous,
      note: trimmedNote || undefined,
    });
    return Response.json({ ok: true, on: body.on, previous });
  } catch (err) {
    logger.error("[admin/cli] restrain failed", err);
    return Response.json(
      { error: "Restrain failed." },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  // `ourspace restrain status` calls GET — return current state
  // without mutating anything.
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  try {
    const on = await readRestraintRaw();
    return Response.json({ ok: true, on });
  } catch (err) {
    logger.error("[admin/cli] restrain read failed", err);
    return Response.json(
      { error: "Restraint read failed." },
      { status: 500 },
    );
  }
}
