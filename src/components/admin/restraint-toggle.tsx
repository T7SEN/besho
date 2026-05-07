"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lock, Loader2, LockOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import {
  getRestraintState,
  setRestraintState,
} from "@/app/actions/admin";
import { OBEDIENCE_NOTE_MAX } from "@/lib/reward-types";

const CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Sir-only restraint toggle. Two-step confirm only when turning ON
 * (an active restriction is destructive intent); turning OFF lifts
 * with a single tap. Caller is responsible for gating render — the
 * `/admin` layout already redirects non-Sir.
 */
export function RestraintToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await getRestraintState();
      if (result.error) {
        setError(result.error);
      } else {
        setOn(result.on ?? false);
      }
    } catch {
      setError("Failed to read state.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleTurnOnTap = () => {
    void vibrate(50, "medium");
    setError(null);
    setConfirming(true);
  };

  const handleConfirmOn = async () => {
    void vibrate([100, 50, 100], "heavy");
    setBusy(true);
    setError(null);
    try {
      const result = await setRestraintState(true, note.trim() || undefined);
      if (result.error) {
        setError(result.error);
      } else {
        setOn(true);
        setConfirming(false);
        setNote("");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleTurnOff = async () => {
    void vibrate(50, "medium");
    setBusy(true);
    setError(null);
    try {
      const result = await setRestraintState(false);
      if (result.error) {
        setError(result.error);
      } else {
        setOn(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = () => {
    void vibrate(20, "light");
    setConfirming(false);
    setNote("");
  };

  if (on == null) {
    return (
      <div className="mb-3 h-12 animate-pulse rounded-2xl border border-border/40 bg-card" />
    );
  }

  return (
    <div className="mb-3">
      <AnimatePresence mode="wait" initial={false}>
        {on ? (
          <motion.div
            key="on"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cn(
              "flex items-center justify-between gap-3 rounded-2xl px-4 py-3",
              "border border-destructive/40 bg-destructive/15",
            )}
          >
            <div className="flex items-center gap-2.5">
              <Lock className="h-4 w-4 text-destructive" />
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-destructive">
                  Restraint on
                </p>
                <p className="text-[10px] text-destructive/70">
                  Kitten is read-only.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleTurnOff()}
              disabled={busy}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <LockOpen className="h-3 w-3" />
              )}
              Lift
            </button>
          </motion.div>
        ) : confirming ? (
          <motion.div
            key="confirming"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            className="flex flex-col gap-2"
          >
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={OBEDIENCE_NOTE_MAX}
              placeholder="Optional reason — e.g. ignored rule X"
              dir="auto"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-2xl border border-border/40 bg-input/40 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-destructive/60 focus:outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={busy}
                className="rounded-2xl border border-border/40 px-4 py-3.5 text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-[0.99] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmOn()}
                disabled={busy}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2",
                  "rounded-2xl bg-destructive px-4 py-3.5",
                  "text-sm font-bold uppercase tracking-wider text-white",
                  "transition-colors hover:bg-destructive/90 active:scale-[0.99]",
                  "disabled:opacity-60",
                )}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
                Confirm restraint
              </button>
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="off"
            type="button"
            onClick={handleTurnOnTap}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className={cn(
              "flex w-full items-center justify-center gap-2",
              "rounded-2xl border border-border/40 bg-card px-4 py-3",
              "text-sm font-bold uppercase tracking-wider text-muted-foreground",
              "transition-colors hover:border-destructive/30 hover:text-destructive active:scale-[0.99]",
            )}
          >
            <Lock className="h-4 w-4" />
            Put kitten on restraint
          </motion.button>
        )}
      </AnimatePresence>
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
