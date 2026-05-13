"use client";

// src/app/admin/games/truth-or-dare/page.tsx
//
// Sir-only admin for Truth or Dare. Tabs: Active / History / Stats.
// All actions go through `@/app/actions/admin/games` (Sir-only enforced
// server-side via requireSir). Weight tuning lives at /admin/rewards;
// this page surfaces a link in the header rather than duplicating.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  HelpCircle,
  Loader2,
  MessageCircleQuestion,
  RotateCcw,
  Save,
  Sliders,
  Trash2,
  Undo2,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  DEFAULT_TOD_STATS,
  MAX_CANCEL_REASON_LEN,
  MAX_TOD_STAT_VALUE,
  STATUS_LABELS,
  TOD_STAT_KEYS,
  TOD_STAT_LABELS,
  type ChallengeStatus,
  type TodChallenge,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";
import {
  adjustTodStat,
  cancelAllActiveTodChallenges,
  forceCancelTodChallenge,
  getTodAdminBundle,
  purgeAllTodChallenges,
  resetTodStats,
  type TodAdminBundle,
} from "@/app/actions/admin";
import { deleteChallenge } from "@/app/actions/games/truth-or-dare";
import { Button } from "@/components/ui/button";
import { PurgeButton } from "@/components/admin/purge-button";

const STATUS_CHIP: Record<ChallengeStatus, string> = {
  pending: "bg-amber-500/15 text-amber-400",
  picked: "bg-blue-500/15 text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  refused: "bg-rose-500/15 text-rose-400",
  safeworded: "bg-purple-500/15 text-purple-400",
  expired: "bg-destructive/15 text-destructive",
  withdrawn: "bg-muted/30 text-muted-foreground",
  cancelled: "bg-muted/30 text-muted-foreground",
};

type Tab = "active" | "history" | "stats";

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function AdminTruthOrDarePage() {
  const [bundle, setBundle] = useState<TodAdminBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("active");
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const r = await getTodAdminBundle();
    setTimeout(() => {
      if (r.bundle) setBundle(r.bundle);
      setLoading(false);
      setNow(Date.now());
    }, 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRefreshListener(refresh);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (loading || !bundle) {
    return (
      <main className="mx-auto max-w-4xl p-4 pb-28 md:p-12 md:pb-32">
        <PageHeader />
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  const activeCount =
    (bundle.active.sirOutgoing ? 1 : 0) +
    (bundle.active.kittenOutgoing ? 1 : 0);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-28 md:p-12 md:pb-32">
      <PageHeader />

      {/* Tab strip */}
      <nav
        role="tablist"
        aria-label="Truth or Dare admin sections"
        className="mb-6 flex flex-wrap gap-2 rounded-full border border-white/5 bg-card/40 p-1"
      >
        <TabButton tab="active" current={tab} onSelect={setTab}>
          Active
          {activeCount > 0 && (
            <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
              {activeCount}
            </span>
          )}
        </TabButton>
        <TabButton tab="history" current={tab} onSelect={setTab}>
          History
          <span className="ml-1.5 text-[10px] font-bold text-muted-foreground/60">
            {bundle.historyTotal}
          </span>
        </TabButton>
        <TabButton tab="stats" current={tab} onSelect={setTab}>
          Stats
        </TabButton>
      </nav>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {tab === "active" && (
            <ActiveTab bundle={bundle} now={now} onAction={refresh} />
          )}
          {tab === "history" && (
            <HistoryTab bundle={bundle} now={now} onAction={refresh} />
          )}
          {tab === "stats" && (
            <StatsTab bundle={bundle} onAction={refresh} />
          )}
        </motion.div>
      </AnimatePresence>
    </main>
  );
}

function PageHeader() {
  return (
    <header className="mb-6">
      <Link
        href="/admin/games"
        className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
        Games admin
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <MessageCircleQuestion className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Truth or Dare admin
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Force-cancel, stat edits, history purge.
            </p>
          </div>
        </div>
        <Link
          href="/admin/rewards"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-card px-3 py-2",
            "text-[11px] font-bold uppercase tracking-wider text-muted-foreground",
            "transition-colors hover:border-primary/40 hover:text-foreground active:scale-[0.97]",
          )}
        >
          <Sliders className="h-3 w-3" />
          Weights
        </Link>
      </div>
    </header>
  );
}

