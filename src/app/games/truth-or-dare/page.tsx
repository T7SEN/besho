"use client";

// src/app/games/truth-or-dare/page.tsx
//
// Truth or Dare game page. Client component owning bundle state. Both
// authors see both directions of active play; either can issue when
// their outgoing slot is empty. Sir-only per-item delete on terminal-
// state history rows; restraint blocks Kitten from issuing + withdrawing.

import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  HelpCircle,
  Loader2,
  MessageCircleQuestion,
  Send,
  Sparkles,
  Trash2,
  Undo2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  DEFAULT_TOD_STATS,
  MAX_PROMPT_LEN,
  MAX_REFUSE_REASON_LEN,
  MAX_RESPONSE_LEN,
  STATUS_LABELS,
  TOD_HISTORY_PAGE_SIZE,
  TOD_STAT_KEYS,
  TOD_STAT_LABELS,
  type ChallengeStatus,
  type ChallengeType,
  type TodChallenge,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";
import {
  deleteChallenge,
  getChallengeHistory,
  getTodBundle,
  issueChallenge,
  pickPrompt,
  refuseChallenge,
  safewordChallenge,
  submitResponse,
  withdrawChallenge,
  type TodBundle,
} from "@/app/actions/games/truth-or-dare";
import { Button } from "@/components/ui/button";

// ── Status chip styles (mirrors directive admin page) ───────────────────

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

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function TruthOrDarePage() {
  const [bundle, setBundle] = useState<TodBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getTodBundle();
    setTimeout(() => {
      setBundle(next);
      setLoading(false);
      setHistoryOffset(0);
    }, 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRefreshListener(refresh);

  // 1Hz tick — drives the countdown chip on active cards.
  useEffect(() => {
    if (!bundle?.incoming && !bundle?.outgoing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [bundle?.incoming, bundle?.outgoing]);

  const me = bundle?.me ?? null;
  const partner: Author | null =
    me === "T7SEN" ? "Besho" : me === "Besho" ? "T7SEN" : null;

  const handleLoadMoreHistory = async () => {
    if (!bundle || historyLoading) return;
    const nextOffset = bundle.history.length;
    if (nextOffset >= bundle.historyTotal) return;
    setHistoryLoading(true);
    const more = await getChallengeHistory(TOD_HISTORY_PAGE_SIZE, nextOffset);
    if (more.records.length > 0) {
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              history: [...prev.history, ...more.records],
              historyTotal: more.total,
            }
          : prev,
      );
      setHistoryOffset(nextOffset + more.records.length);
    }
    setHistoryLoading(false);
  };

  const handleDeleteHistory = async (id: string) => {
    const r = await deleteChallenge(id);
    if (r.success) {
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              history: prev.history.filter((c) => c.id !== id),
              historyTotal: Math.max(0, prev.historyTotal - 1),
            }
          : prev,
      );
    }
    return r;
  };

  if (loading || !bundle || !me || !partner) {
    return (
      <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
        <PageHeader />
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <PageHeader />

      {/* Active section */}
      <section className="space-y-4">
        <AnimatePresence mode="wait" initial={false}>
          {bundle.incoming && (
            <IncomingCard
              key={`in-${bundle.incoming.id}`}
              challenge={bundle.incoming}
              me={me}
              now={now}
              onAction={refresh}
            />
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          {bundle.outgoing && (
            <OutgoingCard
              key={`out-${bundle.outgoing.id}`}
              challenge={bundle.outgoing}
              me={me}
              now={now}
              onAction={refresh}
            />
          )}
        </AnimatePresence>
      </section>

      {/* Issue form — disabled when an outgoing already exists */}
      <section className="mt-6">
        <IssueForm
          disabled={!!bundle.outgoing}
          partner={partner}
          onSuccess={refresh}
        />
      </section>

      {/* History */}
      <section className="mt-10 space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            History
          </h2>
          {bundle.historyTotal > 0 && (
            <span className="text-[10px] font-semibold text-muted-foreground/60">
              {bundle.history.length} of {bundle.historyTotal}
            </span>
          )}
        </header>

        {bundle.history.length === 0 ? (
          <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
            No challenges yet.
          </p>
        ) : (
          <div className="space-y-2">
            {bundle.history.map((c) => (
              <HistoryRow
                key={c.id}
                challenge={c}
                me={me}
                now={now}
                onDelete={handleDeleteHistory}
              />
            ))}
            {bundle.history.length < bundle.historyTotal && (
              <button
                type="button"
                onClick={handleLoadMoreHistory}
                disabled={historyLoading || undefined}
                className={cn(
                  "w-full rounded-xl border border-white/10 bg-black/20 py-2.5 text-xs font-bold uppercase tracking-widest text-muted-foreground",
                  "transition-colors hover:border-white/20 hover:text-foreground active:scale-[0.99]",
                  "disabled:opacity-50",
                )}
              >
                {historyLoading ? (
                  <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Load more"
                )}
              </button>
            )}
            {/* Suppress unused-var lint on the offset state used only
                to trigger re-fetches transitively via load-more. */}
            <span className="sr-only">{historyOffset}</span>
          </div>
        )}
      </section>

      {/* Stats footer */}
      <section className="mt-10">
        <StatsStrip stats={bundle.stats} />
      </section>
    </main>
  );
}

// ── Header ───────────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <header className="mb-6">
      <Link
        href="/games"
        className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
        Games
      </Link>
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
          <MessageCircleQuestion className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Truth or Dare</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One round: a truth and a dare. They pick.
          </p>
        </div>
      </div>
    </header>
  );
}

