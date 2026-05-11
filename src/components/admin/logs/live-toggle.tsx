"use client";

// src/components/admin/logs/live-toggle.tsx
//
// "Live" mode toggle — when on, the parent re-fires its fetch every
// `intervalMs` (defaults to 10s). Off by default; this is opt-in
// because the logs page is "investigate after the fact" and constant
// polling burns Upstash quota.
//
// Sentry/Vercel pattern: a pulsing dot when live, static when off.
// Hands the parent a stable callback to fire — parent owns the fetch.

import { useEffect, useState } from "react";
import { Pause } from "lucide-react";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";

export function LiveToggle({
  onTick,
  intervalMs = 10_000,
}: {
  onTick: () => void;
  intervalMs?: number;
}) {
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(onTick, intervalMs);
    return () => clearInterval(id);
  }, [live, intervalMs, onTick]);

  return (
    <button
      type="button"
      onClick={() => {
        void vibrate(20, "light");
        setLive((v) => !v);
      }}
      aria-pressed={live}
      title={live ? `Auto-refreshing every ${intervalMs / 1000}s` : "Click to enable auto-refresh"}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-95",
        live
          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
          : "border-border/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {live ? (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Live
        </>
      ) : (
        <>
          <Pause className="h-3 w-3" />
          Live
        </>
      )}
    </button>
  );
}
