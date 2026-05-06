"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  getTrashList,
  getTrashRetention,
  restoreTrashEntryAction,
  deleteTrashEntryAction,
  purgeTrashAction,
  setTrashRetention,
} from "@/app/actions/admin";
import {
  TRASH_FEATURE_LABELS,
  type TrashEntry,
  type TrashFeature,
} from "@/lib/trash";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 5_000;

const FEATURE_FILTERS: ReadonlyArray<{
  value: TrashFeature | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "notes", label: "Notes" },
  { value: "rules", label: "Rules" },
  { value: "tasks", label: "Tasks" },
  { value: "ledger", label: "Ledger" },
  { value: "permissions", label: "Permissions" },
  { value: "rituals", label: "Rituals" },
  { value: "timeline", label: "Timeline" },
  { value: "reviews", label: "Reviews" },
];

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function expiresAt(deletedAt: number, retentionDays: number): number {
  return deletedAt + retentionDays * 24 * 60 * 60 * 1000;
}

export default function TrashPage() {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [filter, setFilter] = useState<TrashFeature | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number>(7);
  const [retentionBounds, setRetentionBounds] = useState<{
    min: number;
    max: number;
  }>({ min: 1, max: 90 });

  const fetchTrash = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getTrashList(
        filter === "all" ? undefined : filter,
      );
      if (result.error) {
        setError(result.error);
      } else {
        setEntries(result.entries ?? []);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    void fetchTrash();
    const id = setInterval(() => void fetchTrash(), POLL_MS);
    return () => clearInterval(id);
  }, [fetchTrash]);

  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        const result = await getTrashRetention();
        if (result.days) setRetentionDays(result.days);
        if (typeof result.min === "number" && typeof result.max === "number") {
          setRetentionBounds({ min: result.min, max: result.max });
        }
      })();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!confirmingDelete) return;
    const id = setTimeout(() => setConfirmingDelete(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirmingDelete]);

  useEffect(() => {
    if (!confirmingPurge) return;
    const id = setTimeout(() => setConfirmingPurge(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirmingPurge]);

  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    if (filter === "all") return entries;
    return entries.filter((e) => e.feature === filter);
  }, [entries, filter]);

  const handleRestore = async (entry: TrashEntry) => {
    const key = `${entry.feature}:${entry.id}`;
    void vibrate(50, "medium");
    setBusyKey(key);
    setError(null);
    try {
      const result = await restoreTrashEntryAction(entry.feature, entry.id);
      if (result.error) {
        setError(result.error);
      } else {
        setEntries((prev) =>
          prev ? prev.filter((e) => e.id !== entry.id || e.feature !== entry.feature) : prev,
        );
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (entry: TrashEntry) => {
    const key = `${entry.feature}:${entry.id}`;
    void vibrate([100, 50, 100], "heavy");
    setBusyKey(key);
    setError(null);
    try {
      const result = await deleteTrashEntryAction(entry.feature, entry.id);
      if (result.error) {
        setError(result.error);
      } else {
        setEntries((prev) =>
          prev ? prev.filter((e) => e.id !== entry.id || e.feature !== entry.feature) : prev,
        );
        setConfirmingDelete(null);
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handlePurge = async () => {
    void vibrate([100, 50, 100], "heavy");
    setBusyKey("__purge__");
    setError(null);
    try {
      const result = await purgeTrashAction(
        filter === "all" ? undefined : filter,
      );
      if (result.error) {
        setError(result.error);
      } else {
        setEntries([]);
        setConfirmingPurge(false);
      }
    } finally {
      setBusyKey(null);
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
          onClick={() => {
            void vibrate(20, "light");
            void fetchTrash();
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

      <h1 className="text-2xl font-bold tracking-tight">Trash</h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Soft-deleted records auto-expire after{" "}
        <span className="font-semibold text-foreground">
          {retentionDays} {retentionDays === 1 ? "day" : "days"}
        </span>
        . Restore puts the record back in its original index with the
        original score.
      </p>

      <RetentionDial
        days={retentionDays}
        bounds={retentionBounds}
        onSaved={(d) => setRetentionDays(d)}
      />

      <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        {FEATURE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => {
              void vibrate(20, "light");
              setFilter(f.value);
            }}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-95",
              filter === f.value
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/40 bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {visibleEntries == null ? (
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-20 animate-pulse rounded-xl border border-border/40 bg-card"
            />
          ))}
        </ul>
      ) : visibleEntries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
          Trash is empty.
        </p>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {visibleEntries.map((entry) => {
              const key = `${entry.feature}:${entry.id}`;
              const isConfirmingDelete = confirmingDelete === key;
              const isBusy = busyKey === key;
              return (
                <motion.li
                  key={key}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  className="rounded-xl border border-border/40 bg-card p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">
                          {TRASH_FEATURE_LABELS[entry.feature]}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          by {TITLE_BY_AUTHOR[entry.deletedBy as Author]}
                        </span>
                      </div>
                      <p className="mt-1.5 truncate text-sm font-medium">
                        {entry.label || entry.id}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        deleted {formatRelative(entry.deletedAt, tick)} · expires{" "}
                        {formatRelative(
                          expiresAt(entry.deletedAt, retentionDays),
                          tick,
                        )
                          .replace("ago", "")
                          .trim()}{" "}
                        from now
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-end gap-1.5">
                    {isConfirmingDelete ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void vibrate(20, "light");
                            setConfirmingDelete(null);
                          }}
                          disabled={isBusy}
                          className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(entry)}
                          disabled={isBusy}
                          className="flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                          Delete forever
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            void vibrate(50, "medium");
                            setConfirmingDelete(key);
                          }}
                          className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
                        >
                          <Trash2 className="h-3 w-3" />
                          Forget
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRestore(entry)}
                          disabled={isBusy}
                          className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 disabled:opacity-60"
                        >
                          {isBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                          Restore
                        </button>
                      </>
                    )}
                  </div>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      {visibleEntries && visibleEntries.length > 0 && (
        <div className="mt-6 flex items-center justify-end">
          {confirmingPurge ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  void vibrate(20, "light");
                  setConfirmingPurge(false);
                }}
                disabled={busyKey === "__purge__"}
                className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePurge()}
                disabled={busyKey === "__purge__"}
                className="flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
              >
                {busyKey === "__purge__" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                Confirm purge
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                void vibrate(50, "medium");
                setConfirmingPurge(true);
              }}
              className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
            >
              <Trash2 className="h-3 w-3" />
              {filter === "all" ? "Purge entire trash" : `Purge ${filter} trash`}
            </button>
          )}
        </div>
      )}
    </main>
  );
}

