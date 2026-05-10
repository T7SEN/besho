"use client";

// src/components/directive/directive-dialog.tsx
//
// Full-screen overlay for the real-time directive feature. Mounts
// once in the root layout; self-gates on `getCurrentAuthor() === "Besho"`
// AND active-directive presence so it renders nothing for Sir, on
// /login, or when no directive is pending.
//
// State machine:
//   ISSUED         → forced-acknowledge (default open-question 2: blocks
//                    app interaction until tapped)
//   ACKNOWLEDGED   → countdown view with "Mark complete" button. App
//                    interaction is allowed; the overlay collapses to
//                    a non-modal "directive in progress" header strip.
//   COMPLETED      → brief confirm screen, auto-dismiss after 2s
//   (expired/      → dialog closes; no terminal UI surface — Sir sees
//    cancelled)      the outcome on /admin/directive instead.
//
// Trigger sources:
//   1. Cold-start / pull-to-refresh: `getActiveDirective("Besho")`
//   2. Foreground FCM with `data.kind === "directive"`: the
//      fcm-provider dispatches `ourspace:directive-arrived` and we
//      refetch immediately.

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Check, Loader2, Target, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import {
  acknowledgeDirective,
  completeDirective,
  getActiveDirective,
  type Directive,
} from "@/app/actions/directive";
import { getActivePunishment } from "@/app/actions/punishment";
import { getCurrentAuthor } from "@/app/actions/auth";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { DIRECTIVE_ARRIVED_EVENT } from "@/lib/directive-constants";
import { PUNISHMENT_CLEARED_EVENT } from "@/lib/punishment-constants";

const COMPLETED_DISMISS_MS = 2_000;
/** Routes where the dialog never renders — biometric gate / login
 *  flows. Mirrors the pattern in `<DeviceTracker>`. */
const UNGUARDED_PATHS = new Set<string>(["/login"]);

interface CountdownState {
  remainingMs: number;
  totalMs: number;
}