function TabButton({
  tab,
  current,
  onSelect,
  children,
}: {
  tab: Tab;
  current: Tab;
  onSelect: (t: Tab) => void;
  children: React.ReactNode;
}) {
  const active = tab === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => {
        void vibrate(20, "light");
        onSelect(tab);
      }}
      className={cn(
        "inline-flex items-center rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest transition-colors",
        "active:scale-[0.97]",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ── Active tab ───────────────────────────────────────────────────────────

function ActiveTab({
  bundle,
  now,
  onAction,
}: {
  bundle: TodAdminBundle;
  now: number;
  onAction: () => void;
}) {
  const slots: Array<{ key: string; label: string; record: TodChallenge | null }> =
    [
      {
        key: "sir",
        label: `${TITLE_BY_AUTHOR.T7SEN}'s outgoing`,
        record: bundle.active.sirOutgoing,
      },
      {
        key: "kitten",
        label: `${TITLE_BY_AUTHOR.Besho}'s outgoing`,
        record: bundle.active.kittenOutgoing,
      },
    ];

  const activeCount = slots.filter((s) => s.record).length;

  return (
    <section className="space-y-4">
      {activeCount > 1 && (
        <div className="flex justify-end">
          <MassCancelButton onAction={onAction} />
        </div>
      )}

      {slots.map((slot) => (
        <div key={slot.key} className="space-y-2">
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70">
            {slot.label}
          </h3>
          {slot.record ? (
            <ActiveRecordCard
              challenge={slot.record}
              now={now}
              onAction={onAction}
            />
          ) : (
            <p className="rounded-2xl border border-white/5 bg-card/20 p-4 text-center text-xs text-muted-foreground/50">
              No active challenge.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function MassCancelButton({ onAction }: { onAction: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleClick = async () => {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      void vibrate(50, "medium");
      return;
    }
    setBusy(true);
    void vibrate([80, 40, 80], "heavy");
    const r = await cancelAllActiveTodChallenges();
    if (r.error) setError(r.error);
    else onAction();
    setBusy(false);
    setConfirming(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.95] disabled:opacity-50",
          confirming
            ? "border-destructive bg-destructive text-white"
            : "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20",
        )}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <>
            <X className="h-3 w-3" />
            {confirming ? "Confirm cancel all" : "Cancel all active"}
          </>
        )}
      </button>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

function ActiveRecordCard({
  challenge,
  now,
  onAction,
}: {
  challenge: TodChallenge;
  now: number;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), 6000);
    return () => clearTimeout(id);
  }, [confirming]);

  const remainingSec = Math.max(
    0,
    Math.ceil((challenge.expiresAt - now) / 1000),
  );

  const handleCancel = async () => {
    if (busy) return;
    if (!confirming) {
      setConfirming(true);
      void vibrate(50, "medium");
      return;
    }
    setBusy(true);
    void vibrate([80, 40, 80], "heavy");
    const r = await forceCancelTodChallenge(challenge.id, reason);
    if (r.error) setError(r.error);
    else {
      onAction();
      setReason("");
    }
    setBusy(false);
    setConfirming(false);
  };

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
            STATUS_CHIP[challenge.status],
          )}
        >
          {STATUS_LABELS[challenge.status]}
        </span>
        {challenge.pick && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
            {challenge.pick}
          </span>
        )}
        <span className="text-[10px] font-semibold text-muted-foreground/60">
          {TITLE_BY_AUTHOR[challenge.issuer]} → {TITLE_BY_AUTHOR[challenge.recipient]}
        </span>
        <span className="text-[10px] font-semibold text-muted-foreground/60">
          · expires in {Math.floor(remainingSec / 60)}m {remainingSec % 60}s
        </span>
      </div>

      <div className="mt-3 grid gap-2">
        <div className="rounded-lg border border-white/5 bg-black/20 p-3">
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <HelpCircle className="h-2.5 w-2.5" />
            Truth
          </div>
          <p
            dir="auto"
            className="text-xs leading-relaxed text-foreground/90"
          >
            {challenge.truthPrompt}
          </p>
        </div>
        <div className="rounded-lg border border-white/5 bg-black/20 p-3">
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <Zap className="h-2.5 w-2.5" />
            Dare
          </div>
          <p
            dir="auto"
            className="text-xs leading-relaxed text-foreground/90"
          >
            {challenge.darePrompt}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming && (
          <input
            dir="auto"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MAX_CANCEL_REASON_LEN}
            placeholder="Optional reason…"
            disabled={busy || undefined}
            className={cn(
              "flex-1 min-w-35 rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-xs",
              "placeholder:text-muted-foreground/40 outline-none focus:border-rose-500/40",
            )}
          />
        )}
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy || undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.95] disabled:opacity-50",
            confirming
              ? "border-destructive bg-destructive text-white"
              : "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20",
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <X className="h-3 w-3" />
              {confirming ? "Confirm force-cancel" : "Force-cancel"}
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="mt-2 text-[11px] font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ── History tab ──────────────────────────────────────────────────────────

