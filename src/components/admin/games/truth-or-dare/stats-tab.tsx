// src/components/admin/games/truth-or-dare/stats-tab.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCcw, Save, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  DEFAULT_TOD_STATS,
  MAX_TOD_STAT_VALUE,
  TOD_STAT_KEYS,
  TOD_STAT_LABELS,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";
import {
  adjustTodStat,
  getTodWindowedStats,
  resetTodStats,
  type TodAdminBundle,
  type TodWindowedStats,
} from "@/app/actions/admin";
import { Button } from "@/components/ui/button";

interface StatsTabProps {
  bundle: TodAdminBundle;
  onAction: () => void;
}

/** Read-only windowed view of activity over a fixed time window. The
 *  `null` value represents "all time" (no score-range filter). */
type WindowChoice = null | 7 | 30;

const WINDOW_OPTIONS: { value: WindowChoice; label: string }[] = [
  { value: null, label: "All time" },
  { value: 30, label: "Last 30d" },
  { value: 7, label: "Last 7d" },
];

/** Three-section layout: windowed read-only summary (top), then the
 *  per-author editable cumulative counters (bottom — unchanged). The
 *  windowed view is computed server-side via
 *  `getTodWindowedStats(windowDays?)`; cumulative is the on-disk HASH. */
export function StatsTab({ bundle, onAction }: StatsTabProps) {
  // Named `selectedWindow` (not `window`) to avoid shadowing the
  // global `window` object — and to read naturally next to
  // `windowed`/`windowError` without ambiguity.
  const [selectedWindow, setSelectedWindow] = useState<WindowChoice>(30);
  const [windowed, setWindowed] = useState<TodWindowedStats | null>(null);
  const [windowError, setWindowError] = useState<string | null>(null);

  // Stale-while-revalidate: keep the previous windowed view rendered
  // while the new fetch lands, derive "loading" from the absence of a
  // matching response. No synchronous setState inside the effect —
  // every mutation goes through the deferred path so React 19's
  // set-state-in-effect lint stays happy.
  const fetchWindowed = useCallback(async (choice: WindowChoice) => {
    const r = await getTodWindowedStats(choice ?? undefined);
    setTimeout(() => {
      if (r.error) {
        setWindowError(r.error);
      } else {
        setWindowError(null);
        if (r.stats) setWindowed(r.stats);
      }
    }, 0);
  }, []);

  useEffect(() => {
    void fetchWindowed(selectedWindow);
  }, [fetchWindowed, selectedWindow]);

  // "Loading" derives from: nothing rendered yet OR the rendered
  // window doesn't match the currently-selected one. Mismatch case
  // = the user just flipped the toggle and the new fetch is in flight.
  const isInitialLoad = windowed === null && !windowError;
  const isStale =
    windowed !== null &&
    (windowed.windowDays ?? null) !== selectedWindow;

  return (
    <section className="space-y-6">
      {/* Windowed view */}
      <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
              Activity window
            </h3>
            <p className="text-[11px] text-muted-foreground/60">
              Read-only aggregation by{" "}
              <code className="rounded bg-white/5 px-1 py-0.5 font-mono text-[10px]">
                createdAt
              </code>
              . Cancelled and active records aren&rsquo;t counted.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5 rounded-full border border-white/5 bg-black/20 p-1">
            {WINDOW_OPTIONS.map((opt) => {
              const active = selectedWindow === opt.value;
              return (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => {
                    void vibrate(20, "light");
                    setSelectedWindow(opt.value);
                  }}
                  className={cn(
                    "rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.97]",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </header>

        {windowError && (
          <p className="mb-3 text-[11px] font-medium text-destructive">
            {windowError}
          </p>
        )}

        {isInitialLoad ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : windowed ? (
          <div
            className={cn(
              "grid gap-4 md:grid-cols-2 transition-opacity",
              isStale && "opacity-60",
            )}
          >
            <WindowedColumn
              author="T7SEN"
              counters={windowed.T7SEN}
            />
            <WindowedColumn
              author="Besho"
              counters={windowed.Besho}
            />
          </div>
        ) : null}

        {windowed && (
          <p className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground/50">
            <span>
              {windowed.total} challenges in window · generated{" "}
              {new Date(windowed.generatedAt).toLocaleTimeString()}
            </span>
            {isStale && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
            )}
          </p>
        )}
      </div>

      {/* Cumulative editable counters */}
      <div>
        <p className="mb-3 text-xs text-muted-foreground/70">
          Edit cumulative counters per author. Each value is set
          directly — to wipe a column use Reset. Streak fields reset to
          zero automatically when the bound action transitions
          (refuse / expire reset current; new responses bump it). The
          longest-streak field is the high-water mark.
        </p>
        <div className="grid gap-6 md:grid-cols-2">
          <StatsEditor
            author="T7SEN"
            stats={bundle.stats.T7SEN ?? DEFAULT_TOD_STATS}
            onAction={onAction}
          />
          <StatsEditor
            author="Besho"
            stats={bundle.stats.Besho ?? DEFAULT_TOD_STATS}
            onAction={onAction}
          />
        </div>
      </div>
    </section>
  );
}

interface WindowedColumnProps {
  author: Author;
  counters: TodWindowedStats["T7SEN"];
}

/** Read-only counter grid for the windowed view. Mirrors the layout of
 *  the cumulative editor but with no controls. */
function WindowedColumn({ author, counters }: WindowedColumnProps) {
  const entries: { key: keyof typeof counters; label: string }[] = [
    { key: "issued", label: "Issued" },
    { key: "truthsAnswered", label: "Truths answered" },
    { key: "daresCompleted", label: "Dares completed" },
    { key: "refused", label: "Refused" },
    { key: "safeworded", label: "Safeworded" },
    { key: "expired", label: "Expired" },
    { key: "withdrawn", label: "Withdrawn" },
  ];
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wider text-foreground/80">
        {TITLE_BY_AUTHOR[author]}
      </h4>
      <dl className="grid grid-cols-2 gap-2">
        {entries.map(({ key, label }) => (
          <div
            key={key}
            className="rounded-lg border border-white/5 bg-black/20 px-3 py-2"
          >
            <dt className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
              {label}
            </dt>
            <dd className="text-base font-bold tabular-nums text-foreground">
              {counters[key] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

interface StatsEditorProps {
  author: Author;
  stats: TodStats;
  onAction: () => void;
}

/** Per-author stat editor. Maintains a `draft` copy of `stats` (the
 *  server snapshot). Each row has a number input + save button + undo
 *  button (active when the draft differs from the server value). Reset
 *  wipes the whole HASH. */
function StatsEditor({ author, stats, onAction }: StatsEditorProps) {
  const [draft, setDraft] = useState<TodStats>(stats);
  const [busy, setBusy] = useState(false);
  const [busyKey, setBusyKey] = useState<keyof TodStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Defer the sync so React 19's set-state-in-effect lint stays happy.
  // The draft is the editable copy of `stats` (per-author server state)
  // and must reset whenever the server re-fetches — but a synchronous
  // setState inside the effect trips the rule. Wrapping in setTimeout
  // pushes it past the commit and matches the codebase pattern.
  useEffect(() => {
    setTimeout(() => setDraft(stats), 0);
  }, [stats]);

  const handleSet = async (key: keyof TodStats) => {
    if (busy) return;
    setBusy(true);
    setBusyKey(key);
    setError(null);
    void vibrate(40, "light");
    const r = await adjustTodStat({
      author,
      key,
      value: draft[key],
    });
    if (r.error) setError(r.error);
    else onAction();
    setBusy(false);
    setBusyKey(null);
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void vibrate([50, 30, 50], "heavy");
    const r = await resetTodStats(author);
    if (r.error) setError(r.error);
    else onAction();
    setBusy(false);
  };

  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
      <header className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          {TITLE_BY_AUTHOR[author]}
        </h3>
        <button
          type="button"
          onClick={handleReset}
          disabled={busy || undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-card px-3 py-1.5",
            "text-[10px] font-bold uppercase tracking-wider text-muted-foreground",
            "transition-colors hover:border-destructive/40 hover:text-destructive active:scale-[0.95] disabled:opacity-50",
          )}
        >
          <RotateCcw className="h-3 w-3" />
          Reset
        </button>
      </header>

      <div className="space-y-2">
        {TOD_STAT_KEYS.map((key) => (
          <div
            key={key}
            className="flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 px-3 py-2"
          >
            <span className="flex-1 text-[11px] font-semibold text-muted-foreground/80">
              {TOD_STAT_LABELS[key]}
            </span>
            <input
              type="number"
              min={0}
              max={MAX_TOD_STAT_VALUE}
              step={1}
              value={draft[key]}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                setDraft((prev) => ({
                  ...prev,
                  [key]: Math.max(
                    0,
                    Math.min(MAX_TOD_STAT_VALUE, Math.floor(v)),
                  ),
                }));
              }}
              disabled={busy || undefined}
              className={cn(
                "w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-right text-xs tabular-nums",
                "outline-none focus:border-primary/40",
              )}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleSet(key)}
              disabled={busy || draft[key] === stats[key] || undefined}
              className="h-7 rounded-full px-2 text-[10px] font-bold uppercase tracking-wider"
            >
              {busyKey === key ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Save className="h-3 w-3" />
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() =>
                setDraft((prev) => ({ ...prev, [key]: stats[key] }))
              }
              disabled={busy || draft[key] === stats[key] || undefined}
              className="h-7 rounded-full px-2 text-[10px]"
              aria-label="Discard change"
            >
              <Undo2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
