// src/lib/games/truth-or-dare-constants.ts
//
// Types, enums, validation bounds, and FCM payload kinds for the
// Truth or Dare game. Pure value/type definitions — no Redis, no async.
// Imported by the server actions, the game page, the admin pages, and
// the timer-expire cron.

import type { Author } from "@/lib/constants";

// ── Redis key helpers ────────────────────────────────────────────────────
//
// Co-located with the constants because the admin bucket (a separate
// 'use server' file) needs to read these without importing from another
// 'use server' module. The actions file is the canonical writer; admin
// uses the same keys for reads + force-cancel.

/** Global index ZSET — every challenge id scored by `createdAt`.
 *  Walked by `expireDueChallenges` (cron) and `getChallengeHistory`. */
export const TOD_INDEX_KEY = "tod:challenges:index";

/** JSON record key for a single challenge: `tod:challenge:{id}`. */
export const todChallengeKey = (id: string) => `tod:challenge:${id}`;

/** Single-slot sentinel key for an author's outgoing direction:
 *  `tod:active:T7SEN` or `tod:active:Besho`. Value is the active
 *  challenge id; absence means the slot is free. */
export const todActiveKey = (issuer: Author) => `tod:active:${issuer}`;

/** Per-author stats HASH: `tod:stats:T7SEN` or `tod:stats:Besho`.
 *  Fields enumerated by `TOD_STAT_KEYS`. */
export const todStatsKey = (author: Author) => `tod:stats:${author}`;

/** The recipient's pick: a truth question or a dare action. The issuer
 *  always authors both prompts; the recipient locks in one type via
 *  `pickPrompt`. */
export type ChallengeType = "truth" | "dare";

/** Full state machine. Terminal states: completed | refused | safeworded
 *  | expired | withdrawn | cancelled. Active states: pending | picked. */
export type ChallengeStatus =
  | "pending"
  | "picked"
  | "completed"
  | "refused"
  | "safeworded"
  | "expired"
  | "withdrawn"
  | "cancelled";

/** All challenge statuses in declaration order. Useful for serializing
 *  state-machine UIs or iterating over admin filter chips. */
export const CHALLENGE_STATUSES: readonly ChallengeStatus[] = [
  "pending",
  "picked",
  "completed",
  "refused",
  "safeworded",
  "expired",
  "withdrawn",
  "cancelled",
] as const;

/** Statuses that hold the active sentinel slot. Use
 *  `ACTIVE_STATUSES.includes(record.status)` to gate any mutation that
 *  requires the challenge to still be in flight. */
export const ACTIVE_STATUSES: readonly ChallengeStatus[] = [
  "pending",
  "picked",
] as const;

/** Statuses that are terminal — no further mutations allowed except
 *  soft-delete. Used to gate `deleteChallenge` (refuses non-terminal). */
export const TERMINAL_STATUSES: readonly ChallengeStatus[] = [
  "completed",
  "refused",
  "safeworded",
  "expired",
  "withdrawn",
  "cancelled",
] as const;

// ── Validation bounds ────────────────────────────────────────────────────

/** Cap on each prompt (truth + dare) at issuance. Bigger than tweet-
 *  length, small enough that pagination + render stays cheap. */
export const MAX_PROMPT_LEN = 500;
/** Cap on the recipient's response. Larger than prompts because a
 *  truthful answer or dare-completion note may need detail. */
export const MAX_RESPONSE_LEN = 2000;
/** Length of the response excerpt embedded in the issuer-side FCM
 *  body when a response is submitted. Trims to a word boundary when
 *  possible and appends an ellipsis on truncation so Sir can skim the
 *  answer without opening the app. The full text is always retained
 *  on the record. The device biometric gate is the reason it's safe
 *  to surface intimate text on a lock screen at all. */
export const RESPONSE_EXCERPT_LEN = 80;
/** Cap on the optional refuse reason. Short — it's a note, not a defense. */
export const MAX_REFUSE_REASON_LEN = 200;
/** Cap on the Sir admin force-cancel reason. Same shape as refuse. */
export const MAX_CANCEL_REASON_LEN = 200;

// ── TTLs (seconds) ───────────────────────────────────────────────────────

/** Time from issue until the recipient must pick or refuse, otherwise
 *  the cron sweeps it as expired. 72h fits the conversational half-life
 *  of a dare/truth — issuer's mood and intent stay current for a few
 *  days but go stale beyond that. Tighter than the original 7d so
 *  stuck challenges clear faster; still loose enough that an LDR
 *  couple has wiggle room without being on call. */
