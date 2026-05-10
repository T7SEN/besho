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
  | "rule_violation_minor"
  | "rule_violation_moderate"
  | "rule_violation_major"
  | "directive_completed"
  | "directive_missed"
  | "punishment_completed"
  | "punishment_bailed"
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
  "rule_violation_minor",
  "rule_violation_moderate",
  "rule_violation_major",
  "directive_completed",
  "directive_missed",
  "punishment_completed",
  "punishment_bailed",
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
  /** Optional emoji shown alongside the tier name in the ladder, claim
   *  picker, and history. Snapshotted onto each claim's `tierEmoji` so
   *  catalog renames don't rewrite historical displays. */
  emoji?: string;
}

export interface ObedienceBreakdownEntry {
  type: ObedienceEventType;
  count: number;
  points: number;
  /** For `manual_adjust` only — each event becomes its own breakdown
   *  row (not aggregated by type) so the reason can label it. Other
   *  types keep `count > 1` aggregation. Stable React key. */
  eventId?: string;
  /** For `manual_adjust` only — the reason supplied at adjustment
   *  time. Renders in place of the generic "Manual adjustment" label.
   *  Absent for legacy events recorded before the reasons HASH shipped. */
  reason?: string;
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

export type ClaimStatus =
  | "pending"
  | "delivered"
  | "denied"
  | "revoked";

export interface RewardClaim {
  id: string;
  /** Always Besho currently — Sir is not scored. */
  author: Author;
  weekKey: string;
  tierId: string;
  tierName: string;
  /** Snapshotted at claim time. Symmetric with rewardEmoji. */
  tierEmoji?: string;
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
  /** Set when Sir revokes a previously-decided claim. The reason
   *  text is captured here verbatim. Status is "revoked"; revokedAt
   *  carries the timestamp. Re-revoking is a no-op. */
  revokedAt?: number;
  revokeReason?: string;
  /** Set when Besho confirms receipt of a delivered reward. Optional
   *  thank-you note is captured. Status remains "delivered" — ack is
   *  a parallel field, not a new state. */
  acknowledgedAt?: number;
  acknowledgeNote?: string;
  /** Audit snapshot — score + tier threshold at claim time. */
  claimedScore: number;
  claimedTierThreshold: number;
  /** Set on claims made via test mode (current-week claim path).
   *  Filtered out of `ClaimHistoryCard` and `HistorySection` so they
   *  don't pollute the permanent history view. Persisted so the
   *  full flow (Sir delivery, status card) still works during the
   *  test cycle. Sir can wipe these via `adminPurgeTestClaims`. */
  testMode?: boolean;
  /** Computed at fetch time, not persisted. Length of the
   *  `reward:claim:audit:{id}` LIST. Surfaces in the UI as a
   *  "Changed Nx" chip when > 0. */
  auditCount?: number;
}

/** Snapshot of a previous claim state, captured before it gets
 *  overwritten by a re-decide / revoke / ack. Stored in
 *  `reward:claim:audit:{id}` LIST, capped at 20 entries. Mirrors the
 *  `permission:audit:{id}` pattern. */
export interface ClaimAuditEntry {
  /** The prior status (the state being moved away from). */
  status: ClaimStatus;
  changedAt: number;
  changedBy: Author;
  /** Whichever note applied at that prior state — sirNote on a
   *  delivered/denied entry, revokeReason on a revoked entry,
   *  acknowledgeNote on an acknowledged entry. */
  note?: string;
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
  /** Sir-logged rule violations. Severity-scaled. The three keys are
   *  separate event types (not a single key with a multiplier) so they
   *  remain individually tunable in /admin/rewards and surface as
   *  distinct rows in the breakdown. */
  rule_violation_minor: -3,
  rule_violation_moderate: -8,
  rule_violation_major: -20,
  /** Real-time directive overlay outcomes. `directive_completed`
   *  fires when kitten confirms completion within the countdown.
   *  `directive_missed` fires from the timer-expire cron when the
   *  countdown elapses without completion (or, for open-ended
   *  directives, after the 24h fallback TTL). */
  directive_completed: 5,
  directive_missed: -10,
  /** Punishment timer outcomes. `punishment_completed` fires when
   *  kitten confirms after `endsAt` — small positive (compliance
   *  with corrective action). `punishment_bailed` fires when she
   *  taps Bail (two-tap), backgrounds the app past the 60s grace
   *  window, or the cron sweeps her past `endsAt + grace` —
   *  larger negative (defiance). The auto-created `ledger:{id}`
   *  entry's `ledger_punishment` emit is suppressed at the
   *  inline write site to avoid double-counting these typed events. */
  punishment_completed: 2,
  punishment_bailed: -20,
  permission_approved: 1,
  permission_reasked: -1,
  mood_checkin: 1,
  restraint_engaged: -10,
  /** Auto-deducted on every new ledger punishment entry. Violations
   *  use the `rule_violation_*` events instead — the punishment-style
   *  emit is suppressed for `type === "violation"` so the score isn't
   *  double-counted. */
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
    emoji: "🥉",
    threshold: 20,
    rewards: [
      { id: "t1-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t2",
    name: "Tier II",
    emoji: "🥈",
    threshold: 50,
    rewards: [
      { id: "t2-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t3",
    name: "Tier III",
    emoji: "🥇",
    threshold: 85,
    rewards: [
      { id: "t3-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t4",
    name: "Tier IV",
    emoji: "🏆",
    threshold: 120,
    rewards: [
      { id: "t4-r1", label: "Reward 1", body: "Sir, fill this in." },
    ],
  },
  {
    id: "t5",
    name: "Tier V",
    emoji: "👑",
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
/** Minimum deficit (in displayed pts) required to fire the
 *  Friday-evening "streak at risk" FCM. Default 1 means any deficit
 *  triggers; raise to suppress trivial nudges. Sir-tunable from the
 *  Streak tab on /admin/rewards. */
export const DEFAULT_STREAK_RISK_MIN_DEFICIT = 1;
/** Pending-claim age (hours) before the obedience-sweep cron fires a
 *  one-shot nudge FCM to Sir. */
export const STALE_CLAIM_NUDGE_HOURS = 24;

export const OBEDIENCE_EVENT_LABELS: Record<ObedienceEventType, string> = {
  task_on_time: "Task on time",
  task_late: "Task late",
  task_missed: "Task missed",
  ritual_on_time: "Ritual within window",
  ritual_missed: "Ritual missed",
  rule_acked: "Rule acked",
  rule_unacked: "Rule not acked",
  rule_violation_minor: "Rule violation (minor)",
  rule_violation_moderate: "Rule violation (moderate)",
  rule_violation_major: "Rule violation (major)",
  directive_completed: "Directive completed",
  directive_missed: "Directive missed",
  punishment_completed: "Punishment completed",
  punishment_bailed: "Punishment bailed",
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
export const TIER_EMOJI_MAX = 8;
export const TIER_NAME_MAX = 32;
export const MAX_REWARDS_PER_TIER = 12;
export const MAX_TIER_THRESHOLD = 9999;
/** Upper bound on `obedience:streak-risk-min-deficit`. Setting it
 *  this high effectively disables the Friday FCM. */
export const MAX_STREAK_RISK_MIN_DEFICIT = MAX_TIER_THRESHOLD;
export const MAX_MULTIPLIER = 5.0;
export const SIR_NOTE_MAX = 500;
export const MANUAL_ADJUST_MIN = -100;
export const MANUAL_ADJUST_MAX = 100;
export const MANUAL_ADJUST_REASON_MAX = 200;
export const REVOKE_REASON_MAX = 500;
export const ACKNOWLEDGE_NOTE_MAX = 500;
export const CLAIM_AUDIT_LIMIT = 20;
export const BULK_DENY_MAX_DAYS = 365;
/** Optional context note threaded through `recordObedienceEvent`'s
 *  `note?` parameter. Lands in `/admin/activity` only — never the
 *  ZSET member. Used currently by the restraint-engaged emit site. */
export const OBEDIENCE_NOTE_MAX = 500;
