"use client";

// src/app/admin/directive/page.tsx
//
// Sir-only issuance UI for the real-time directive overlay. The
// /admin layout redirects non-Sir; the actions also call requireSir-
// equivalent role checks server-side. Page state:
//   - Issue form (title + body + duration preset chips)
//   - Active directive card (cancel button) — single slot
//   - Recent history (last 50)

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, Clock, Loader2, Target, Trash2 } from "lucide-react";
import {
  cancelDirective,
  deleteDirective,
  getActiveDirective,
  getDirectiveHistory,
  issueDirective,
  purgeAllDirectives,
  type Directive,
} from "@/app/actions/directive";
import {
  DEFAULT_DIRECTIVE_DURATION_SEC,
  MAX_DIRECTIVE_BODY_LEN,
  MAX_DIRECTIVE_TITLE_LEN,
} from "@/lib/directive-constants";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { PurgeButton } from "@/components/admin/purge-button";

const DURATION_PRESETS = [
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "15 min", seconds: 900 },
  { label: "30 min", seconds: 1800 },
  { label: "60 min", seconds: 3600 },
  { label: "Open-ended", seconds: 0 },
] as const;

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatAbsolute(ts: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

const STATE_STYLES: Record<
  Directive["state"],
  { label: string; chip: string }
> = {
  issued: {
    label: "Pending acknowledgement",
    chip: "bg-amber-500/15 text-amber-400",
  },
  acknowledged: {
    label: "Acknowledged",
    chip: "bg-blue-500/15 text-blue-400",
  },
  completed: {
    label: "Completed",
    chip: "bg-emerald-500/15 text-emerald-400",
  },
  expired: {
    label: "Expired",
    chip: "bg-destructive/15 text-destructive",
  },
  cancelled: {
    label: "Cancelled",
    chip: "bg-muted/30 text-muted-foreground",
  },
};

export default function AdminDirectivePage() {
  const [active, setActive] = useState<Directive | null>(null);
  const [history, setHistory] = useState<Directive[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [duration, setDuration] = useState<number>(
    DEFAULT_DIRECTIVE_DURATION_SEC,
  );
  const [state, action, isPending] = useActionState(issueDirective, null);
  const formRef = useRef<HTMLFormElement & { reset: () => void }>(null);

  const refresh = useCallback(async () => {
    const [a, h] = await Promise.all([
      getActiveDirective("Besho"),
      getDirectiveHistory(50),
    ]);
    setTimeout(() => {
      setActive(a);
      setHistory(h);
    }, 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRefreshListener(refresh);

  // 1Hz tick for the "remaining" countdown on the active card.
  useEffect(() => {
    if (!active?.expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Form-success effect: clear the form, dismiss keyboard, refresh.
  useEffect(() => {
    if (!state?.success) return;
    setTimeout(() => {
      formRef.current?.reset();
      void vibrate(60, "medium");
      void hideKeyboard();
      void refresh();
    }, 0);
  }, [state, refresh]);

  const handleCancel = async () => {
    if (!active) return;
    if (busy) return;
    setBusy(true);
    void vibrate(60, "medium");
    const result = await cancelDirective(active.id);
    if (result.success) {
      void refresh();
    }
    setBusy(false);
  };

  const handleDelete = async (id: string) => {
    if (busyRowId) return;
    setBusyRowId(id);
    void vibrate(50, "heavy");
    const result = await deleteDirective(id);
    if (result.success) {
      setHistory((prev) => prev.filter((d) => d.id !== id));
    }
    setBusyRowId(null);
  };

  const remainingSec =
    active?.expiresAt && active.state !== "completed"
      ? Math.max(0, Math.ceil((active.expiresAt - now) / 1000))
      : null;

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6">
        <Link
          href="/admin"
          className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
          Admin
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">
          Real-time directive
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Short-lived command to {TITLE_BY_AUTHOR.Besho}. Single-slot —
          cancel an active directive before issuing a new one.
        </p>
      </header>

      {/* Active directive card */}
      <AnimatePresence mode="wait">
        {active && (
          <motion.section
            key={active.id}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
                <Target className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                      STATE_STYLES[active.state].chip,
                    )}
                  >
                    {STATE_STYLES[active.state].label}
                  </span>
                  {remainingSec !== null && (
                    <span className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400">
                      <Clock className="h-2.5 w-2.5" />
                      {Math.floor(remainingSec / 60)}:
                      {(remainingSec % 60).toString().padStart(2, "0")}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-sm font-bold text-foreground">
                  {active.title}
                </p>
                {active.body && (
                  <MarkdownRenderer
                    content={active.body}
                    className={cn(
                      "mt-1 text-sm leading-relaxed text-muted-foreground/90",
                      "prose-p:my-1 prose-p:last:mb-0",
                    )}
                  />
                )}
                <p className="mt-2 text-[10px] font-semibold text-muted-foreground/40">
                  Issued {formatAbsolute(active.issuedAt)}
                  {active.acknowledgedAt &&
                    ` · acknowledged ${formatAbsolute(active.acknowledgedAt)}`}
                </p>
              </div>

              <button
                onClick={handleCancel}
                disabled={busy || undefined}
                className={cn(
                  "shrink-0 rounded-full bg-destructive/10 px-3 py-1.5",
                  "text-[10px] font-bold uppercase tracking-wider text-destructive",
                  "transition-all hover:bg-destructive/20 active:scale-[0.95]",
                  "disabled:opacity-50",
                )}
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Cancel"
                )}
              </button>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Issue form */}
      {!active && (
        <form
          ref={formRef}
          action={action}
          className="mb-8 space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-md shadow-xl shadow-black/30"
        >
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Issue directive
          </h2>

          <div>
            <label
              htmlFor="directive-title"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
            >
              Title *
            </label>
            <input
              id="directive-title"
              name="title"
              type="text"
              required
              maxLength={MAX_DIRECTIVE_TITLE_LEN}
              placeholder="State the directive plainly…"
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "placeholder:text-muted-foreground/40 outline-none",
                "focus:border-amber-500/40 transition-colors",
              )}
            />
          </div>

          <div>
            <label
              htmlFor="directive-body"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
            >
              Body
            </label>
            <RichTextEditor
              id="directive-body"
              name="body"
              rows={3}
              placeholder="Optional context — what kitten should do, how to confirm…"
              disabled={isPending || undefined}
              maxLength={MAX_DIRECTIVE_BODY_LEN}
              className={cn(
                "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "placeholder:text-muted-foreground/40 outline-none",
                "focus:border-amber-500/40 transition-colors",
              )}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
              Duration
            </label>
            <div className="grid grid-cols-3 gap-2">
              {DURATION_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setDuration(preset.seconds)}
                  className={cn(
                    "rounded-xl border py-2 text-[11px] font-bold uppercase tracking-wider transition-all",
                    duration === preset.seconds
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                      : "border-white/10 bg-black/20 text-muted-foreground hover:border-white/20",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* `0` represents "open-ended" (no countdown). The action
                treats an empty/zero string as null durationSec and
                falls back to the 24h sentinel TTL. */}
            <input
              type="hidden"
              name="durationSec"
              value={duration > 0 ? String(duration) : ""}
            />
          </div>

          {state?.error && (
            <p className="text-xs font-medium text-destructive">
              {state.error}
            </p>
          )}

          <Button
            type="submit"
            disabled={isPending || undefined}
            className="w-full rounded-full"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Issue directive"
            )}
          </Button>
        </form>
      )}

      {/* History */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Recent directives
          </h2>
          {history.length > 0 && (
            <PurgeButton
              label="Purge all directives"
              onPurge={async () => {
                const r = await purgeAllDirectives();
                if (!r.error) {
                  setHistory([]);
                }
                return r;
              }}
            />
          )}
        </div>

        {history.length === 0 ? (
          <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
            No directives issued yet.
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((d) => (
              <div
                key={d.id}
                className="group rounded-2xl border border-white/5 bg-card/20 p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                          STATE_STYLES[d.state].chip,
                        )}
                      >
                        {STATE_STYLES[d.state].label}
                      </span>
                      {d.durationSec && (
                        <span className="text-[10px] font-semibold text-muted-foreground/40">
                          {Math.round(d.durationSec / 60)} min
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-bold text-foreground">
                      {d.title}
                    </p>
                    <p className="mt-1 text-[10px] font-semibold text-muted-foreground/40">
                      Issued {formatRelative(d.issuedAt, now)}
                      {d.completedAt &&
                        ` · completed ${formatRelative(d.completedAt, now)}`}
                    </p>
                  </div>

                  {/* Soft-delete only for terminal states (the action
                      refuses for active records). */}
                  {(d.state === "completed" ||
                    d.state === "expired" ||
                    d.state === "cancelled") && (
                    <button
                      onClick={() => handleDelete(d.id)}
                      disabled={busyRowId === d.id || undefined}
                      aria-label="Delete directive"
                      className={cn(
                        "shrink-0 rounded-full p-2 text-muted-foreground/40 transition-all",
                        "hover:bg-destructive/10 hover:text-destructive active:scale-95",
                        "md:opacity-0 md:group-hover:opacity-100",
                        "disabled:opacity-50",
                      )}
                    >
                      {busyRowId === d.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