export const TOD_PENDING_TTL_SEC = 72 * 60 * 60;
/** Time from pick until the response must be submitted, otherwise the
 *  cron sweeps as expired. 48h tightens the window once the recipient
 *  has committed to a type. */
export const TOD_PICKED_TTL_SEC = 48 * 60 * 60;

/** Grace window after `pickPrompt` during which the recipient can
 *  change their mind — re-pick the other type without penalty or new
 *  state. Locked once a response is submitted (status → completed)
 *  AND once the window elapses (60s from `pickedAt`). Implemented by
 *  loosening `pickPrompt`'s guard to also accept `status === "picked"`
 *  when the new pick differs and `now - pickedAt <
 *  CHANGE_PICK_WINDOW_SEC * 1000`. */
export const CHANGE_PICK_WINDOW_SEC = 60;

/** Threshold for the cron-driven "expires soon" pre-warning push.
 *  When `expiresAt - now < THRESHOLD`, the warner walker fires a
 *  one-shot FCM to the recipient and sets the dedup sentinel below.
 *  24h works for both the 72h pending TTL (fires at 48h elapsed) and
 *  the 48h picked TTL (fires at 24h elapsed). */
export const TOD_EXPIRE_WARN_THRESHOLD_SEC = 24 * 60 * 60;

/** Dedup sentinel for the pre-warning push. SET NX EX with a TTL that
 *  expires when the challenge does — naturally evicts so a future
 *  resurrection of the same challenge id couldn't accidentally double-
 *  warn. One sentinel per challenge id (covers both
 *  pending→picked TTL refreshes since neither flows back into pending). */
export const todExpireWarnSentinelKey = (id: string) =>
  `tod:fcm:expire-warn:${id}`;

// ── Prompt library ───────────────────────────────────────────────────────

/** Per-author library of pre-authored truth+dare pairs. Stored as a
 *  JSON array at `tod:prompts:{author}`. Each author manages their
 *  own library — there is no cross-author view (Sir cannot see Kitten's
 *  saved prompts, and vice versa). The library is private writer
 *  state; the issue form pulls from it on demand. */
export const todPromptsKey = (author: Author) => `tod:prompts:${author}`;

export interface TodPrompt {
  id: string;
  truthPrompt: string;
  darePrompt: string;
  /** Optional short label rendered in the picker; falls back to a
   *  truncated truth prompt when absent. */
  label?: string;
  createdAt: number;
}

/** Cap on saved prompt entries per author. Generous enough for a
 *  thoughtful curator but bounded so the JSON read stays cheap. */
export const MAX_PROMPTS_PER_LIBRARY = 50;

/** Cap on the optional label per entry. */
export const MAX_PROMPT_LABEL_LEN = 60;

// ── Pagination ───────────────────────────────────────────────────────────

/** Default page size for `getChallengeHistory`. The user-facing game
 *  page paginates 20 at a time via "load more"; admin pulls
 *  `TOD_HISTORY_MAX_LIMIT` on initial load. */
export const TOD_HISTORY_PAGE_SIZE = 20;
/** Hard ceiling on a single history read — protects against unbounded
 *  ZSET ranges if a caller passes an absurd limit. */
export const TOD_HISTORY_MAX_LIMIT = 200;

// ── FCM payload kind + custom event names ────────────────────────────────

/** Canonical FCM payload `data.kind` value for TOD challenges. The
 *  `<FCMProvider>` foreground listener can branch on this if we want
 *  in-app overlays later; for v1 the standard PushToast route handles
 *  it transparently. */
export const TOD_PAYLOAD_KIND = "tod_challenge" as const;

/** CustomEvent name reserved for a future in-app TOD overlay component
 *  (mirroring the directive / punishment event-dispatch pattern). Not
 *  currently dispatched — the FCM payload uses the standard PushToast
 *  route. Kept here so adding the overlay later is a single touch. */
export const TOD_ARRIVED_EVENT = "ourspace:tod-arrived";

// ── Record shape ─────────────────────────────────────────────────────────

/** A single Truth or Dare challenge record. Stored as JSON at
 *  `tod:challenge:{id}`. Both authors can see both directions — the
 *  game is symmetric. State machine is encoded in `status`; see
 *  `CHALLENGE_STATUSES` for the full list. */