function computeCountdown(directive: Directive, now: number): CountdownState | null {
  if (!directive.expiresAt || !directive.durationSec) return null;
  const totalMs = directive.durationSec * 1000;
  const remainingMs = Math.max(0, directive.expiresAt - now);
  return { remainingMs, totalMs };
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function DirectiveDialog() {
  const pathname = usePathname();
  const [author, setAuthor] = useState<string | null>(null);
  const [directive, setDirective] = useState<Directive | null>(null);
  /** When true, the directive overlay is suppressed because a
   *  punishment timer is active. The directive record is still
   *  loaded into local state — the overlay will surface
   *  automatically once `<PunishmentOverlay>` dispatches
   *  PUNISHMENT_CLEARED_EVENT and we refetch the punishment-active
   *  flag. */
  const [punishmentActive, setPunishmentActive] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [completedShown, setCompletedShown] = useState(false);

  const refetch = useCallback(async () => {
    if (author !== "Besho") return;
    try {
      const [next, punishment] = await Promise.all([
        getActiveDirective("Besho"),
        getActivePunishment("Besho"),
      ]);
      setTimeout(() => {
        setDirective(next);
        setPunishmentActive(punishment !== null);
        setCompletedShown(false);
      }, 0);
    } catch {
      // Best-effort. Next refresh tick re-tries.
    }
  }, [author]);

  // Resolve the current author once. The pathname-keyed effect
  // re-resolves on navigation in case session state shifted.
  useEffect(() => {
    let cancelled = false;
    getCurrentAuthor().then((a) => {
      if (!cancelled) setAuthor(a);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Initial fetch + on-author-resolved fetch.
  useEffect(() => {
    if (author !== "Besho") {
      // Deferred setState — `setTimeout(..., 0)` per § 4 pattern.
      // Sync setState inside an effect trips
      // `react-hooks/set-state-in-effect`.
      setTimeout(() => setDirective(null), 0);
      return;
    }
    void refetch();
  }, [author, refetch]);

  // Refresh-listener — pull-to-refresh anywhere in the app re-checks.
  useRefreshListener(() => {
    void refetch();
  });

  // FCM foreground arrival → refetch immediately. The fcm-provider
  // dispatches `ourspace:directive-arrived` before navigating; we
  // re-read so the dialog opens without waiting for the next refresh.
  useEffect(() => {
    if (author !== "Besho") return;
    const handler = () => {
      void vibrate(80, "heavy");
      void refetch();
    };
    const win = globalThis as unknown as {
      addEventListener: (t: string, h: EventListener) => void;
      removeEventListener: (t: string, h: EventListener) => void;
    };
    win.addEventListener(DIRECTIVE_ARRIVED_EVENT, handler);
    return () => win.removeEventListener(DIRECTIVE_ARRIVED_EVENT, handler);
  }, [author, refetch]);

  // <PunishmentOverlay> dispatches PUNISHMENT_CLEARED_EVENT when its
  // active punishment transitions to a terminal state. Refetch so
  // any directive that arrived during the punishment can surface.
  useEffect(() => {
    if (author !== "Besho") return;
    const handler = () => {
      void refetch();
    };
    const win = globalThis as unknown as {
      addEventListener: (t: string, h: EventListener) => void;
      removeEventListener: (t: string, h: EventListener) => void;
    };
    win.addEventListener(PUNISHMENT_CLEARED_EVENT, handler);
    return () => win.removeEventListener(PUNISHMENT_CLEARED_EVENT, handler);
  }, [author, refetch]);

  // 1Hz tick for the countdown — only when an active directive with a
  // duration is in view. Stop the interval otherwise to avoid waking
  // the renderer needlessly.
  useEffect(() => {
    if (!directive) return;
    if (!directive.expiresAt) return;
    if (directive.state === "completed") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [directive]);

  // Auto-dismiss the COMPLETED confirmation after 2s. We keep the
  // record around for a beat so the success UI registers, then clear
  // local state and let the next refetch find no active directive.
  useEffect(() => {
    if (!directive) return;
    if (directive.state !== "completed") return;
    if (!completedShown) {
      // Deferred setState — see § 4 / coding-patterns.md. The
      // dismiss timeout itself fires after a 2s delay so it's safe;
      // it's only the immediate `setCompletedShown(true)` that
      // would trip the lint rule synchronously.
      const armId = setTimeout(() => setCompletedShown(true), 0);
      const dismissId = setTimeout(() => {
        setTimeout(() => setDirective(null), 0);
      }, COMPLETED_DISMISS_MS);
      return () => {
        clearTimeout(armId);
        clearTimeout(dismissId);
      };
    }
  }, [directive, completedShown]);

  // Local-side expiry watch. The cron is the authoritative expirer
  // (it emits the obedience event), but the UI shouldn't keep
  // showing the overlay past `expiresAt`. Refetch once at the
  // boundary so the cron / state catches up; if it hasn't, hide the
  // overlay locally so kitten can keep using the app.
  useEffect(() => {
    if (!directive?.expiresAt) return;
    if (directive.state === "completed") return;
    const remaining = directive.expiresAt - now;
    if (remaining <= 0) {
      setTimeout(() => {
        void refetch();
        setDirective((prev) =>
          prev && prev.id === directive.id ? null : prev,
        );
      }, 0);
    }
  }, [directive, now, refetch]);

  // ── Render gates ────────────────────────────────────────────────────────
  if (author !== "Besho") return null;
  if (UNGUARDED_PATHS.has(pathname)) return null;
  if (!directive) return null;
  if (directive.state === "expired" || directive.state === "cancelled")
    return null;
  // Punishment overlay supersedes — yield until it dispatches
  // PUNISHMENT_CLEARED_EVENT and our refetch flips the flag.
  if (punishmentActive) return null;

  const isIssued = directive.state === "issued";
  const isAcknowledged = directive.state === "acknowledged";
  const isCompleted = directive.state === "completed";
  const countdown = computeCountdown(directive, now);

  const handleAcknowledge = async () => {
    if (busy) return;
    setBusy(true);
    void vibrate(60, "medium");
    const result = await acknowledgeDirective(directive.id);
    if (result.success) {
      void refetch();
    }
    setBusy(false);
  };

  const handleComplete = async () => {
    if (busy) return;
    setBusy(true);
    void vibrate(80, "heavy");
    const result = await completeDirective(directive.id);
    if (result.success) {
      // Optimistically flip local state so the COMPLETED screen
      // shows even if the refetch takes a beat.
      setTimeout(() => {
        setDirective((prev) =>
          prev && prev.id === directive.id
            ? { ...prev, state: "completed", completedAt: Date.now() }
            : prev,
        );
      }, 0);
    }
    setBusy(false);
  };

  // ISSUED state: forced-acknowledge full-screen modal. Z-index above
  // the floating navbar (z-40) and BiometricGate (z-50 via backdrop)
  // but below the StaffToolbar (z-200ish) — using z-90.
  if (isIssued) {
    return (
      <AnimatePresence>
        <motion.div
          key="issued"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className={cn(
            "fixed inset-0 z-90 flex items-center justify-center",
            "bg-black/85 p-4",
          )}
          style={{ willChange: "transform" }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.45 }}
            className={cn(
              "w-full max-w-md rounded-3xl border border-amber-500/30",
              "bg-card shadow-2xl shadow-black/60 p-6",
            )}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
                <Target className="h-5 w-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-amber-400/80">
                  Directive from Sir
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                  Acknowledge to continue
                </span>
              </div>
            </div>

            <h2 className="mt-4 text-lg font-bold leading-tight text-foreground">
              {directive.title}
            </h2>

            {directive.body && (
              <MarkdownRenderer
                content={directive.body}
                className={cn(
                  "mt-3 text-sm leading-relaxed text-muted-foreground/90",
                  "prose-p:my-1 prose-p:last:mb-0",
                )}
              />
            )}

            {directive.durationSec && (
              <p className="mt-4 rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-[11px] font-semibold text-amber-400/80">
                Countdown {Math.round(directive.durationSec / 60)} min
                — starts on acknowledge
              </p>
            )}

            <button
              onClick={handleAcknowledge}
              disabled={busy || undefined}
              className={cn(
                "mt-5 flex w-full items-center justify-center gap-2",
                "rounded-full bg-amber-500/90 px-4 py-3 text-sm font-bold",
                "uppercase tracking-wider text-black transition-all",
                "hover:bg-amber-500 active:scale-[0.97]",
                "disabled:opacity-60",
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Acknowledge
            </button>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    );
  }

  // ACKNOWLEDGED state: non-modal header strip + complete button. App
  // is usable; the strip stays pinned at the top until completed or
  // expired. Pinned via `position: fixed` rather than blocking the
  // viewport.
  if (isAcknowledged) {
    return (
      <AnimatePresence>
        <motion.div
          key="acknowledged"
          initial={{ y: -64, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -64, opacity: 0 }}
          transition={{ type: "spring", bounce: 0.25, duration: 0.4 }}
          className={cn(
            "fixed left-1/2 z-90 w-[min(28rem,calc(100vw-1rem))]",
            "-translate-x-1/2 rounded-2xl border border-amber-500/30",
            "bg-card/95 shadow-xl shadow-black/40 backdrop-blur-md",
          )}
          style={{
            top: "calc(env(safe-area-inset-top) + 0.5rem)",
            willChange: "transform",
          }}
        >
          <div className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
              <Target className="h-4 w-4" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-foreground">
                {directive.title}
              </p>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                {countdown
                  ? `${formatCountdown(countdown.remainingMs)} remaining`
                  : "Open-ended"}
              </p>
            </div>

            <button
              onClick={handleComplete}
              disabled={busy || undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-full",
                "bg-amber-500/90 px-3 py-1.5 text-[10px] font-bold",
                "uppercase tracking-wider text-black transition-all",
                "hover:bg-amber-500 active:scale-[0.95]",
                "disabled:opacity-60",
              )}
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Complete
            </button>
          </div>

          {countdown && countdown.totalMs > 0 && (
            <div className="h-0.5 w-full overflow-hidden rounded-b-2xl bg-black/20">
              <motion.div
                animate={{
                  width: `${Math.max(
                    0,
                    Math.min(
                      100,
                      (countdown.remainingMs / countdown.totalMs) * 100,
                    ),
                  )}%`,
                }}
                transition={{ duration: 0.3 }}
                className="h-full bg-amber-500/80"
              />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    );
  }

  // COMPLETED state: brief confirmation. Auto-dismiss after 2s.
  if (isCompleted) {
    return (
      <AnimatePresence>
        <motion.div
          key="completed"
          initial={{ y: -64, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -64, opacity: 0 }}
          transition={{ type: "spring", bounce: 0.3, duration: 0.4 }}
          className={cn(
            "fixed left-1/2 z-90 flex w-[min(28rem,calc(100vw-1rem))]",
            "-translate-x-1/2 items-center gap-3",
            "rounded-2xl border border-emerald-500/30 bg-card/95",
            "px-4 py-3 shadow-xl shadow-black/40 backdrop-blur-md",
          )}
          style={{
            top: "calc(env(safe-area-inset-top) + 0.5rem)",
            willChange: "transform",
          }}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
            <Check className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-foreground">
              Directive completed
            </p>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              {directive.title}
            </p>
          </div>
          <button
            onClick={() => setDirective(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:text-foreground active:scale-95"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  return null;
}
