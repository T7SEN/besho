/**
 * Unified haptic feedback utility.
 *
 * On native Android (Capacitor): uses @capacitor/haptics which talks
 * directly to the Android vibration API — works regardless of DND.
 *
 * On PWA (browser): falls back to navigator.vibrate with a 50ms minimum.
 * Silently ignored on iOS and desktop.
 */

type HapticStyle = "light" | "medium" | "heavy";

function isNative(): boolean {
  const cap = (
    globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return typeof cap !== "undefined" && !!cap.isNativePlatform?.();
}

export async function vibrate(
  pattern: number | number[] = 50,
  style: HapticStyle = "medium",
): Promise<void> {
  if (isNative()) {
    try {
      const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
      const styleMap: Record<
        HapticStyle,
        (typeof ImpactStyle)[keyof typeof ImpactStyle]
      > = {
        light: ImpactStyle.Light,
        medium: ImpactStyle.Medium,
        heavy: ImpactStyle.Heavy,
      };
      await Haptics.impact({ style: styleMap[style] });
    } catch (err) {
      console.error("[haptic] Capacitor haptics failed:", err);
    }
    return;
  }

  // PWA fallback
  const win = globalThis as unknown as {
    navigator?: { vibrate?: (pattern: number | number[]) => boolean };
  };
  if (!win.navigator?.vibrate) return;

  const corrected =
    typeof pattern === "number" ? Math.max(pattern, 50) : pattern;
  win.navigator.vibrate(corrected);
}