export interface TodChallenge {
  id: string;
  issuer: Author;
  recipient: Author;
  truthPrompt: string;
  darePrompt: string;
  /** Recipient's choice. Null while pending. */
  pick: ChallengeType | null;
  status: ChallengeStatus;
  /** Truth answer text OR dare-completion note. Null until submitted. */
  response: string | null;
  createdAt: number;
  pickedAt: number | null;
  respondedAt: number | null;
  /** Set when the record reaches a terminal status (any terminal state). */
  closedAt: number | null;
  /** Moves on status transitions: pending → +TOD_PENDING_TTL_SEC,
   *  picked → pickedAt + TOD_PICKED_TTL_SEC. The cron expires past it. */
  expiresAt: number;
  /** Free-form reason when the recipient refused. */
  refuseReason?: string;
  /** Sir-supplied reason when force-cancelled via `/admin/games`.
   *  Distinct from `refuseReason` (recipient-initiated) and
   *  `withdrawReason` (issuer-initiated own-cancel) — the name makes
   *  the origin clear in code reads. */
  adminCancelReason?: string;
  /** When the issuer withdrew their own challenge. */
  withdrawReason?: string;
}

// ── Stats shape (per author, both visible to both) ───────────────────────

/** Per-author counters maintained as a Redis HASH at `tod:stats:{author}`.
 *  Both authors' stats are visible to both — same transparency as
 *  `/review` and `/rewards`. Stats are independent of obedience score;
 *  only Kitten's `truthsAnswered` / `daresCompleted` / `refused` /
 *  `expired` move her score (via the obedience event emit at the action
 *  site or the cron). Sir's counters track gameplay but do not feed
 *  any score axis.
 *
 *  `currentStreak` is consecutive responses submitted by this author
 *  AS RECIPIENT — increments on each `submitResponse`, resets to 0 on
 *  `refuseChallenge` or cron-driven `tod_expired`. Safeword and
 *  withdrawn do NOT reset (free outs by design). `longestStreak` is
 *  the high-water mark; only ever increases via the normal flow, but
 *  admin stat edits can correct it. */
export interface TodStats {
  issued: number;
  truthsAnswered: number;
  daresCompleted: number;
  refused: number;
  safeworded: number;
  expired: number;
  withdrawn: number;
  currentStreak: number;
  longestStreak: number;
}

/** Zero-valued seed used as a fallback when the stats HASH is absent
 *  or partially populated. Ensures every counter has a defined number. */
export const DEFAULT_TOD_STATS: TodStats = {
  issued: 0,
  truthsAnswered: 0,
  daresCompleted: 0,
  refused: 0,
  safeworded: 0,
  expired: 0,
  withdrawn: 0,
  currentStreak: 0,
  longestStreak: 0,
};

/** Iteration order for stat rendering + admin editor. Keep this in
 *  sync with `TodStats` keys — `keyof TodStats` is the type guarantee. */
export const TOD_STAT_KEYS: readonly (keyof TodStats)[] = [
  "issued",
  "truthsAnswered",
  "daresCompleted",
  "refused",
  "safeworded",
  "expired",
  "withdrawn",
  "currentStreak",
  "longestStreak",
] as const;

/** Human-readable labels for stat keys. Used by the game page footer
 *  and the admin Stats tab. */
export const TOD_STAT_LABELS: Record<keyof TodStats, string> = {
  issued: "Issued",
  truthsAnswered: "Truths answered",
  daresCompleted: "Dares completed",
  refused: "Refused",
  safeworded: "Safeworded",
  expired: "Expired",
  withdrawn: "Withdrawn",
  currentStreak: "Current streak",
  longestStreak: "Longest streak",
};

/** Reasonable upper bound for admin stat edits — guards against
 *  fat-finger input that would overflow the UI columns. */
export const MAX_TOD_STAT_VALUE = 999_999;

// ── Display ──────────────────────────────────────────────────────────────

/** Human-readable status labels rendered on the active card, history
 *  rows, and admin tabs. Keep wording compact — they appear inside
 *  small chips. */
export const STATUS_LABELS: Record<ChallengeStatus, string> = {
  pending: "Waiting to pick",
  picked: "Answering",
  completed: "Answered",
  refused: "Refused",
  safeworded: "Safeworded",
  expired: "Expired",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

/** Tailwind class strings for the status chip — same shape as
 *  `STATUS_LABELS`. Co-located so the user-facing game page + the
 *  admin page render identical chips without copy-pasting the map.
 *  Hover/focus styles are left to the consumer. */
export const STATUS_CHIP: Record<ChallengeStatus, string> = {
  pending: "bg-amber-500/15 text-amber-400",
  picked: "bg-blue-500/15 text-blue-400",
  completed: "bg-emerald-500/15 text-emerald-400",
  refused: "bg-rose-500/15 text-rose-400",
  safeworded: "bg-purple-500/15 text-purple-400",
  expired: "bg-destructive/15 text-destructive",
  withdrawn: "bg-muted/30 text-muted-foreground",
  cancelled: "bg-muted/30 text-muted-foreground",
};
