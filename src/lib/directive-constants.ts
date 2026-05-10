// src/lib/directive-constants.ts
//
// Pure value/type definitions for the real-time directive overlay.
// Imported by the server action, the dialog component, the admin
// issuance page, and the timer-expire cron. No Redis or async work.

export type DirectiveState =
  | "issued"
  | "acknowledged"
  | "completed"
  | "expired"
  | "cancelled";

export const DIRECTIVE_STATES: readonly DirectiveState[] = [
  "issued",
  "acknowledged",
  "completed",
  "expired",
  "cancelled",
] as const;

/** Title is the headline shown on the overlay; deliberately short. */
export const MAX_DIRECTIVE_TITLE_LEN = 80;
/** Body is optional context; capped to keep payloads bounded but
 *  still allow a couple of paragraphs of instruction. */
export const MAX_DIRECTIVE_BODY_LEN = 500;
/** Lower bound — directives shorter than 1 minute are reflexive
 *  enough that summon or a notes ping is the right surface. */
export const MIN_DIRECTIVE_DURATION_SEC = 60;
/** Upper bound — directives longer than 1 hour drift into ritual /
 *  rule territory. Use those features for long-running expectations. */
export const MAX_DIRECTIVE_DURATION_SEC = 60 * 60;
/** Default duration when Sir doesn't specify. 10 minutes is enough
 *  for most operational directives without forcing kitten to choose. */
export const DEFAULT_DIRECTIVE_DURATION_SEC = 600;
/** Active sentinel TTL fallback when the directive has no countdown.
 *  Open-ended directives still need an upper bound or the active
 *  slot deadlocks if Sir never cancels. 24h matches the natural
 *  daily cadence of /rituals + /review. */
export const DIRECTIVE_OPEN_ENDED_TTL_SEC = 24 * 60 * 60;

/** Canonical FCM payload `data.kind` value. The fcm-provider
 *  foreground listener branches on this string; the timer-expire
 *  cron and the admin page reference it for symmetry with the
 *  punishment timer (which uses `kind: "punishment"`). */
export const DIRECTIVE_PAYLOAD_KIND = "directive" as const;

/** CustomEvent name dispatched by the FCM foreground listener when a
 *  directive payload arrives while the app is open. Subscribed by
 *  `<DirectiveDialog>` to flip its state from idle to active without
 *  waiting for the next refresh-listener tick. */
export const DIRECTIVE_ARRIVED_EVENT = "ourspace:directive-arrived";
