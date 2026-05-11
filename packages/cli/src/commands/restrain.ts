// packages/cli/src/commands/restrain.ts
//
// Subcommands:
//   ourspace restrain on   [note]
//   ourspace restrain off  [note]
//   ourspace restrain status

import { loadConfig } from "../lib/config.ts";
import { get, post } from "../lib/api.ts";
import { c, fail, ok } from "../lib/format.ts";

interface RestrainResponse {
  ok: true;
  on: boolean;
  previous?: boolean;
}

export async function restrainCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || (sub !== "on" && sub !== "off" && sub !== "status")) {
    fail("Usage: ourspace restrain <on|off|status> [note]");
    return 2;
  }
  const config = loadConfig();

  if (sub === "status") {
    const res = await get<RestrainResponse>(
      config,
      "/api/admin/cli/restrain",
    );
    ok(
      `Restraint is ${res.on ? c.red("ON") : c.green("OFF")}.`,
    );
    return 0;
  }

  const note = args.slice(1).join(" ").trim();
  const res = await post<RestrainResponse>(
    config,
    "/api/admin/cli/restrain",
    {
      on: sub === "on",
      ...(note.length > 0 && { note }),
    },
  );
  const transitioned = res.previous !== res.on;
  ok(
    `Restraint set to ${res.on ? c.red("ON") : c.green("OFF")}` +
      (transitioned ? "" : c.dim(" (no change)")) +
      ".",
  );
  return 0;
}

restrainCommand.help =
  "ourspace restrain <on|off|status> [note]\n" +
  "  Toggle or read kitten's restraint flag. `on` fires an obedience\n" +
  "  penalty on the off→on transition; `off` lifts. Optional note\n" +
  "  rides into the activity log (engage transition only).";