function HistoryTab({
  bundle,
  now,
  onAction,
}: {
  bundle: TodAdminBundle;
  now: number;
  onAction: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    void vibrate(50, "heavy");
    const r = await deleteChallenge(id);
    if (r.success) onAction();
    setBusyId(null);
  };

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70">
          All challenges · {bundle.history.length} loaded of {bundle.historyTotal}
        </h3>
        {bundle.historyTotal > 0 && (
          <PurgeButton
            label="Purge all challenges"
            onPurge={async () => {
              const r = await purgeAllTodChallenges();
              if (r.success) onAction();
              return r;
            }}
          />
        )}
      </header>

      {bundle.history.length === 0 ? (
        <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
          No challenges yet.
        </p>
      ) : (
        <div className="space-y-2">
          {bundle.history.map((c) => (
            <AdminHistoryRow
              key={c.id}
              challenge={c}
              now={now}
              busy={busyId === c.id}
              onDelete={() => handleDelete(c.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AdminHistoryRow({
  challenge,
  now,
  busy,
  onDelete,
}: {
  challenge: TodChallenge;
  now: number;
  busy: boolean;
  onDelete: () => void;
}) {
  const ts =
    challenge.closedAt ?? challenge.respondedAt ?? challenge.pickedAt ?? challenge.createdAt;
  const isTerminal =
    challenge.status !== "pending" && challenge.status !== "picked";
  return (
    <div className="group rounded-2xl border border-white/5 bg-card/20 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                STATUS_CHIP[challenge.status],
              )}
            >
              {STATUS_LABELS[challenge.status]}
            </span>
            {challenge.pick && (
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                {challenge.pick}
              </span>
            )}
            <span className="text-[10px] font-semibold text-muted-foreground/40">
              {TITLE_BY_AUTHOR[challenge.issuer]} → {TITLE_BY_AUTHOR[challenge.recipient]}
            </span>
            <span className="text-[10px] font-semibold text-muted-foreground/40">
              · {formatRelative(ts, now)}
            </span>
          </div>
          <p
            dir="auto"
            className="mt-1 line-clamp-2 text-xs text-foreground/80"
          >
            <span className="font-bold uppercase tracking-wider text-muted-foreground/60">
              T:{" "}
            </span>
            {challenge.truthPrompt}
            <span className="ml-2 font-bold uppercase tracking-wider text-muted-foreground/60">
              D:{" "}
            </span>
            {challenge.darePrompt}
          </p>
          {challenge.response && (
            <p
              dir="auto"
              className="mt-1 line-clamp-2 text-[11px] text-emerald-400/90"
            >
              ↩ {challenge.response}
            </p>
          )}
          {challenge.refuseReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-rose-400/80"
            >
              Refused: {challenge.refuseReason}
            </p>
          )}
          {challenge.cancellationReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-muted-foreground/70"
            >
              Cancelled: {challenge.cancellationReason}
            </p>
          )}
          {challenge.withdrawReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-muted-foreground/70"
            >
              Withdrawn: {challenge.withdrawReason}
            </p>
          )}
        </div>

        {isTerminal && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || undefined}
            aria-label="Delete challenge"
            className={cn(
              "shrink-0 rounded-full p-2 text-muted-foreground/40 transition-all",
              "hover:bg-destructive/10 hover:text-destructive active:scale-95",
              "md:opacity-0 md:group-hover:opacity-100",
              "disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Stats tab ────────────────────────────────────────────────────────────

function StatsTab({
  bundle,
  onAction,
}: {
  bundle: TodAdminBundle;
  onAction: () => void;
}) {
  return (
    <section className="space-y-6">
      <p className="text-xs text-muted-foreground/70">
        Edit per-author counters. Each value is set directly — to wipe a
        column use Reset.
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
    </section>
  );
}

function StatsEditor({
  author,
  stats,
  onAction,
}: {
  author: Author;
  stats: TodStats;
  onAction: () => void;
}) {
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
              onClick={() => setDraft((prev) => ({ ...prev, [key]: stats[key] }))}
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
