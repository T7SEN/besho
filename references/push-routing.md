# Push Routing — FCM Only

Detailed reference for the presence-aware push notification routing in Our Space. Load this when implementing or modifying any push path.

## Architecture Note

**FCM is the only push transport.** There is no Web Push, no Service Worker, no VAPID. Web Push and PWA infrastructure were removed because:

1. The app runs as a hosted-webapp Capacitor shell (`server.url`) — the WebView doesn't run service workers reliably.
2. Maintaining two transport stacks (FCM + Web Push) for a two-user app was cost-disproportionate.

If a future contributor proposes adding Web Push back, they must read [`./capacitor-native.md`](./capacitor-native.md) Section "Why No Web Push" and explain why the prior reasoning no longer applies.

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

### Step 4 — FCM delivery

```ts
const fcmToken = await redis.get<string>(`push:fcm:${targetAuthor}`);
if (!fcmToken) {
  logger.info(`[push] No FCM token for ${targetAuthor}.`);
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

  await getMessaging().send({
    token: fcmToken,
    ...(isAppOpen
      ? {
          // Foreground: data-only payload — Capacitor intercepts,
          // FCMProvider dispatches PushToast in-app.
          data: {
            url: payload.url,
            title: payload.title,
            body: payload.body,
          },
        }
      : {
          // Background/closed: full notification payload —
          // the OS draws the heads-up banner natively.
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: { url: payload.url },
          android: { priority: "high" },
        }),
  });
} catch (err) {
  logger.error("[push] FCM send failed:", err);
  // No fallback. The notification record in history is the only artifact.
}
```

**Critical detail:** the `notification` field must NOT be present in the foreground payload. If it is, Android draws a system banner _and_ the in-app `PushToast` — the user sees the same message twice.

The `firebase-admin` SDK is imported dynamically. Top-level imports inflate the Edge bundle and break runtime detection.

---

## Storage Keys

| Key                      | Type   | TTL  | Purpose                                |
| ------------------------ | ------ | ---- | -------------------------------------- |
| `presence:{author}`      | STRING | 6s   | `{ page, ts }` JSON — heartbeat target |
| `push:fcm:{author}`      | STRING | none | FCM device token (Android with GMS)    |
| `notifications:{author}` | LIST   | none | Last 50 records (LPUSH + LTRIM)        |

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

| Symptom                                     | Cause                                       | Fix                                         |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| Duplicate banner + toast on Android         | `notification` field set in foreground path | Strip `notification` when `isAppOpen`       |
| Notifications stop after server restart     | Firebase Admin re-initialized               | Guard with `if (!getApps().length)`         |
| Push fires while user is on the target page | Presence stale or never written             | Check `usePresence(currentRoute)` is called |
| `FIREBASE_PRIVATE_KEY` parse error          | `\n` literals not converted                 | `.replace(/\\n/g, '\n')` at runtime         |

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
