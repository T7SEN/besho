# Push Routing — FCM Only

Detailed reference for the presence-aware push notification routing in Our Space. Load this when implementing or modifying any push path.

## Architecture Note

**FCM is the only push transport.** There is no Web Push, no Service Worker, no VAPID. There is also no Telegram / WhatsApp / Signal / any other third-party messenger as a fallback or sidecar channel — these are explicitly banned (see `references/refusal-catalog.md` + `references/anti-hallucination.md`). Web Push and PWA infrastructure were removed because:

1. The app runs as a hosted-webapp Capacitor shell (`server.url`) — the WebView doesn't run service workers reliably.
2. Maintaining two transport stacks (FCM + Web Push) for a two-user app was cost-disproportionate.

The third-party-messenger ban exists for the same cost-disproportion reason plus an additional one: out-of-band messenger fallbacks duplicate the channel and add an unlocked third-party dependency outside the deliberate Vercel + Upstash + Firebase + Capacitor stack. The defensive design in § 3.3 of `AGENTS.md` (FCM registration tolerance + durable `notifications:{author}` history LIST + per-token failure pruning) IS the sanctioned answer to OEM / Honor / no-GMS reliability concerns.

If a future contributor proposes adding Web Push back, they must read [`./capacitor-native.md`](./capacitor-native.md) Section "Why No Web Push" and explain why the prior reasoning no longer applies. The same bar applies to any proposal to add a third-party messenger as a push channel — refuse on sight unless the user explicitly retracts the ban.

## The Four-Step Algorithm

Every code path that sends a notification (`sendPushToUser`, `sendRuleNotification`, `sendHugPush`, and any future addition) **must** follow this exact sequence. Deviations cause duplicate notifications, missing notifications, or runtime errors.

### Step 1 — Always write to history first

```ts
await pushNotificationToHistory(targetAuthor, {
  title: payload.title,
  body: payload.body,
  url: payload.url,
  timestamp: Date.now(),
});
```

History is the source of truth even if delivery fails. The `NotificationDrawer` reads from `notifications:{author}` (LIST, capped at 50) regardless of whether FCM succeeded. The history record is the durable artifact when FCM delivery is unavailable for any reason — both users see missed notifications next time they open the app.

### Step 2 — Read presence

```ts
let currentPage: string | null = null;
try {
  const presenceRaw = await redis.get<string>(`presence:${targetAuthor}`);
  if (presenceRaw) {
    const { page, ts } = JSON.parse(presenceRaw) as {
      page: string;
      ts: number;
    };
    const ageMs = Date.now() - ts;
    if (ageMs < 12_000) {
      currentPage = page;
    }
  }
} catch (err) {
  logger.warn("[push] Presence check failed, proceeding:", { error: err });
}
```

The 12-second threshold is wider than the 8-second heartbeat in `usePresence` to absorb network jitter without over-extending. The `presence:{author}` key has a Redis TTL of 6 seconds (`PRESENCE_TTL` in `src/app/api/presence/route.ts`). The TTL and the 12s freshness window together act as a two-layer expiry.

### Step 3 — Skip if recipient is on the target page

```ts
if (currentPage === payload.url) {
  logger.info(`[push] Skipping — ${targetAuthor} is on ${payload.url}.`);
  return;
}
```

The recipient sees the update via SSE (`/notes`) or the `useRefreshListener` hook on other pages. A push at this point would double-notify.

### Step 4 — FCM delivery (multi-token fan-out)

```ts
import { readFcmTokens, pruneStaleFcmTokens, PERMANENTLY_DEAD_FCM_ERROR_CODES }
  from "@/lib/fcm-tokens";

const tokens = await readFcmTokens(redis, targetAuthor);
if (tokens.length === 0) {
  logger.info(`[push] No FCM tokens for ${targetAuthor}.`);
  return;
}

const isAppOpen = currentPage !== null;

try {
  const { getApps, initializeApp, cert } = await import("firebase-admin/app");
  const { getMessaging } = await import("firebase-admin/messaging");

  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID!,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
        privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
      }),
    });
  }

  const multicast = isAppOpen
    ? {
        // Foreground: data-only payload — Capacitor intercepts,
        // FCMProvider dispatches PushToast in-app.
        tokens,
        data: {
          url: payload.url,
          title: payload.title,
          body: payload.body,
        },
      }
    : {
        // Background/closed: full notification payload —
        // the OS draws the heads-up banner natively.
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: { url: payload.url },
        android: { priority: "high" as const },
      };

  const result = await getMessaging().sendEachForMulticast(multicast);

  // Per-token failure inspection. Permanently-dead error codes
  // trigger SREM so the SET self-cleans; transient failures are
  // logged and the token is kept for the next attempt.
  const stale: string[] = [];
  result.responses.forEach((resp, i) => {
    if (resp.success) return;
    const code = resp.error?.code ?? "";
    if (PERMANENTLY_DEAD_FCM_ERROR_CODES.has(code)) {
      stale.push(tokens[i]);
    }
  });
  if (stale.length > 0) {
    await pruneStaleFcmTokens(redis, targetAuthor, stale);
  }
} catch (err) {
  logger.error("[push] FCM send failed:", err);
  // No fallback. The notification record in history is the only artifact.
}
```

