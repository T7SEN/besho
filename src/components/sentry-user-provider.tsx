// src/components/sentry-user-provider.tsx
"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getCurrentAuthor } from "@/app/actions/auth";

/**
 * Tags every client-side Sentry event with the current author so the
 * Sentry UI groups events by phone (T7SEN vs Besho). Mirrors the
 * `FCMProvider` shape — pathname-driven `getCurrentAuthor` poll, no
 * cleanup needed because `Sentry.setUser(null)` is idempotent.
 *
 * Server and Edge errors are tagged via `beforeSend` hooks in
 * `sentry.server.config.ts` / `sentry.edge.config.ts`. This component
 * only handles the browser SDK.
 */
export function SentryUserProvider() {
  const [author, setAuthor] = useState<string | null>(null);
  const pathname = usePathname();

  // Re-fetch on pathname change so logout (which redirects) clears the
  // user, and post-login (which also redirects) sets the new user.
  useEffect(() => {
    getCurrentAuthor().then(setAuthor);
  }, [pathname]);

  useEffect(() => {
    if (author === null) {
      Sentry.setUser(null);
      Sentry.setTag("app.author", undefined);
      return;
    }
    // `id` and `username` both set to the author label. No PII —
    // T7SEN/Besho are role identifiers, not real names.
    Sentry.setUser({ id: author, username: author });
    Sentry.setTag("app.author", author);
  }, [author]);

  return null;
}
