// packages/cli/src/commands/violation.ts
//
//   ourspace violation <ruleId> <minor|moderate|major> "<title>" [--description "..."]
//
// Logs a rule-violation ledger entry against the given rule. Snapshots
// the rule body into the entry (mirrors the in-app behavior — rule
// edits don't rewrite history). Fires a severity-scaled obedience
// penalty (rule_violation_${severity}) and notifies kitten via FCM.
//
// Grab `ruleId` from `ourspace rules`. Severity must be exactly one
// of: minor, moderate, major.

import { loadConfig } from "../lib/config.ts";
import { post } from "../lib/api.ts";
import { c, fail, ok } from "../lib/format.ts";

const SEVERITIES = ["minor", "moderate", "major"] as const;
type Severity = (typeof SEVERITIES)[number];

interface ViolationResponse {
  ok: true;
  id: string;
}

export async function violationCommand(args: string[]): Promise<number> {
  if (args.length < 3) {
    fail(
      'Usage: ourspace violation <ruleId> <minor|moderate|major> "<title>" [--description "..."]',
    );
    return 2;
  }

  const ruleId = args[0];
  const severityRaw = args[1];
  const title = args[2];

  if (!(SEVERITIES as readonly string[]).includes(severityRaw)) {
    fail(`severity must be one of ${SEVERITIES.join(", ")}.`);
    return 2;
  }
  const severity = severityRaw as Severity;

  let description: string | undefined;
  for (let i = 3; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--description") {
      description = value;
      i++;
    } else {
      fail(`Unknown flag: ${flag}`);
      return 2;
    }
  }

  const config = loadConfig();
  const res = await post<ViolationResponse>(
    config,
    "/api/admin/cli/violation",
    {
      ruleId,
      severity,
      title,
      ...(description && { description }),
    },
  );
  ok(`Violation logged (${c.red(severity)}). ${c.dim(res.id)}`);
  return 0;
}

violationCommand.help =
  'ourspace violation <ruleId> <minor|moderate|major> "<title>" [--description "..."]\n' +
  "  Log a rule-violation ledger entry. ruleId comes from\n" +
  "  `os rules`. Severity scales the obedience penalty (minor / mod /\n" +
  "  major). The rule body is snapshotted at write time so future rule\n" +
  "  edits don't rewrite this entry's display.";
