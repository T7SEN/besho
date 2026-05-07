"use client";

// src/components/session-guard.tsx
//
// Watches `getCurrentAuthor()` for mid-session expiry. When the
// session epoch is bumped via `forceLogoutAuthor` or the JWT expires
// while the app is open, server actions silently start returning
// null/error. Without this guard the page sits in a half-broken state
// (skeletons forever, fetches that silently fail) until the user
// thinks to manually navigate.
//
// Logic:
//   - Polls `getCurrentAuthor()` every 60s.
//   - Tracks the last-known value in a ref. The first observation is
//     the baseline — never trigger on initial null because
//     BiometricGate may still be resolving auth on cold start.
//   - On transition `string → null`, replace to `/login?expired=1`
//     so the login form can surface "Session ended" copy.
//   - Skips polling on `/login` itself.
//
// Mounted once in the root layout. Sibling to `<BiometricGate>`.

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getCurrentAuthor } from "@/app/actions/auth";

const POLL_MS = 60_000;

export function SessionGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const lastKnownAuthorRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (pathname === "/login") {
      lastKnownAuthorRef.current = undefined;
      return;
    }

    let cancelled = false;

    const check = async () => {
      try {
        const author = await getCurrentAuthor();
        if (cancelled) return;
        const previous = lastKnownAuthorRef.current;
        lastKnownAuthorRef.current = author;

        // Initial baseline — don't redirect on first null since
        // BiometricGate may still be resolving auth on cold start
        // and unauthenticated visitors are already redirected by the
        // server-side guard.
        if (previous === undefined) return;

        // Transition from authenticated → null = mid-session expiry.
        if (previous && !author) {
          router.replace("/login?expired=1");
        }
      } catch {
        // Best-effort — transient errors shouldn't redirect.
      }
    };

    void check();
    const id = setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pathname, router]);

  return null;
}
