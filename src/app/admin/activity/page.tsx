"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Loader2, Trash2 } from "lucide-react";
import {
  getActivityFeed,
  clearActivityFeed,
} from "@/app/actions/admin";
import type { ActivityRecord } from "@/lib/activity";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const POLL_MS = 10_000;
const LIMIT = 200;

function formatTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

const LEVEL_STYLES: Record<ActivityRecord["level"], string> = {
  interaction: "bg-primary/10 text-primary",
  info: "bg-muted text-muted-foreground",
  warn: "bg-amber-400/10 text-amber-400",
  error: "bg-destructive/10 text-destructive",
  fatal: "bg-destructive/20 text-destructive",
};

export default function ActivityPage() {
  const [records, setRecords] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchFeed = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getActivityFeed(LIMIT);
      if (result.error) {
        setError(result.error);
      } else {
        setRecords(result.records ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchFeed();
    const id = setInterval(() => void fetchFeed(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchFeed]);

  useRefreshListener(fetchFeed);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!confirmingClear) return;
    const id = setTimeout(() => setConfirmingClear(false), 5_000);
    return () => clearTimeout(id);
  }, [confirmingClear]);

  const handleManualRefresh = () => {
    void vibrate(20, "light");
    void fetchFeed();
  };

  const handleClear = async () => {
    void vibrate([100, 50, 100], "heavy");
    setClearing(true);
    try {
      const result = await clearActivityFeed();
      if (result.error) {
        setError(result.error);
      } else {
        setRecords([]);
        setConfirmingClear(false);
      }
    } finally {
      setClearing(false);
    }
  };

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleManualRefresh}
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
          {!confirmingClear ? (
            <button
              type="button"
              onClick={() => {
                void vibrate(50, "medium");
                setConfirmingClear(true);
              }}
              className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          ) : (
            <button
              type="button"
              onClick={handleClear}
              disabled={clearing}
              className="flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
            >
              {clearing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
              Confirm clear
            </button>
          )}
        </div>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Activity feed</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Last {LIMIT} interaction / warn / error events. Capped at 500 server-side.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {records == null ? (
        <FeedSkeleton />
      ) : records.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
          No activity recorded yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((r, i) => (
            <li
              key={`${r.at}-${i}`}
              className="rounded-xl border border-border/40 bg-card p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                    LEVEL_STYLES[r.level],
                  )}
                >
                  {r.level}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatTime(r.at, tick)}
                </span>
              </div>
              <p className="mt-1.5 text-sm font-medium">{r.message}</p>
              {r.context && Object.keys(r.context).length > 0 && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[10px] text-muted-foreground">
                  {JSON.stringify(r.context, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function FeedSkeleton() {
  return (
    <ul className="space-y-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="h-16 animate-pulse rounded-xl border border-border/40 bg-card"
        />
      ))}
    </ul>
  );
}
