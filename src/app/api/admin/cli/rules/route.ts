// src/app/api/admin/cli/rules/route.ts
//
// CLI-only rule list. Read-only, no mutations. Returns the same
// records as `getRules()` from `src/app/actions/rules.ts`. Sir uses
// this to grab a `ruleId` before logging a violation via
// `os violation <ruleId> ...`.
//
//   GET /api/admin/cli/rules?status=pending|active|completed
//     → { ok, rules: [...] }
//
// The optional `status` filter lets Sir narrow to actionable rules
// (e.g. `?status=active` for the typical "what rules can she break"
// query). No filter returns the full set.

import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { requireCliAuth, cliAuthError } from "@/lib/admin-cli-auth";
import type { Rule, RuleStatus } from "@/app/actions/rules";

const INDEX_KEY = "rules:index";
const ruleKey = (id: string) => `rule:${id}`;

const VALID_STATUSES: readonly RuleStatus[] = [
  "pending",
  "active",
  "completed",
];

export async function GET(req: Request) {
  const guard = requireCliAuth(req);
  if (!guard.ok) return cliAuthError(guard);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const filter =
    statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as RuleStatus)
      : null;

  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];
    let rules: Rule[] = [];
    if (ids.length) {
      const records = await redis.mget<(Rule | null)[]>(...ids.map(ruleKey));
      rules = records.filter((r): r is Rule => r !== null);
    }
    if (filter) {
      rules = rules.filter((r) => r.status === filter);
    }
    return Response.json({ ok: true, rules });
  } catch (err) {
    logger.error("[admin/cli] rules read failed", err);
    return Response.json({ error: "Rules read failed." }, { status: 500 });
  }
}
