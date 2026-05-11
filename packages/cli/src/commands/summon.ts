// packages/cli/src/commands/summon.ts

import { loadConfig } from "../lib/config.ts";
import { post } from "../lib/api.ts";
import { ok } from "../lib/format.ts";

export async function summonCommand(_args: string[]): Promise<number> {
  const config = loadConfig();
  await post(config, "/api/admin/cli/summon");
  ok("Summon push fired.");
  return 0;
}

summonCommand.help =
  "ourspace summon\n" +
  "  Fire the Sir → Besho summon push (safeword channel, max priority).";
