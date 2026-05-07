"use client";

import { useRouter } from "next/navigation";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

/**
 * Drop-in client component for Server Component pages that need to
 * subscribe to the global pull-to-refresh event. Calls
 * `router.refresh()` on receipt, which re-runs the route's Server
 * Components and revalidates the RSC payload.
 *
 * For Client Component pages with their own state, prefer wiring
 * `useRefreshListener(yourFetchCallback)` directly — that lets you
 * control exactly what re-fetches and when. Use this helper only when
 * the page is a Server Component (or has no client-side fetch state to
 * re-trigger).
 */
export function RefreshListenerForServerPage() {
  const router = useRouter();
  useRefreshListener(() => {
    router.refresh();
  });
  return null;
}
