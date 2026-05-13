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
/** Cap on the optional refuse reason. Short — it's a note, not a defense. */
export const MAX_REFUSE_REASON_LEN = 200;
/** Cap on the Sir admin force-cancel reason. Same shape as refuse. */
export const MAX_CANCEL_REASON_LEN = 200;

// ── TTLs (seconds) ───────────────────────────────────────────────────────

/** Time from issue until the recipient must pick or refuse, otherwise
 *  the cron sweeps it as expired. 7d matches the leisurely async cadence
 *  of an LDR couple — kitten/Sir doesn't have to be on call. */
export const TOD_PENDING_TTL_SEC = 7 * 24 * 60 * 60;
/** Time from pick until the response must be submitted, otherwise the
 *  cron sweeps as expired. 48h tightens the window once the recipient
 *  has committed to a type. */
export const TOD_PICKED_TTL_SEC = 48 * 60 * 60;

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
  /** Free-form reason when Sir force-cancelled via /admin/games. */
  cancellationReason?: string;
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
 *  any score axis. */
export interface TodStats {
  issued: number;
  truthsAnswered: number;
  daresCompleted: number;
  refused: number;
  safeworded: number;
  expired: number;
  withdrawn: number;
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
