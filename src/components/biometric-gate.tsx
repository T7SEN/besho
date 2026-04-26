"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Fingerprint, Lock, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";

// How long the app can be backgrounded before re-locking (ms)
const LOCK_AFTER_MS = 30_000;

// Preference key stored on device
const ENROLLED_KEY = "biometric_enrolled";

type GateState =
  | "checking" // Determining if biometrics available + enrolled
  | "locked" // Showing the lock screen
  | "prompting" // Biometric prompt is active
  | "unlocked" // Authenticated — render children
  | "unavailable"; // Native not available, render children immediately

function isNative(): boolean {
  const cap = (
    globalThis as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return typeof cap !== "undefined" && !!cap.isNativePlatform?.();
}

interface BiometricGateProps {
  children: React.ReactNode;
}

export function BiometricGate({ children }: BiometricGateProps) {
  const [gateState, setGateState] = useState<GateState>("checking");
  const [biometryLabel, setBiometryLabel] = useState("Biometrics");
  const [authError, setAuthError] = useState<string | null>(null);
  const backgroundedAtRef = useRef<number | null>(null);
  const isAuthenticatingRef = useRef(false);

  // ── Authenticate ──────────────────────────────────────────────────────────
  const authenticate = useCallback(async () => {
    if (isAuthenticatingRef.current) return;
    isAuthenticatingRef.current = true;
    setGateState("prompting");
    setAuthError(null);

    try {
      const { BiometricAuth, BiometryType } =
        await import("@aparajita/capacitor-biometric-auth");

      const { isAvailable, biometryType } = await BiometricAuth.checkBiometry();

      if (!isAvailable) {
        // No biometrics on device — skip gate entirely
        setGateState("unavailable");
        isAuthenticatingRef.current = false;
        return;
      }

      // Set human-readable label
      const label =
        biometryType === BiometryType.faceId
          ? "Face ID"
          : biometryType === BiometryType.touchId
            ? "Touch ID"
            : biometryType === BiometryType.faceAuthentication
              ? "Face Unlock"
              : biometryType === BiometryType.fingerprintAuthentication
                ? "Fingerprint"
                : "Biometrics";
      setBiometryLabel(label);

      await BiometricAuth.authenticate({
        reason: `Use ${label} to open Our Space`,
        cancelTitle: "Use Password",
        allowDeviceCredential: false,
        androidTitle: "Our Space",
        androidSubtitle: `Authenticate with ${label}`,
        androidConfirmationRequired: false,
      });

      // Success
      void vibrate(50, "medium");
      setGateState("unlocked");

      // Mark as enrolled so future opens skip the password
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: ENROLLED_KEY, value: "true" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // User tapped "Use Password" or cancelled
      if (
        message.includes("cancel") ||
        message.includes("Cancel") ||
        message.includes("USER_CANCELED") ||
        message.includes("userCancel")
      ) {
        setGateState("locked");
        setAuthError("use_password");
      } else {
        // Actual failure (too many attempts, lockout etc.)
        void vibrate([50, 100, 50], "heavy");
        setGateState("locked");
        setAuthError("failed");
      }
    } finally {
      isAuthenticatingRef.current = false;
    }
  }, []);

  // ── Initial check ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isNative()) {
      setTimeout(() => {
        setGateState("unavailable");
      }, 0);
      return;
    }

    void (async () => {
      try {
        const { BiometricAuth } =
          await import("@aparajita/capacitor-biometric-auth");
        const { isAvailable } = await BiometricAuth.checkBiometry();

        if (!isAvailable) {
          setGateState("unavailable");
          return;
        }

        // Check if user has previously authenticated (enrolled)
        const { Preferences } = await import("@capacitor/preferences");
        const { value } = await Preferences.get({ key: ENROLLED_KEY });

        if (value === "true") {
          // Returning user — show lock screen and auto-trigger biometric
          setGateState("locked");
          await authenticate();
        } else {
          // First time — show lock screen, wait for tap
          setGateState("locked");
        }
      } catch {
        setGateState("unavailable");
      }
    })();
  }, [authenticate]);

  // ── Background → foreground re-lock ───────────────────────────────────────
  useEffect(() => {
    if (!isNative()) return;

    let removeListener: (() => void) | null = null;

    void (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const listener = await App.addListener(
          "appStateChange",
          async ({ isActive }) => {
            if (!isActive) {
              backgroundedAtRef.current = Date.now();
              return;
            }

            if (backgroundedAtRef.current === null) return;
            const elapsed = Date.now() - backgroundedAtRef.current;
            backgroundedAtRef.current = null;

            if (elapsed >= LOCK_AFTER_MS && gateState === "unlocked") {
              setGateState("locked");
              setAuthError(null);
              await authenticate();
            }
          },
        );
        removeListener = () => void listener.remove();
      } catch (err) {
        console.error("[biometric] App listener failed:", err);
      }
    })();

    return () => {
      removeListener?.();
    };
  }, [gateState, authenticate]);

  // ── Render children immediately if not native or unavailable ─────────────
  if (gateState === "unavailable") return <>{children}</>;

  return (
    <>
      {/* Always render children in background so the app loads */}
      <div
        aria-hidden={gateState !== "unlocked"}
        className={cn(
          gateState !== "unlocked" && "pointer-events-none select-none",
        )}
      >
        {children}
      </div>

      {/* Lock overlay */}
      <AnimatePresence>
        {(gateState === "locked" ||
          gateState === "prompting" ||
          gateState === "checking") && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.05, filter: "blur(8px)" }}
            transition={{ duration: 0.3 }}
            className={cn(
              "fixed inset-0 z-200 flex flex-col items-center justify-center",
              "bg-background",
            )}
            style={{ paddingTop: "env(safe-area-inset-top)" }}
          >
            {/* Ambient glow */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="absolute left-1/2 top-1/3 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-[100px]" />
            </div>

            <div className="relative z-10 flex flex-col items-center gap-8 px-8 text-center">
              {/* Icon */}
              <motion.div
                animate={
                  gateState === "prompting" ? { scale: [1, 1.08, 1] } : {}
                }
                transition={{
                  duration: 1.5,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                className={cn(
                  "flex h-24 w-24 items-center justify-center rounded-full",
                  "border-2 transition-colors duration-500",
                  gateState === "prompting"
                    ? "border-primary/60 bg-primary/10"
                    : authError === "failed"
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-white/10 bg-white/5",
                )}
              >
                {gateState === "checking" ? (
                  <Loader2 className="h-10 w-10 animate-spin text-muted-foreground/40" />
                ) : authError === "failed" ? (
                  <Lock className="h-10 w-10 text-destructive/60" />
                ) : (
                  <Fingerprint
                    className={cn(
                      "h-10 w-10 transition-colors duration-500",
                      gateState === "prompting"
                        ? "text-primary"
                        : "text-muted-foreground/40",
                    )}
                  />
                )}
              </motion.div>

              {/* App name */}
              <div className="space-y-2">
                <h1 className="text-2xl font-black tracking-tight text-foreground">
                  Our Space
                </h1>
                <p
                  className={cn(
                    "text-sm font-medium transition-colors",
                    authError === "failed"
                      ? "text-destructive/80"
                      : "text-muted-foreground/60",
                  )}
                >
                  {gateState === "checking" && "Loading…"}
                  {gateState === "prompting" && `Waiting for ${biometryLabel}…`}
                  {gateState === "locked" &&
                    authError === "failed" &&
                    "Authentication failed"}
                  {gateState === "locked" &&
                    authError === "use_password" &&
                    "Enter your password below"}
                  {gateState === "locked" &&
                    !authError &&
                    `Unlock with ${biometryLabel}`}
                </p>
              </div>

              {/* Buttons */}
              {gateState === "locked" && (
                <div className="flex flex-col items-center gap-3 w-full">
                  {authError !== "use_password" && (
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={() => void authenticate()}
                      className={cn(
                        "flex w-full max-w-xs items-center justify-center gap-2",
                        "rounded-full bg-primary px-8 py-3.5",
                        "text-sm font-bold text-primary-foreground",
                        "transition-all hover:bg-primary/90 hover:scale-105",
                      )}
                    >
                      <Fingerprint className="h-4 w-4" />
                      Unlock with {biometryLabel}
                    </motion.button>
                  )}

                  <motion.button
                    whileTap={{ scale: 0.95 }}
                    onClick={() => {
                      // Navigate to login page — session cookie handles
                      // the rest; after login the gate will be unlocked
                      void vibrate(30, "light");
                      (
                        globalThis as unknown as {
                          location: { href: string };
                        }
                      ).location.href = "/login";
                    }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-6 py-2.5",
                      "text-xs font-bold uppercase tracking-wider",
                      "text-muted-foreground/50 transition-all",
                      "hover:bg-white/5 hover:text-muted-foreground",
                    )}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Use Password
                  </motion.button>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
