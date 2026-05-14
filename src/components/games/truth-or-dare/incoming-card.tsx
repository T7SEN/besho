// src/components/games/truth-or-dare/incoming-card.tsx
"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Clock,
  HelpCircle,
  Loader2,
  MessageCircleQuestion,
  Send,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import {
  CHANGE_PICK_WINDOW_SEC,
  MAX_RESPONSE_LEN,
  STATUS_CHIP,
  STATUS_LABELS,
  type ChallengeType,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";
import { formatCountdown } from "@/lib/games/truth-or-dare-utils";
import {
  pickPrompt,
  refuseChallenge,
  safewordChallenge,
  submitResponse,
} from "@/app/actions/games/truth-or-dare";
import { Button } from "@/components/ui/button";

interface IncomingCardProps {
  challenge: TodChallenge;
  now: number;
  onAction: () => void;
}

/** Recipient-side card. Renders pending → pick UI; picked → response
 *  form. Both states share refuse/safeword controls. Handles its own
 *  busy + error + 5s confirm-refuse auto-revert state. The parent owns
 *  the bundle re-fetch via `onAction`. The component derives the
 *  recipient's perspective from `challenge.recipient` directly — no
 *  separate `me` prop is needed because incoming is only rendered
 *  when the caller IS the recipient. */
export function IncomingCard({
  challenge,
  now,
  onAction,
}: IncomingCardProps) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRefuse, setConfirmRefuse] = useState(false);
  const [response, setResponse] = useState("");

  useEffect(() => {
    if (!confirmRefuse) return;
    const id = setTimeout(() => setConfirmRefuse(false), 5000);
    return () => clearTimeout(id);
  }, [confirmRefuse]);

  // Reset response draft when the pick changes (change-of-mind flow).
  // Otherwise the textarea would carry stale text from the previously-
  // picked type into the newly-picked one.
  useEffect(() => {
    setTimeout(() => setResponse(""), 0);
  }, [challenge.pick]);

  const remainingMs = challenge.expiresAt - now;
  const expiresIn = formatCountdown(remainingMs);

  // Change-of-mind window: open while status is picked AND we're within
  // CHANGE_PICK_WINDOW_SEC of pickedAt. Computed in render so the
  // affordance hides itself once the window elapses (the 1Hz tick
  // re-renders the card and re-evaluates).
  const changePickWindowOpen =
    challenge.status === "picked" &&
    challenge.pickedAt !== null &&
    now - challenge.pickedAt < CHANGE_PICK_WINDOW_SEC * 1000;
  const changePickRemainingSec = challenge.pickedAt
    ? Math.max(
        0,
        Math.ceil(
          (challenge.pickedAt + CHANGE_PICK_WINDOW_SEC * 1000 - now) / 1000,
        ),
      )
    : 0;

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
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-blue-400">
                {challenge.pick === "truth" ? (
                  <HelpCircle className="h-3 w-3" />
                ) : (
                  <Zap className="h-3 w-3" />
                )}
                {challenge.pick}
              </div>
              {changePickWindowOpen && (
                <button
                  type="button"
                  onClick={() =>
                    handlePick(challenge.pick === "truth" ? "dare" : "truth")
                  }
                  disabled={!!busyAction || undefined}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5",
                    "text-[9px] font-bold uppercase tracking-wider text-blue-300",
                    "transition-colors hover:bg-blue-500/20 active:scale-[0.95] disabled:opacity-50",
                  )}
                  title={`${changePickRemainingSec}s left to swap`}
                >
                  {busyAction?.startsWith("pick-") ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      Pick {challenge.pick === "truth" ? "dare" : "truth"}{" "}
                      instead · {changePickRemainingSec}s
                    </>
                  )}
                </button>
              )}
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
    </motion.section>
  );
}

interface PromptCardProps {
  kind: ChallengeType;
  text: string;
  disabled: boolean;
  onPick: () => void;
  picking: boolean;
}

/** A single-prompt picker tile (truth OR dare). Internal to
 *  IncomingCard — kept in the same file to avoid pollution since it's
 *  not consumed elsewhere. */
function PromptCard({ kind, text, disabled, onPick, picking }: PromptCardProps) {
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
