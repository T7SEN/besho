// src/components/games/truth-or-dare/history-row.tsx
"use client";

import { useState } from "react";
import { CheckCircle2, HelpCircle, Loader2, Trash2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  STATUS_CHIP,
  STATUS_LABELS,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";
import { formatRelative } from "@/lib/games/truth-or-dare-utils";
import { TodReactions } from "./tod-reactions";

interface HistoryRowProps {
  challenge: TodChallenge;
  /** Caller's identity — drives whether the delete button renders.
   *  Sir-only soft-delete (matches notes / permissions / review). */
  me: Author;
  now: number;
  /** Current reactions on this challenge — `{ author: emoji }`. Empty
   *  object when none. Reactions are only rendered for completed
   *  challenges (where there's a response worth reacting to). */
  reactions: Record<string, string>;
  /** Called by `<TodReactions>` with the new reactions HASH after a
   *  toggle. Parent owns the per-id reactions state and re-renders. */
  onReactionsChange: (reactions: Record<string, string>) => void;
  onDelete: (id: string) => Promise<{ success?: boolean; error?: string }>;
}

/** One row in the bottom history list. Renders the status chip, pick
 *  type if any, direction (issuer → recipient), and relative close
 *  timestamp. Shows the picked prompt + response for `completed`;
 *  shows both prompts for terminal-pre-pick states (refused /
 *  safeworded / expired / withdrawn / cancelled). Sir gets a hover-
 *  revealed delete button on md+ and an always-visible one on mobile
 *  (via the md: opacity gate inverted by default). */
export function HistoryRow({
  challenge,
  me,
  now,
  reactions,
  onReactionsChange,
  onDelete,
}: HistoryRowProps) {
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

  const closedTs =
    challenge.closedAt ??
    challenge.respondedAt ??
    challenge.pickedAt ??
    challenge.createdAt;

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
          {challenge.adminCancelReason && (
            <p
              dir="auto"
              className="mt-2 text-[11px] italic text-muted-foreground/70"
            >
              Cancelled: {challenge.adminCancelReason}
            </p>
          )}

          {/* Reactions — only on completed rows where there's an
              answer worth reacting to. Refused / safeworded / expired
              / withdrawn / cancelled rows skip this affordance. */}
          {challenge.status === "completed" && (
            <div className="mt-3">
              <TodReactions
                challengeId={challenge.id}
                reactions={reactions}
                currentAuthor={me}
                onReactionsChange={onReactionsChange}
              />
            </div>
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
