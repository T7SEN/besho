// src/lib/os-notifications.ts
//
// Shared helper for the OS-level "Allow notifications" toggle being
// off — the OEM gate behind both `@capacitor/push-notifications`
// `register()` AND `@capacitor/local-notifications` `schedule()` /
// `cancel()` / `requestPermissions()`. Vivo (FuntouchOS), Oppo
// (ColorOS), and Honor (MagicOS) commonly default this toggle off
// post-install — separate from the Android 13+ runtime
// `POST_NOTIFICATIONS` permission grant, which we check separately
// at the FCMProvider / `useLocalNotifications` permission-request
// layer.
//
// Resolution path is OS-side: Settings → Apps → Our Space →
// Notifications → Allow notifications. After flipping it, close +
// reopen the app so registration / scheduling re-fires.
//
// Both callers (FCMProvider, use-local-notifications) detect this
// specific error family in their catch blocks and demote the log
// level from `error` → `warn`, with the OS-settings hint attached as
// context. That stops both the Sentry Issue (already filtered via
// `ignoreErrors` family 4 in `instrumentation-client.ts`) AND the
// Sentry Log error severity entry, while preserving operational
// visibility through the activity feed.

/**
 * True iff the error came from the OS-level notification toggle being
 * off. The native side throws / rejects with the message
 * "Notifications not enabled on this device" — we match the message
 * substring case-insensitively so minor wording variants across
 * Capacitor versions still get detected.
 */
export function isOsNotificationsDisabledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /notifications not enabled/i.test(msg);
}

/** User-facing path to flip the OS-level toggle. Surfaced in the
 *  activity feed alongside the demoted warn so the operator can tell
 *  the affected user the exact setting to change. */
export const OS_NOTIF_HINT =
  "Settings → Apps → Our Space → Notifications → Allow notifications";
