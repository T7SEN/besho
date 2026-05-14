// src/components/admin/games/truth-or-dare/active-tab.tsx
"use client";

import { useEffect, useState } from "react";
import { HelpCircle, Loader2, X, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import {
  MAX_CANCEL_REASON_LEN,
  STATUS_CHIP,
  STATUS_LABELS,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";
import {
  cancelAllActiveTodChallenges,
  forceCancelTodChallenge,
  type TodAdminBundle,
} from "@/app/actions/admin";

interface ActiveTabProps {
  bundle: TodAdminBundle;
  now: number;
  onAction: () => void;
}

/** Renders the two single-slot direction labels (Sir's outgoing,
 *  Kitten's outgoing). Each slot shows either an active record card
 *  with a force-cancel control or a "No active challenge" placeholder.
 *  When both slots are filled, surfaces a "Cancel all active" button
 *  at the top of the tab. */
export function ActiveTab({ bundle, now, onAction }: ActiveTabProps) {
  const slots: Array<{
    key: string;
    label: string;
    record: TodChallenge | null;
  }> = [
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

interface MassCancelButtonProps {
  onAction: () => void;
}

/** Two-tap "Cancel all active" with 5s auto-revert. Calls
 *  `cancelAllActiveTodChallenges`, which walks both sentinels and
 *  force-cancels each. */
function MassCancelButton({ onAction }: MassCancelButtonProps) {
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

interface ActiveRecordCardProps {
  challenge: TodChallenge;
  now: number;
  onAction: () => void;
}

/** Per-record force-cancel card. Two-tap with 6s auto-revert (slightly
 *  longer than refuse/withdraw — admin overrides are heavier). Optional
 *  reason lands on `adminCancelReason`. No obedience emit either
 *  direction; no stat increment. */
function ActiveRecordCard({
  challenge,
  now,
  onAction,
}: ActiveRecordCardProps) {
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
          {TITLE_BY_AUTHOR[challenge.issuer]} →{" "}
          {TITLE_BY_AUTHOR[challenge.recipient]}
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
