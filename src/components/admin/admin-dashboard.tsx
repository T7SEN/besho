"use client";

// src/components/admin/admin-dashboard.tsx
//
// At-a-glance dashboard for the /admin landing. Two compact widgets:
//
// 1. <AdminDashboardStrip /> — four chips covering the things Sir
//    most often opens admin to check: pending permissions, pending
//    claims, cron freshness, errors-last-24h. Each chip is a Link to
//    the relevant deep page.
//
// 2. <RecentAdminActions /> — the last N entries from `activity:log`
//    filtered to messages prefixed with "[admin]". Cheap "what did
//    I just do" timeline.
//
// Both poll lazily: initial fetch on mount + 30s interval + global
// `ourspace:refresh` event subscription via `useRefreshListener`.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Clock,
  Gift,
  History,
  MessageCircleQuestion,
  ShieldCheck,
} from "lucide-react";
import {
  getAdminLandingSummary,
  getRecentAdminActions,
  type AdminLandingSummary,
} from "@/app/actions/admin";
import type { ActivityRecord } from "@/lib/activity";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const POLL_MS = 30_000;
const ACTIONS_LIMIT = 8;

function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`;
  return `${Math.round(diff / 86_400_000)}d`;
}

export function AdminDashboardStrip() {
  const [summary, setSummary] = useState<AdminLandingSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fetchSummary = useCallback(async () => {
    try {
      const result = await getAdminLandingSummary();
      if (result.summary) {
        setSummary(result.summary);
        setNow(Date.now());
      }
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchSummary(), 0);
    const id = setInterval(() => void fetchSummary(), POLL_MS);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [fetchSummary]);

  useRefreshListener(fetchSummary);

  return (
    <div className="mb-6 grid grid-cols-2 gap-2 md:grid-cols-5">
      <DashboardChip
        href="/permissions"
        icon={ShieldCheck}
        label="Pending perms"
        value={summary?.pendingPermissions}
        tone={
          !summary
            ? "muted"
            : summary.pendingPermissions === 0
              ? "ok"
              : "amber"
        }
      />
      <DashboardChip
        href="/rewards"
        icon={Gift}
        label="Pending claims"
        value={summary?.pendingClaims}
        tone={
          !summary
            ? "muted"
            : summary.pendingClaims === 0
              ? "ok"
              : "amber"
        }
      />
      <DashboardChip
        href="/admin/games/truth-or-dare"
        icon={MessageCircleQuestion}
        label="Active TOD"
        value={summary?.activeTodChallenges}
        tone={
          !summary
            ? "muted"
            : summary.activeTodChallenges === 0
              ? "ok"
              : "amber"
        }
      />
      <DashboardChip
        href="/admin/health"
        icon={Clock}
        label={
          summary
            ? `Crons (${summary.cronTotal - summary.cronStaleCount}/${summary.cronTotal})`
            : "Crons"
        }
        value={summary?.cronStaleCount === 0 ? "fresh" : summary?.cronStaleCount}
        tone={
          !summary
            ? "muted"
            : summary.cronStaleCount === 0
              ? "ok"
              : "rose"
        }
      />
      <DashboardChip
        href="/admin/logs"
        icon={AlertTriangle}
        label="Errors (24h)"
        value={summary?.errorsLast24h}
        tone={
          !summary
            ? "muted"
            : summary.errorsLast24h === 0
              ? "ok"
              : "rose"
        }
        sub={
          summary && summary.warningsLast24h > 0
            ? `${summary.warningsLast24h} warns`
            : undefined
        }
      />
      {/* Off-screen "now" pin to keep formatRelativeTs imports honest. */}
      <span className="sr-only">{now}</span>
    </div>
  );
}

function DashboardChip({
  href,
  icon: Icon,
  label,
  value,
  tone,
  sub,
}: {
  href: string;
  icon: typeof Clock;
  label: string;
  value: number | string | null | undefined;
  tone: "ok" | "amber" | "rose" | "muted";
  sub?: string;
}) {
  const toneClasses: Record<typeof tone, string> = {
    ok: "border-emerald-500/40 bg-emerald-500/5 text-emerald-400",
    amber: "border-amber-500/40 bg-amber-500/10 text-amber-400",
    rose: "border-rose-500/40 bg-rose-500/10 text-rose-400",
    muted: "border-border/40 bg-card text-muted-foreground",
  };
  const display =
    value == null
      ? "—"
      : typeof value === "number"
        ? value === 0
          ? "0"
          : String(value)
        : value;
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 transition-colors hover:border-primary/40 active:scale-[0.99]",
        toneClasses[tone],
      )}
    >
      <span className="rounded-lg bg-card p-1.5">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[10px] font-bold uppercase tracking-wider opacity-80">
          {label}
        </span>
        <span className="block truncate text-sm font-bold tabular-nums">
          {display}
          {sub && (
            <span className="ml-1.5 text-[10px] font-normal opacity-70">
              · {sub}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}

// ── Recent admin actions timeline ────────────────────────────────────────

const LEVEL_DOT: Record<ActivityRecord["level"], string> = {
  interaction: "bg-primary",
  info: "bg-muted-foreground",
  warn: "bg-amber-400",
  error: "bg-destructive",
  fatal: "bg-destructive",
};

export function RecentAdminActions() {
  const [records, setRecords] = useState<ActivityRecord[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const fetchActions = useCallback(async () => {
    try {
      const result = await getRecentAdminActions(ACTIONS_LIMIT);
      if (result.records) {
        setRecords(result.records);
        setNow(Date.now());
      }
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void fetchActions(), 0);
    const id = setInterval(() => void fetchActions(), POLL_MS);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [fetchActions]);

  useRefreshListener(fetchActions);

  if (records !== null && records.length === 0) {
    // No recent admin actions — hide the section entirely rather than
    // show an "empty" placeholder.
    return null;
  }

  return (
    <section className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Recent admin actions
        </h2>
        <Link
          href="/admin/logs"
          className="ml-auto text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          Full log →
        </Link>
      </header>
      {!records ? (
        <ul className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-8 animate-pulse rounded-lg border border-border/30 bg-card/40"
            />
          ))}
        </ul>
      ) : (
        <ul className="space-y-1">
          {records.map((r, i) => (
            <li
              key={`${r.at}-${i}`}
              className="flex items-baseline gap-2 rounded-lg border border-border/30 bg-card/40 px-2.5 py-1.5 text-xs"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  LEVEL_DOT[r.level],
                )}
              />
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {r.message.replace(/^\[admin\]\s*/, "")}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                {formatRelativeTs(r.at, now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
