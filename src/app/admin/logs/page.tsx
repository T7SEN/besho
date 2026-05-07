"use client";

// src/app/admin/logs/page.tsx
//
// Merged audit-log surface — four append-only chronological event
// streams behind tabs:
//   - Activity     — interaction / warn / error log (capped 500)
//   - Outbound     — outbound notification audit (forward-only ZSET)
//   - Restraint    — engage / lift transitions
//   - Auth failures — failed login attempts
//
// Each tab body fetches independently via `useRefreshListener` so the
// global header Refresh button dispatches a single
// `ourspace:refresh` event that all subscribed tabs respond to.
// No per-tab polling — the page is "investigate after the fact"
// rather than a live dashboard, manual refresh suffices.
//
// Replaces the standalone /admin/activity, /admin/notifications,
// /admin/restraint-history, and /admin/auth-log pages. Each was its
// own TOOLS entry; this consolidation drops three.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  History,
  Loader2,
  Lock,
  LockOpen,
  RefreshCw,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  clearActivityFeed,
  clearAuthFailures,
  getActivityFeed,
  getAuthFailures,
  getOutboundNotificationAudit,
  getRestraintHistory,
  resendNotification,
  type NotificationAuditPair,
  type OutboundNotificationAuditEntry,
  type RestraintHistoryEntry,
} from "@/app/actions/admin";
import type { ActivityRecord } from "@/lib/activity";
import type { AuthFailureRecord } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const CONFIRM_TIMEOUT_MS = 5_000;

function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1_000) return "just now";
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function LogsPage() {
  const [now, setNow] = useState(() => Date.now());

  // 30s tick for relative-time labels. Cheap; doesn't fetch anything.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const handleRefresh = () => {
    void vibrate(20, "light");
    setNow(Date.now());
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("ourspace:refresh"));
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
        <button
          type="button"
          onClick={handleRefresh}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Chronological event streams. Refresh dispatches one event;
        every tab refetches in parallel.
      </p>

      <Tabs defaultValue="activity">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="activity">
            <History className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="outbound">
            <Bell className="h-3.5 w-3.5" />
            Outbound
          </TabsTrigger>
          <TabsTrigger value="restraint">
            <Lock className="h-3.5 w-3.5" />
            Restraint
          </TabsTrigger>
          <TabsTrigger value="auth">
            <ShieldAlert className="h-3.5 w-3.5" />
            Auth failures
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="space-y-4">
          <ActivityTabBody now={now} />
        </TabsContent>
        <TabsContent value="outbound" className="space-y-4">
          <OutboundTabBody now={now} />
        </TabsContent>
        <TabsContent value="restraint" className="space-y-4">
          <RestraintTabBody now={now} />
        </TabsContent>
        <TabsContent value="auth" className="space-y-4">
          <AuthFailuresTabBody now={now} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

// ── Activity tab ─────────────────────────────────────────────────────────

const ACTIVITY_LIMIT = 200;

const LEVEL_STYLES: Record<ActivityRecord["level"], string> = {
  interaction: "bg-primary/10 text-primary",
  info: "bg-muted text-muted-foreground",
  warn: "bg-amber-400/10 text-amber-400",
  error: "bg-destructive/10 text-destructive",
  fatal: "bg-destructive/20 text-destructive",
};

