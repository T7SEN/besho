// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

/**
 * Sentry-side filtering for two non-actionable error families.
 *
 * Family 1 — Network-layer fetch failures:
 *   `TypeError: Failed to fetch` (Chrome/Edge),
 *   `TypeError: network error` (Capacitor WebView / older Chromium),
 *   `TypeError: Load failed` (Safari),
 *   `TypeError: NetworkError when attempting to fetch resource.` (Firefox).
 *   Caused by WiFi → cellular handoffs, WebView pauses on app
 *   background, TLS resumption hiccups, cellular signal drops.
 *   Multiple successful POSTs always precede the failure; a retry
 *   moments later succeeds.
 *
 * Family 2 — Server-action client's content-type fallback:
 *   `Error: An unexpected response was received from the server.`
 *   Next throws this when the server-action POST gets a non-text/plain
 *   response — i.e. an HTML 404 or non-server-action error page. Real
 *   server-action 5xx errors return text/plain with the actual error
 *   string and never trigger this fallback. The universe of cases
 *   producing this message is "the URL didn't match a server-action
 *   handler" — bad URL, route moved, or a passive component
 *   (DeviceTracker, refresh listener) firing on a 404 page.
 *
 * Family 3 — Vercel Toolbar feedback widget Range API misuse:
 *   `InvalidNodeTypeError: Failed to execute 'selectNode' on 'Range':
 *   the given Node has no parent.`
 *   Thrown from `app:///_next-live/feedback/*.js` when the feedback
 *   widget tries to wrap a DOM range that's been detached or unmounted
 *   between the user's annotation gesture and the rAF callback. Third-
 *   party code we don't ship — `<StaffToolbar />` mounts the upstream
 *   bundle as-is. Sir-only on web (per `staff-toolbar.tsx` gate), so
 *   only Sir's session ever surfaces this. We can't fix it, can't
 *   reproduce it on demand, and it's already self-contained inside the
 *   feedback annotation flow — pure noise on our side.
 *
 * Family 4 — Capacitor PushNotifications OS-level disable:
 *   `Error: Notifications not enabled on this device`.
 *   Thrown from the native side of `@capacitor/push-notifications`
 *   `register()` when `NotificationManager.areNotificationsEnabled()`
 *   returns false — i.e. the user has toggled "Allow notifications"
 *   off in OS settings (DIFFERENT from the Android 13+ runtime
 *   `POST_NOTIFICATIONS` grant, which we check separately at the
 *   FCMProvider layer). This is an expected user-side state on first
 *   launch after a fresh install on Vivo / Oppo / Honor (FuntouchOS /
 *   ColorOS / MagicOS all default the toggle off post-install on some
 *   ROM versions). Operational visibility is preserved through
 *   `logger.warn` + the activity feed + the `/admin/health` "tokens
 *   per author" diagnostic — no Issue needed.
 *
 * `ignoreErrors` matches against the exception message string and is
 * invariant under minification — works the same in dev and prod. The
 * earlier `beforeSend`-with-stack-frame-check approach silently failed
 * in production: Turbopack-minified frames don't contain the literal
 * string `fetchServerAction`, and `beforeSend` runs before Sentry's
 * server-side source-map resolution.
 *
 * Trade-off: `ignoreErrors` drops the entire `TypeError: Failed to
 * fetch` family regardless of fetch target. At our scale (two users,
 * all client-side fetches go to our own domain) this is safe. If a
 * future feature adds a third-party client-side fetch with potential
 * CORS issues, we'd want a different observability path.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Add optional integrations for additional features
  integrations: [Sentry.replayIntegration()],

  // Drop the three non-actionable families before transmission. Matches
  // against `event.exception.values[*].value` (the message string).
  // Source-map-independent — works in production minified bundles.
  ignoreErrors: [
    /^Failed to fetch$/i,
    /^network error$/i,
    /^Load failed$/i,
    /^NetworkError when attempting to fetch resource\.?$/i,
    "An unexpected response was received from the server.",
    /Failed to execute 'selectNode' on 'Range'/i,
    /^Notifications not enabled on this device\.?$/i,
  ],

  // Drop any error originating from the Vercel Toolbar's feedback
  // chunk — it's third-party code, Sir-only, and we can't fix bugs
  // inside it. Belt-and-suspenders alongside the Range message regex
  // above; future variations of the same widget bug will be caught
  // here without needing additional `ignoreErrors` maintenance.
  denyUrls: [/\/_next-live\/feedback\//],

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
