"use client";

// src/app/admin/logs/page.tsx
//
// Merged audit-log surface — four append-only chronological event
// streams behind tabs:
//   - Activity      — interaction / warn / error log (capped 500)
//   - Outbound      — outbound notification audit (forward-only ZSET)
//   - Restraint     — engage / lift transitions
//   - Auth failures — failed login attempts
//
// Each tab body fetches independently via `useRefreshListener` so the
// global header Refresh button dispatches a single `ourspace:refresh`
// event that all subscribed tabs respond to. Per-tab Live toggle adds
// opt-in 10s auto-refresh for that tab only.
//
// Per-tab clear: each tab's destructive button only wipes that tab's
// dataset — never global. Per-entry copy button writes a readable
// text representation to the system clipboard (Capacitor on native,
// navigator.clipboard on web).
//
// Replaces the standalone /admin/activity, /admin/notifications,
// /admin/restraint-history, and /admin/auth-log pages.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  History,
  Lock,
  LockOpen,
  RefreshCw,
  Send,
  ShieldAlert,
  Loader2,
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
  clearOutboundNotificationAudit,
  clearRestraintHistory,
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
import { ClearTabButton } from "@/components/admin/logs/clear-tab-button";
import { LiveToggle } from "@/components/admin/logs/live-toggle";
import { SearchBar } from "@/components/admin/logs/search-bar";
import {
  LogEntryShell,
  type LogSeverity,
} from "@/components/admin/logs/log-entry-shell";

