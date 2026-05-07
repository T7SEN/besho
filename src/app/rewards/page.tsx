"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  ArrowLeft,
  Award,
  Check,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  Gift,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  Trophy,
  X,
} from "lucide-react";
import {
  claimReward,
  denyClaim,
  deliverClaim,
  getRewardsBundle,
  getRewardsHistory,
  type RewardsBundle,
  type RewardsHistoryEntry,
} from "@/app/actions/rewards";
import {
  OBEDIENCE_EVENT_LABELS,
  type ObedienceWeekState,
  type RewardClaim,
  type RewardItem,
  type RewardTier,
} from "@/lib/reward-types";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";

function buildHeaderStat(bundle: RewardsBundle | null): string {
  if (!bundle) return "—";
  // Clamp at zero for the headline. The underlying penalty state is
  // surfaced separately in the score card so a negative week reads as
  // "0 pts · in the hole" rather than a startling negative number in
  // the page header.
  const displayed = Math.max(0, bundle.besho.displayedScore);
  const tier = bundle.besho.unlockedTier;
  const tierLabel = tier ? `· ${tier.name}` : "· no tier";
  return `${displayed} pts ${tierLabel}`;
}

function formatWeekRange(weekKey: string): string {
  // weekKey is the Sunday YYYY-MM-DD; render as "Nov 2 – Nov 8".
  const [y, m, d] = weekKey.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const fmt = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export default function RewardsPage() {
  const [bundle, setBundle] = useState<RewardsBundle | null>(null);
  const [history, setHistory] = useState<RewardsHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBundle = useCallback(async () => {
    setRefreshing(true);
    try {
      const [bundleResult, historyResult] = await Promise.all([
        getRewardsBundle(),
        getRewardsHistory(12),
      ]);
      if (bundleResult.error) {
        setError(bundleResult.error);
      } else if (bundleResult.bundle) {
        setBundle(bundleResult.bundle);
        setError(null);
      }
      if (historyResult.entries) setHistory(historyResult.entries);
    } catch {
      setError("Failed to load rewards.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchBundle();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchBundle]);

  return (
    <div className="relative min-h-screen bg-background p-4 pb-28 md:p-12 md:pb-32">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[150px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl space-y-8 pt-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            Back
          </Link>

          <div className="flex flex-col items-center gap-0.5">
            <h1 className="text-xl font-bold tracking-widest uppercase text-primary/80">
              Rewards
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {buildHeaderStat(bundle)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              void vibrate(20, "light");
              void fetchBundle();
            }}
            disabled={refreshing}
            aria-label="Refresh"
            className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary disabled:opacity-30"
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
            />
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {!bundle ? (
          <Skeleton />
        ) : (
          <RewardsView
            bundle={bundle}
            history={history}
            onRefresh={fetchBundle}
          />
        )}
      </div>
    </div>
  );
}

// ── Top-level view ────────────────────────────────────────────────────────

function RewardsView({
  bundle,
  history,
  onRefresh,
}: {
  bundle: RewardsBundle;
  history: RewardsHistoryEntry[] | null;
  onRefresh: () => Promise<void>;
}) {
  const isSir = bundle.viewer === "T7SEN";

  return (
    <div className="space-y-4">
      {bundle.testModeOn && <TestModeBanner />}

      <ScoreCard
        weekState={bundle.besho}
        viewer={bundle.viewer}
        streakThreshold={bundle.streakThreshold}
        multipliers={bundle.multipliers}
        weekKeyLabel="This week"
      />

      <TierLadderCard weekState={bundle.besho} />

      {bundle.besho.breakdown.length > 0 && (
        <BreakdownCard weekState={bundle.besho} />
      )}

      {/* Test-mode current-week claim path. Renders only when Sir
       *  enabled the flag AND Besho actually has a tier reached this
       *  week. Pre-empts the prior-week section when it's active so
       *  the picker she sees is the test one. */}
      {bundle.testModeOn ? (
        <CurrentWeekClaimSection
          besho={bundle.besho}
          currentClaim={bundle.currentClaim}
          viewer={bundle.viewer}
          onRefresh={onRefresh}
        />
      ) : null}

      <PriorWeekSection
        priorBesho={bundle.priorBesho}
        priorClaim={bundle.priorClaim}
        viewer={bundle.viewer}
        onRefresh={onRefresh}
      />

      {isSir && bundle.pendingClaim && (
        <PendingClaimCard
          claim={bundle.pendingClaim}
          onRefresh={onRefresh}
        />
      )}

      {bundle.viewer === "Besho" && bundle.myClaims.length > 0 && (
        <ClaimHistoryCard claims={bundle.myClaims} />
      )}

      {history && history.length > 0 && <HistorySection entries={history} />}
    </div>
  );
}

function TestModeBanner() {
  return (
    <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-3">
        <FlaskConical className="h-4 w-4 flex-none text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-semibold text-amber-400">
            Test mode is on
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Current-week claims are open. The week itself isn&apos;t
            ending — streak and multiplier stay untouched.
          </p>
        </div>
      </div>
    </section>
  );
}

function CurrentWeekClaimSection({
  besho,
  currentClaim,
  viewer,
  onRefresh,
}: {
  besho: ObedienceWeekState;
  currentClaim: RewardClaim | null;
  viewer: "T7SEN" | "Besho";
  onRefresh: () => Promise<void>;
}) {
  const tier = besho.unlockedTier;

  if (currentClaim) {
    return <ClaimStatusCard claim={currentClaim} />;
  }
  if (!tier) {
    return null; // Nothing to test — no tier reached yet this week.
  }
  if (viewer === "T7SEN") {
    return (
      <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 backdrop-blur-md shadow-xl shadow-black/30">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Gift className="h-4 w-4 text-amber-400" />
          This week (test) —{" "}
          {tier.emoji && <span className="mr-1">{tier.emoji}</span>}
          {tier.name} unlocked
        </h2>
        <p className="text-sm text-muted-foreground">
          {Math.max(0, besho.displayedScore)} pts so far. kitten can claim
          against the current week while test mode is on.
        </p>
      </section>
    );
  }
  return (
    <ClaimPicker
      priorBesho={besho}
      tier={tier}
      onRefresh={onRefresh}
      testMode
    />
  );
}

// ── Score card ───────────────────────────────────────────────────────────

function ScoreCard({
  weekState,
  viewer,
  streakThreshold,
  multipliers,
  weekKeyLabel,
}: {
  weekState: ObedienceWeekState;
  viewer: "T7SEN" | "Besho";
  streakThreshold: number;
  multipliers: readonly number[];
  weekKeyLabel: string;
}) {
  const ownerLabel =
    viewer === "T7SEN" ? `${TITLE_BY_AUTHOR.Besho}'s` : "Your";
  const showMultiplier = weekState.multiplier !== 1;
  const maxMultiplier = multipliers[multipliers.length - 1] ?? 1;

  // Clamp the headline at zero. When displayed is negative, the actual
  // negative magnitude is shown alongside as a "penalty" chip so the
  // information isn't lost — it just isn't the headline. Tier math
  // already treats negatives as no-tier-earned, so clamping the
  // display doesn't change reachability.
  const headlineDisplayed = Math.max(0, weekState.displayedScore);
  const isPenalized = weekState.displayedScore < 0;
  const penaltyMagnitude = isPenalized ? Math.abs(weekState.displayedScore) : 0;
  const showRawHint =
    !isPenalized && weekState.rawScore !== weekState.displayedScore;

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
            {ownerLabel} {weekKeyLabel}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatWeekRange(weekState.weekKey)}
          </p>
        </div>
        {showMultiplier && (
          <span className="rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-primary">
            ×{weekState.multiplier.toFixed(1)} streak
          </span>
        )}
      </div>

      <div className="mt-4 flex items-end gap-3">
        <span
          className={cn(
            "text-5xl font-bold tracking-tight tabular-nums",
            isPenalized && "text-muted-foreground/60",
          )}
        >
          {headlineDisplayed}
        </span>
        {showRawHint && (
          <span className="text-xs text-muted-foreground">
            ({weekState.rawScore} raw)
          </span>
        )}
        {isPenalized && (
          <span
            className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-rose-400"
            title="Net penalty for the week. Earn points to climb back to zero before any tier becomes reachable."
          >
            −{penaltyMagnitude} penalty
          </span>
        )}
      </div>

      <div className="mt-4 space-y-2 text-sm text-muted-foreground">
        <div>
          High-score threshold:{" "}
          <span className="font-semibold text-foreground">
            {streakThreshold} pts
          </span>
        </div>
        <div>
          Streak entering this week:{" "}
          <span className="font-semibold text-foreground">
            {weekState.streakEntering}
          </span>{" "}
          {weekState.streakEntering === 1 ? "week" : "weeks"}
        </div>
        <div>
          Max possible multiplier:{" "}
          <span className="font-semibold text-foreground">
            ×{maxMultiplier.toFixed(1)}
          </span>{" "}
          — after a {multipliers.length - 1}-week high-score streak
        </div>
      </div>
    </section>
  );
}

// ── Tier ladder ──────────────────────────────────────────────────────────

function TierLadderCard({ weekState }: { weekState: ObedienceWeekState }) {
  const tiers = weekState.tiers;
  const score = weekState.displayedScore;

  // Next-tier nudge — first tier whose threshold is strictly above the
  // current displayed score. Null when she's already maxed out.
  const nextTier = tiers.find((t) => t.threshold > score) ?? null;
  const gap = nextTier ? nextTier.threshold - score : 0;

  // Expanded tier IDs — tap a row to preview its rewards. Multi-expand
  // so she can compare what's at Tier IV vs Tier V at a glance.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => {
    void vibrate(15, "light");
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Trophy className="h-4 w-4 text-primary/70" />
        Tier ladder
      </h2>
      <div className="space-y-2">
        {tiers.map((tier) => {
          const reached = score >= tier.threshold;
          const isHighestReached =
            reached &&
            tier.threshold ===
              tiers
                .filter((t) => score >= t.threshold)
                .reduce(
                  (m, t) => (t.threshold > m ? t.threshold : m),
                  -Infinity,
                );
          const isNext = nextTier !== null && tier.id === nextTier.id;
          const isOpen = expanded.has(tier.id);
          const hasRewards = tier.rewards.length > 0;
          return (
            <div
              key={tier.id}
              className={cn(
                "rounded-lg border transition-colors",
                isHighestReached
                  ? "border-primary/50 bg-primary/15"
                  : reached
                    ? "border-primary/25 bg-primary/5"
                    : isNext
                      ? "border-border/60 bg-card"
                      : "border-border/30 bg-card opacity-60",
              )}
            >
              <button
                type="button"
                onClick={() => toggle(tier.id)}
                aria-expanded={isOpen}
                aria-label={`${tier.name} — ${reached ? "reached" : "locked"}, ${tier.rewards.length} rewards`}
                className="flex w-full items-center gap-3 px-3 py-2 text-left active:scale-[0.99]"
              >
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold",
                    reached
                      ? "bg-primary/30 text-primary"
                      : "bg-muted/40 text-muted-foreground",
                  )}
                >
                  {reached ? <Check className="h-3.5 w-3.5" /> : tier.threshold}
                </span>
                {tier.emoji && (
                  <span className="text-base leading-none">{tier.emoji}</span>
                )}
                <span className="flex-1 text-sm font-semibold">
                  {tier.name}
                </span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  {tier.threshold} pts
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground/70 transition-transform",
                    isOpen && "rotate-180",
                  )}
                />
              </button>
              {isOpen && (
                <div className="border-t border-border/30 px-3 py-3">
                  {!hasRewards && (
                    <p className="text-sm text-muted-foreground/70">
                      No rewards in this tier yet.
                    </p>
                  )}
                  {hasRewards && (
                    <>
                      <ul className="space-y-2">
                        {tier.rewards.map((r) => (
                          <li
                            key={r.id}
                            className={cn(
                              "flex items-center gap-2 text-sm",
                              !reached && "opacity-70",
                            )}
                          >
                            {r.emoji ? (
                              <span className="text-base leading-none">
                                {r.emoji}
                              </span>
                            ) : (
                              <Gift
                                className={cn(
                                  "h-4 w-4 flex-none",
                                  reached
                                    ? "text-primary/70"
                                    : "text-muted-foreground/50",
                                )}
                              />
                            )}
                            <span
                              dir="auto"
                              className="min-w-0 flex-1 truncate font-semibold"
                            >
                              {r.label}
                            </span>
                            {!reached && (
                              <Lock
                                className="h-3.5 w-3.5 flex-none text-muted-foreground/40"
                                aria-label="Locked"
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                      {/* Bodies are intentionally hidden everywhere in
                       *  the catalog — the description reveals only when
                       *  Besho commits to a claim. Picking is blind by
                       *  design; the gamble is the point. */}
                      <p className="mt-3 text-sm italic text-muted-foreground/70">
                        Descriptions reveal after you claim.
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {weekState.unlockedTier && (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/10 px-3 py-3">
          <p className="text-base font-semibold text-primary">
            {weekState.unlockedTier.emoji ?? "🎁"}{" "}
            {weekState.unlockedTier.name} unlocked this week.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Claim opens once this week wraps (after Sat 23:59 Cairo). Push
            higher before then if you can.
          </p>
        </div>
      )}
      {nextTier && (
        <p className="mt-3 text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{gap}</span> more pts
          to {nextTier.name}.
        </p>
      )}
      {!nextTier && score > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Top tier reached. Hold the line.
        </p>
      )}
      <p className="mt-2 text-sm text-muted-foreground/70">
        Tap any tier to preview what&apos;s inside.
      </p>
    </section>
  );
}

// ── Breakdown ────────────────────────────────────────────────────────────

function BreakdownCard({ weekState }: { weekState: ObedienceWeekState }) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary/70" />
        Breakdown
      </h2>
      <ul className="space-y-1.5">
        {weekState.breakdown.map((entry) => {
          const positive = entry.points >= 0;
          return (
            <li
              key={entry.type}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground">
                {OBEDIENCE_EVENT_LABELS[entry.type] ?? entry.type}{" "}
                {entry.count > 1 && (
                  <span className="text-[10px] text-muted-foreground/70">
                    × {entry.count}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "tabular-nums font-semibold",
                  positive ? "text-emerald-400" : "text-rose-400",
                )}
              >
                {positive ? "+" : ""}
                {entry.points}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Prior week claim section ─────────────────────────────────────────────

function PriorWeekSection({
  priorBesho,
  priorClaim,
  viewer,
  onRefresh,
}: {
  priorBesho: ObedienceWeekState;
  priorClaim: RewardClaim | null;
  viewer: "T7SEN" | "Besho";
  onRefresh: () => Promise<void>;
}) {
  const tier = priorBesho.unlockedTier;

  if (priorClaim) {
    return <ClaimStatusCard claim={priorClaim} />;
  }

  if (!tier) {
    const headline = Math.max(0, priorBesho.displayedScore);
    const penalized = priorBesho.displayedScore < 0;
    return (
      <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Gift className="h-4 w-4 text-muted-foreground/70" />
          Last week — {formatWeekRange(priorBesho.weekKey)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {headline} pts
          {penalized && (
            <>
              {" "}
              <span className="text-rose-400">
                (−{Math.abs(priorBesho.displayedScore)} penalty)
              </span>
            </>
          )}
          . No tier reached — no reward this week.
        </p>
      </section>
    );
  }

  // Tier reached. Besho can claim. Sir sees status only.
  if (viewer === "T7SEN") {
    return (
      <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Gift className="h-4 w-4 text-primary/70" />
          Last week — {formatWeekRange(priorBesho.weekKey)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {Math.max(0, priorBesho.displayedScore)} pts • Unlocked{" "}
          {tier.emoji && <span className="mr-1">{tier.emoji}</span>}
          {tier.name}. Awaiting her claim.
        </p>
      </section>
    );
  }

  return (
    <ClaimPicker
      priorBesho={priorBesho}
      tier={tier}
      onRefresh={onRefresh}
    />
  );
}

function ClaimPicker({
  priorBesho,
  tier,
  onRefresh,
  testMode = false,
}: {
  /** Score state of the week being claimed against. Param name is
   *  historical — it can be the current week when `testMode` is on. */
  priorBesho: ObedienceWeekState;
  tier: RewardTier;
  onRefresh: () => Promise<void>;
  testMode?: boolean;
}) {
  // She can pick from any tier whose threshold ≤ her unlocked tier.
  const claimableTiers = priorBesho.tiers.filter(
    (t) => t.threshold <= tier.threshold && t.rewards.length > 0,
  );
  const initialTier = claimableTiers[claimableTiers.length - 1] ?? tier;
  const [selectedTierId, setSelectedTierId] = useState<string>(initialTier.id);
  const [selectedRewardId, setSelectedRewardId] = useState<string>(
    initialTier.rewards[0]?.id ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [unlockedClaim, setUnlockedClaim] = useState<RewardClaim | null>(null);

  const selectedTier =
    claimableTiers.find((t) => t.id === selectedTierId) ?? initialTier;

  const handleSubmit = async () => {
    if (!selectedRewardId) {
      setLocalError("Pick a reward.");
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    void vibrate(40, "medium");
    const result = await claimReward({
      weekKey: priorBesho.weekKey,
      tierId: selectedTier.id,
      rewardId: selectedRewardId,
    });
    setSubmitting(false);
    if (result.error) {
      setLocalError(result.error);
      return;
    }
    // Build a local claim record to drive the unlock animation. The
    // server-persisted version will replace it on the next bundle
    // refresh after the modal closes — `AnimatePresence`
    // `onExitComplete` defers the refresh until the exit animation
    // finishes so the picker doesn't yank out from under the modal.
    const reward =
      selectedTier.rewards.find((r) => r.id === selectedRewardId) ??
      selectedTier.rewards[0];
    if (!reward) return;
    const localClaim: RewardClaim = {
      id: result.claimId ?? crypto.randomUUID(),
      author: "Besho",
      weekKey: priorBesho.weekKey,
      tierId: selectedTier.id,
      tierName: selectedTier.name,
      ...(selectedTier.emoji && { tierEmoji: selectedTier.emoji }),
      rewardId: reward.id,
      rewardLabel: reward.label,
      ...(reward.body && { rewardBody: reward.body }),
      ...(reward.emoji && { rewardEmoji: reward.emoji }),
      status: "pending",
      requestedAt: Date.now(),
      claimedScore: priorBesho.displayedScore,
      claimedTierThreshold: selectedTier.threshold,
      ...(testMode && { testMode: true }),
    };
    setUnlockedClaim(localClaim);
  };

  return (
    <section className="rounded-2xl border border-primary/40 bg-primary/5 p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Gift className="h-4 w-4 text-primary" />
        Claim your reward {testMode && "(test)"}
      </h2>
      <p className="mb-1 text-sm text-muted-foreground">
        {Math.max(0, priorBesho.displayedScore)} pts{" "}
        {testMode ? "this week (test mode)" : "last week"} —{" "}
        {tier.emoji && <span className="mr-1">{tier.emoji}</span>}
        {tier.name} unlocked. Pick a reward at this tier or any below.
      </p>
      <p className="mb-4 text-sm italic text-muted-foreground/70">
        Pick blind. The description reveals once you commit.
      </p>

      <div className="mb-3">
        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Tier
        </label>
        <div className="flex flex-wrap gap-2">
          {claimableTiers.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                void vibrate(20, "light");
                setSelectedTierId(t.id);
                setSelectedRewardId(t.rewards[0]?.id ?? "");
              }}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors active:scale-95",
                selectedTierId === t.id
                  ? "border-primary bg-primary/20 text-primary"
                  : "border-border/40 bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          Reward
        </label>
        <div className="space-y-2">
          {selectedTier.rewards.map((r) => (
            <RewardOption
              key={r.id}
              reward={r}
              checked={selectedRewardId === r.id}
              onSelect={() => {
                void vibrate(15, "light");
                setSelectedRewardId(r.id);
              }}
            />
          ))}
        </div>
      </div>

      {localError && (
        <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {localError}
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting || !selectedRewardId || unlockedClaim !== null}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
        Claim
      </button>

      {/* Unlock animation. AnimatePresence's `onExitComplete` defers
       *  the parent refresh until the exit animation finishes — without
       *  it the picker would unmount mid-exit when the bundle re-fetch
       *  populates `priorClaim` / `currentClaim`, yanking the modal. */}
      <AnimatePresence
        onExitComplete={() => {
          void onRefresh();
        }}
      >
        {unlockedClaim && (
          <RewardUnlockOverlay
            claim={unlockedClaim}
            onDismiss={() => setUnlockedClaim(null)}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

function RewardOption({
  reward,
  checked,
  onSelect,
}: {
  reward: RewardItem;
  checked: boolean;
  onSelect: () => void;
}) {
  // Body intentionally NOT shown in the picker. The description is the
  // reveal — she commits blind, then sees what she got in
  // ClaimStatusCard once the claim record exists.
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors active:scale-[0.98]",
        checked
          ? "border-primary/60 bg-primary/10"
          : "border-border/40 bg-card hover:border-border",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 flex-none items-center justify-center rounded-full border-2",
          checked ? "border-primary bg-primary/30" : "border-border",
        )}
      >
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
      </span>
      {reward.emoji ? (
        <span className="flex-none text-base leading-none">
          {reward.emoji}
        </span>
      ) : (
        <Gift className="h-4 w-4 flex-none text-primary/70" />
      )}
      <span
        dir="auto"
        className="min-w-0 flex-1 truncate text-sm font-semibold"
      >
        {reward.label}
      </span>
    </button>
  );
}

// ── Claim status ─────────────────────────────────────────────────────────

function ClaimStatusCard({ claim }: { claim: RewardClaim }) {
  const statusLabel = {
    pending: "Awaiting Sir",
    delivered: "Delivered",
    denied: "Denied",
  }[claim.status];
  const statusClass = {
    pending: "text-amber-400",
    delivered: "text-emerald-400",
    denied: "text-rose-400",
  }[claim.status];
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Gift className="h-4 w-4 text-primary/70" />
        Last week&apos;s claim
      </h2>
      <p className="text-sm text-muted-foreground">
        {formatWeekRange(claim.weekKey)} •{" "}
        {claim.tierEmoji && <span className="mr-1">{claim.tierEmoji}</span>}
        {claim.tierName}
      </p>
      <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
        {claim.rewardEmoji && (
          <span className="text-base leading-none">{claim.rewardEmoji}</span>
        )}
        <span dir="auto">{claim.rewardLabel}</span>
      </p>
      {claim.rewardBody && (
        <p
          dir="auto"
          className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-muted-foreground"
        >
          {claim.rewardBody}
        </p>
      )}
      <p className={cn("mt-3 text-xs font-bold uppercase tracking-wider", statusClass)}>
        {statusLabel}
      </p>
      {claim.sirNote && (
        <p className="mt-1 text-sm text-muted-foreground">
          <span>Sir: </span>
          <span dir="auto" className="whitespace-pre-wrap">
            {claim.sirNote}
          </span>
        </p>
      )}
    </section>
  );
}

// ── Sir-only pending claim card ──────────────────────────────────────────

function PendingClaimCard({
  claim,
  onRefresh,
}: {
  claim: RewardClaim;
  onRefresh: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"deliver" | "deny" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (decision: "deliver" | "deny") => {
    setBusy(decision);
    setLocalError(null);
    void vibrate(40, "medium");
    const result =
      decision === "deliver"
        ? await deliverClaim(claim.id, note || undefined)
        : await denyClaim(claim.id, note || undefined);
    setBusy(null);
    if (result.error) {
      setLocalError(result.error);
      return;
    }
    void onRefresh();
  };

  return (
    <section className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Award className="h-4 w-4 text-amber-400" />
        Pending claim
      </h2>
      <p className="text-sm text-muted-foreground">
        {formatWeekRange(claim.weekKey)} •{" "}
        {claim.tierEmoji && <span className="mr-1">{claim.tierEmoji}</span>}
        {claim.tierName} • {claim.claimedScore} pts
      </p>
      <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
        {claim.rewardEmoji && (
          <span className="text-base leading-none">{claim.rewardEmoji}</span>
        )}
        <span dir="auto">{claim.rewardLabel}</span>
      </p>
      {claim.rewardBody && (
        <p
          dir="auto"
          className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-muted-foreground"
        >
          {claim.rewardBody}
        </p>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (kitten will see this)"
        rows={2}
        maxLength={500}
        dir="auto"
        className="mt-3 w-full rounded-lg border border-border/60 bg-input/50 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
      />

      {localError && (
        <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {localError}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void submit("deliver")}
          disabled={busy !== null}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-emerald-500/90 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white transition-opacity active:scale-95 disabled:opacity-60"
        >
          {busy === "deliver" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          Deliver
        </button>
        <button
          type="button"
          onClick={() => void submit("deny")}
          disabled={busy !== null}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-full bg-rose-500/80 px-3 py-2 text-xs font-bold uppercase tracking-wider text-white transition-opacity active:scale-95 disabled:opacity-60"
        >
          {busy === "deny" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <X className="h-3.5 w-3.5" />
          )}
          Deny
        </button>
      </div>
    </section>
  );
}

// ── Claim history ────────────────────────────────────────────────────────

function ClaimHistoryCard({ claims }: { claims: RewardClaim[] }) {
  const [now] = useState(() => Date.now());
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Award className="h-4 w-4 text-primary/70" />
        Claim history
      </h2>
      <ul className="space-y-2">
        {claims.map((c) => {
          const statusClass = {
            pending: "text-amber-400",
            delivered: "text-emerald-400",
            denied: "text-rose-400",
          }[c.status];
          return (
            <li
              key={c.id}
              className="rounded-lg border border-border/40 bg-card/50 p-3"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {formatWeekRange(c.weekKey)}
                </span>
                <span
                  className={cn(
                    "font-bold uppercase tracking-wider",
                    statusClass,
                  )}
                >
                  {c.status}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
                {c.tierEmoji && (
                  <span className="text-base leading-none">{c.tierEmoji}</span>
                )}
                <span>{c.tierName} —</span>
                {c.rewardEmoji && (
                  <span className="text-base leading-none">{c.rewardEmoji}</span>
                )}
                <span dir="auto">{c.rewardLabel}</span>
              </div>
              <div className="mt-1 text-sm text-muted-foreground/70">
                Claimed {formatRelative(c.requestedAt, now)}
              </div>
              {c.sirNote && (
                <div className="mt-1 text-sm text-muted-foreground">
                  <span>Sir: </span>
                  <span dir="auto" className="whitespace-pre-wrap">
                    {c.sirNote}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Score history archive ────────────────────────────────────────────────

function HistorySection({ entries }: { entries: RewardsHistoryEntry[] }) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5 backdrop-blur-md shadow-xl shadow-black/30">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary/70" />
        Score history
      </h2>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <HistoryRow key={entry.weekKey} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function HistoryRow({ entry }: { entry: RewardsHistoryEntry }) {
  const claim = entry.claim;
  const tier = entry.tier;
  const claimStatusClass = claim
    ? {
        pending: "text-amber-400",
        delivered: "text-emerald-400",
        denied: "text-rose-400",
      }[claim.status]
    : null;
  const historyHeadline = Math.max(0, entry.displayedScore);
  const historyPenalized = entry.displayedScore < 0;
  return (
    <li className="rounded-lg border border-border/40 bg-card/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {formatWeekRange(entry.weekKey)}
        </span>
        <span className="flex items-center gap-2 text-xs">
          <span
            className={cn(
              "tabular-nums font-semibold",
              historyPenalized && "text-muted-foreground/60",
            )}
          >
            {historyHeadline} pts
          </span>
          {historyPenalized && (
            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-rose-400">
              −{Math.abs(entry.displayedScore)}
            </span>
          )}
          {entry.multiplier !== 1 && (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-primary">
              ×{entry.multiplier.toFixed(1)}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          {tier?.emoji && <span>{tier.emoji}</span>}
          <span>{tier ? tier.name : "no tier"}</span>
        </span>
        {claim && (
          <span className="flex items-center gap-1.5">
            {claim.rewardEmoji && (
              <span className="text-sm leading-none">{claim.rewardEmoji}</span>
            )}
            <span dir="auto" className="truncate">
              {claim.rewardLabel}
            </span>
            <span
              className={cn(
                "ml-1 font-bold uppercase tracking-wider",
                claimStatusClass,
              )}
            >
              {claim.status}
            </span>
          </span>
        )}
        {!claim && tier && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
            unclaimed
          </span>
        )}
      </div>
    </li>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-2xl border border-border/40 bg-card"
        />
      ))}
    </div>
  );
}

// ── Reward unlock overlay ────────────────────────────────────────────────
//
// Four-phase reveal animation that fires the moment a claim succeeds:
//   1. (0.0–0.4s)  Backdrop fades in, gift box scales in with a bounce
//   2. (0.4–0.9s)  Gift box wiggles + glow pulse (anticipation)
//   3. (0.9–1.1s)  Gift box bursts (scale-out) + confetti emoji fan
//   4. (1.0–2.0s)  Reveal card scales in with the tier line, the
//                  reward emoji big and bouncy, label, and body
//
// Constraints baked in (per AGENTS.md hot-path animation rules):
//   - No `filter: blur()`. Glow is via animated `box-shadow` on the
//     reveal card (GPU-composited).
//   - No `mode="popLayout"` on AnimatePresence. Default mode is fine.
//   - `will-change-transform` only on the elements that actually animate
//     repeatedly (the box + reveal card).
//   - `useReducedMotion` short-circuits the choreography for users with
//     prefers-reduced-motion (instant reveal, no confetti).

const CONFETTI_PARTICLES = ["✨", "🎉", "💖", "⭐", "🌟", "💫"] as const;
const CONFETTI_COUNT = 18;

function RewardUnlockOverlay({
  claim,
  onDismiss,
}: {
  claim: RewardClaim;
  onDismiss: () => void;
}) {
  const reduced = useReducedMotion();
  const [showHint, setShowHint] = useState(false);

  // Surface the dismiss hint after the reveal has settled, so it
  // doesn't compete with the climax. setState calls are deferred via
  // setTimeout per AGENTS.md § 4 (no synchronous-setState-in-effect).
  useEffect(() => {
    const t = setTimeout(() => setShowHint(true), reduced ? 0 : 2200);
    return () => clearTimeout(t);
  }, [reduced]);

  // Haptic punctuation matching the four phases. Skipped under
  // reduced-motion since the visual choreography is also collapsed.
  useEffect(() => {
    if (reduced) {
      void vibrate(60, "medium");
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => void vibrate(40, "light"), 0));
    timers.push(
      setTimeout(() => void vibrate([20, 30, 20, 30, 20], "light"), 400),
    );
    timers.push(
      setTimeout(() => void vibrate([100, 40, 80], "heavy"), 900),
    );
    timers.push(setTimeout(() => void vibrate(50, "medium"), 1200));
    return () => timers.forEach(clearTimeout);
  }, [reduced]);

  return (
    <motion.div
      key="reward-unlock"
      className="fixed inset-0 z-60 flex items-center justify-center overflow-hidden bg-black/85 px-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
      aria-label="Reward unlock"
    >
      {/* Phase 1+2+3 — gift box. Disappears at the burst. */}
      {!reduced && (
        <motion.div
          className="absolute inset-0 flex items-center justify-center"
          initial={{ scale: 0, opacity: 0, rotate: 0 }}
          animate={{
            scale: [0, 1.1, 1, 1.05, 1, 1.05, 1, 0],
            opacity: [0, 1, 1, 1, 1, 1, 1, 0],
            rotate: [0, 0, -10, 10, -10, 10, 0, 0],
          }}
          transition={{
            duration: 1.0,
            times: [0, 0.18, 0.3, 0.42, 0.54, 0.66, 0.8, 1],
            ease: "easeInOut",
          }}
        >
          <span
            className="text-9xl will-change-transform"
            style={{
              textShadow:
                "0 0 32px hsl(var(--primary) / 0.6), 0 0 64px hsl(var(--primary) / 0.3)",
            }}
          >
            🎁
          </span>
        </motion.div>
      )}

      {/* Phase 3 — confetti burst. Renders only on the live tick the
       *  box opens; AnimatePresence handles cleanup. */}
      {!reduced && <ConfettiBurst delay={0.85} />}

      {/* Phase 4 — reveal card. */}
      <motion.div
        className="relative max-w-sm overflow-hidden rounded-3xl border border-primary/40 bg-card/95 px-6 py-7 shadow-xl shadow-black/60 will-change-transform"
        initial={{ scale: reduced ? 1 : 0, opacity: reduced ? 1 : 0, y: 12 }}
        animate={{
          scale: 1,
          opacity: 1,
          y: 0,
          boxShadow: reduced
            ? undefined
            : [
                "0 0 0 hsl(var(--primary) / 0)",
                "0 0 80px hsl(var(--primary) / 0.5)",
                "0 0 30px hsl(var(--primary) / 0.25)",
              ],
        }}
        transition={{
          delay: reduced ? 0 : 1.0,
          type: "spring",
          stiffness: 260,
          damping: 18,
          boxShadow: { duration: 1.4, times: [0, 0.4, 1] },
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tier line */}
        <motion.p
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduced ? 0 : 1.25, duration: 0.3 }}
          className="text-center text-xs font-bold uppercase tracking-widest text-primary/80"
        >
          {claim.tierEmoji && (
            <span className="mr-1">{claim.tierEmoji}</span>
          )}
          {claim.tierName}
        </motion.p>

        {/* Reward emoji — the main spectacle */}
        <motion.div
          className="my-4 flex items-center justify-center"
          initial={{
            scale: reduced ? 1 : 0,
            rotate: reduced ? 0 : -180,
          }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{
            delay: reduced ? 0 : 1.35,
            type: "spring",
            stiffness: 220,
            damping: 12,
          }}
        >
          <span className="select-none text-7xl will-change-transform">
            {claim.rewardEmoji ?? "🎁"}
          </span>
        </motion.div>

        {/* Reward label */}
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: reduced ? 0 : 1.55, duration: 0.3 }}
          dir="auto"
          className="text-center text-xl font-bold leading-tight"
        >
          {claim.rewardLabel}
        </motion.p>

        {/* Reward body — the surprise reveal */}
        {claim.rewardBody && (
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: reduced ? 0 : 1.75, duration: 0.4 }}
            dir="auto"
            className="mt-3 whitespace-pre-wrap text-center text-base leading-relaxed text-muted-foreground"
          >
            {claim.rewardBody}
          </motion.p>
        )}

        {/* Tier-claim hint */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: reduced ? 0 : 1.95, duration: 0.3 }}
          className="mt-5 text-center text-xs uppercase tracking-widest text-muted-foreground/70"
        >
          {claim.testMode
            ? "Test mode — claim recorded for current week"
            : "Awaiting Sir to deliver"}
        </motion.p>

        {showHint && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.7 }}
            transition={{ duration: 0.5 }}
            className="mt-2 text-center text-[11px] uppercase tracking-widest text-muted-foreground/50"
          >
            Tap anywhere to close
          </motion.p>
        )}
      </motion.div>
    </motion.div>
  );
}

function ConfettiBurst({ delay }: { delay: number }) {
  // Generate the layout once on mount so re-renders don't reshuffle the
  // particles mid-animation. Each particle gets a deterministic
  // position based on its index plus a hashed jitter — pure but
  // varied.
  const [particles] = useState(() =>
    Array.from({ length: CONFETTI_COUNT }, (_, i) => {
      const angle = (i / CONFETTI_COUNT) * Math.PI * 2;
      const jitter = ((i * 1103515245 + 12345) & 0xff) / 0xff;
      const distance = 160 + jitter * 80;
      return {
        i,
        emoji: CONFETTI_PARTICLES[i % CONFETTI_PARTICLES.length],
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        rotate: jitter * 720 - 360,
      };
    }),
  );
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
      aria-hidden
    >
      {particles.map((p) => (
        <motion.span
          key={p.i}
          className="absolute text-2xl"
          initial={{ x: 0, y: 0, opacity: 0, scale: 0, rotate: 0 }}
          animate={{
            x: p.x,
            y: p.y,
            opacity: [0, 1, 1, 0],
            scale: [0, 1.3, 1, 0.4],
            rotate: p.rotate,
          }}
          transition={{
            delay,
            duration: 1.5,
            ease: "easeOut",
            opacity: { duration: 1.5, times: [0, 0.15, 0.7, 1] },
            scale: { duration: 1.5, times: [0, 0.2, 0.6, 1] },
          }}
        >
          {p.emoji}
        </motion.span>
      ))}
    </div>
  );
}
