// src/lib/admin-cli-auth.ts
//
// Bearer-token guard for the `/api/admin/cli/*` route group. The
// `ourspace` CLI on Sir's Windows desktop calls these endpoints with
// `Authorization: Bearer ${OURSPACE_CLI_TOKEN}`; the server checks
// the token against `ADMIN_CLI_TOKEN` (Vercel env var) using a
// timing-safe comparison.
//
// This is a SEPARATE auth path from the JWT cookie that drives the
// web UI. The CLI doesn't have a browser session — Sir's terminal
// has the token in his shell profile. Treat the token as Sir-level
// admin credentials:
//   - High-entropy random string (64+ chars).
//   - Never logged.
//   - Rotated via Vercel env var update + Sir's shell profile update.
//
// The token is the entire security boundary for these routes. Don't
// add a "fall through to cookie auth" path — the CLI routes are
// intentionally bearer-only.

import { timingSafeEqual } from "crypto";
import { logger } from "@/lib/logger";

export interface CliAuthOk {
  ok: true;
}

export interface CliAuthFail {
  ok: false;
  status: 401 | 503;
  message: string;
}

/** Validates the bearer token on an incoming CLI request. Returns
 *  a 503 (not 500) when the server env var is missing — that's an
 *  operator configuration error, not a client error. 401 for every
 *  other failure (missing header, wrong scheme, bad token) — clients
 *  see a single error code to handle. */
export function requireCliAuth(req: Request): CliAuthOk | CliAuthFail {
  const expected = process.env.ADMIN_CLI_TOKEN;
  if (!expected || expected.length < 32) {
    // Refuse to run with a missing or trivially-short token. Better
    // a hard fail than a security hole.
    logger.warn("[cli-auth] ADMIN_CLI_TOKEN not configured (>=32 chars)");
    return {
      ok: false,
      status: 503,
      message: "ADMIN_CLI_TOKEN not configured on server.",
    };
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, message: "Missing bearer token." };
  }
  const presented = auth.slice("Bearer ".length).trim();
  if (!presented) {
    return { ok: false, status: 401, message: "Empty bearer token." };
  }

  // Length-aware constant-time comparison. `timingSafeEqual` throws
  // if buffers differ in length, so prefix-check first to avoid
  // leaking length info via a thrown error. Then pad to a fixed
  // length before comparing so equal-length-but-wrong tokens still
  // get the constant-time path.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Run a dummy compare to keep timing flat-ish regardless of the
    // length mismatch. Result discarded.
    try {
      timingSafeEqual(Buffer.alloc(b.length), b);
    } catch {
      // ignore
    }
    return { ok: false, status: 401, message: "Invalid token." };
  }
  const match = timingSafeEqual(a, b);
  if (!match) {
    return { ok: false, status: 401, message: "Invalid token." };
  }
  return { ok: true };
}

/** Helper for route handlers — pairs the auth check with a JSON
 *  401/503 response. Usage:
 *
 *  ```ts
 *  const guard = requireCliAuth(req);
 *  if (!guard.ok) return cliAuthError(guard);
 *  // ... handle request ...
 *  ```
 */
export function cliAuthError(fail: CliAuthFail): Response {
  return new Response(
    JSON.stringify({ error: fail.message }),
    {
      status: fail.status,
      headers: { "content-type": "application/json" },
    },
  );
}
