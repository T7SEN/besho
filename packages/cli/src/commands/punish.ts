// packages/cli/src/commands/punish.ts
//
// Subcommands:
//   ourspace punish "<reason>" --duration <sec>
//   ourspace punish cancel
//   ourspace punish list [--limit N]
//
// Mirrors the in-app punishment-timer feature. Reason and duration
// are both required when issuing. Duration is in seconds (60–7200).
// Only one punishment can be active at a time.
//
// NOT to be confused with `ourspace push` — that fires a generic
// one-off FCM. `punish` issues a corrective timer that kitten must
// sit through.

import { loadConfig } from "../lib/config.ts";
import { get, post } from "../lib/api.ts";
import { c, fail, formatAge, formatDuration, ok, pad } from "../lib/format.ts";

interface Punishment {
  id: string;
  reason: string;
  durationSec: number;
  issuedAt: number;
  startsAt: number | null;
  endsAt: number | null;
  state: "issued" | "running" | "completed" | "bailed" | "cancelled";
}

interface IssueResponse {
  ok: true;
  id: string;
  durationSec: number;
  issuedAt: number;
}

interface ListResponse {
  ok: true;
  active: Punishment | null;
  recent: Punishment[];
}

interface CancelResponse {
  ok: true;
  id: string;
  reason: string;
}

function stateColor(state: Punishment["state"]): string {
  switch (state) {
    case "issued":
      return c.yellow(state);
    case "running":
      return c.cyan(state);
    case "completed":
      return c.green(state);
    case "cancelled":
      return c.gray(state);
    case "bailed":
      return c.red(state);
  }
}

export async function punishCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) {
    fail("Usage: ourspace punish <reason|cancel|list> [...]");
    return 2;
  }
  const config = loadConfig();

  // ── cancel ──────────────────────────────────────────────────────────────
  if (sub === "cancel") {
    const res = await post<CancelResponse>(
      config,
      "/api/admin/cli/punish/cancel",
    );
    ok(`Cancelled punishment: ${c.dim(res.reason)}`);
    return 0;
  }

  // ── list ────────────────────────────────────────────────────────────────
  if (sub === "list") {
    let limit = 10;
    const limitIdx = args.indexOf("--limit");
    if (limitIdx !== -1 && args[limitIdx + 1]) {
      const n = Number(args[limitIdx + 1]);
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
    const res = await get<ListResponse>(
      config,
      `/api/admin/cli/punish?limit=${limit}`,
    );
    const out: string[] = [];
    if (res.active) {
      out.push(c.bold("Active"));
      out.push(
        `  ${stateColor(res.active.state)}  ${res.active.reason}`,
      );
      out.push(`  ${c.dim("duration")}  ${res.active.durationSec}s`);
      if (res.active.endsAt) {
        const remaining = res.active.endsAt - Date.now();
        out.push(
          `  ${c.dim("ends in")}   ${
            remaining > 0 ? formatDuration(remaining) : c.red("overdue")
          }`,
        );
      }
      out.push("");
    }
    out.push(c.bold(`Recent (${res.recent.length})`));
    if (res.recent.length === 0) {
      out.push(c.dim("  (none)"));
    } else {
      for (const p of res.recent) {
        out.push(
          `  ${pad(stateColor(p.state), 22)} ${p.reason.slice(0, 40)}  ${c.dim(
            `${p.durationSec}s · ${formatAge(Date.now() - p.issuedAt)}`,
          )}`,
        );
      }
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  // ── issue (default) ─────────────────────────────────────────────────────
  const reason = sub;
  if (reason.startsWith("--")) {
    fail('Usage: ourspace punish "<reason>" --duration <sec>');
    return 2;
  }

  let durationSec: number | undefined;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--duration") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        fail(`--duration must be a positive number (got ${value}).`);
        return 2;
      }
      durationSec = Math.floor(n);
      i++;
    } else {
      fail(`Unknown flag: ${flag}`);
      return 2;
    }
  }

  if (durationSec === undefined) {
    fail("--duration is required (in seconds, 60–7200).");
    return 2;
  }

  const res = await post<IssueResponse>(config, "/api/admin/cli/punish", {
    reason,
    durationSec,
  });
  ok(`Punishment issued (${res.durationSec}s). ${c.dim(res.id)}`);
  return 0;
}

punishCommand.help =
  'ourspace punish "<reason>" --duration <sec>\n' +
  "ourspace punish cancel\n" +
  "ourspace punish list [--limit N]\n" +
  "  Issue a punishment timer. Reason and duration are required when\n" +
  "  issuing — duration is in seconds (60–7200, i.e. 1 min – 2 hr).\n" +
  "  The timer engages on kitten's app immediately (bypassPresence).\n" +
  "  Only one punishment can be active at a time. Cancel before\n" +
  "  reissuing. NOT to be confused with `push` (generic FCM).";
