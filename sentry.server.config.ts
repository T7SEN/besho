// sentry.server.config.ts
// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Drop non-actionable noise on the server. The client config
  // (`src/instrumentation-client.ts`) filters its own browser-level
  // patterns; these are server-side equivalents:
  //   - `AbortError` — request canceled, common on SSE disconnect
  //   - `fetch failed` / `UND_ERR_SOCKET` / `Connection terminated` —
  //     undici (Node fetch) transient TLS / socket churn talking to
  //     Upstash REST or Firebase HTTP v1
  //   - `socket hang up` / `ECONNRESET` — same family
  //   - `Failed to fetch` — Capacitor SSR boundary noise
  // Source-map-independent (matches event.exception.values[*].value).
  ignoreErrors: [
    /^AbortError$/i,
    /UND_ERR_SOCKET/i,
    /^Connection terminated$/i,
    /^fetch failed$/i,
    /^socket hang up$/i,
    /^ECONNRESET$/i,
    /^Failed to fetch$/i,
  ],

  /**
   * Tag every server-side Sentry event with the current author. Reads
   * the session cookie inside `beforeSend` because that hook fires
   * inside the request scope where `cookies()` is available.
   *
   * `cookies()` outside a request scope throws — that path is guarded
   * with try/catch so module-load-time Sentry events (rare) don't
   * cascade-fail. The cost of a `decrypt` per Sentry event is ~0.5ms;
   * only errors hit this path, so the overhead is invisible.
   *
   * Two-user app, no real PII concern: `T7SEN` / `Besho` are role
   * identifiers, not names.
   */
  beforeSend: async (event) => {
    try {
      const cookieStore = await cookies();
      const sessionCookie = cookieStore.get("session")?.value;
      if (sessionCookie) {
        const session = await decrypt(sessionCookie);
        if (session?.author) {
          event.user = {
            ...event.user,
            id: session.author,
            username: session.author,
          };
          event.tags = {
            ...event.tags,
            "app.author": session.author,
          };
        }
      }
    } catch {
      // `cookies()` outside a request scope, or decrypt failure —
      // either way, leave the event un-tagged rather than dropping it.
    }
    return event;
  },
});
