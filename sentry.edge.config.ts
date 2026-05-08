// sentry.edge.config.ts
// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
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

  // Drop non-actionable Edge-runtime noise. The Edge SSE route
  // (`/api/notes/stream`) routinely surfaces `AbortError` when the
  // WebView pauses or the user navigates away mid-stream — that's
  // expected client-disconnect behavior, not a bug. Same shape as
  // `sentry.server.config.ts`'s ignoreErrors.
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
   * Tag every Edge-runtime Sentry event with the current author.
   * Same shape as `sentry.server.config.ts` — Edge supports
   * `next/headers` `cookies()` inside the request scope where
   * `beforeSend` fires.
   *
   * Edge captures errors from middleware, the SSE route at
   * `/api/notes/stream`, the FCM subscribe route, and any other
   * Edge-runtime handlers. Without this, those errors are
   * un-attributable.
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
      // Out-of-request-scope or decrypt failure — leave un-tagged.
    }
    return event;
  },
});
