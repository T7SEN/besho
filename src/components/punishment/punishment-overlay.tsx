"use client";

// src/components/punishment/punishment-overlay.tsx
//
// Full-screen kneel-timer overlay. Mounts once in the root layout;
// self-gates on `getCurrentAuthor() === "Besho"` AND active-punishment
// presence so Sir, /login, and the "no active punishment" cases
// render nothing.
//
// State machine:
//   ISSUED         → "Begin" button. App is blocked until kitten
//                    consents to start the clock.
//   RUNNING        → countdown + Bail button (two-tap with delay).
//                    `appStateChange { isActive: false }` starts a
//                    60s grace; on grace expiry, fires bail with
//                    reason "background-grace".
//   COMPLETED /    → brief confirm, dispatches PUNISHMENT_CLEARED_EVENT,
//   BAILED           auto-dismiss after 2.5s.
//
// Z-index / precedence: this overlay supersedes <DirectiveDialog>.
// The dialog reads getActivePunishment and self-suppresses; the
// overlay dispatches PUNISHMENT_CLEARED_EVENT on terminal transition
// so the dialog can refetch and surface any queued directive.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import {
  bailPunishment,
  completePunishment,
  getActivePunishment,
  startPunishment,
  type Punishment,
} from "@/app/actions/punishment";
import { getCurrentAuthor } from "@/app/actions/auth";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import {
  BAIL_CONFIRM_DELAY_MS,
  BACKGROUND_GRACE_SEC,
  PUNISHMENT_ARRIVED_EVENT,
  PUNISHMENT_CLEARED_EVENT,
} from "@/lib/punishment-constants";

const TERMINAL_DISMISS_MS = 2_500;
const UNGUARDED_PATHS = new Set<string>(["/login"]);

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function dispatchPunishmentCleared() {
  try {
    (
      globalThis as unknown as { dispatchEvent: (e: Event) => void }
    ).dispatchEvent(new CustomEvent(PUNISHMENT_CLEARED_EVENT));
  } catch {
    // best-effort
  }
}

