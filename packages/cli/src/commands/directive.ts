// packages/cli/src/commands/directive.ts
//
// Subcommands:
//   ourspace directive "<title>" [--body "..."] [--duration <sec>]
//   ourspace directive cancel
//   ourspace directive list [--limit N]
//
// Mirrors the in-app real-time directive overlay. Issuing while one is
// active fails with 409 — cancel first. Body is optional. Duration is
// in seconds (60–3600); omit for open-ended.

import { loadConfig } from "../lib/config.ts";
import { get, post } from "../lib/api.ts";
import { c, fail, formatAge, formatDuration, ok, pad } from "../lib/format.ts";

interface Directive {
  id: string;
  title: string;
  body?: string;
  durationSec: number | null;
  issuedAt: number;
  expiresAt: number | null;
  state: "issued" | "acknowledged" | "completed" | "expired" | "cancelled";
}

interface IssueResponse {
  ok: true;
  id: string;
  durationSec: number | null;
  expiresAt: number | null;
}

interface ListResponse {
  ok: true;
  active: Directive | null;
  recent: Directive[];
}

interface CancelResponse {
  ok: true;
  id: string;
  title: string;
}

function stateColor(state: Directive["state"]): string {
  switch (state) {
    case "issued":
      return c.yellow(state);
    case "acknowledged":
      return c.cyan(state);
    case "completed":
      return c.green(state);
    case "cancelled":
      return c.gray(state);
    case "expired":
      return c.red(state);
  }
}

export async function directiveCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) {
    fail("Usage: ourspace directive <title|cancel|list> [...]");
    return 2;
  }
  const config = loadConfig();

  // ── cancel ──────────────────────────────────────────────────────────────
  if (sub === "cancel") {
    const res = await post<CancelResponse>(
      config,
      "/api/admin/cli/directive/cancel",
    );
    ok(`Cancelled directive: ${c.dim(res.title)}`);
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
      `/api/admin/cli/directive?limit=${limit}`,
    );
    const out: string[] = [];
    if (res.active) {
      out.push(c.bold("Active"));
      out.push(
        `  ${stateColor(res.active.state)}  ${res.active.title}`,
      );
      if (res.active.expiresAt) {
        const remaining = res.active.expiresAt - Date.now();
        out.push(
          `  ${c.dim("expires in")} ${
            remaining > 0 ? formatDuration(remaining) : c.red("overdue")
          }`,
        );
      } else {
        out.push(`  ${c.dim("open-ended")}`);
      }
      out.push("");
    }
    out.push(c.bold(`Recent (${res.recent.length})`));
    if (res.recent.length === 0) {
      out.push(c.dim("  (none)"));
    } else {
      for (const d of res.recent) {
        out.push(
          `  ${pad(stateColor(d.state), 22)} ${d.title.slice(0, 50)}  ${c.dim(
            formatAge(Date.now() - d.issuedAt),
          )}`,
        );
      }
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  }

  // ── issue (default) ─────────────────────────────────────────────────────
  // First positional arg is the title.
  const title = sub;
  if (title.startsWith("--")) {
    fail("Usage: ourspace directive \"<title>\" [--body \"...\"] [--duration <sec>]");
    return 2;
  }

  let body: string | undefined;
  let durationSec: number | undefined;
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--body") {
      body = value;
      i++;
    } else if (flag === "--duration") {
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

  const res = await post<IssueResponse>(config, "/api/admin/cli/directive", {
    title,
    ...(body && { body }),
    ...(durationSec !== undefined && { durationSec }),
  });
  const duration = res.durationSec
    ? `${res.durationSec}s`
    : c.dim("open-ended");
  ok(`Directive issued (${duration}). ${c.dim(res.id)}`);
  return 0;
}

directiveCommand.help =
  'ourspace directive "<title>" [--body "..."] [--duration <sec>]\n' +
  "ourspace directive cancel\n" +
  "ourspace directive list [--limit N]\n" +
  "  Issue a real-time directive overlay to kitten. Duration is in\n" +
  "  seconds (60–3600); omit for open-ended. Only one directive can be\n" +
  "  active at a time — cancel first if issuing replaces an existing\n" +
  "  one. `list` shows the active directive plus recent history.";