// ── Incoming card (pending → picked → respond) ──────────────────────────

function IncomingCard({
  challenge,
  me,
  now,
  onAction,
}: {
  challenge: TodChallenge;
  me: Author;
  now: number;
  onAction: () => void;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRefuse, setConfirmRefuse] = useState(false);
  const [response, setResponse] = useState("");

  useEffect(() => {
    if (!confirmRefuse) return;
    const id = setTimeout(() => setConfirmRefuse(false), 5000);
    return () => clearTimeout(id);
  }, [confirmRefuse]);

  const remainingMs = challenge.expiresAt - now;
  const expiresIn = formatCountdown(remainingMs);

  const handlePick = async (pick: ChallengeType) => {
    if (busyAction) return;
    setBusyAction(`pick-${pick}`);
    setError(null);
    void vibrate(40, "medium");
    const r = await pickPrompt(challenge.id, pick);
    if (r.error) setError(r.error);
    else onAction();
    setBusyAction(null);
  };

  const handleRefuse = async () => {
    if (busyAction) return;
    if (!confirmRefuse) {
      setConfirmRefuse(true);
      void vibrate(40, "light");
      return;
    }
    setBusyAction("refuse");
    setError(null);
    void vibrate([60, 40, 60], "heavy");
    const r = await refuseChallenge(challenge.id);
    if (r.error) setError(r.error);
    else onAction();
    setBusyAction(null);
    setConfirmRefuse(false);
  };

  const handleSafeword = async () => {
    if (busyAction) return;
    setBusyAction("safeword");
    setError(null);
    void vibrate([80, 40, 80], "heavy");
    const r = await safewordChallenge(challenge.id);
    if (r.error) setError(r.error);
    else onAction();
    setBusyAction(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busyAction) return;
    const formData = new FormData(e.currentTarget);
    setBusyAction("submit");
    setError(null);
    void vibrate(60, "medium");
    const r = await submitResponse(challenge.id, formData);
    if (r.error) {
      setError(r.error);
    } else {
      void hideKeyboard();
      onAction();
    }
    setBusyAction(null);
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
          <MessageCircleQuestion className="h-4 w-4" />
        </div>
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
            <span className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">
              <Clock className="h-2.5 w-2.5" />
              {expiresIn}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            From {TITLE_BY_AUTHOR[challenge.issuer]}
          </p>
        </div>
      </div>

      {/* Pending — show both prompts and Pick / Refuse / Safeword */}
      {challenge.status === "pending" && (
        <div className="mt-4 space-y-4">
          <PromptCard
            kind="truth"
            text={challenge.truthPrompt}
            disabled={!!busyAction}
            onPick={() => handlePick("truth")}
            picking={busyAction === "pick-truth"}
          />
          <PromptCard
            kind="dare"
            text={challenge.darePrompt}
            disabled={!!busyAction}
            onPick={() => handlePick("dare")}
            picking={busyAction === "pick-dare"}
          />
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleRefuse}
              disabled={!!busyAction || undefined}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.95] disabled:opacity-50",
                confirmRefuse
                  ? "border-rose-500/60 bg-rose-500/20 text-rose-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
              )}
            >
              {busyAction === "refuse" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : confirmRefuse ? (
                "Confirm refuse"
              ) : (
                "Refuse"
              )}
            </button>
            <button
              type="button"
              onClick={handleSafeword}
              disabled={!!busyAction || undefined}
              className={cn(
                "rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5",
                "text-[10px] font-bold uppercase tracking-wider text-purple-300",
                "transition-colors hover:bg-purple-500/20 active:scale-[0.95] disabled:opacity-50",
              )}
            >
              {busyAction === "safeword" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                "Safeword"
              )}
            </button>
            <span className="text-[10px] text-muted-foreground/60">
              Refuse counts. Safeword is free.
            </span>
          </div>
        </div>
      )}

      {/* Picked — show the picked prompt and the response form */}
      {challenge.status === "picked" && challenge.pick && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-4">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-400">
              {challenge.pick === "truth" ? (
                <HelpCircle className="h-3 w-3" />
              ) : (
                <Zap className="h-3 w-3" />
              )}
              {challenge.pick}
            </div>
            <p
              dir="auto"
              className="text-sm leading-relaxed text-foreground"
            >
              {challenge.pick === "truth"
                ? challenge.truthPrompt
                : challenge.darePrompt}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <textarea
              dir="auto"
              name="response"
              required
              value={response}
              onChange={(e) => setResponse(e.target.value)}
              maxLength={MAX_RESPONSE_LEN}
              rows={4}
              placeholder={
                challenge.pick === "truth"
                  ? "Answer the truth honestly…"
                  : "Confirm completion. Add detail if you want…"
              }
              disabled={!!busyAction || undefined}
              className={cn(
                "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "placeholder:text-muted-foreground/40 outline-none",
                "focus:border-blue-500/40 transition-colors",
              )}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                disabled={!!busyAction || !response.trim() || undefined}
                className="rounded-full"
              >
                {busyAction === "submit" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Send className="mr-1.5 h-3.5 w-3.5" />
                    Submit answer
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={handleRefuse}
                disabled={!!busyAction || undefined}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.95] disabled:opacity-50",
                  confirmRefuse
                    ? "border-rose-500/60 bg-rose-500/20 text-rose-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
                )}
              >
                {busyAction === "refuse" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : confirmRefuse ? (
                  "Confirm refuse"
                ) : (
                  "Refuse"
                )}
              </button>
              <button
                type="button"
                onClick={handleSafeword}
                disabled={!!busyAction || undefined}
                className={cn(
                  "rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5",
                  "text-[10px] font-bold uppercase tracking-wider text-purple-300",
                  "transition-colors hover:bg-purple-500/20 active:scale-[0.95] disabled:opacity-50",
                )}
              >
                {busyAction === "safeword" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Safeword"
                )}
              </button>
              <span className="text-[10px] text-muted-foreground/60">
                {response.length}/{MAX_RESPONSE_LEN}
              </span>
            </div>
          </form>
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs font-medium text-destructive">{error}</p>
      )}
      <span className="sr-only">{me}</span>
    </motion.section>
  );
}

