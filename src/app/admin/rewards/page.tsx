"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Award,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import {
  adminAdjustScore,
  adminDeleteObedienceEvent,
  adminPurgeTestClaims,
  getObedienceAdminSnapshot,
  getObedienceEventLog,
  getTestModeState,
  recomputeWeek,
  setObedienceWeights,
  setRewardTiers,
  setStreakSettings,
  setTestModeState,
  type ObedienceAdminSnapshot,
} from "@/app/actions/admin";
import type { ObedienceAuditEntry } from "@/lib/obedience";
import {
  MANUAL_ADJUST_MAX,
  MANUAL_ADJUST_MIN,
  MANUAL_ADJUST_REASON_MAX,
  OBEDIENCE_EVENT_LABELS,
  REWARD_BODY_MAX,
  REWARD_EMOJI_MAX,
  REWARD_LABEL_MAX,
  TIER_EMOJI_MAX,
  TIER_NAME_MAX,
  TUNABLE_EVENT_TYPES,
  MAX_REWARDS_PER_TIER,
  MAX_TIER_THRESHOLD,
  type ObedienceEventType,
  type ObedienceWeights,
  type RewardItem,
  type RewardTier,
} from "@/lib/reward-types";
import type { Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export default function AdminRewardsPage() {
  const [snapshot, setSnapshot] = useState<ObedienceAdminSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSnapshot = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getObedienceAdminSnapshot();
      if (result.error) setError(result.error);
      else if (result.snapshot) {
        setSnapshot(result.snapshot);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchSnapshot();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchSnapshot]);

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <button
          type="button"
          onClick={() => {
            void vibrate(20, "light");
            void fetchSnapshot();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Rewards & obedience</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Status, manual adjustments, and audit live on the Status tab. Tier
        catalog, score weights, and streak settings each have their own tab.
        Changes take effect at the next read (5s cache).
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!snapshot ? (
        <Skeleton />
      ) : (
        <Tabs defaultValue="status">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="tiers">Tiers</TabsTrigger>
            <TabsTrigger value="weights">Weights</TabsTrigger>
            <TabsTrigger value="streak">Streak</TabsTrigger>
          </TabsList>

          <TabsContent value="status" className="space-y-6">
            <CurrentScoreSection
              snapshot={snapshot}
              onRefresh={fetchSnapshot}
            />
            <TestModeToggle />
            <ManualAdjustEditor onSaved={fetchSnapshot} />
            <EventLogViewer
              initialWeekKey={snapshot.besho.currentWeek.weekKey}
            />
          </TabsContent>

          <TabsContent value="tiers" className="space-y-6">
            <TierCatalogEditor
              initialTiers={snapshot.tiers}
              onSaved={fetchSnapshot}
            />
          </TabsContent>

          <TabsContent value="weights" className="space-y-6">
            <WeightsEditor
              initialWeights={snapshot.weights}
              onSaved={fetchSnapshot}
            />
          </TabsContent>

          <TabsContent value="streak" className="space-y-6">
            <StreakSettingsEditor
              initialThreshold={snapshot.streakThreshold}
              initialMultipliers={snapshot.multipliers}
              onSaved={fetchSnapshot}
            />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

// ── Current score + recompute ─────────────────────────────────────────────

function CurrentScoreSection({
  snapshot,
  onRefresh,
}: {
  snapshot: ObedienceAdminSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleRecompute = async () => {
    setBusy(true);
    setMsg(null);
    void vibrate(30, "light");
    const result = await recomputeWeek("Besho", snapshot.besho.currentWeek.weekKey);
    setBusy(false);
    if (result.error) setMsg(result.error);
    else if (result.finalized)
      setMsg(`Finalized — displayed score ${result.displayedScore}.`);
    else setMsg(`Skipped (${result.reason ?? "no reason"}).`);
    void onRefresh();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Award className="h-4 w-4 text-primary/70" />
        kitten — this week
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
        <Stat label="Week" value={snapshot.besho.currentWeek.weekKey} />
        <Stat
          label="Raw"
          value={String(snapshot.besho.currentWeek.rawScore)}
        />
        <Stat
          label="Displayed"
          value={String(snapshot.besho.currentWeek.displayedScore)}
        />
        <Stat label="Streak" value={String(snapshot.besho.streak)} />
      </dl>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleRecompute()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          Finalize current week (admin)
        </button>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm font-bold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

// ── Test mode toggle ─────────────────────────────────────────────────────

function TestModeToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        const result = await getTestModeState();
        if (typeof result.on === "boolean") setOn(result.on);
      })();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Auto-cancel the purge confirm after 5s, matching the trash pattern.
  useEffect(() => {
    if (!confirmingPurge) return;
    const t = setTimeout(() => setConfirmingPurge(false), 5_000);
    return () => clearTimeout(t);
  }, [confirmingPurge]);

  const toggle = async () => {
    if (on === null) return;
    const next = !on;
    setBusy(true);
    setErr(null);
    void vibrate(40, "medium");
    const result = await setTestModeState(next);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    if (typeof result.on === "boolean") setOn(result.on);
  };

  const purge = async () => {
    if (!confirmingPurge) {
      setConfirmingPurge(true);
      void vibrate(40, "medium");
      return;
    }
    setPurging(true);
    setPurgeMsg(null);
    void vibrate([100, 50, 100], "heavy");
    const result = await adminPurgeTestClaims();
    setPurging(false);
    setConfirmingPurge(false);
    if (result.error) {
      setPurgeMsg(`Failed: ${result.error}`);
      return;
    }
    setPurgeMsg(
      `Removed ${result.removed ?? 0} test claim${result.removed === 1 ? "" : "s"}.`,
    );
  };

  return (
    <section
      className={cn(
        "rounded-2xl border p-5",
        on
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-border/40 bg-card",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Test mode</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When ON, kitten can claim a reward against the{" "}
            <span className="font-semibold text-foreground">current</span>{" "}
            week without ending it. Streak counter and frozen multiplier
            are untouched. The claim still goes through normal
            deliver/deny — useful for verifying the full flow before a
            real week-close. Test claims are filtered out of her
            permanent history.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={busy || on === null}
          className={cn(
            "flex flex-none items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold uppercase tracking-wider transition-opacity active:scale-95 disabled:opacity-60",
            on
              ? "bg-amber-500/90 text-white"
              : "bg-primary text-primary-foreground",
          )}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {on === null ? "…" : on ? "Disable" : "Enable"}
        </button>
      </div>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/30 pt-4">
        <button
          type="button"
          onClick={() => void purge()}
          disabled={purging}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors active:scale-95 disabled:opacity-50",
            confirmingPurge
              ? "border-rose-500/60 bg-rose-500/15 text-rose-400"
              : "border-rose-500/30 bg-rose-500/10 text-rose-400 hover:border-rose-500/60",
          )}
        >
          {purging ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
          {confirmingPurge ? "Confirm purge" : "Purge test claims"}
        </button>
        <p className="text-sm text-muted-foreground">
          Wipes every claim flagged as test mode (and any current/future
          week claim — legacy fallback). Hard delete, no trash.
        </p>
      </div>
      {purgeMsg && (
        <p className="mt-2 text-sm text-emerald-400">{purgeMsg}</p>
      )}
    </section>
  );
}

// ── Manual obedience adjustment ──────────────────────────────────────────

function ManualAdjustEditor({
  onSaved,
}: {
  onSaved: () => Promise<void>;
}) {
  const [author, setAuthor] = useState<Author>("Besho");
  const [pointsText, setPointsText] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async () => {
    const points = Number(pointsText);
    if (
      !Number.isFinite(points) ||
      points < MANUAL_ADJUST_MIN ||
      points > MANUAL_ADJUST_MAX
    ) {
      setErr(`Points must be ${MANUAL_ADJUST_MIN}..${MANUAL_ADJUST_MAX}.`);
      return;
    }
    if (Math.round(points) === 0) {
      setErr("Adjustment cannot be zero.");
      return;
    }
    if (!reason.trim()) {
      setErr("Reason is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await adminAdjustScore({
      author,
      points: Math.round(points),
      reason: reason.trim(),
    });
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg(`Applied ${points > 0 ? "+" : ""}${Math.round(points)} pts.`);
    setPointsText("");
    setReason("");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Manual adjustment</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Ad-hoc score adjustment when a behavior is outside the standard
        event types. Lands as a <code>manual_adjust</code> emit in the
        current week. Reason is logged to <code>/admin/activity</code>.
      </p>

      <div className="grid gap-3 md:grid-cols-[1fr_1fr_2fr]">
        <Field label="Author">
          <select
            value={author}
            onChange={(e) => setAuthor(e.target.value as Author)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
          >
            <option value="Besho">Besho</option>
            <option value="T7SEN">T7SEN</option>
          </select>
        </Field>
        <Field label={`Points (${MANUAL_ADJUST_MIN}..${MANUAL_ADJUST_MAX})`}>
          <input
            type="number"
            inputMode="numeric"
            value={pointsText}
            onChange={(e) => setPointsText(e.target.value)}
            placeholder="+5 or -5"
            min={MANUAL_ADJUST_MIN}
            max={MANUAL_ADJUST_MAX}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label="Reason (required)">
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MANUAL_ADJUST_REASON_MAX}
            placeholder="why this adjustment exists"
            dir="auto"
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Apply
        </button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </section>
  );
}

// ── Tier catalog editor ──────────────────────────────────────────────────

function TierCatalogEditor({
  initialTiers,
  onSaved,
}: {
  initialTiers: RewardTier[];
  onSaved: () => Promise<void>;
}) {
  const [tiers, setTiers] = useState<RewardTier[]>(() => deepCloneTiers(initialTiers));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const updateTier = (index: number, patch: Partial<RewardTier>) => {
    setTiers((prev) =>
      prev.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    );
  };

  const updateReward = (
    tierIndex: number,
    rewardIndex: number,
    patch: Partial<RewardItem>,
  ) => {
    setTiers((prev) =>
      prev.map((t, i) => {
        if (i !== tierIndex) return t;
        const rewards = t.rewards.map((r, j) =>
          j === rewardIndex ? { ...r, ...patch } : r,
        );
        return { ...t, rewards };
      }),
    );
  };

  const addReward = (tierIndex: number) => {
    setTiers((prev) =>
      prev.map((t, i) => {
        if (i !== tierIndex) return t;
        if (t.rewards.length >= MAX_REWARDS_PER_TIER) return t;
        const rewards = [
          ...t.rewards,
          {
            id: `${t.id}-r${Date.now().toString(36)}`,
            label: "New reward",
            body: "",
          },
        ];
        return { ...t, rewards };
      }),
    );
  };

  const deleteReward = (tierIndex: number, rewardIndex: number) => {
    setTiers((prev) =>
      prev.map((t, i) => {
        if (i !== tierIndex) return t;
        const rewards = t.rewards.filter((_, j) => j !== rewardIndex);
        return { ...t, rewards };
      }),
    );
  };

  const moveReward = (
    tierIndex: number,
    rewardIndex: number,
    direction: -1 | 1,
  ) => {
    setTiers((prev) =>
      prev.map((t, i) => {
        if (i !== tierIndex) return t;
        const target = rewardIndex + direction;
        if (target < 0 || target >= t.rewards.length) return t;
        const rewards = t.rewards.slice();
        const [item] = rewards.splice(rewardIndex, 1);
        rewards.splice(target, 0, item);
        return { ...t, rewards };
      }),
    );
  };

  const handleReset = () => {
    setTiers(deepCloneTiers(initialTiers));
    setErr(null);
    setMsg(null);
  };

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const sanitized = tiers.map((t) => ({
      ...t,
      ...(t.emoji && t.emoji.trim().length > 0
        ? { emoji: t.emoji.trim() }
        : { emoji: undefined }),
      rewards: t.rewards.map((r) => ({
        id: r.id,
        label: r.label,
        ...(r.body && r.body.length > 0 ? { body: r.body } : {}),
        ...(r.emoji && r.emoji.trim().length > 0
          ? { emoji: r.emoji.trim() }
          : {}),
      })),
    }));
    const result = await setRewardTiers(sanitized);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg("Saved.");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Tier catalog</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Tier count is fixed at 5. Thresholds must be ascending. Each tier
        holds up to {MAX_REWARDS_PER_TIER} rewards.
      </p>

      <div className="space-y-4">
        {tiers.map((tier, ti) => (
          <div
            key={tier.id}
            className="rounded-xl border border-border/40 bg-card/50 p-4"
          >
            <div className="grid gap-3 md:grid-cols-[auto_1fr_auto_auto]">
              <Field label="Emoji">
                <input
                  type="text"
                  value={tier.emoji ?? ""}
                  maxLength={TIER_EMOJI_MAX}
                  onChange={(e) =>
                    updateTier(ti, { emoji: e.target.value })
                  }
                  placeholder="🥉"
                  aria-label="Tier emoji"
                  className="w-14 rounded border border-border/60 bg-input/40 px-2 py-1 text-center text-base focus:border-primary focus:outline-none"
                />
              </Field>
              <Field label="Name">
                <input
                  type="text"
                  value={tier.name}
                  maxLength={TIER_NAME_MAX}
                  onChange={(e) => updateTier(ti, { name: e.target.value })}
                  dir="auto"
                  className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
                />
              </Field>
              <Field label="Threshold">
                <input
                  type="number"
                  inputMode="numeric"
                  value={tier.threshold}
                  min={0}
                  max={MAX_TIER_THRESHOLD}
                  onChange={(e) =>
                    updateTier(ti, { threshold: Number(e.target.value) || 0 })
                  }
                  className="w-24 rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
                />
              </Field>
              <Field label="ID">
                <span className="block truncate rounded border border-border/40 bg-card/30 px-2 py-1 text-xs text-muted-foreground">
                  {tier.id}
                </span>
              </Field>
            </div>

            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                  Rewards ({tier.rewards.length}/{MAX_REWARDS_PER_TIER})
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void vibrate(20, "light");
                    addReward(ti);
                  }}
                  disabled={tier.rewards.length >= MAX_REWARDS_PER_TIER}
                  className="flex items-center gap-1 rounded-full border border-border/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
              <div className="space-y-2">
                {tier.rewards.map((r, ri) => (
                  <div
                    key={r.id}
                    className="rounded-lg border border-border/40 bg-card p-3"
                  >
                    <div className="grid gap-2 md:grid-cols-[auto_1fr_auto]">
                      <input
                        type="text"
                        value={r.emoji ?? ""}
                        maxLength={REWARD_EMOJI_MAX}
                        onChange={(e) =>
                          updateReward(ti, ri, { emoji: e.target.value })
                        }
                        placeholder="🎁"
                        aria-label="Emoji"
                        className="w-12 rounded border border-border/60 bg-input/40 px-2 py-1 text-center text-base focus:border-primary focus:outline-none"
                      />
                      <input
                        type="text"
                        value={r.label}
                        maxLength={REWARD_LABEL_MAX}
                        onChange={(e) =>
                          updateReward(ti, ri, { label: e.target.value })
                        }
                        placeholder="Label"
                        dir="auto"
                        className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
                      />
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => moveReward(ti, ri, -1)}
                          disabled={ri === 0}
                          className="rounded border border-border/40 px-2 py-1 text-[10px] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() => moveReward(ti, ri, 1)}
                          disabled={ri === tier.rewards.length - 1}
                          className="rounded border border-border/40 px-2 py-1 text-[10px] disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void vibrate(40, "medium");
                            deleteReward(ti, ri);
                          }}
                          className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-400 transition-colors hover:border-rose-500/60"
                          aria-label="Delete reward"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <textarea
                      value={r.body ?? ""}
                      maxLength={REWARD_BODY_MAX}
                      rows={2}
                      onChange={(e) =>
                        updateReward(ti, ri, { body: e.target.value })
                      }
                      placeholder="Description (optional)"
                      dir="auto"
                      className="mt-2 w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
                    />
                  </div>
                ))}
                {tier.rewards.length === 0 && (
                  <p className="text-xs text-muted-foreground/70">
                    No rewards. Add at least one for kitten to claim.
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <SaveBar
        busy={busy}
        msg={msg}
        err={err}
        onSave={handleSave}
        onReset={handleReset}
      />
    </section>
  );
}

function deepCloneTiers(tiers: RewardTier[]): RewardTier[] {
  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    threshold: t.threshold,
    ...(t.emoji !== undefined && { emoji: t.emoji }),
    rewards: t.rewards.map((r) => ({
      id: r.id,
      label: r.label,
      ...(r.body !== undefined && { body: r.body }),
      ...(r.emoji !== undefined && { emoji: r.emoji }),
    })),
  }));
}

// ── Weights editor ───────────────────────────────────────────────────────

function WeightsEditor({
  initialWeights,
  onSaved,
}: {
  initialWeights: ObedienceWeights;
  onSaved: () => Promise<void>;
}) {
  const [weights, setWeights] = useState<ObedienceWeights>(() => ({
    ...initialWeights,
  }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const update = (type: ObedienceEventType, value: number) => {
    setWeights((prev) => ({ ...prev, [type]: value }));
  };

  const handleReset = () => {
    setWeights({ ...initialWeights });
    setErr(null);
    setMsg(null);
  };

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await setObedienceWeights(weights);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg("Saved.");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Score weights</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Each event type&apos;s points value. Range −100..100. Existing
        emissions are unaffected — only future events use the new weight.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {TUNABLE_EVENT_TYPES.map((type) => (
          <Field key={type} label={OBEDIENCE_EVENT_LABELS[type]}>
            <input
              type="number"
              inputMode="numeric"
              value={weights[type]}
              min={-100}
              max={100}
              onChange={(e) => update(type, Number(e.target.value) || 0)}
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
            />
          </Field>
        ))}
      </div>
      <SaveBar
        busy={busy}
        msg={msg}
        err={err}
        onSave={handleSave}
        onReset={handleReset}
      />
    </section>
  );
}

// ── Streak settings ──────────────────────────────────────────────────────

function StreakSettingsEditor({
  initialThreshold,
  initialMultipliers,
  onSaved,
}: {
  initialThreshold: number;
  initialMultipliers: readonly number[];
  onSaved: () => Promise<void>;
}) {
  const [threshold, setThreshold] = useState<number>(initialThreshold);
  const [multipliersText, setMultipliersText] = useState<string>(
    initialMultipliers.join(", "),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleReset = () => {
    setThreshold(initialThreshold);
    setMultipliersText(initialMultipliers.join(", "));
    setErr(null);
    setMsg(null);
  };

  const handleSave = async () => {
    const mults = multipliersText
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (mults.length === 0) {
      setErr("Multipliers required.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await setStreakSettings(threshold, mults);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg("Saved.");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Streak threshold + multipliers</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        High-score weeks (displayed score ≥ threshold) accumulate a streak.
        The Nth entry of the multiplier ladder applies on the (N)th
        consecutive prior high-score week — index 0 = no streak (×1.0).
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Threshold">
          <input
            type="number"
            inputMode="numeric"
            value={threshold}
            min={0}
            max={MAX_TIER_THRESHOLD}
            onChange={(e) => setThreshold(Number(e.target.value) || 0)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label="Multipliers (comma-separated)">
          <input
            type="text"
            value={multipliersText}
            onChange={(e) => setMultipliersText(e.target.value)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
            placeholder="1.0, 1.1, 1.2, 1.3"
          />
        </Field>
      </div>
      <SaveBar
        busy={busy}
        msg={msg}
        err={err}
        onSave={handleSave}
        onReset={handleReset}
      />
    </section>
  );
}

// ── Event log viewer ─────────────────────────────────────────────────────

function EventLogViewer({ initialWeekKey }: { initialWeekKey: string }) {
  const [author, setAuthor] = useState<Author>("Besho");
  const [weekKey, setWeekKey] = useState<string>(initialWeekKey);
  const [entries, setEntries] = useState<ObedienceAuditEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const fetchLog = useCallback(async () => {
    setBusy(true);
    setErr(null);
    const result = await getObedienceEventLog(author, weekKey, 200);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setEntries(result.entries ?? []);
  }, [author, weekKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchLog();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchLog]);

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Event log</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Per-week audit of every obedience emit, joined from
        <code className="mx-1">obedience:events:*</code> +
        <code className="mx-1">obedience:audit:*</code>. Newest first.
        Reasons for <code>manual_adjust</code> live in
        <code className="mx-1">/admin/activity</code>, not here.
      </p>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <Field label="Author">
          <select
            value={author}
            onChange={(e) => setAuthor(e.target.value as Author)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
          >
            <option value="Besho">Besho</option>
            <option value="T7SEN">T7SEN</option>
          </select>
        </Field>
        <Field label="Week (Sunday YYYY-MM-DD)">
          <input
            type="text"
            value={weekKey}
            onChange={(e) => setWeekKey(e.target.value)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </Field>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => void fetchLog()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Reload
          </button>
        </div>
      </div>

      {err && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {err}
        </div>
      )}

      {entries && entries.length === 0 && !err && (
        <p className="mt-3 text-xs text-muted-foreground">
          No events for this week.
        </p>
      )}

      {entries && entries.length > 0 && (
        <ul className="mt-4 space-y-1">
          {entries.map((e) => (
            <EventRow
              key={`${e.type}:${e.eventId}`}
              entry={e}
              author={author}
              weekKey={weekKey}
              now={now}
              onDeleted={() => {
                setEntries((prev) =>
                  prev
                    ? prev.filter(
                        (x) =>
                          !(x.type === e.type && x.eventId === e.eventId),
                      )
                    : prev,
                );
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EventRow({
  entry,
  author,
  weekKey,
  now,
  onDeleted,
}: {
  entry: ObedienceAuditEntry;
  author: Author;
  weekKey: string;
  now: number;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Auto-cancel the "Confirm" state after 5s, matching the trash page
  // pattern. Sir won't accidentally arm a delete and forget.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5_000);
    return () => clearTimeout(t);
  }, [confirming]);

  const handleClick = async () => {
    if (!confirming) {
      setConfirming(true);
      void vibrate(40, "medium");
      return;
    }
    setBusy(true);
    setErr(null);
    void vibrate([100, 50, 100], "heavy");
    const result = await adminDeleteObedienceEvent({
      author,
      weekKey,
      type: entry.type,
      eventId: entry.eventId,
    });
    setBusy(false);
    setConfirming(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    onDeleted();
  };

  return (
    <li className="grid grid-cols-[auto_1fr_auto_auto_auto] items-baseline gap-3 rounded border border-border/30 bg-card/40 px-2.5 py-1.5 text-xs">
      <span
        className={cn(
          "tabular-nums font-bold",
          entry.points >= 0 ? "text-emerald-400" : "text-rose-400",
        )}
      >
        {entry.points >= 0 ? "+" : ""}
        {entry.points}
      </span>
      <span className="truncate">
        {OBEDIENCE_EVENT_LABELS[entry.type] ?? entry.type}
        {err && (
          <span className="ml-2 text-rose-400">{err}</span>
        )}
      </span>
      <span
        className="truncate text-muted-foreground/70"
        title={entry.eventId}
      >
        {shortId(entry.eventId)}
      </span>
      <span className="text-muted-foreground/70">
        {formatRelativeTs(entry.ts, now)}
      </span>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={busy}
        aria-label={
          confirming
            ? `Confirm delete; will undo ${entry.points >= 0 ? "+" : ""}${entry.points} pts`
            : "Delete event"
        }
        className={cn(
          "flex items-center justify-center rounded border px-2 py-1 transition-colors active:scale-95 disabled:opacity-50",
          confirming
            ? "border-rose-500/60 bg-rose-500/15 text-rose-400"
            : "border-border/40 text-muted-foreground/70 hover:border-rose-500/40 hover:text-rose-400",
        )}
        title={
          confirming
            ? `Confirm — will move score by ${entry.points >= 0 ? "−" : "+"}${Math.abs(entry.points)}`
            : "Delete (two taps)"
        }
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : confirming ? (
          <span className="text-[10px] font-bold uppercase tracking-wider">
            Confirm
          </span>
        ) : (
          <Trash2 className="h-3 w-3" />
        )}
      </button>
    </li>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

// ── Shared UI primitives ─────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function SaveBar({
  busy,
  msg,
  err,
  onSave,
  onReset,
}: {
  busy: boolean;
  msg: string | null;
  err: string | null;
  onSave: () => void | Promise<void>;
  onReset: () => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={busy}
        className={cn(
          "flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60",
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5" />
        )}
        Save
      </button>
      <button
        type="button"
        onClick={onReset}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
      >
        <RotateCcw className="h-3 w-3" />
        Reset
      </button>
      {msg && <span className="text-xs text-emerald-400">{msg}</span>}
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-2xl border border-border/40 bg-card"
        />
      ))}
    </div>
  );
}
