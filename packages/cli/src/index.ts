#!/usr/bin/env node
// packages/cli/src/index.ts
//
// Entry point for the `ourspace` CLI. Dispatches subcommands to
// command modules. Adds top-level --help / --version. Network +
// auth errors are caught at the top level and rendered with a
// uniform `✗` prefix so Sir gets readable failure messages instead
// of raw stack traces.
//
// Usage:
//   ourspace <command> [args...]
//   ourspace --help
//   ourspace --version
//
// Commands:
//   summon                    Fire the Sir → Besho summon push.
//   restrain <on|off|status>  Toggle / read Besho's restraint flag.
//   push <to> <body...>       Fire a one-off FCM.
//   logout <besho|sir>        Force-logout the target author.
//   status                    Read-only system snapshot.
//   directive "<title>"       Issue / cancel / list real-time directives.
//   punish "<reason>"         Issue / cancel / list punishment timers.
//   rules                     List rules with their UUIDs.
//   violation <ruleId> ...    Log a rule-violation ledger entry.
//   tod <status|issue|cancel> Truth or Dare admin from the terminal.

import { summonCommand } from "./commands/summon.ts";
import { restrainCommand } from "./commands/restrain.ts";
import { pushCommand } from "./commands/push.ts";
import { logoutCommand } from "./commands/logout.ts";
import { statusCommand } from "./commands/status.ts";
import { directiveCommand } from "./commands/directive.ts";
import { punishCommand } from "./commands/punish.ts";
import { rulesCommand } from "./commands/rules.ts";
import { violationCommand } from "./commands/violation.ts";
import { todCommand } from "./commands/tod.ts";
import { ApiError } from "./lib/api.ts";
import { c, fail } from "./lib/format.ts";

const VERSION = "0.1.0";

interface CommandFn {
  (args: string[]): Promise<number>;
  help?: string;
}

const COMMANDS: Record<string, CommandFn> = {
  summon: summonCommand,
  restrain: restrainCommand,
  push: pushCommand,
  logout: logoutCommand,
  status: statusCommand,
  directive: directiveCommand,
  punish: punishCommand,
  rules: rulesCommand,
  violation: violationCommand,
  tod: todCommand,
};

function printTopLevelHelp(): void {
  process.stdout.write(
    [
      `${c.bold("ourspace")} ${c.dim(`v${VERSION}`)}`,
      "Sir-only command-line for Our Space admin ops.",
      "",
      c.bold("Commands"),
      "  summon                    Fire the Sir → Besho summon push.",
      "  restrain <on|off|status>  Toggle / read Besho's restraint flag.",
      "  push <to> <body...>       Fire a one-off FCM.",
      "  logout <besho|sir>        Force-logout the target author.",
      "  status                    Read-only system snapshot.",
      "  directive <title|...>     Issue / cancel / list real-time directives.",
      "  punish <reason|...>       Issue / cancel / list punishment timers.",
      "  rules                     List rules with their UUIDs.",
      "  violation <ruleId> ...    Log a rule-violation ledger entry.",
      "  tod <status|issue|cancel> Truth or Dare admin from the terminal.",
      "",
      c.bold("Per-command help"),
      "  ourspace <command> --help",
      "",
      c.bold("Environment"),
      "  OURSPACE_BASE_URL   (default: https://t7senlovesbesho.me)",
      "  OURSPACE_CLI_TOKEN  (required; must match server ADMIN_CLI_TOKEN)",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printTopLevelHelp();
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const name = argv[0];
  const cmd = COMMANDS[name];
  if (!cmd) {
    fail(`Unknown command: ${name}`);
    process.stderr.write("Run `ourspace --help` for a list.\n");
    return 2;
  }
  const rest = argv.slice(1);
  if (rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(`${cmd.help ?? "No help available."}\n`);
    return 0;
  }
  return cmd(rest);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ApiError) {
      fail(`${err.message} (status ${err.status})`);
      if (err.status === 401) {
        process.stderr.write(
          "Check OURSPACE_CLI_TOKEN matches the server's ADMIN_CLI_TOKEN.\n",
        );
      } else if (err.status === 503) {
        process.stderr.write(
          "Server config error — ADMIN_CLI_TOKEN missing in Vercel env.\n",
        );
      }
    } else if (err instanceof Error) {
      fail(err.message);
    } else {
      fail(String(err));
    }
    process.exit(1);
  });