function PromptCard({
  kind,
  text,
  disabled,
  onPick,
  picking,
}: {
  kind: ChallengeType;
  text: string;
  disabled: boolean;
  onPick: () => void;
  picking: boolean;
}) {
  const Icon = kind === "truth" ? HelpCircle : Zap;
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled || undefined}
      className={cn(
        "group w-full rounded-xl border border-white/10 bg-black/20 p-4 text-left",
        "transition-colors hover:border-amber-500/40 active:scale-[0.98] disabled:opacity-50",
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">
        <Icon className="h-3 w-3" />
        Pick {kind}
        {picking && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-amber-400" />
        )}
      </div>
      <p
        dir="auto"
        className="text-sm leading-relaxed text-foreground"
      >
        {text}
      </p>
    </button>
  );
}

// ── Outgoing card (your own pending/picked) ─────────────────────────────

function OutgoingCard({
  challenge,
  me,
  now,
  onAction,
}: {
  challenge: TodChallenge;
  me: Author;
  now: number;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!confirmWithdraw) return;
    const id = setTimeout(() => setConfirmWithdraw(false), 5000);
    return () => clearTimeout(id);
  }, [confirmWithdraw]);

  const remainingMs = challenge.expiresAt - now;

  const handleWithdraw = async () => {
    if (busy) return;
    if (!confirmWithdraw) {
      setConfirmWithdraw(true);
      void vibrate(40, "light");
      return;
    }
    setBusy(true);
    setError(null);
    void vibrate([60, 40, 60], "heavy");
    const r = await withdrawChallenge(challenge.id, reason);
    if (r.error) setError(r.error);
    else {
      onAction();
      setReason("");
    }
    setBusy(false);
    setConfirmWithdraw(false);
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl border border-blue-500/30 bg-blue-500/5 p-5"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
          <Sparkles className="h-4 w-4" />
        </div>
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
            <span className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-400">
              <Clock className="h-2.5 w-2.5" />
              {formatCountdown(remainingMs)}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Waiting on {TITLE_BY_AUTHOR[challenge.recipient]}
            {challenge.pick && ` · they picked ${challenge.pick}`}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <HelpCircle className="h-3 w-3" />
            Truth
          </div>
          <p
            dir="auto"
            className="text-sm leading-relaxed text-foreground/90"
          >
            {challenge.truthPrompt}
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
            <Zap className="h-3 w-3" />
            Dare
          </div>
          <p
            dir="auto"
            className="text-sm leading-relaxed text-foreground/90"
          >
            {challenge.darePrompt}
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {confirmWithdraw && (
          <input
            dir="auto"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MAX_REFUSE_REASON_LEN}
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
          onClick={handleWithdraw}
          disabled={busy || undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-[0.95] disabled:opacity-50",
            confirmWithdraw
              ? "border-rose-500/60 bg-rose-500/20 text-rose-300"
              : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20",
          )}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <Undo2 className="h-3 w-3" />
              {confirmWithdraw ? "Confirm withdraw" : "Withdraw"}
            </>
          )}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-xs font-medium text-destructive">{error}</p>
      )}
      <span className="sr-only">{me}</span>
    </motion.section>
  );
}

