"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Award,
  BookHeart,
  CheckSquare,
  Hand,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Smartphone,
  Sparkles,
} from "lucide-react";
import {
  getActivityHeatmap,
  getStats,
  type HeatmapDay,
  type StatsSnapshot,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export default function StatsPage() {
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [s, h] = await Promise.all([getStats(), getActivityHeatmap(30)]);
      if (s.error) setError(s.error);
      else if (s.stats) {
        setStats(s.stats);
        setError(null);
      }
      if (h.days) setHeatmap(h.days);
    } catch {
      setError("Failed to load stats.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchAll]);

  useRefreshListener(fetchAll);

  const now = stats?.generatedAt ?? Date.now();

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
            void fetchAll();
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

      <h1 className="text-2xl font-bold tracking-tight">Stats</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Computed on demand from current Redis state. Heatmap below covers the
        last 30 days, bucketed by UTC midnight.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!stats ? (
        <StatsSkeleton />
      ) : (
        <div className="space-y-4">
          <Card icon={BookHeart} title="Notes">
            <Stat label="Total" value={formatNumber(stats.notes.total)} />
            <Stat
              label={TITLE_BY_AUTHOR.T7SEN}
              value={formatNumber(stats.notes.byAuthor.T7SEN)}
            />
            <Stat
              label={TITLE_BY_AUTHOR.Besho}
              value={formatNumber(stats.notes.byAuthor.Besho)}
            />
            <Stat
              label="Pinned (Sir / kitten)"
              value={`${stats.notes.pinnedByAuthor.T7SEN} / ${stats.notes.pinnedByAuthor.Besho}`}
            />
          </Card>

          <Card icon={ScrollText} title="Rules">
            <Stat label="Total" value={formatNumber(stats.rules.total)} />
            <Stat label="Pending" value={formatNumber(stats.rules.pending)} />
            <Stat label="Active" value={formatNumber(stats.rules.active)} />
            <Stat
              label="Completed"
              value={formatNumber(stats.rules.completed)}
            />
          </Card>

          <Card icon={CheckSquare} title="Tasks">
            <Stat label="Total" value={formatNumber(stats.tasks.total)} />
            <Stat label="Pending" value={formatNumber(stats.tasks.pending)} />
            <Stat
              label="In review"
              value={formatNumber(stats.tasks.inReview)}
            />
            <Stat
              label="Completion rate"
              value={formatPercent(stats.tasks.completionRate)}
            />
          </Card>

          <Card icon={Award} title="Ledger">
            <Stat label="Total" value={formatNumber(stats.ledger.total)} />
            <Stat
              label="Rewards"
              value={formatNumber(stats.ledger.rewards)}
            />
            <Stat
              label="Punishments"
              value={formatNumber(stats.ledger.punishments)}
            />
            <Stat
              label="Net"
              value={formatNumber(
                stats.ledger.rewards - stats.ledger.punishments,
              )}
            />
          </Card>

          <Card icon={Hand} title="Permissions">
            <Stat
              label="Total"
              value={formatNumber(stats.permissions.total)}
            />
            <Stat
              label="Pending / approved"
              value={`${stats.permissions.pending} / ${stats.permissions.approved}`}
            />
            <Stat
              label="Denied / withdrawn"
              value={`${stats.permissions.denied} / ${stats.permissions.withdrawn}`}
            />
            <Stat
              label="Avg decide latency"
              value={formatLatency(stats.permissions.avgDecideLatencyMs)}
            />
          </Card>

          <Card icon={Sparkles} title="Rituals">
            <Stat
              label="Total"
              value={formatNumber(stats.rituals.total)}
            />
            <Stat
              label="Active"
              value={formatNumber(stats.rituals.active)}
            />
            <Stat
              label="Paused"
              value={formatNumber(stats.rituals.paused)}
            />
          </Card>

          <Card icon={ShieldAlert} title="Safeword">
            <Stat
              label="Total"
              value={formatNumber(stats.safeword.total)}
            />
            <Stat
              label="Last 30 days"
              value={formatNumber(stats.safeword.last30d)}
            />
            <Stat
              label="Last triggered"
              value={
                stats.safeword.lastTriggeredAt
                  ? formatRelative(stats.safeword.lastTriggeredAt, now)
                  : "—"
              }
            />
          </Card>

          <Card icon={Smartphone} title="Devices &amp; activity">
            <Stat
              label="Devices total"
              value={formatNumber(stats.devices.total)}
            />
            <Stat
              label="Devices online"
              value={formatNumber(stats.devices.online)}
            />
            <Stat
              label="Reviews revealed"
              value={formatNumber(stats.reviews.revealedWeeks)}
            />
            <Stat
              label="Activity (24h)"
              value={formatNumber(stats.activity.last24h)}
            />
          </Card>
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Activity heatmap (30 days)
        </h2>
        {heatmap == null ? (
          <div className="h-32 animate-pulse rounded-2xl border border-border/40 bg-card" />
        ) : (
          <Heatmap days={heatmap} />
        )}
      </section>
    </main>
  );
}

function Card({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Icon className="h-4 w-4 text-primary/70" />
        {title}
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
        {children}
      </dl>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-lg font-bold tracking-tight">
        {value}
      </dd>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-2xl border border-border/40 bg-card"
        />
      ))}
    </div>
  );
}

function Heatmap({ days }: { days: HeatmapDay[] }) {
  const max = days.reduce((m, d) => (d.count > m ? d.count : m), 0);
  return (
    <div className="rounded-2xl border border-border/40 bg-card p-4">
      <div className="grid grid-flow-col grid-rows-7 gap-1">
        {days.map((d) => (
          <div
            key={d.ts}
            title={`${d.date}: ${d.count} event${d.count === 1 ? "" : "s"}`}
            className={cn(
              "aspect-square rounded-sm transition-colors",
              max === 0
                ? "bg-muted/40"
                : d.count === 0
                  ? "bg-muted/30"
                  : `${intensityClass(d.count, max)}`,
            )}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>{days[0]?.date}</span>
        <Legend />
        <span>{days[days.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function intensityClass(count: number, max: number): string {
  const ratio = count / max;
  if (ratio > 0.75) return "bg-primary";
  if (ratio > 0.5) return "bg-primary/75";
  if (ratio > 0.25) return "bg-primary/50";
  return "bg-primary/25";
}

function Legend() {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[9px]">less</span>
      <span className="h-2 w-2 rounded-sm bg-muted/30" />
      <span className="h-2 w-2 rounded-sm bg-primary/25" />
      <span className="h-2 w-2 rounded-sm bg-primary/50" />
      <span className="h-2 w-2 rounded-sm bg-primary/75" />
      <span className="h-2 w-2 rounded-sm bg-primary" />
      <span className="text-[9px]">more</span>
    </span>
  );
}

