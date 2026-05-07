"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Lock,
  LockOpen,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  getRestraintHistory,
  type RestraintHistoryEntry,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

export default function RestraintHistoryPage() {
  const [entries, setEntries] = useState<RestraintHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const fetchHistory = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getRestraintHistory(200);
      if (result.error) {
        setError(result.error);
      } else {
        setEntries(result.entries ?? []);
        setError(null);
        setNow(Date.now());
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchHistory();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchHistory]);

  useRefreshListener(fetchHistory);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <button
          type="button"
          onClick={() => {
            void vibrate(20, "light");
            void fetchHistory();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Restraint history</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Every engage and lift transition with timestamp + reason (engage only).
        Capped at 200 entries; older events fall off automatically.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!entries ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No restraint events yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li
              key={`${e.ts}-${e.action}`}
              className={cn(
                "flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm",
                e.action === "engage"
                  ? "border-destructive/40 bg-destructive/10"
                  : "border-emerald-500/30 bg-emerald-500/5",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-2">
                  {e.action === "engage" ? (
                    <Lock className="h-3.5 w-3.5 text-destructive" />
                  ) : (
                    <LockOpen className="h-3.5 w-3.5 text-emerald-400" />
                  )}
                  <span
                    className={cn(
                      "font-bold uppercase tracking-wider",
                      e.action === "engage"
                        ? "text-destructive"
                        : "text-emerald-400",
                    )}
                  >
                    {e.action === "engage" ? "Engaged" : "Lifted"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    by {TITLE_BY_AUTHOR[e.by] ?? e.by}
                  </span>
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70">
                  {formatRelativeTs(e.ts, now)}
                </span>
              </div>
              {e.reason && (
                <p
                  dir="auto"
                  className="pl-5.5 text-xs text-muted-foreground"
                >
                  &ldquo;{e.reason}&rdquo;
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
