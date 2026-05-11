// src/app/api/admin/cli/violation/route.ts
//
// CLI-only rule-violation logger. Mirrors the `violation` branch of
// `createLedgerEntry` from `src/app/actions/ledger.ts` — same Redis
// writes (ledger record + ledger index + per-rule index), same rule-
// snapshot, same severity-typed obedience emit, same FCM. Logged
// with `by: "T7SEN (cli)"` via `recordObedienceEvent` attribution.
//
//   POST /api/admin/cli/violation
//     body: { ruleId, severity, title, description?, timestamp? }
//     → { ok, id }

import { redis } from "@/lib/redis";
import { sendNotification } from "@/app/actions/notifications";
import { recordObedienceEvent } from "@/lib/obedience";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import {
  MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN,
  VIOLATION_SEVERITIES,
  VIOLATION_SEVERITY_LABEL,
  type ViolationSeverity,
} from "@/lib/ledger-constants";
import type { LedgerEntry } from "@/app/actions/ledger";
import type { Rule } from "@/app/actions/rules";

const INDEX_KEY = "ledger:index";
const entryKey = (id: string) => `ledger:${id}`;
const violationsByRuleKey = (ruleId: string) =>
  `ledger:violations:by-rule:${ruleId}`;

interface ViolationBody {
  ruleId?: unknown;
  severity?: unknown;
  title?: unknown;
  description?: unknown;
  timestamp?: unknown;
}

export async function POST(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  let payload: ViolationBody;
  try {
    payload = (await req.json()) as ViolationBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ruleId =
    typeof payload.ruleId === "string" ? payload.ruleId.trim() : "";
  const severityRaw =
    typeof payload.severity === "string" ? payload.severity.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const description =
    typeof payload.description === "string" ? payload.description.trim() : "";

  if (!ruleId) {
    return Response.json({ error: "ruleId is required." }, { status: 400 });
  }
  if (!(VIOLATION_SEVERITIES as readonly string[]).includes(severityRaw)) {
    return Response.json(
      {
        error: `severity must be one of ${VIOLATION_SEVERITIES.join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (!title) {
    return Response.json({ error: "title is required." }, { status: 400 });
  }
  const severity = severityRaw as ViolationSeverity;

  // Timestamp: accept either ISO string, epoch-ms number, or omit
  // for "now".
  let timestamp = Date.now();
  if (payload.timestamp !== undefined && payload.timestamp !== null) {
    if (typeof payload.timestamp === "number") {
      timestamp = payload.timestamp;
    } else if (typeof payload.timestamp === "string") {
      const parsed = new Date(payload.timestamp).getTime();
      if (!Number.isFinite(parsed)) {
        return Response.json(
          { error: "timestamp is not a valid date." },
          { status: 400 },
        );
      }
      timestamp = parsed;
    }
  }

  try {
    const rule = await redis.get<Rule>(`rule:${ruleId}`);
    if (!rule) {
      return Response.json({ error: "Rule not found." }, { status: 404 });
    }

    const snapshotBody = rule.description
      ? rule.description.slice(0, MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN)
      : undefined;
    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      type: "violation",
      category: VIOLATION_SEVERITY_LABEL[severity],
      title,
      ...(description && { description }),
      timestamp,
      author: "T7SEN",
      ruleId,
      ruleSnapshot: {
        title: rule.title,
        ...(snapshotBody && { body: snapshotBody }),
      },
      severity,
    };

    const pipeline = redis.pipeline();
    pipeline.set(entryKey(entry.id), entry);
    pipeline.zadd(INDEX_KEY, { score: timestamp, member: entry.id });
    pipeline.zadd(violationsByRuleKey(ruleId), {
      score: timestamp,
      member: entry.id,
    });
    await pipeline.exec();

    // Severity-scaled obedience emit. Mirrors createLedgerEntry's
    // branch exactly so the score landing is identical to the web UI.
    void recordObedienceEvent(
      "Besho",
      `rule_violation_${severity}` as const,
      entry.id,
      timestamp,
    );

    await sendNotification("Besho", {
      title: "⚠️ Rule violation logged",
      body: `${VIOLATION_SEVERITY_LABEL[severity]} · ${rule.title}: ${title}`,
      url: "/ledger",
    });

    logger.interaction("[admin/cli] violation logged", {
      id: entry.id,
      ruleId,
      severity,
      title,
      by: "T7SEN (cli)",
    });
    return Response.json({ ok: true, id: entry.id });
  } catch (err) {
    logger.error("[admin/cli] violation create failed", err);
    return Response.json(
      { error: "Failed to log violation." },
      { status: 500 },
    );
  }
}
