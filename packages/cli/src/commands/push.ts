// packages/cli/src/commands/push.ts
//
// Usage:
//   ourspace push <to> <body...>
//   ourspace push <to> --title "Custom title" <body...>
//   ourspace push <to> --bypass <body...>
//   ourspace push <to> --url <path> <body...>
//
// `to` is besho | sir | both (case-insensitive). Default title is
// "From Sir". The body picks up everything after the flags.

import { loadConfig } from "../lib/config.ts";
import { post } from "../lib/api.ts";
import { fail, ok } from "../lib/format.ts";

type Recipient = "T7SEN" | "Besho" | "both";

interface PushResponse {
  ok: true;
  fired: number;
  partialErrors?: string[];
}

function normalizeRecipient(input: string | undefined): Recipient | null {
  if (!input) return null;
  const v = input.toLowerCase();
  if (v === "besho" || v === "kitten") return "Besho";
  if (v === "t7sen" || v === "sir" || v === "daddy") return "T7SEN";
  if (v === "both") return "both";
  return null;
}

export async function pushCommand(args: string[]): Promise<number> {
  const recipient = normalizeRecipient(args[0]);
  if (!recipient) {
    fail(
      "Usage: ourspace push <besho|sir|both> [--title <t>] [--url <p>] [--bypass] <body...>",
    );
    return 2;
  }

  // Walk remaining args, peel flags, collect remainder as body words.
  const rest = args.slice(1);
  let title = "From Sir";
  let url: string | undefined = undefined;
  let bypassPresence = false;
  const bodyWords: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--title") {
      const next = rest[i + 1];
      if (!next) {
        fail("--title requires a value.");
        return 2;
      }
      title = next;
      i++;
      continue;
    }
    if (a === "--url") {
      const next = rest[i + 1];
      if (!next) {
        fail("--url requires a value.");
        return 2;
      }
      url = next;
      i++;
      continue;
    }
    if (a === "--bypass") {
      bypassPresence = true;
      continue;
    }
    bodyWords.push(a);
  }
  const body = bodyWords.join(" ").trim();
  if (!body) {
    fail("Push body is required.");
    return 2;
  }

  const config = loadConfig();
  const res = await post<PushResponse>(config, "/api/admin/cli/push", {
    to: recipient,
    title,
    body,
    ...(url && { url }),
    ...(bypassPresence && { bypassPresence: true }),
  });
  ok(`Push fired to ${res.fired} recipient(s).`);
  if (res.partialErrors && res.partialErrors.length > 0) {
    for (const err of res.partialErrors) {
      fail(`Partial failure: ${err}`);
    }
  }
  return 0;
}

pushCommand.help =
  'ourspace push <besho|sir|both> [--title <t>] [--url <p>] [--bypass] <body...>\n' +
  "  Fire a one-off FCM. Default title 'From Sir'. `--bypass` forces\n" +
  "  the heads-up banner even if the recipient is on the target page.";
