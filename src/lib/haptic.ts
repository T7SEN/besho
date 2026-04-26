/**
 * Triggers a haptic pulse on devices that support the Vibration API.
 *
 * ✅ Android Chrome — fully supported
 * ❌ Desktop browsers — intentionally unsupported by the spec (no-op)
 * ❌ iOS Safari — not supported; Apple gates haptics at the native layer
 *
 * The Vibration API unit is milliseconds. The sensory threshold for a
 * felt vibration is ~50ms — this function enforces that as a minimum
 * for scalar values. Array patterns (rhythms) are left untouched.
 *
 * NOTE: The system vibration setting is respected. If the Android device
 * has vibration disabled in Settings → Sound, this will silently no-op.
 */
export function vibrate(pattern: number | number[] = 50): void {
  const win = globalThis as unknown as {
    navigator?: {
      vibrate?: (pattern: number | number[]) => boolean;
    };
  };

  if (!win.navigator?.vibrate) return;

  const corrected =
    typeof pattern === "number" ? Math.max(pattern, 50) : pattern;

  win.navigator.vibrate(corrected);
}
