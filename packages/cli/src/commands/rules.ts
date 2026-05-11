// packages/cli/src/commands/rules.ts
//
//   ourspace rules [--active | --pending | --completed]
//
// Lists rules with their UUIDs. Sir uses this to grab a `ruleId`
// before logging a violation via `os violation <ruleId> ...`. The
// optional status flag narrows the list.

import { loadConfig } from "../lib/config.ts";
import { get } from "../lib/api.ts";
import { c, fail, formatAge, pad } from "../lib/format.ts";

interface Rule {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "active" | "completed";
  createdAt: number;
}

interface ListResponse {
  ok: true;
  rules: Rule[];
}

function statusColor(status: Rule["status"]): string {
  switch (status) {
    case "pending":
      return c.yellow(status);
    case "active":
      return c.green(status);
    case "completed":
      return c.gray(status);
  }
}

export async function rulesCommand(args: string[]): Promise<number> {
  const config = loadConfig();

  let filter: Rule["status"] | null = null;
  if (args.includes("--active")) filter = "active";
  else if (args.includes("--pending")) filter = "pending";
  else if (args.includes("--completed")) filter = "completed";

  const query = filter ? `?status=${filter}` : "";
  const res = await get<ListResponse>(config, `/api/admin/cli/rules${query}`);

  if (res.rules.length === 0) {
    fail(filter ? `No ${filter} rules.` : "No rules.");
    return 0;
  }

  const out: string[] = [];
  out.push(c.bold(`Rules (${res.rules.length}${filter ? `, ${filter}` : ""})`));
  for (const r of res.rules) {
    out.push(
      `  ${c.dim(r.id)}  ${pad(statusColor(r.status), 18)} ${r.title.slice(0, 60)}  ${c.dim(
        formatAge(Date.now() - r.createdAt),
      )}`,
    );
  }
  process.stdout.write(out.join("\n") + "\n");
  return 0;
}

rulesCommand.help =
  "ourspace rules [--active | --pending | --completed]\n" +
  "  List rules with their UUIDs. Use the UUID with `os violation\n" +
  "  <ruleId> <severity> \"<title>\"` to log a violation against that\n" +
  "  rule.";
