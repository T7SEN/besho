/**
 * Writes text to the system clipboard.
 *
 * On native Android: uses @capacitor/clipboard which calls
 * ClipboardManager directly — works even when the WebView is not
 * the focused window, unlike navigator.clipboard.writeText().
 *
 * On web: falls back to navigator.clipboard (requires user gesture
 * and page focus).
 *
 * Returns true on success, false on failure. Never throws.
 */

function isNative(): boolean {
  const cap = (
    globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return typeof cap !== "undefined" && !!cap.isNativePlatform?.();
}

export async function writeToClipboard(text: string): Promise<boolean> {
  if (isNative()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      await Clipboard.write({ string: text });
      return true;
    } catch (err) {
      console.error("[clipboard] Capacitor write failed:", err);
    }
  }

  // Web fallback
  try {
    const nav = (
      globalThis as unknown as {
        navigator?: {
          clipboard?: { writeText: (t: string) => Promise<void> };
        };
      }
    ).navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.error("[clipboard] navigator.clipboard failed:", err);
  }

  return false;
}

/**
 * Reads text from the system clipboard.
 * Returns null if reading is unavailable or denied.
 */
export async function readFromClipboard(): Promise<string | null> {
  if (isNative()) {
    try {
      const { Clipboard } = await import("@capacitor/clipboard");
      const { type, value } = await Clipboard.read();
      return type === "text/plain" ? value : null;
    } catch (err) {
      console.error("[clipboard] Capacitor read failed:", err);
    }
  }

  try {
    const nav = (
      globalThis as unknown as {
        navigator?: {
          clipboard?: { readText: () => Promise<string> };
        };
      }
    ).navigator;
    if (nav?.clipboard?.readText) {
      return await nav.clipboard.readText();
    }
  } catch {
    /* clipboard read denied or unavailable */
  }

  return null;
}
