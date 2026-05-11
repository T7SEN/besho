// packages/cli/src/lib/config.ts
//
// Reads the two env vars the CLI needs:
//   - OURSPACE_BASE_URL   — defaults to production (t7senlovesbesho.me).
//                           Override for local dev (e.g. http://localhost:3000).
//   - OURSPACE_CLI_TOKEN  — required. Must match `ADMIN_CLI_TOKEN`
//                           on the Vercel side.
//
// Throws a helpful error early if the token is missing — failing here
// is friendlier than getting a 401 from the API.

export interface CliConfig {
  baseUrl: string;
  token: string;
}

const DEFAULT_BASE_URL = "https://t7senlovesbesho.me";

export function loadConfig(): CliConfig {
  const baseUrl = (process.env.OURSPACE_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const token = process.env.OURSPACE_CLI_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "OURSPACE_CLI_TOKEN is not set. Add it to your shell profile or set it for this session:\n" +
        "  PowerShell: $env:OURSPACE_CLI_TOKEN = '<your-token>'\n" +
        "  bash:       export OURSPACE_CLI_TOKEN='<your-token>'",
    );
  }
  if (token.length < 32) {
    throw new Error(
      "OURSPACE_CLI_TOKEN must be at least 32 characters. The server refuses anything shorter.",
    );
  }
  return { baseUrl, token };
}