export default function LogsPage() {
  const [now, setNow] = useState(() => Date.now());

  // 30s tick for relative-time labels. Cheap; doesn't fetch anything.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Tab counts surfaced in the TabsTrigger labels. Each tab body
  // hoists its loaded record count up so the trigger can show e.g.
  // "Activity 200". Initial null = unknown / loading.
  const [counts, setCounts] = useState<{
    activity: number | null;
    outbound: number | null;
    restraint: number | null;
    auth: number | null;
  }>({ activity: null, outbound: null, restraint: null, auth: null });

  const setCount = useCallback(
    (tab: keyof typeof counts, n: number) => {
      setCounts((c) => (c[tab] === n ? c : { ...c, [tab]: n }));
    },
    [],
  );

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
          Refresh all
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Logs</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Chronological event streams. Tap any entry to expand its
        details; the copy button writes a readable snapshot to your
        clipboard. Each tab&rsquo;s Clear button wipes only that tab.
      </p>

      <Tabs defaultValue="activity">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="activity">
            <History className="h-3.5 w-3.5" />
            Activity{renderCount(counts.activity)}
          </TabsTrigger>
          <TabsTrigger value="outbound">
            <Bell className="h-3.5 w-3.5" />
            Outbound{renderCount(counts.outbound)}
          </TabsTrigger>
          <TabsTrigger value="restraint">
            <Lock className="h-3.5 w-3.5" />
            Restraint{renderCount(counts.restraint)}
          </TabsTrigger>
          <TabsTrigger value="auth">
            <ShieldAlert className="h-3.5 w-3.5" />
            Auth failures{renderCount(counts.auth)}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activity" className="space-y-4">
          <ActivityTabBody now={now} onCountChange={(n) => setCount("activity", n)} />
        </TabsContent>
        <TabsContent value="outbound" className="space-y-4">
          <OutboundTabBody now={now} onCountChange={(n) => setCount("outbound", n)} />
        </TabsContent>
        <TabsContent value="restraint" className="space-y-4">
          <RestraintTabBody now={now} onCountChange={(n) => setCount("restraint", n)} />
        </TabsContent>
        <TabsContent value="auth" className="space-y-4">
          <AuthFailuresTabBody now={now} onCountChange={(n) => setCount("auth", n)} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function renderCount(n: number | null) {
  if (n === null) return null;
  return (
    <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-muted-foreground/80">
      {n}
    </span>
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

const LEVEL_SEVERITY: Record<ActivityRecord["level"], LogSeverity> = {
  interaction: "interaction",
  info: "info",
  warn: "warn",
  error: "error",
  fatal: "fatal",
};

const ACTIVITY_LEVEL_FILTERS: ReadonlyArray<{
  value: ActivityRecord["level"] | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "interaction", label: "Interaction" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
  { value: "fatal", label: "Fatal" },
];

/** Pluralized noun rendered after the count in the Clear-confirm
 *  button label ("Clear 12 warnings"). The "all" key yields the
 *  whole-feed wording. */
const CLEAR_LABEL_BY_LEVEL: Record<
  ActivityRecord["level"] | "all",
  string
> = {
  all: "activity",
  interaction: "interactions",
  info: "info entries",
  warn: "warnings",
  error: "errors",
  fatal: "fatal entries",
};

function ActivityTabBody({
  now,
  onCountChange,
}: {
  now: number;
  onCountChange: (n: number) => void;
}) {
  const [records, setRecords] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<
    ActivityRecord["level"] | "all"
  >("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  // Hoist count to the parent so the tab trigger pill stays in sync.
  useEffect(() => {
    if (records) onCountChange(records.length);
  }, [records, onCountChange]);

  // Level-specific clear. Scoped to the currently-selected filter
  // chip — Clear on "All" wipes everything; Clear on "Warn" wipes
  // only warnings; etc. The level-filtered count (NOT the search-
  // filtered count) is what gets removed.
  const handleClear = async () => {
    const level = levelFilter === "all" ? undefined : levelFilter;
    const result = await clearActivityFeed(level);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (level === undefined) {
      setRecords([]);
    } else {
      setRecords((prev) =>
        prev ? prev.filter((r) => r.level !== level) : prev,
      );
    }
    setExpanded(new Set());
  };

  const filtered = useMemo(() => {
    if (!records) return [];
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (levelFilter !== "all" && r.level !== levelFilter) return false;
      if (!q) return true;
      const hay =
        r.message.toLowerCase() +
        " " +
        r.level +
        " " +
        (r.context ? JSON.stringify(r.context).toLowerCase() : "");
      return hay.includes(q);
    });
  }, [records, levelFilter, search]);

  // Level-keyed counts power the Clear button's "Clear N <kind>" label.
  // Count is the level-only filter (ignoring search) so Sir knows
  // exactly how many entries his next tap will destroy regardless of
  // what's currently visible.
  const clearCount = useMemo(() => {
    if (!records) return 0;
    if (levelFilter === "all") return records.length;
    return records.filter((r) => r.level === levelFilter).length;
  }, [records, levelFilter]);

  const clearLabel = CLEAR_LABEL_BY_LEVEL[levelFilter];

  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      <TabToolbar
        leftLabel={`Last ${ACTIVITY_LIMIT} interaction / warn / error events. Capped at 500 server-side.`}
        clearLabel={clearLabel}
        count={clearCount}
        onClear={handleClear}
        onLiveTick={fetchFeed}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search messages, context…"
      />

      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap items-center gap-1.5">
        {ACTIVITY_LEVEL_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={levelFilter === f.value}
            onClick={() => setLevelFilter(f.value)}
            label={f.label}
          />
        ))}
        <CountBadge
          loaded={records?.length ?? null}
          matching={filtered.length}
          filtered={levelFilter !== "all" || search.length > 0}
        />
      </div>

      {records == null ? (
        <FeedSkeleton />
      ) : records.length === 0 ? (
        <EmptyState message="No activity recorded yet." icon={History} />
      ) : filtered.length === 0 ? (
        <EmptyState
          message="No matches for this filter."
          icon={History}
        />
      ) : (
        <ul className="space-y-2">
          {filtered.map((r, i) => {
            const key = `${r.at}-${i}`;
            const isExpanded = expanded.has(key);
            const hasContext = !!r.context && Object.keys(r.context).length > 0;
            const copyText = formatActivityCopy(r);
            return (
              <LogEntryShell
                key={key}
                severity={LEVEL_SEVERITY[r.level]}
                pill={
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      LEVEL_STYLES[r.level],
                    )}
                  >
                    {r.level}
                  </span>
                }
                timestamp={r.at}
                now={now}
                copyText={copyText}
                summary={
                  <p dir="auto" className="text-sm font-medium">
                    {r.message}
                  </p>
                }
                expandedContent={
                  hasContext ? (
                    <pre className="max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-[10px] text-muted-foreground">
                      {JSON.stringify(r.context, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/70">
                      No additional context.
                    </p>
                  )
                }
                expanded={isExpanded}
                onToggle={() => toggleExpanded(key)}
              />
            );
          })}
        </ul>
      )}
    </>
  );
}

