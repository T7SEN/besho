// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

/**
 * Errors raised from inside Next's server-action client
 * (`fetchServerAction`) that are universally non-actionable. Two
 * families, both narrowed by the same stack-frame check so unrelated
 * errors with the same message still surface.
 *
 * Family 1 — Network-layer `TypeError`:
 *   `Failed to fetch` (Chrome/Edge), `network error` (Capacitor WebView
 *   / older Chromium), `Load failed` (Safari). Caused by WiFi →
 *   cellular handoffs, WebView pauses on app background, TLS
 *   resumption hiccups, cellular signal drops. Multiple successful
 *   POSTs always precede the failure; a retry moments later succeeds.
 *
 * Family 2 — Generic non-text/plain response `Error`:
 *   `"An unexpected response was received from the server."` Next
 *   throws this when the server-action POST gets a response with a
 *   content-type other than text/plain — i.e. an HTML 404 or
 *   non-server-action error page. Real server-action 5xx errors
 *   return text/plain with the actual error string and never trigger
 *   this fallback. The universe of cases producing this message is
 *   "the URL didn't match a server-action handler" — bad URL, route
 *   moved, or a passive component (DeviceTracker, refresh listener)
 *   firing on a 404 page.
 */
const NETWORK_FETCH_MESSAGES = [
  /^failed to fetch$/i,
  /^network error$/i,
  /^load failed$/i, // Safari's flavor
];

const SERVER_ACTION_ROUTE_MISMATCH_MESSAGE =
  "An unexpected response was received from the server.";

function hasServerActionFrame(
  exception: NonNullable<Sentry.ErrorEvent["exception"]>["values"] extends
    | (infer V)[]
    | undefined
    ? V
    : never,
): boolean {
  const frames = exception?.stacktrace?.frames ?? [];
  return frames.some((f) => {
    const fn = f.function ?? "";
    const file = f.filename ?? "";
    return (
      fn.includes("fetchServerAction") ||
      file.includes("server-action-reducer")
    );
  });
}

function isServerActionNetworkError(event: Sentry.ErrorEvent): boolean {
  const exception = event.exception?.values?.[0];
  if (!exception) return false;
  if (exception.type !== "TypeError") return false;
  const value = (exception.value ?? "").trim();
  if (!NETWORK_FETCH_MESSAGES.some((re) => re.test(value))) return false;
  return hasServerActionFrame(exception);
}

function isServerActionRouteMismatch(event: Sentry.ErrorEvent): boolean {
  const exception = event.exception?.values?.[0];
  if (!exception) return false;
  if (exception.type !== "Error") return false;
  if ((exception.value ?? "").trim() !== SERVER_ACTION_ROUTE_MISMATCH_MESSAGE) {
    return false;
  }
  return hasServerActionFrame(exception);
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Add optional integrations for additional features
  integrations: [Sentry.replayIntegration()],

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

  beforeSend(event) {
    if (isServerActionNetworkError(event)) return null;
    if (isServerActionRouteMismatch(event)) return null;
    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
