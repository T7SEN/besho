/**
 * Triggers a short haptic pulse on devices that support it (Android).
 * Silently ignored on iOS, desktop, and when the Vibration API is unavailable.
 */
export function vibrate(pattern: number | number[] = 8) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}