function ActivityTabBody({ now }: { now: number }) {
  const [records, setRecords] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchFeed = useCallback(async () => {
    try {
      const result = await getActivityFeed(ACTIVITY_LIMIT);
      if (result.error) setError(result.error);
      else {
        setRecords(result.records ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchFeed(), 0);
    return () => clearTimeout(t);
  }, [fetchFeed]);

  useRefreshListener(fetchFeed);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleClear = async () => {
    void vibrate([100, 50, 100], "heavy");
    setClearing(true);
    try {
      const result = await clearActivityFeed();
      if (result.error) setError(result.error);
      else {
        setRecords([]);
        setConfirming(false);
      }
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Last {ACTIVITY_LIMIT} interaction / warn / error events.
          Capped at 500 server-side.
        </p>
        {!confirming ? (
          <button
            type="button"
            onClick={() => {
              void vibrate(50, "medium");
              setConfirming(true);
            }}
            disabled={!records || records.length === 0}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95 disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={clearing}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
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

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
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
                  {formatRelativeTs(r.at, now)}
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
    </>
  );
}

// ── Outbound notification audit tab ──────────────────────────────────────

function OutboundTabBody({ now }: { now: number }) {
  const [pairs, setPairs] = useState<NotificationAuditPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchAudit = useCallback(async () => {
    try {
      const result = await getOutboundNotificationAudit();
      if (result.error) setError(result.error);
      else {
        setPairs(result.pairs ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchAudit(), 0);
    return () => clearTimeout(t);
  }, [fetchAudit]);

  useRefreshListener(fetchAudit);

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Forward-only send-time audit log
        (<code>notifications:audit</code> ZSET, capped at 200),
        independent from the per-user drawers. Re-send fires a fresh push
        and creates new audit + drawer entries using the original
        title/body/url.
      </p>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!pairs ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-96 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 md:gap-6">
          {pairs.map((pair) => (
            <DrawerColumn
              key={pair.author}
              pair={pair}
              now={now}
              onResent={fetchAudit}
            />
          ))}
        </div>
      )}
    </>
  );
}

function DrawerColumn({
  pair,
  now,
  onResent,
}: {
  pair: NotificationAuditPair;
  now: number;
  onResent: () => Promise<void>;
}) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Bell className="h-4 w-4 text-primary/70" />
        <h2 className="text-sm font-semibold">
          {TITLE_BY_AUTHOR[pair.author] ?? pair.author}
        </h2>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">
          {pair.records.length} entries
        </span>
      </header>
      {pair.records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notifications yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {pair.records.map((r) => (
            <NotificationRow
              key={r.id}
              record={r}
              author={pair.author}
              now={now}
              onResent={onResent}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function NotificationRow({
  record,
  author,
  now,
  onResent,
}: {
  record: OutboundNotificationAuditEntry;
  author: Author;
  now: number;
  onResent: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleResend = async () => {
    setBusy(true);
    setErr(null);
    void vibrate(40, "medium");
    const result = await resendNotification(author, record.id);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setDone(true);
    setTimeout(() => setDone(false), 2_500);
    void onResent();
  };

  return (
    <li className="rounded-lg border border-border/30 bg-card/40 px-3 py-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-semibold" dir="auto">
          {record.title}
        </p>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatRelativeTs(record.ts, now)}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-muted-foreground" dir="auto">
        {record.body}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[10px] text-muted-foreground/70">
          {record.url}
        </span>
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={busy}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-95 disabled:opacity-50",
            done
              ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
              : "border-border/40 text-muted-foreground hover:border-primary/40 hover:text-primary",
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Send className="h-3 w-3" />
          )}
          {done ? "Re-sent" : "Re-send"}
        </button>
      </div>
      {err && <p className="mt-1 text-[10px] text-destructive">{err}</p>}
    </li>
  );
}

// ── Restraint history tab ────────────────────────────────────────────────

function RestraintTabBody({ now }: { now: number }) {
  const [entries, setEntries] = useState<RestraintHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const result = await getRestraintHistory(200);
      if (result.error) setError(result.error);
      else {
        setEntries(result.entries ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchHistory(), 0);
    return () => clearTimeout(t);
  }, [fetchHistory]);

  useRefreshListener(fetchHistory);

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Every engage and lift transition with timestamp + reason (engage
        only). Capped at 200 entries.
      </p>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
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
        <p className="rounded-2xl border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
          No restraint events yet.
        </p>
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
    </>
  );
}

// ── Auth failures tab ────────────────────────────────────────────────────

function AuthFailuresTabBody({ now }: { now: number }) {
  const [records, setRecords] = useState<AuthFailureRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const fetchLog = useCallback(async () => {
    try {
      const result = await getAuthFailures(100);
      if (result.error) setError(result.error);
      else {
        setRecords(result.records ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchLog(), 0);
    return () => clearTimeout(t);
  }, [fetchLog]);

  useRefreshListener(fetchLog);

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
      if (result.error) setError(result.error);
      else {
        setRecords([]);
        setConfirming(false);
      }
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Last 100 failed login attempts. Successful logins live in the
          Activity tab.
        </p>
        {!confirming ? (
          <button
            type="button"
            onClick={() => {
              void vibrate(50, "medium");
              setConfirming(true);
            }}
            disabled={!records || records.length === 0}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95 disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Clear
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={clearing}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
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

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
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
              className="rounded-xl border border-border/40 bg-card p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive">
                  <ShieldAlert className="h-3 w-3" />
                  Failure
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {formatRelativeTs(r.ts, now)}
                </span>
              </div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <KVRow label="IP" value={r.ip ?? "—"} mono />
                <KVRow label="User-Agent" value={r.ua ?? "—"} mono />
                <KVRow
                  label="Passcode length"
                  value={String(r.passcodeLen)}
                />
              </dl>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────

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

function KVRow({
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
