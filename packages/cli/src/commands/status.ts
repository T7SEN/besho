// packages/cli/src/commands/status.ts
//
// Pretty-prints the system snapshot returned by GET /api/admin/cli/status.

import { loadConfig } from "../lib/config.ts";
import { get } from "../lib/api.ts";
import { c, formatAge, pad } from "../lib/format.ts";

interface PresenceSnapshot {
  page: string | null;
  ageMs: number | null;
  fresh: boolean;
}

interface CronTelemetrySnapshot {
  name: string;
  lastRun: {
    ts: number;
    ok: boolean;
    durationMs: number;
    summary?: Record<string, unknown>;
    error?: string;
  } | null;
}

interface StatusResponse {
  ok: true;
  serverTime: number;
  presence: {
    T7SEN: PresenceSnapshot;
    Besho: PresenceSnapshot;
  };
  cron: CronTelemetrySnapshot[];
  restraint: { on: boolean };
  fcm: { T7SEN: number; Besho: number };
}

export async function statusCommand(_args: string[]): Promise<number> {
  const config = loadConfig();
  const res = await get<StatusResponse>(config, "/api/admin/cli/status");

  const now = res.serverTime;
  const out: string[] = [];

  out.push(c.bold("Our Space — status"));
  out.push(
    c.dim(
      `  server time: ${new Date(now).toISOString().replace("T", " ").slice(0, 19)}`,
    ),
  );
  out.push("");

  out.push(c.bold("Presence"));
  for (const author of ["T7SEN", "Besho"] as const) {
    const p = res.presence[author];
    const label = pad(author, 8);
    if (!p.page) {
      out.push(`  ${label}  ${c.gray("offline")}`);
    } else {
      const fresh = p.fresh ? c.green("●") : c.yellow("●");
      const age = p.ageMs !== null ? formatAge(p.ageMs) : "?";
      out.push(`  ${label}  ${fresh} ${pad(p.page, 22)} ${c.dim(age)}`);
    }
  }
  out.push("");

  out.push(c.bold("Restraint"));
  out.push(
    `  Besho     ${res.restraint.on ? c.red("ON") : c.green("OFF")}`,
  );
  out.push("");

  out.push(c.bold("FCM tokens"));
  for (const author of ["T7SEN", "Besho"] as const) {
    const count = res.fcm[author];
    const display =
      count === 0 ? c.red("0") : count === 1 ? `${count}` : c.green(`${count}`);
    out.push(`  ${pad(author, 8)}  ${display}`);
  }
  out.push("");

  out.push(c.bold("Crons"));
  for (const snap of res.cron) {
    const name = pad(snap.name, 22);
    if (!snap.lastRun) {
      out.push(`  ${name}  ${c.gray("never")}`);
      continue;
    }
    const last = snap.lastRun;
    const age = formatAge(now - last.ts);
    const status = last.ok ? c.green("ok") : c.red("FAIL");
    const dur = `${last.durationMs}ms`;
    out.push(`  ${name}  ${status} ${pad(age, 10)} ${c.dim(dur)}`);
    if (!last.ok && last.error) {
      out.push(`    ${c.red("error:")} ${last.error}`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

statusCommand.help =
  "ourspace status\n" +
  "  Read-only system snapshot: presence (both authors), restraint\n" +
  "  flag, FCM token counts, and last-run telemetry for every cron.";
