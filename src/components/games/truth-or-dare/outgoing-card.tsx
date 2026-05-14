// src/components/games/truth-or-dare/outgoing-card.tsx
"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Clock,
  HelpCircle,
  Loader2,
  Sparkles,
  Undo2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import {
  MAX_REFUSE_REASON_LEN,
  STATUS_CHIP,
  STATUS_LABELS,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";
import { formatCountdown } from "@/lib/games/truth-or-dare-utils";
import { withdrawChallenge } from "@/app/actions/games/truth-or-dare";

interface OutgoingCardProps {
  challenge: TodChallenge;
  now: number;
  onAction: () => void;
}

/** Issuer-side card. Shows both prompts (so the issuer remembers what
 *  they wrote) + a two-tap withdraw flow with an optional reason. The
 *  Withdraw button is hidden behind a confirm step + 5s auto-revert
 *  (matches the refuse pattern). Restraint blocks Kitten server-side
 *  via `assertWriteAllowed` — the button still renders; the action
 *  returns an error that surfaces inline. The component derives the
 *  issuer's perspective from `challenge.issuer` directly — outgoing
 *  is only rendered when the caller IS the issuer. */
export function OutgoingCard({
  challenge,
  now,
  onAction,
}: OutgoingCardProps) {
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
    </motion.section>
  );
}
