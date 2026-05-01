"use client";

import { logger } from "@/lib/logger";
import { isNative } from "@/lib/native";
import { useEffect, useState } from "react";

/**
 * Returns the current software keyboard height in pixels.
 *
 * ARCHITECTURAL CONTEXT:
 * This hook is designed to work with `resize: "none"` in capacitor.config.ts.
 * The webview remains full-screen, and the keyboard slides over it.
 * Use this hook to smoothly animate your input fields above the keyboard edge.
 *
 * Usage:
 *   const keyboardHeight = useKeyboardHeight()
 *   <motion.div style={{ paddingBottom: keyboardHeight }}>...
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
          // requestAnimationFrame ensures the React state update paints
          // in sync with the browser's rendering cycle, reducing jitter.
          requestAnimationFrame(() => {
            setHeight(info.keyboardHeight);
          });
        });

        hideHandle = await Keyboard.addListener("keyboardWillHide", () => {
          requestAnimationFrame(() => {
            setHeight(0);
          });
        });
      } catch (err) {
        logger.error("[keyboard] Failed to initialize listeners:", err);
      }
    })();

    return () => {
      showHandle?.remove();
      hideHandle?.remove();
    };
  }, []);

  return height;
}
