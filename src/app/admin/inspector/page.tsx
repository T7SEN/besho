"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, RefreshCw, Loader2 } from "lucide-react";
import {
  getInspectorSnapshot,
  type InspectorSnapshot,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const POLL_MS = 5_000;

function formatAge(ts: number | null, now: number): string {
  if (ts == null) return "—";
  const diff = Math.max(0, now - ts);
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export default function InspectorPage() {
  const [snapshot, setSnapshot] = useState<InspectorSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  const fetchSnapshot = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getInspectorSnapshot();
      if (result.error) {
        setError(result.error);
      } else if (result.snapshot) {
        setSnapshot(result.snapshot);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot();
    const id = setInterval(() => void fetchSnapshot(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchSnapshot]);

  useRefreshListener(fetchSnapshot);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const handleManualRefresh = () => {
    void vibrate(20, "light");
    void fetchSnapshot();
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
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Inspector</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Polls every {POLL_MS / 1000}s. Presence is fresh inside 12 seconds.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!snapshot ? (
        <SnapshotSkeleton />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Presence
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.presence.map((p) => (
                <div
                  key={p.author}
                  className="rounded-2xl border border-border/40 bg-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      {TITLE_BY_AUTHOR[p.author as Author]}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
                        p.fresh ? "text-emerald-400" : "text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          p.fresh
                            ? "bg-emerald-400 animate-pulse"
                            : "bg-muted-foreground/40",
                        )}
                      />
                      {p.fresh ? "live" : "stale"}
                    </span>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Page</dt>
                      <dd className="truncate text-right font-mono">
                        {p.page ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Last seen</dt>
                      <dd className="text-right">{formatAge(p.ts, tick)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              FCM tokens
            </h2>
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.push.map((p) => (
                <div
                  key={p.author}
                  className="rounded-2xl border border-border/40 bg-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      {TITLE_BY_AUTHOR[p.author as Author]}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        p.hasToken
                          ? "bg-emerald-400/10 text-emerald-400"
                          : "bg-destructive/10 text-destructive",
                      )}
                    >
                      {p.hasToken ? "registered" : "missing"}
                    </span>
                  </div>
                  <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
                    {p.preview ?? "—"}
                  </p>
                </div>
              ))}
            </div>
          </section>
        </motion.div>
      )}
    </main>
  );
}

function SnapshotSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-3 w-24 rounded bg-muted-foreground/10" />
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border border-border/40 bg-card"
          />
        ))}
      </div>
      <div className="h-3 w-24 rounded bg-muted-foreground/10" />
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl border border-border/40 bg-card"
          />
        ))}
      </div>
    </div>
  );
}