function formatActivityCopy(r: ActivityRecord): string {
  const lines = [
    `[${r.level.toUpperCase()}] ${new Date(r.at).toISOString()}`,
    r.message,
  ];
  if (r.context && Object.keys(r.context).length > 0) {
    lines.push("", JSON.stringify(r.context, null, 2));
  }
  return lines.join("\n");
}

// ── Outbound notification audit tab ──────────────────────────────────────

function OutboundTabBody({
  now,
  onCountChange,
}: {
  now: number;
  onCountChange: (n: number) => void;
}) {
  const [pairs, setPairs] = useState<NotificationAuditPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const totalCount = pairs?.reduce((sum, p) => sum + p.records.length, 0) ?? 0;
  useEffect(() => {
    if (pairs) onCountChange(totalCount);
  }, [pairs, totalCount, onCountChange]);

  const handleClear = async () => {
    const result = await clearOutboundNotificationAudit();
    if (result.error) {
      setError(result.error);
      return;
    }
    setPairs((prev) =>
      prev ? prev.map((p) => ({ ...p, records: [] })) : prev,
    );
    setExpanded(new Set());
  };

  return (
    <>
      <TabToolbar
        leftLabel={
          <>
            Forward-only send-time audit log
            (<code>notifications:audit</code> ZSET, capped at 200),
            independent from the per-user drawers. Clearing here does
            NOT clear the in-app notification drawers.
          </>
        }
        clearLabel="audit entries"
        count={totalCount}
        onClear={handleClear}
        onLiveTick={fetchAudit}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search titles, body, URLs…"
      />

      {error && <ErrorBanner message={error} />}

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
              search={search}
              expanded={expanded}
              onToggleExpanded={(key) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
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
  search,
  expanded,
  onToggleExpanded,
  onResent,
}: {
  pair: NotificationAuditPair;
  now: number;
  search: string;
  expanded: Set<string>;
  onToggleExpanded: (key: string) => void;
  onResent: () => Promise<void>;
}) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? pair.records.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q) ||
          r.url.toLowerCase().includes(q),
      )
    : pair.records;

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-4">
      <header className="mb-3 flex items-center gap-2">
        <Bell className="h-4 w-4 text-primary/70" />
        <h2 className="text-sm font-semibold">
          {TITLE_BY_AUTHOR[pair.author] ?? pair.author}
        </h2>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">
          {q && filtered.length !== pair.records.length
            ? `${filtered.length} / ${pair.records.length}`
            : `${pair.records.length} entries`}
        </span>
      </header>
      {pair.records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No notifications yet.</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-muted-foreground">No matches.</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r) => (
            <NotificationRow
              key={r.id}
              record={r}
              author={pair.author}
              now={now}
              expanded={expanded.has(r.id)}
              onToggle={() => onToggleExpanded(r.id)}
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
  expanded,
  onToggle,
  onResent,
}: {
  record: OutboundNotificationAuditEntry;
  author: Author;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onResent: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleResend = async (e: React.MouseEvent) => {
    e.stopPropagation();
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

  const copyText = [
    `[OUTBOUND → ${TITLE_BY_AUTHOR[author] ?? author}] ${new Date(record.ts).toISOString()}`,
    `Title: ${record.title}`,
    `Body:  ${record.body}`,
    `URL:   ${record.url}`,
    `ID:    ${record.id}`,
  ].join("\n");

  return (
    <LogEntryShell
      severity="interaction"
      pill={
        <span className="truncate text-xs font-semibold" dir="auto">
          {record.title}
        </span>
      }
      timestamp={record.ts}
      now={now}
      copyText={copyText}
      summary={
        <>
          <p
            className="line-clamp-2 text-xs text-muted-foreground"
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
              onClick={(e) => void handleResend(e)}
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
        </>
      }
      expandedContent={
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-muted-foreground/70">id</dt>
          <dd className="break-all font-mono">{record.id}</dd>
          <dt className="text-muted-foreground/70">to</dt>
          <dd>{TITLE_BY_AUTHOR[author] ?? author}</dd>
          <dt className="text-muted-foreground/70">title</dt>
          <dd dir="auto">{record.title}</dd>
          <dt className="text-muted-foreground/70">body</dt>
          <dd dir="auto">{record.body}</dd>
          <dt className="text-muted-foreground/70">url</dt>
          <dd className="font-mono">{record.url}</dd>
          <dt className="text-muted-foreground/70">ts</dt>
          <dd className="font-mono">
            {new Date(record.ts).toISOString()}
          </dd>
        </dl>
      }
      expanded={expanded}
      onToggle={onToggle}
    />
  );
}

// ── Restraint history tab ────────────────────────────────────────────────

function RestraintTabBody({
  now,
  onCountChange,
}: {
  now: number;
  onCountChange: (n: number) => void;
}) {
  const [entries, setEntries] = useState<RestraintHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] =
    useState<"all" | "engage" | "lift">("all");

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

  useEffect(() => {
    if (entries) onCountChange(entries.length);
  }, [entries, onCountChange]);

  const handleClear = async () => {
    const result = await clearRestraintHistory();
    if (result.error) {
      setError(result.error);
      return;
    }
    setEntries([]);
  };

  const filtered = useMemo(() => {
    if (!entries) return [];
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (actionFilter !== "all" && e.action !== actionFilter) return false;
      if (!q) return true;
      const hay =
        e.action +
        " " +
        (e.by ?? "") +
        " " +
        (e.reason ?? "");
      return hay.toLowerCase().includes(q);
    });
  }, [entries, actionFilter, search]);

  return (
    <>
      <TabToolbar
        leftLabel="Every engage and lift transition with timestamp + reason (engage only). Capped at 200 entries server-side."
        clearLabel="history entries"
        count={entries?.length ?? 0}
        onClear={handleClear}
        onLiveTick={fetchHistory}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by reason or actor…"
      />

      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          active={actionFilter === "all"}
          onClick={() => setActionFilter("all")}
          label="All"
        />
        <FilterChip
          active={actionFilter === "engage"}
          onClick={() => setActionFilter("engage")}
          label="Engage"
        />
        <FilterChip
          active={actionFilter === "lift"}
          onClick={() => setActionFilter("lift")}
          label="Lift"
        />
        <CountBadge
          loaded={entries?.length ?? null}
          matching={filtered.length}
          filtered={actionFilter !== "all" || search.length > 0}
        />
      </div>

      {entries == null ? (
        <FeedSkeleton />
      ) : entries.length === 0 ? (
        <EmptyState message="No restraint events yet." icon={Lock} />
      ) : filtered.length === 0 ? (
        <EmptyState message="No matches." icon={Lock} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((e, i) => {
            const key = `${e.ts}-${i}-${e.action}`;
            const isEngage = e.action === "engage";
            const copyText = [
              `[RESTRAINT ${e.action.toUpperCase()}] ${new Date(e.ts).toISOString()}`,
              `By: ${TITLE_BY_AUTHOR[e.by] ?? e.by}`,
              e.reason ? `Reason: ${e.reason}` : null,
            ]
              .filter(Boolean)
              .join("\n");
            return (
              <LogEntryShell
                key={key}
                severity={isEngage ? "danger" : "success"}
                pill={
                  <span
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                      isEngage
                        ? "bg-destructive/10 text-destructive"
                        : "bg-emerald-500/10 text-emerald-400",
                    )}
                  >
                    {isEngage ? (
                      <Lock className="h-3 w-3" />
                    ) : (
                      <LockOpen className="h-3 w-3" />
                    )}
                    {isEngage ? "Engaged" : "Lifted"}
                  </span>
                }
                timestamp={e.ts}
                now={now}
                copyText={copyText}
                summary={
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-muted-foreground">
                      by {TITLE_BY_AUTHOR[e.by] ?? e.by}
                    </span>
                    {e.reason && (
                      <p dir="auto" className="italic text-muted-foreground">
                        &ldquo;{e.reason}&rdquo;
                      </p>
                    )}
                  </div>
                }
              />
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── Auth failures tab ────────────────────────────────────────────────────

function AuthFailuresTabBody({
  now,
  onCountChange,
}: {
  now: number;
  onCountChange: (n: number) => void;
}) {
  const [records, setRecords] = useState<AuthFailureRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ipFilter, setIpFilter] = useState<string | "all">("all");
  const [search, setSearch] = useState("");

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
    if (records) onCountChange(records.length);
  }, [records, onCountChange]);

  const handleClear = async () => {
    const result = await clearAuthFailures();
    if (result.error) {
      setError(result.error);
      return;
    }
    setRecords([]);
  };

  const ips = useMemo(() => {
    if (!records) return [];
    return Array.from(
      new Set(records.map((r) => r.ip).filter((ip): ip is string => !!ip)),
    ).sort();
  }, [records]);

  const filtered = useMemo(() => {
    if (!records) return [];
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (ipFilter !== "all" && r.ip !== ipFilter) return false;
      if (!q) return true;
      const hay = `${r.ip ?? ""} ${r.ua ?? ""} ${r.passcodeLen}`.toLowerCase();
      return hay.includes(q);
    });
  }, [records, ipFilter, search]);

  return (
    <>
      <TabToolbar
        leftLabel="Last 100 failed login attempts. Successful logins live in the Activity tab."
        clearLabel="failures"
        count={records?.length ?? 0}
        onClear={handleClear}
        onLiveTick={fetchLog}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by IP or User-Agent…"
      />

      {error && <ErrorBanner message={error} />}

      {ips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            active={ipFilter === "all"}
            onClick={() => setIpFilter("all")}
            label="All IPs"
          />
          {ips.map((ip) => (
            <FilterChip
              key={ip}
              active={ipFilter === ip}
              onClick={() => setIpFilter(ip)}
              label={ip}
              mono
            />
          ))}
          <CountBadge
            loaded={records?.length ?? null}
            matching={filtered.length}
            filtered={ipFilter !== "all" || search.length > 0}
          />
        </div>
      )}

      {records == null ? (
        <FeedSkeleton rows={3} />
      ) : records.length === 0 ? (
        <EmptyState message="No failed logins on file." icon={ShieldAlert} />
      ) : filtered.length === 0 ? (
        <EmptyState message="No matches." icon={ShieldAlert} />
      ) : (
        <ul className="space-y-2">
          {filtered.map((r, i) => {
            const copyText = [
              `[AUTH FAILURE] ${new Date(r.ts).toISOString()}`,
              `IP:            ${r.ip ?? "—"}`,
              `User-Agent:    ${r.ua ?? "—"}`,
              `Passcode len:  ${r.passcodeLen}`,
            ].join("\n");
            return (
              <LogEntryShell
                key={`${r.ts}-${i}`}
                severity="error"
                pill={
                  <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-destructive">
                    <ShieldAlert className="h-3 w-3" />
                    Failure
                  </span>
                }
                timestamp={r.ts}
                now={now}
                copyText={copyText}
                summary={
                  <dl className="space-y-1 text-[11px]">
                    <KVRow label="IP" value={r.ip ?? "—"} mono />
                    <KVRow label="User-Agent" value={r.ua ?? "—"} mono />
                    <KVRow
                      label="Passcode length"
                      value={String(r.passcodeLen)}
                    />
                  </dl>
                }
              />
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── Shared sub-components ────────────────────────────────────────────────

function TabToolbar({
  leftLabel,
  clearLabel,
  count,
  onClear,
  onLiveTick,
  searchValue,
  onSearchChange,
  searchPlaceholder,
}: {
  leftLabel: React.ReactNode;
  clearLabel: string;
  count: number;
  onClear: () => Promise<void>;
  onLiveTick: () => void;
  searchValue: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{leftLabel}</p>
      <div className="flex flex-wrap items-center gap-2">
        <SearchBar
          value={searchValue}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
        />
        <LiveToggle onTick={onLiveTick} />
        <ClearTabButton label={clearLabel} count={count} onClear={onClear} />
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  mono = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  mono?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        void vibrate(15, "light");
        onClick();
      }}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[10px] tracking-wider transition-colors active:scale-95",
        mono ? "font-mono" : "font-bold uppercase",
        active
          ? "border-primary/60 bg-primary/15 text-primary"
          : "border-border/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function CountBadge({
  loaded,
  matching,
  filtered,
}: {
  loaded: number | null;
  matching: number;
  filtered: boolean;
}) {
  if (loaded === null || loaded === 0) return null;
  return (
    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
      {filtered ? `${matching} match · ${loaded} loaded` : `${loaded}`}
    </span>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
    >
      {message}
    </div>
  );
}

function EmptyState({
  message,
  icon: Icon,
}: {
  message: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/40 p-10 text-center">
      <Icon className="h-6 w-6 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function FeedSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
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