function RetentionDial({
  days,
  bounds,
  onSaved,
}: {
  days: number;
  bounds: { min: number; max: number };
  onSaved: (days: number) => void;
}) {
  const [draft, setDraft] = useState<string>(String(days));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Keep the draft in sync with external updates (initial fetch).
  useEffect(() => {
    setDraft(String(days));
  }, [days]);

  const dirty = draft.trim() !== String(days);

  const handleSave = async () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < bounds.min || n > bounds.max) {
      setErr(`Must be ${bounds.min}-${bounds.max}.`);
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await setTrashRetention(Math.floor(n));
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    if (typeof result.days === "number") {
      onSaved(result.days);
      setMsg("Saved. Existing entries keep their original TTL.");
    }
  };

  return (
    <section className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Retention (days)
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={draft}
            min={bounds.min}
            max={bounds.max}
            onChange={(e) => setDraft(e.target.value)}
            className="w-24 rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !dirty}
          className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Save
        </button>
        <span className="text-[10px] text-muted-foreground/70">
          Range {bounds.min}-{bounds.max}. New TTL applies only to records
          deleted from now on.
        </span>
      </div>
      {msg && <p className="mt-2 text-[10px] text-emerald-400">{msg}</p>}
      {err && <p className="mt-2 text-[10px] text-destructive">{err}</p>}
    </section>
  );
}
