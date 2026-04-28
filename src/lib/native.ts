interface GlobalWithCapacitor {
  Capacitor?: {
    isNativePlatform?: () => boolean;
  };
}

/**
 * Safely checks if the application is currently running within a native
 * Capacitor shell (iOS/Android) rather than a standard web browser.
 */
export const isNative = (): boolean => {
  if (typeof globalThis === "undefined") return false;

  const cap = (globalThis as unknown as GlobalWithCapacitor).Capacitor;
  return typeof cap !== "undefined" && cap.isNativePlatform?.() === true;
};
