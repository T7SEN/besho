// packages/cli/src/commands/tod.ts
//
// Subcommands:
//   ourspace tod status [--limit N]
//   ourspace tod issue "<truth>" "<dare>"
//   ourspace tod cancel [<id>] [--reason "..."]
//
// Mirrors the in-app TOD admin surface. CLI issuance is always
// Sir-to-Kitten (the CLI is Sir's terminal tool — no symmetric play
// from the command line). `cancel` without an id resolves to whichever
// slot is currently active, preferring Sir's outgoing when both are
// filled.

import { loadConfig } from "../lib/config.ts";
import { get, post } from "../lib/api.ts";
import { c, fail, formatAge, ok, pad } from "../lib/format.ts";

type ChallengeStatus =
  | "pending"
  | "picked"
  | "completed"
  | "refused"
  | "safeworded"
  | "expired"
  | "withdrawn"
  | "cancelled";

interface Challenge {
  id: string;
  issuer: "T7SEN" | "Besho";
  recipient: "T7SEN" | "Besho";
  truthPrompt: string;
  darePrompt: string;
  pick: "truth" | "dare" | null;
  status: ChallengeStatus;
  response: string | null;
  createdAt: number;
  pickedAt: number | null;
  expiresAt: number;
}

interface StatusResponse {
  ok: true;
  active: {
    sirOutgoing: Challenge | null;
    kittenOutgoing: Challenge | null;
  };
  recent: Challenge[];
}

interface IssueResponse {
  ok: true;
  id: string;
  recipient: "Besho";
  expiresAt: number;
}

interface CancelResponse {
  ok: true;
  id: string;
  issuer: "T7SEN" | "Besho";
  recipient: "T7SEN" | "Besho";
}

function statusColor(status: ChallengeStatus): string {
  switch (status) {
    case "pending":
      return c.yellow(status);
    case "picked":
      return c.cyan(status);
    case "completed":
      return c.green(status);
    case "refused":
      return c.red(status);
    case "safeworded":
      return c.magenta(status);
    case "expired":
      return c.red(status);
    case "withdrawn":
    case "cancelled":
      return c.gray(status);
  }
}

function renderActiveCard(
  label: string,
  record: Challenge | null,
): string[] {
  const out: string[] = [c.bold(label)];
  if (!record) {
    out.push(c.dim("  (none)"));
    return out;
  }
  out.push(`  ${statusColor(record.status)}  ${c.dim(record.id)}`);
  out.push(`  ${c.dim("T:")} ${record.truthPrompt.slice(0, 80)}`);
  out.push(`  ${c.dim("D:")} ${record.darePrompt.slice(0, 80)}`);
  const remainingMs = record.expiresAt - Date.now();
  if (remainingMs > 0) {
    const hours = Math.floor(remainingMs / 3_600_000);
    const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
    out.push(`  ${c.dim("expires in")} ${hours}h ${minutes}m`);
  } else {
    out.push(`  ${c.dim("expires in")} ${c.red("overdue")}`);
  }
  if (record.pick) {
    out.push(`  ${c.dim("picked")} ${record.pick}`);
  }
  return out;
}

export async function todCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) {
    fail("Usage: ourspace tod <status|issue|cancel> [...]");
    return 2;
  }
  const config = loadConfig();

  // ── status ──────────────────────────────────────────────────────────────
  if (sub === "status") {
    let limit = 10;
    const limitIdx = args.indexOf("--limit");
    if (limitIdx !== -1 && args[limitIdx + 1]) {
      const n = Number(args[limitIdx + 1]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
    const res = await get<StatusResponse>(
      config,
      `/api/admin/cli/tod?limit=${limit}`,
    );
    const out: string[] = [];
    out.push(...renderActiveCard("Sir's outgoing", res.active.sirOutgoing));
    out.push("");
    out.push(
      ...renderActiveCard("Kitten's outgoing", res.active.kittenOutgoing),
    );
    out.push("");
    out.push(c.bold(`Recent (${res.recent.length})`));
    if (res.recent.length === 0) {
      out.push(c.dim("  (none)"));
    } else {
      for (const r of res.recent) {
        const directionLabel = `${r.issuer}→${r.recipient}`;
        out.push(
          `  ${pad(statusColor(r.status), 24)} ${pad(
            directionLabel,
            14,
          )} ${r.truthPrompt.slice(0, 40)}  ${c.dim(
            formatAge(Date.now() - r.createdAt),
          )}`,
        );
      }
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  // ── cancel ──────────────────────────────────────────────────────────────
  if (sub === "cancel") {
    let id: string | undefined;
    let reason: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--reason") {
        reason = args[i + 1];
        i++;
        continue;
      }
      if (!arg.startsWith("--") && !id) {
        id = arg;
      }
    }
    const res = await post<CancelResponse>(
      config,
      "/api/admin/cli/tod/cancel",
      {
        ...(id && { id }),
        ...(reason && { reason }),
      },
    );
    ok(
      `Force-cancelled ${c.dim(res.id)} (${res.issuer}→${res.recipient}).`,
    );
    return 0;
  }

  // ── issue ───────────────────────────────────────────────────────────────
  if (sub === "issue") {
    const truth = args[1];
    const dare = args[2];
    if (!truth || !dare) {
      fail('Usage: ourspace tod issue "<truth prompt>" "<dare prompt>"');
      return 2;
    }
    const res = await post<IssueResponse>(config, "/api/admin/cli/tod", {
      truthPrompt: truth,
      darePrompt: dare,
    });
    const expiresIn = res.expiresAt - Date.now();
    const hours = Math.floor(expiresIn / 3_600_000);
    ok(
      `Challenge issued to ${res.recipient} (${hours}h to pick). ${c.dim(
        res.id,
      )}`,
    );
    return 0;
  }

  fail(`Unknown tod subcommand: ${sub}`);
  return 2;
}

todCommand.help =
  'ourspace tod status [--limit N]\n' +
  'ourspace tod issue "<truth prompt>" "<dare prompt>"\n' +
  'ourspace tod cancel [<id>] [--reason "..."]\n' +
  "  status: show both active slots + the N most-recent challenges.\n" +
  "  issue:  fire a Sir-to-Kitten challenge (CLI is Sir-only by design).\n" +
  "          Refuses if Sir already has an outgoing — cancel first.\n" +
  "  cancel: force-cancel the active challenge (no obedience penalty,\n" +
  "          no stat increment). Omit the id to cancel whichever slot\n" +
  "          is currently active.";