**Critical details:**

- The `notification` field must NOT be present in the foreground payload. If it is, Android draws a system banner _and_ the in-app `PushToast` — the user sees the same message twice.
- `sendEachForMulticast` is the canonical multi-token API on `firebase-admin`. It returns a `BatchResponse` with `responses[]` — one entry per input token, each carrying `success` or `error`. Don't loop with single-token `send()` calls; that's N round-trips for the same payload.
- Token rotation is real (Play Services updates, app reinstalls, security events). Without the per-token failure inspection + SREM, a dead token stays in the SET forever and the device it represented goes silent until the user opens the app and triggers a fresh registration.
- The `firebase-admin` SDK is imported dynamically. Top-level imports inflate the Edge bundle and break runtime detection.

---

## Storage Keys

| Key                      | Type   | TTL  | Purpose                                                                    |
| ------------------------ | ------ | ---- | -------------------------------------------------------------------------- |
| `presence:{author}`      | STRING | 6s   | `{ page, ts }` JSON — heartbeat target                                     |
| `push:fcm:{author}`      | SET    | none | FCM device tokens (one entry per registered device — Android with GMS)     |
| `notifications:{author}` | LIST   | none | Last 50 records (LPUSH + LTRIM)                                            |

> **Migration note:** `push:fcm:{author}` was a STRING in the original implementation. It's now a SET to support multi-device per author (Besho has phone + tablet — each device's token is its own SET member; sends fan out via `sendEachForMulticast`). The read path in `@/lib/fcm-tokens` tolerates legacy STRING values during the transition; the first registration after deploy migrates the key shape.

> **Note:** `push:subscription:{author}` (formerly Web Push subscription) is removed. If your Redis still has dead entries, clean them: `DEL push:subscription:T7SEN push:subscription:Besho`.

---

## Client Wiring

### `usePresence(page, paused?)`

`src/hooks/use-presence.ts`. Heartbeats `POST /api/presence` every 8 seconds with the current page. Calls `DELETE /api/presence` on unmount. Pause via the second arg when the user is idle.

Every page that should suppress duplicate pushes when foregrounded must call `usePresence(currentRoute)`.

### `FCMProvider`

`src/components/fcm-provider.tsx`. Persistent in `layout.tsx` so registration survives navigation. Listens for:

- `registration` → `POST /api/push/subscribe-fcm` to store the token
- `registrationError` → log and continue (registration can fail for ordinary reasons — permissions, network, OEM quirks; not an error to crash on)
- `pushNotificationReceived` → `dispatchPushToast` for the in-app toast
- `pushNotificationActionPerformed` → navigate to `data.url`

The notification channel is created with `importance: 4` and `visibility: 1` to keep the OS from drawing duplicate heads-up banners while the app is foregrounded.

### `PushToast`

`src/components/push-toast.tsx`. Portaled to `document.body`. Uses Web Audio API for the chime and `vibrate()` for haptics. Auto-dismisses after a fixed timeout; tap to navigate.

---

## Feature-Routed Payloads via `data.kind`

Some payloads route to a feature surface (overlay, toast, full-screen dialog) rather than the generic PushToast. The discriminant is `data.kind` — set on the FCM `data` object via `sendNotification`'s `extraData` option. The `<FCMProvider>` foreground listener branches on `kind` before falling through to the default `dispatchPushToast(...)` path.

### Currently routed kinds

| `data.kind`        | Foreground handler                                                           | Background handler                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `"directive"`      | Dispatches `ourspace:directive-arrived` CustomEvent → `<DirectiveDialog>` refetches and opens. PushToast NOT shown. | Standard heads-up banner. Tap → navigates to `data.url` (`/`); `<DirectiveDialog>` reads active state on mount. |
| `"punishment"`     | Dispatches `ourspace:punishment-arrived` → `<PunishmentOverlay>` refetches and opens. PushToast NOT shown. Sender uses `bypassPresence: true` + `priority: "high"` so the timer engages immediately regardless of which page kitten is on. | Standard heads-up banner. Tap → navigates to `data.url` (`/`); `<PunishmentOverlay>` reads active state on mount. Channel is `default`, NOT `safeword`. |
| `"tod_challenge"`  | Dispatches `ourspace:tod-arrived` CustomEvent → `/games/truth-or-dare` re-fetches its bundle without waiting for the next pull-to-refresh or 30s poll. The page itself is the listener (no dedicated overlay component — TOD is a play surface, not an interrupt). When the recipient is on a different page, the FCM-provider branch ALSO dispatches the standard PushToast so they see the arrival; if they're already on `/games/truth-or-dare`, the toast is skipped (the page reconciles immediately). Fallback path: if dispatch throws, falls through to the standard PushToast. | Standard heads-up banner. Tap → navigates to `data.url` (`/games/truth-or-dare`); the page refetches its bundle on mount. |