// ── Issue form ───────────────────────────────────────────────────────────

function IssueForm({
  disabled,
  partner,
  onSuccess,
}: {
  disabled: boolean;
  partner: Author;
  onSuccess: () => void;
}) {
  const [state, action, isPending] = useActionState(issueChallenge, null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (!state?.success) return;
    setTimeout(() => {
      formRef.current?.reset();
      void vibrate(60, "medium");
      void hideKeyboard();
      onSuccess();
    }, 0);
  }, [state, onSuccess]);

  if (disabled) {
    return (
      <div className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/60">
        You already have a challenge in flight. Withdraw it to issue a new one.
      </div>
    );
  }

  return (
    <form
      ref={formRef}
      action={action}
      className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-md shadow-xl shadow-black/30"
    >
      <header className="space-y-1">
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          Issue a challenge
        </h2>
        <p className="text-[11px] text-muted-foreground/60">
          Write one truth and one dare. {TITLE_BY_AUTHOR[partner]} picks which.
        </p>
      </header>

      <div>
        <label
          htmlFor="tod-truth"
          className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60"
        >
          <HelpCircle className="h-3 w-3" />
          Truth prompt *
        </label>
        <textarea
          dir="auto"
          id="tod-truth"
          name="truthPrompt"
          required
          rows={2}
          maxLength={MAX_PROMPT_LEN}
          placeholder="Ask them something honest…"
          disabled={isPending || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-amber-500/40 transition-colors",
          )}
        />
      </div>

      <div>
        <label
          htmlFor="tod-dare"
          className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60"
        >
          <Zap className="h-3 w-3" />
          Dare prompt *
        </label>
        <textarea
          dir="auto"
          id="tod-dare"
          name="darePrompt"
          required
          rows={2}
          maxLength={MAX_PROMPT_LEN}
          placeholder="Dare them to do something…"
          disabled={isPending || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-amber-500/40 transition-colors",
          )}
        />
      </div>

      {state?.error && (
        <p className="text-xs font-medium text-destructive">{state.error}</p>
      )}

      <Button
        type="submit"
        disabled={isPending || undefined}
        className="w-full rounded-full"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <Send className="mr-1.5 h-3.5 w-3.5" />
            Issue
          </>
        )}
      </Button>
    </form>
  );
}

// ── History row ──────────────────────────────────────────────────────────

