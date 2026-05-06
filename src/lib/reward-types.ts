// src/lib/reward-types.ts
//
// Types + defaults for the obedience-score / rewards system. Pure
// definitions; no Redis, no server actions. Imported by `obedience.ts`,
// `rewards.ts`, `admin.ts`, and any UI surface that renders score state.

import type { Author } from "./constants";

export type ObedienceEventType =
  | "task_on_time"
  | "task_late"
  | "task_missed"
  | "ritual_on_time"
  | "ritual_missed"
  | "rule_acked"
  | "rule_unacked"
  | "permission_approved"
  | "permission_reasked"
  | "mood_checkin"
  | "restraint_engaged"
  | "ledger_punishment"
  | "manual_adjust";

export const OBEDIENCE_EVENT_TYPES: readonly ObedienceEventType[] = [
  "task_on_time",
  "task_late",
  "task_missed",
  "ritual_on_time",
  "ritual_missed",
  "rule_acked",
  "rule_unacked",
  "permission_approved",
  "permission_reasked",
  "mood_checkin",
  "restraint_engaged",
  "ledger_punishment",
  "manual_adjust",
] as const;

/** Event types whose default weight is configurable in the admin UI.
 *  Excludes `manual_adjust` because its points are always supplied per
 *  emit by Sir; the stored default of 0 is meaningless. */
export const TUNABLE_EVENT_TYPES: readonly ObedienceEventType[] =
  OBEDIENCE_EVENT_TYPES.filter((t) => t !== "manual_adjust");

export type ObedienceWeights = Record<ObedienceEventType, number>;

export interface RewardItem {
  id: string;
  label: string;
  body?: string;
  /** Optional emoji shown alongside the label in claim picker + history.
   *  Stored as raw codepoints; validation caps at REWARD_EMOJI_MAX chars
   *  to allow compound emoji while rejecting arbitrary text. */
  emoji?: string;
}

export interface RewardTier {
  id: string;
  name: string;
  threshold: number;
  rewards: RewardItem[];
}

export interface ObedienceBreakdownEntry {
  type: ObedienceEventType;
  count: number;
  points: number;
}

export interface ObedienceWeekScore {
  weekKey: string;
  rawScore: number;
  multiplier: number;
  displayedScore: number;
  /** Streak count entering this week (consecutive prior high-score weeks). */
  streakEntering: number;
  breakdown: ObedienceBreakdownEntry[];
}

export interface ObedienceWeekState extends ObedienceWeekScore {
  /** Highest tier whose threshold ≤ displayedScore, or null. */
  unlockedTier: RewardTier | null;
  tiers: RewardTier[];
}

export type ClaimStatus = "pending" | "delivered" | "denied";

export interface RewardClaim {
  id: string;
  /** Always Besho currently — Sir is not scored. */
  author: Author;
  weekKey: string;
  tierId: string;
  tierName: string;
  rewardId: string;
  rewardLabel: string;
  rewardBody?: string;
  /** Snapshotted at claim time so renames/deletes in the catalog don't
   *  rewrite history. */
  rewardEmoji?: string;
  status: ClaimStatus;
  requestedAt: number;
  respondedAt?: number;
  respondedBy?: Author;
  sirNote?: string;
  /** Audit snapshot — score + tier threshold at claim time. */
  claimedScore: number;
  claimedTierThreshold: number;
}

// ── Default tunables ─────────────────────────────────────────────────────

export const DEFAULT_OBEDIENCE_WEIGHTS: ObedienceWeights = {
  task_on_time: 10,
  task_late: 4,
  task_missed: -4,
  ritual_on_time: 5,
  ritual_missed: -3,
  rule_acked: 3,
  rule_unacked: -2,
  permission_approved: 1,
  permission_reasked: -1,
  mood_checkin: 1,
  restraint_engaged: -10,
  /** Auto-deducted on every new ledger punishment entry. */
  ledger_punishment: -10,
  /** Manual adjustments always supply their own points value at emit
   *  time. The default of 0 here is a placeholder so the type is
   *  satisfied; never used as a fallback. */
  manual_adjust: 0,
};

export const DEFAULT_REWARD_TIERS: RewardTier[] = [
  {
    id: "t1",
    name: "Tier I",
    threshold: 20,
    rewards: [
      { id: "t1-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t2",
    name: "Tier II",
    threshold: 50,
    rewards: [
      { id: "t2-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t3",
    name: "Tier III",
    threshold: 85,
    rewards: [
      { id: "t3-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t4",
    name: "Tier IV",
    threshold: 120,
    rewards: [
      { id: "t4-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t5",
    name: "Tier V",
    threshold: 160,
    rewards: [
      { id: "t5-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
];

export const REWARD_TIER_COUNT = 5;
export const DEFAULT_STREAK_THRESHOLD = 80;
export const DEFAULT_MULTIPLIERS: readonly number[] = [
  1.0, 1.1, 1.2, 1.3,
] as const;

export const OBEDIENCE_EVENT_LABELS: Record<ObedienceEventType, string> = {
  task_on_time: "Task on time",
  task_late: "Task late",
  task_missed: "Task missed",
  ritual_on_time: "Ritual within window",
  ritual_missed: "Ritual missed",
  rule_acked: "Rule acked",
  rule_unacked: "Rule not acked",
  permission_approved: "Permission approved",
  permission_reasked: "Re-asked denied permission",
  mood_checkin: "Mood check-in",
  restraint_engaged: "Restraint engaged",
  ledger_punishment: "Ledger punishment",
  manual_adjust: "Manual adjustment",
};

// ── Validation bounds for admin editor ───────────────────────────────────

export const REWARD_LABEL_MAX = 80;
export const REWARD_BODY_MAX = 500;
export const REWARD_EMOJI_MAX = 8;
export const TIER_NAME_MAX = 32;
export const MAX_REWARDS_PER_TIER = 12;
export const MAX_TIER_THRESHOLD = 9999;
export const MAX_MULTIPLIER = 5.0;
export const SIR_NOTE_MAX = 500;
export const MANUAL_ADJUST_MIN = -100;
export const MANUAL_ADJUST_MAX = 100;
export const MANUAL_ADJUST_REASON_MAX = 200;