export function PunishmentOverlay() {
  const pathname = usePathname();
  const [author, setAuthor] = useState<string | null>(null);
  const [punishment, setPunishment] = useState<Punishment | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [bailConfirming, setBailConfirming] = useState(false);
  const [terminalShown, setTerminalShown] = useState(false);
  const bailConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const graceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(async () => {
    if (author !== "Besho") return;
    try {
      const next = await getActivePunishment("Besho");
      setTimeout(() => {
        setPunishment(next);
        setTerminalShown(false);
      }, 0);
    } catch {
      // best-effort
    }
  }, [author]);

  // Resolve current author + re-resolve on navigation.
  useEffect(() => {
    let cancelled = false;
    getCurrentAuthor().then((a) => {
      if (!cancelled) setAuthor(a);
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (author !== "Besho") {
      // Deferred setState — `setTimeout(..., 0)` per § 4 pattern.
      // Sync setState inside an effect trips
      // `react-hooks/set-state-in-effect`.
      setTimeout(() => setPunishment(null), 0);
      return;
    }
    void refetch();
  }, [author, refetch]);

  useRefreshListener(() => {
    void refetch();
  });

  // FCM arrival → refetch.
  useEffect(() => {
    if (author !== "Besho") return;
    const handler = () => {
      void vibrate(120, "heavy");
      void refetch();
    };
    const win = globalThis as unknown as {
      addEventListener: (t: string, h: EventListener) => void;
      removeEventListener: (t: string, h: EventListener) => void;
    };
    win.addEventListener(PUNISHMENT_ARRIVED_EVENT, handler);
    return () => win.removeEventListener(PUNISHMENT_ARRIVED_EVENT, handler);
  }, [author, refetch]);

  // 1Hz tick during RUNNING.
  useEffect(() => {
    if (!punishment) return;
    if (punishment.state !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [punishment]);

  // Background-grace: when running and the app goes to background,
  // start a 60s grace timer. If the app returns active before it
  // fires, cancel. If it fires, bail with reason "background-grace".
  useEffect(() => {
    if (!punishment) return;
    if (punishment.state !== "running") return;
    if (author !== "Besho") return;

    let cancelled = false;
    let appHandle: { remove: () => Promise<void> } | null = null;

    const setupAppListener = async () => {
      try {
        const { App } = await import("@capacitor/app");
        const handle = await App.addListener("appStateChange", (state) => {
          if (cancelled) return;
          if (state.isActive) {
            // Returned to foreground — cancel any pending grace.
            if (graceTimeoutRef.current) {
              clearTimeout(graceTimeoutRef.current);
              graceTimeoutRef.current = null;
            }
            return;
          }
          // Backgrounded — start the grace timer.
          if (graceTimeoutRef.current) clearTimeout(graceTimeoutRef.current);
          graceTimeoutRef.current = setTimeout(
            () => {
              graceTimeoutRef.current = null;
              void bailPunishment(punishment.id, "background-grace").then(
                () => {
                  if (cancelled) return;
                  void refetch();
                },
              );
            },
            BACKGROUND_GRACE_SEC * 1000,
          );
        });
        if (cancelled) {
          void handle.remove();
          return;
        }
        appHandle = handle;
      } catch {
        // Web / no @capacitor/app — grace doesn't apply.
      }
    };

    void setupAppListener();

    return () => {
      cancelled = true;
      if (graceTimeoutRef.current) {
        clearTimeout(graceTimeoutRef.current);
        graceTimeoutRef.current = null;
      }
      void appHandle?.remove();
    };
  }, [punishment, author, refetch]);

  // Bail-confirm two-tap auto-revert.
  useEffect(() => {
    if (!bailConfirming) return;
    if (bailConfirmTimeoutRef.current)
      clearTimeout(bailConfirmTimeoutRef.current);
    bailConfirmTimeoutRef.current = setTimeout(() => {
      setBailConfirming(false);
      bailConfirmTimeoutRef.current = null;
    }, BAIL_CONFIRM_DELAY_MS);
    return () => {
      if (bailConfirmTimeoutRef.current) {
        clearTimeout(bailConfirmTimeoutRef.current);
        bailConfirmTimeoutRef.current = null;
      }
    };
  }, [bailConfirming]);

  // Auto-dismiss the COMPLETED / BAILED confirmation after 2.5s.
  // Dispatch PUNISHMENT_CLEARED_EVENT so DirectiveDialog can refetch.
  useEffect(() => {
    if (!punishment) return;
    if (punishment.state !== "completed" && punishment.state !== "bailed") {
      return;
    }
    if (terminalShown) return;
    // Deferred setState per § 4. The dispatch + dismiss timeout
    // path is async-safe; only the immediate `setTerminalShown(true)`
    // would trip `react-hooks/set-state-in-effect` synchronously.
    const armId = setTimeout(() => setTerminalShown(true), 0);
    dispatchPunishmentCleared();
    const dismissId = setTimeout(() => {
      setTimeout(() => setPunishment(null), 0);
    }, TERMINAL_DISMISS_MS);
    return () => {
      clearTimeout(armId);
      clearTimeout(dismissId);
    };
  }, [punishment, terminalShown]);

  // Render gates.
  if (author !== "Besho") return null;
  if (UNGUARDED_PATHS.has(pathname)) return null;
  if (!punishment) return null;
  if (punishment.state === "cancelled") {
    // Sir cancelled — don't show a terminal screen, just clear silently.
    setTimeout(() => {
      dispatchPunishmentCleared();
      setPunishment(null);
    }, 0);
    return null;
  }

  const isIssued = punishment.state === "issued";
  const isRunning = punishment.state === "running";
  const isCompleted = punishment.state === "completed";
  const isBailed = punishment.state === "bailed";

  const remainingMs =
    punishment.endsAt && isRunning
      ? Math.max(0, punishment.endsAt - now)
      : 0;
  const totalMs = punishment.durationSec * 1000;
  const elapsedPct =
    totalMs > 0 && punishment.endsAt && punishment.startsAt
      ? Math.min(
          100,
          Math.max(
            0,
            ((now - punishment.startsAt) / totalMs) * 100,
          ),
        )
      : 0;

  const handleBegin = async () => {
    if (busy) return;
    setBusy(true);
    void vibrate(80, "medium");
    const result = await startPunishment(punishment.id);
    if (result.success) {
      void refetch();
    }
    setBusy(false);
  };

  const handleComplete = async () => {
    if (busy) return;
    if (remainingMs > 0) return;
    setBusy(true);
    void vibrate(100, "heavy");
    const result = await completePunishment(punishment.id);
    if (result.success) {
      setTimeout(() => {
        setPunishment((prev) =>
          prev && prev.id === punishment.id
            ? { ...prev, state: "completed", completedAt: Date.now() }
            : prev,
        );
      }, 0);
    }
    setBusy(false);
  };

  const handleBail = async () => {
    if (busy) return;
    if (!bailConfirming) {
      setBailConfirming(true);
      void vibrate(40, "light");
      return;
    }
    setBailConfirming(false);
    if (bailConfirmTimeoutRef.current) {
      clearTimeout(bailConfirmTimeoutRef.current);
      bailConfirmTimeoutRef.current = null;
    }
    setBusy(true);
    void vibrate(120, "heavy");
    const result = await bailPunishment(punishment.id, "user-bail");
    if (result.success) {
      setTimeout(() => {
        setPunishment((prev) =>
          prev && prev.id === punishment.id
            ? { ...prev, state: "bailed", bailedAt: Date.now() }
            : prev,
        );
      }, 0);
    }
    setBusy(false);
  };

  // ── ISSUED ──────────────────────────────────────────────────────────────
  if (isIssued) {
    return (
      <AnimatePresence>
        <motion.div
          key="issued"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-95 flex items-center justify-center bg-black/90 p-4"
          style={{ willChange: "transform" }}
        >
          <motion.div
            initial={{ scale: 0.95, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.45 }}
            className="w-full max-w-md rounded-3xl border border-destructive/40 bg-card p-6 shadow-2xl shadow-black/60"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] font-bold uppercase tracking-widest text-destructive">
                  Punishment timer
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                  {Math.round(punishment.durationSec / 60)} minutes
                </span>
              </div>
            </div>

            <p
              dir="auto"
              className="mt-4 text-base leading-relaxed text-foreground"
            >
              {punishment.reason}
            </p>

            <p className="mt-4 rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-[11px] font-semibold text-destructive/80">
              The clock starts when you tap Begin. Don&apos;t leave the app
              for more than {BACKGROUND_GRACE_SEC}s — that counts as
              bailing.
            </p>

            <button
              onClick={handleBegin}
              disabled={busy || undefined}
              className={cn(
                "mt-5 flex w-full items-center justify-center gap-2",
                "rounded-full bg-destructive/90 px-4 py-3 text-sm font-bold",
                "uppercase tracking-wider text-white transition-all",
                "hover:bg-destructive active:scale-[0.97]",
                "disabled:opacity-60",
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Begin
            </button>
          </motion.div>
        </motion.div>
      </AnimatePresence>
    );
  }

  // ── RUNNING ─────────────────────────────────────────────────────────────
  if (isRunning) {
    return (
      <AnimatePresence>
        <motion.div
          key="running"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-95 flex flex-col items-center justify-center bg-black/95 p-6"
          style={{ willChange: "transform" }}
        >
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-destructive/80">
              Punishment timer running
            </p>
            <p
              dir="auto"
              className="mt-2 max-w-sm text-sm text-muted-foreground"
            >
              {punishment.reason}
            </p>
          </div>

          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            className="mt-10 text-7xl font-bold tabular-nums tracking-tight text-foreground"
          >
            {formatCountdown(remainingMs)}
          </motion.div>

          <div className="mt-6 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/5">
            <motion.div
              animate={{ width: `${elapsedPct}%` }}
              transition={{ duration: 0.3 }}
              className="h-full bg-destructive/70"
            />
          </div>

          {remainingMs > 0 ? (
            <p className="mt-8 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
              Wait for the clock. Bailing logs an entry.
            </p>
          ) : (
            <button
              onClick={handleComplete}
              disabled={busy || undefined}
              className={cn(
                "mt-8 flex items-center gap-2 rounded-full bg-emerald-500/90 px-6 py-3",
                "text-sm font-bold uppercase tracking-wider text-black",
                "transition-all hover:bg-emerald-500 active:scale-[0.97]",
                "disabled:opacity-60",
              )}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Complete
            </button>
          )}

          <button
            onClick={handleBail}
            disabled={busy || undefined}
            className={cn(
              "mt-6 flex items-center gap-2 rounded-full px-5 py-2 text-[11px] font-bold uppercase tracking-wider transition-all",
              bailConfirming
                ? "bg-destructive/90 text-white animate-pulse"
                : "bg-white/5 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10",
              "disabled:opacity-60",
            )}
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <X className="h-3 w-3" />
            )}
            {bailConfirming ? "Tap again to bail" : "Bail"}
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  // ── COMPLETED / BAILED ──────────────────────────────────────────────────
  if (isCompleted || isBailed) {
    const accent = isCompleted
      ? {
          ring: "border-emerald-500/40",
          iconBg: "bg-emerald-500/15 text-emerald-400",
          chipBg: "bg-emerald-500/15 text-emerald-400",
          Icon: Check,
          label: "Punishment completed",
        }
      : {
          ring: "border-destructive/40",
          iconBg: "bg-destructive/15 text-destructive",
          chipBg: "bg-destructive/15 text-destructive",
          Icon: AlertTriangle,
          label: "Punishment bailed",
        };

    const Icon = accent.Icon;

    return (
      <AnimatePresence>
        <motion.div
          key={isCompleted ? "completed" : "bailed"}
          initial={{ y: -64, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -64, opacity: 0 }}
          transition={{ type: "spring", bounce: 0.3, duration: 0.4 }}
          className={cn(
            "fixed left-1/2 z-95 flex w-[min(28rem,calc(100vw-1rem))]",
            "-translate-x-1/2 items-center gap-3",
            "rounded-2xl border bg-card/95 px-4 py-3",
            "shadow-xl shadow-black/40 backdrop-blur-md",
            accent.ring,
          )}
          style={{
            top: "calc(env(safe-area-inset-top) + 0.5rem)",
            willChange: "transform",
          }}
        >
          <div
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
              accent.iconBg,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-foreground">
              {accent.label}
            </p>
            <p
              dir="auto"
              className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60"
            >
              {punishment.reason}
            </p>
          </div>
          <button
            onClick={() => {
              dispatchPunishmentCleared();
              setPunishment(null);
            }}
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