function HistoryRow({
  challenge,
  me,
  now,
  onDelete,
}: {
  challenge: TodChallenge;
  me: Author;
  now: number;
  onDelete: (id: string) => Promise<{ success?: boolean; error?: string }>;
}) {
  const [busy, setBusy] = useState(false);
  const canDelete = me === "T7SEN";
  const directionLabel = `${TITLE_BY_AUTHOR[challenge.issuer]} → ${TITLE_BY_AUTHOR[challenge.recipient]}`;

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    void vibrate(50, "heavy");
    await onDelete(challenge.id);
    // Setting busy stays true if the delete succeeded — the row is
    // about to unmount via parent state. If it failed, reset so the
    // user can retry.
    setBusy(false);
  };

  const closedTs = challenge.closedAt ?? challenge.respondedAt ?? challenge.pickedAt ?? challenge.createdAt;

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
              {directionLabel}
            </span>
            <span className="text-[10px] font-semibold text-muted-foreground/40">
              · {formatRelative(closedTs, now)}
            </span>
          </div>

          {/* Show prompts. If picked, only the picked one matters; if
              terminal pre-pick (refused/safeworded/expired/withdrawn/
              cancelled), show both since neither was selected. */}
          {challenge.pick === "truth" && (
            <div className="mt-2 rounded-lg border border-white/5 bg-black/20 p-3">
              <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
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
          )}
          {challenge.pick === "dare" && (
            <div className="mt-2 rounded-lg border border-white/5 bg-black/20 p-3">
              <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
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
          )}
          {!challenge.pick && (
            <div className="mt-2 space-y-1.5">
              <p
                dir="auto"
                className="text-xs leading-relaxed text-foreground/80"
              >
                <span className="font-bold uppercase tracking-wider text-muted-foreground/60">
                  Truth ·{" "}
                </span>
                {challenge.truthPrompt}
              </p>
              <p
                dir="auto"
                className="text-xs leading-relaxed text-foreground/80"
              >
                <span className="font-bold uppercase tracking-wider text-muted-foreground/60">
                  Dare ·{" "}
                </span>
                {challenge.darePrompt}
              </p>
            </div>
          )}

          {challenge.response && (
            <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-emerald-400">
                <CheckCircle2 className="h-2.5 w-2.5" />
                Answer
              </div>
              <p
                dir="auto"
                className="text-xs leading-relaxed text-foreground/90"
              >
                {challenge.response}
              </p>
            </div>
          )}

          {challenge.refuseReason && (
            <p
              dir="auto"
              className="mt-2 text-[11px] italic text-rose-400/80"
            >
              Refused: {challenge.refuseReason}
            </p>
          )}
          {challenge.withdrawReason && (
            <p
              dir="auto"
              className="mt-2 text-[11px] italic text-muted-foreground/70"
            >
              Withdrawn: {challenge.withdrawReason}
            </p>
          )}
          {challenge.cancellationReason && (
            <p
              dir="auto"
              className="mt-2 text-[11px] italic text-muted-foreground/70"
            >
              Cancelled: {challenge.cancellationReason}
            </p>
          )}
        </div>

        {canDelete && (
          <button
            type="button"
            onClick={handleDelete}
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

// ── Stats strip ──────────────────────────────────────────────────────────

function StatsStrip({
  stats,
}: {
  stats: { T7SEN: TodStats; Besho: TodStats };
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
      <h2 className="mb-4 text-sm font-bold uppercase tracking-widest text-muted-foreground">
        Stats
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <StatsColumn author="T7SEN" stats={stats.T7SEN ?? DEFAULT_TOD_STATS} />
        <StatsColumn author="Besho" stats={stats.Besho ?? DEFAULT_TOD_STATS} />
      </div>
    </div>
  );
}

function StatsColumn({
  author,
  stats,
}: {
  author: Author;
  stats: TodStats;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-foreground/80">
        {TITLE_BY_AUTHOR[author]}
      </h3>
      <dl className="grid grid-cols-2 gap-2">
        {TOD_STAT_KEYS.map((key) => (
          <div
            key={key}
            className="rounded-lg border border-white/5 bg-black/20 px-3 py-2"
          >
            <dt className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
              {TOD_STAT_LABELS[key]}
            </dt>
            <dd className="text-base font-bold tabular-nums text-foreground">
              {stats[key] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