**Non-kind TOD pushes:** the cron-driven pre-warning ("⏳ TOD challenge expires soon") fires via `sendNotification(recipient, ...)` with no `kind` field — it routes through the standard PushToast path. Dedup happens at the Redis layer via `tod:fcm:expire-warn:{id}` (`SET NX EX`) so the same challenge can't double-warn even if the cron retries within the warning window. See `redis-schema.md` § "Pre-warning sweep" for the algorithm.

### Adding a kind

1. Pick a stable string value. Add it to the kind constant (e.g. `DIRECTIVE_PAYLOAD_KIND` in `src/lib/directive-constants.ts`).
2. Define a CustomEvent name (`DIRECTIVE_ARRIVED_EVENT = "ourspace:directive-arrived"`).
3. Wire the FCM-provider foreground branch — match on `notification.data?.kind`, dispatch the event, return early to suppress the PushToast fall-through.
4. Have the surface component subscribe via `addEventListener` on the global event name.
5. The background path is automatic — `notification: { title, body }` + `data: { url, kind, ...extra }` falls through to standard tap-navigation; the surface component opens itself on the next render via its existing read path.
6. **Always include the standard `url` field** in the payload — it's the fallback path when foreground branching fails for any reason (the catch-block in fcm-provider falls back to `dispatchPushToast` with `url: data.url`).

The `extraData` parameter on `sendNotification` is the sanctioned way to add fields. Values must be strings — FCM rejects nested objects and non-string values.

---

## Adding a New Push Path

Checklist for any new server action that needs to notify the partner:

1. Import `pushNotificationToHistory` from `@/app/actions/notifications`.
2. Determine the target author (the partner of `session.author`).
3. Build the payload `{ title, body, url }`.
4. Call `pushNotificationToHistory(target, { ...payload, timestamp: Date.now() })` first.
5. Run the presence check — if `currentPage === payload.url`, return.
6. Try FCM. Wrap in `try/catch` and log on failure. **Do not add a Web Push fallback.**
7. Never throw out of a notification path. The originating user action must succeed regardless of push delivery.

Copy the `sendRuleNotification` function in `src/app/actions/rules.ts` as a template — it's the cleanest example.

---

## Failure Modes & Diagnostics

| Symptom                                                | Cause                                                                  | Fix                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Duplicate banner + toast on Android                    | `notification` field set in foreground path                            | Strip `notification` when `isAppOpen`                                                                     |
| Notifications stop after server restart                | Firebase Admin re-initialized                                          | Guard with `if (!getApps().length)`                                                                       |
| Push fires while user is on the target page            | Presence stale or never written                                        | Check `usePresence(currentRoute)` is called                                                               |
| `FIREBASE_PRIVATE_KEY` parse error                     | `\n` literals not converted                                            | `.replace(/\\n/g, '\n')` at runtime                                                                       |
| One device gets pushes, other(s) silent (multi-device) | Pre-SET-migration single-token race (last-writer-wins on STRING)       | Ensured by SET shape — every device's token persists. Re-registration auto-migrates legacy STRING values. |
| Notifications stop without a server change             | Token rotated; old value persists; new sends hit dead token            | `sendEachForMulticast` failure inspection + `pruneStaleFcmTokens` on `registration-token-not-registered`  |
| Honor / EMUI device drops background pushes            | OEM aggressive battery management / notification suppression           | Device-side: Phone Manager → Protected Apps → toggle on; App Launch → Manual; Battery → Don't restrict    |
| `Error: Notifications not enabled on this device` from `register()` OR `LocalNotifications.schedule()` after fresh install on Vivo / Oppo / Honor | OS-level "Allow notifications" toggle defaulted off post-install (separate from Android 13+ runtime POST_NOTIFICATIONS grant — that one passed our check) | Device-side: Settings → Apps → Our Space → Notifications → Allow notifications. Then close + reopen the app so FCMProvider re-registers. Detection / hint shared via `@/lib/os-notifications` between FCMProvider + `useLocalNotifications`. Sentry **Issue** filtered by `ignoreErrors` family 4; Sentry **Log** error-severity entry suppressed by demoting to `logger.warn` in each catch. The activity feed surfaces the OS-settings hint. |

---

## Cross-References

- `src/app/actions/notes.ts` — `sendPushToUser`
- `src/app/actions/rules.ts` — `sendRuleNotification`
- `src/app/actions/mood.ts` — `sendHugPush`
- `src/app/actions/notifications.ts` — `pushNotificationToHistory`, `getNotificationHistory`, `markAllNotificationsRead`, `clearAllNotifications`
- `src/app/api/presence/route.ts` — presence write/delete
- `src/app/api/push/subscribe-fcm/route.ts` — FCM token store
- `src/components/fcm-provider.tsx` — client-side FCM lifecycle
- `src/components/push-toast.tsx` — in-app toast UI
- `src/hooks/use-presence.ts` — presence heartbeat
