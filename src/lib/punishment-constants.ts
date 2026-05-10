// src/lib/punishment-constants.ts
//
// Pure value/type definitions for the punishment timer feature.
// Imported by the server action, the overlay component, the admin
// issuance page, and the timer-expire cron. No Redis or async work.

export type PunishmentState =
  | "issued"
  | "running"
  | "completed"
  | "bailed"
  | "cancelled";

export const PUNISHMENT_STATES: readonly PunishmentState[] = [
  "issued",
  "running",
  "completed",
  "bailed",
  "cancelled",
] as const;

/** Reason field — Sir's note on why the timer was issued. Surfaces
 *  in the auto-created ledger entry's description. */
export const MAX_PUNISHMENT_REASON_LEN = 200;

/** Lower bound — punishments shorter than 1 minute are reflexive
 *  enough that summon or a notes ping is a better surface. */
export const MIN_PUNISHMENT_DURATION_SEC = 60;
/** Upper bound — 2 hours. Anything longer drifts into ritual /
 *  rule territory. */
export const MAX_PUNISHMENT_DURATION_SEC = 2 * 60 * 60;
/** Default duration when Sir doesn't specify. 10 minutes — enough
 *  to feel substantial without forcing a full deliberation. */
export const DEFAULT_PUNISHMENT_DURATION_SEC = 600;

/** Background-grace window — kitten can leave the app for this
 *  long before backgrounding is considered "bailed." 60s tolerates
 *  a quick OS notification check without letting her sit out the
 *  punishment with the screen off. */
export const BACKGROUND_GRACE_SEC = 60;

/** Two-tap bail confirmation. First tap shows the confirm UI; if
 *  no second tap within this window, the UI auto-reverts. Mirrors
 *  the PurgeButton pattern. */
export const BAIL_CONFIRM_DELAY_MS = 1500;

/** Active sentinel TTL adds a buffer past `endsAt` so the cron has
 *  a window to finalize the bail without the active slot reopening
 *  prematurely. */
export const PUNISHMENT_ACTIVE_TTL_BUFFER_SEC = 600;

/** Canonical FCM payload `data.kind` value. The fcm-provider
 *  foreground listener branches on this string. */
export const PUNISHMENT_PAYLOAD_KIND = "punishment" as const;

/** CustomEvent name dispatched by the FCM foreground listener when
 *  a punishment payload arrives. */
export const PUNISHMENT_ARRIVED_EVENT = "ourspace:punishment-arrived";

/** CustomEvent dispatched by `<PunishmentOverlay>` when the active
 *  punishment transitions to a terminal state (completed/bailed/
 *  cancelled/expired). Subscribed by `<DirectiveDialog>` so it can
 *  refetch the active directive (which it suppresses while a
 *  punishment is active). */
export const PUNISHMENT_CLEARED_EVENT = "ourspace:punishment-cleared";
