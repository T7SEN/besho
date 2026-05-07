"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  getAuthFailures,
  clearAuthFailures,
} from "@/app/actions/admin";
import type { AuthFailureRecord } from "@/app/actions/auth";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const POLL_MS = 30_000;
const CONFIRM_TIMEOUT_MS = 5_000;

function formatTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

export default function AuthLogPage() {
  const [records, setRecords] = useState<AuthFailureRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchLog = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getAuthFailures(100);
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
    void fetchLog();
    const id = setInterval(() => void fetchLog(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchLog]);

  useRefreshListener(fetchLog);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleClear = async () => {
    void vibrate([100, 50, 100], "heavy");
    setClearing(true);
    try {
      const result = await clearAuthFailures();
      if (result.error) {
        setError(result.error);
      } else {
        setRecords([]);
        setConfirming(false);
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
            onClick={() => {
              void vibrate(20, "light");
              void fetchLog();
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
          {!confirming ? (
            <button
              type="button"
              onClick={() => {
                void vibrate(50, "medium");
                setConfirming(true);
              }}
              disabled={!records || records.length === 0}
              className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleClear()}
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

      <h1 className="text-2xl font-bold tracking-tight">Auth log</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Last 100 failed login attempts. Successful logins live in{" "}
        <Link
          href="/admin/activity"
          className="font-medium text-primary/80 hover:underline"
        >
          activity
        </Link>
        .
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {records == null ? (
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-16 animate-pulse rounded-xl border border-border/40 bg-card"
            />
          ))}
        </ul>
      ) : records.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
          No failed logins on file.
        </p>
      ) : (
        <ul className="space-y-2">
          {records.map((r, i) => (
            <li
              key={`${r.ts}-${i}`}
              className={cn(
                "rounded-xl border border-border/40 bg-card p-3",
              )}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive">
                  <ShieldAlert className="h-3 w-3" />
                  Failure
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatTime(r.ts, tick)}
                </span>
              </div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <Row label="IP" value={r.ip ?? "—"} mono />
                <Row label="User-Agent" value={r.ua ?? "—"} mono />
                <Row
                  label="Passcode length"
                  value={String(r.passcodeLen)}
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
