"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  Loader2,
  RefreshCw,
  Send,
} from "lucide-react";
import {
  getOutboundNotificationAudit,
  resendNotification,
  type NotificationAuditPair,
  type OutboundNotificationAuditEntry,
} from "@/app/actions/admin";
import type { Author } from "@/lib/constants";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

export default function AdminNotificationsPage() {
  const [pairs, setPairs] = useState<NotificationAuditPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const fetchAudit = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getOutboundNotificationAudit();
      if (result.error) {
        setError(result.error);
      } else {
        setPairs(result.pairs ?? []);
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
      void fetchAudit();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchAudit]);

  useRefreshListener(fetchAudit);

  return (
    <main className="mx-auto max-w-5xl p-4 pb-28 md:p-12 md:pb-32">
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
            void fetchAudit();
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

      <h1 className="text-2xl font-bold tracking-tight">Notification audit</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Forward-only send-time audit log (<code>notifications:audit</code> ZSET,
        capped at 200), independent from the per-user drawers. Drawer clears
        and the 50-entry LTRIM don&apos;t touch this. Re-send fires a fresh
        push (and creates new audit + drawer entries) using the original
        title/body/url — useful for verifying delivery without composing a
        new test push.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
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
    </main>
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
      <p
        className="mt-0.5 line-clamp-2 text-muted-foreground"
        dir="auto"
      >
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

function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
