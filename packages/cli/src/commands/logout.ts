// packages/cli/src/commands/logout.ts

import { loadConfig } from "../lib/config.ts";
import { post } from "../lib/api.ts";
import { fail, ok } from "../lib/format.ts";

interface LogoutResponse {
  ok: true;
  author: "T7SEN" | "Besho";
}

export async function logoutCommand(args: string[]): Promise<number> {
  const input = args[0]?.toLowerCase();
  let author: "T7SEN" | "Besho" | null = null;
  if (input === "besho" || input === "kitten") author = "Besho";
  else if (input === "t7sen" || input === "sir" || input === "daddy")
    author = "T7SEN";
  if (!author) {
    fail("Usage: ourspace logout <besho|sir>");
    return 2;
  }

  const config = loadConfig();
  const res = await post<LogoutResponse>(config, "/api/admin/cli/logout", {
    author,
  });
  ok(`Force-logged out ${res.author}. All existing JWTs reject on next request.`);
  return 0;
}

logoutCommand.help =
  "ourspace logout <besho|sir>\n" +
  "  Bump the target author's session epoch. Every existing JWT for\n" +
  "  that author becomes invalid on the next decrypt (~5s cache cutover).";
