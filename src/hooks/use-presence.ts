"use client";

import { useEffect } from "react";

const HEARTBEAT_INTERVAL_MS = 20_000;

async function setPresence(page: string): Promise<void> {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page }),
      credentials: "same-origin",
    });
  } catch (err) {
    console.error("[presence] Failed to set presence:", err);
  }
}

async function clearPresence(): Promise<void> {
  try {
    // Use keepalive so the request survives page unload
    await fetch("/api/presence", {
      method: "DELETE",
      credentials: "same-origin",
      keepalive: true,
    });
  } catch {
    // Best effort — TTL will expire it anyway
  }
}

/**
 * Tracks the user's current page in Redis with a 30s TTL.
 * Sends a heartbeat every 20s to keep presence alive.
 * Clears presence when:
 *   - Component unmounts (page navigation)
 *   - App goes to background (visibilitychange)
 *   - Page unloads (pagehide)
 *
 * @param page - The current route, e.g. "/notes" or "/"
 * @param enabled - Only track when user is authenticated
 */
export function usePresence(page: string, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    // Set immediately on mount
    void setPresence(page);

    // Heartbeat to keep TTL alive
    const heartbeatId = setInterval(() => {
      void setPresence(page);
    }, HEARTBEAT_INTERVAL_MS);

    const doc = globalThis as unknown as {
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
      visibilityState?: string;
    };
    const win = globalThis as unknown as {
      addEventListener: (type: string, fn: () => void) => void;
      removeEventListener: (type: string, fn: () => void) => void;
    };

    // Clear when app goes to background
    const handleVisibilityChange = () => {
      if (doc.visibilityState === "hidden") {
        void clearPresence();
      } else {
        void setPresence(page);
      }
    };

    // Clear on page unload
    const handlePageHide = () => {
      void clearPresence();
    };

    doc.addEventListener("visibilitychange", handleVisibilityChange);
    win.addEventListener("pagehide", handlePageHide);

    return () => {
      clearInterval(heartbeatId);
      doc.removeEventListener("visibilitychange", handleVisibilityChange);
      win.removeEventListener("pagehide", handlePageHide);
      void clearPresence();
    };
  }, [page, enabled]);
}
