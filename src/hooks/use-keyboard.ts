"use client";

import { isNative } from "@/lib/native";
import { useEffect, useState } from "react";

/**
 * Returns the current software keyboard height in pixels.
 * 0 when the keyboard is hidden or on web.
 *
 * On native: driven by @capacitor/keyboard keyboardWillShow/Hide events.
 * With Keyboard.resize = "body" in capacitor.config.ts, the body already
 * shrinks — this hook gives you the exact height for additional layout
 * adjustments (e.g. padding the compose bar above the keyboard edge).
 *
 * Usage:
 *   const keyboardHeight = useKeyboardHeight()
 *   <div style={{ paddingBottom: keyboardHeight }}>...</div>
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!isNative()) return;

    type Handle = { remove: () => void };
    let showHandle: Handle | null = null;
    let hideHandle: Handle | null = null;

    void (async () => {
      try {
        const { Keyboard } = await import("@capacitor/keyboard");

        showHandle = await Keyboard.addListener("keyboardWillShow", (info) => {
          setTimeout(() => setHeight(info.keyboardHeight), 0);
        });

        hideHandle = await Keyboard.addListener("keyboardWillHide", () => {
          setTimeout(() => setHeight(0), 0);
        });
      } catch (err) {
        console.error("[keyboard] Failed to initialize listeners:", err);
      }
    })();

    return () => {
      showHandle?.remove();
      hideHandle?.remove();
    };
  }, []);

  return height;
}
