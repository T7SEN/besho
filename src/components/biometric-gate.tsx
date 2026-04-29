"use client";

import { useEffect, useState, useCallback, useRef, useTransition } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Fingerprint, Lock, KeyRound, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { isNative } from "@/lib/native";
import { logout } from "@/app/actions/auth";

const LOCK_AFTER_MS = 30_000;
const COLD_START_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes
const ENROLLED_KEY = "biometric_enrolled";
const SKIP_BIOMETRIC_KEY = "ourspace_skip_biometric";
const MAX_AUTO_FAILURES = 2;

const UNGUARDED_ROUTES = ["/login"];

type GateState =
  | "checking"
  | "locked"
  | "prompting"
  | "unlocked"
  | "unavailable";

type SessionStorageLike = {
  getItem: (k: string) => string | null;
  removeItem: (k: string) => void;
  setItem: (k: string, v: string) => void;
};

function readSessionFlag(key: string): boolean {
  try {
    const ss = (
      globalThis as unknown as { sessionStorage?: SessionStorageLike }
    ).sessionStorage;
    return ss?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function clearSessionFlag(key: string): void {
  try {
    const ss = (
      globalThis as unknown as { sessionStorage?: SessionStorageLike }
    ).sessionStorage;
    ss?.removeItem(key);
  } catch {
    // ignore
  }
}

interface BiometricGateProps {
  children: React.ReactNode;
}

export function BiometricGate({ children }: BiometricGateProps) {
  const pathname = usePathname();

  if (UNGUARDED_ROUTES.includes(pathname)) {
    return <>{children}</>;
  }

  return <BiometricGateInner>{children}</BiometricGateInner>;
}

function BiometricGateInner({ children }: BiometricGateProps) {
  const [gateState, setGateState] = useState<GateState>("checking");
  const [biometryLabel, setBiometryLabel] = useState("Biometrics");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const backgroundedAtRef = useRef<number | null>(null);

  // CRITICAL FIX: This ref prevents the Knox/Android lifecycle loop.
  // It ensures that if the app goes to the background/foreground *because*
  // of the native biometric prompt, we don't accidentally fire it again.
  const isAuthenticatingRef = useRef(false);

  const failureCountRef = useRef(0);
  const hasInitializedRef = useRef(false);

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
        setGateState("unavailable");
        isAuthenticatingRef.current = false;
        return;
      }

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

      // ── Success ──
      failureCountRef.current = 0;
      void vibrate(50, "medium");
      setGateState("unlocked");

      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: ENROLLED_KEY, value: "true" });
      await Preferences.set({
        key: "last_unlocked_at",
        value: Date.now().toString(),
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown");

      const isCancelled =
        message.includes("cancel") ||
        message.includes("Cancel") ||
        message.includes("USER_CANCELED") ||
        message.includes("userCancel") ||
        message.includes("DISMISS") ||
        message.includes("dismissed") ||
        message.includes("Negative") ||
        message.includes("negative");

      if (isCancelled) {
        failureCountRef.current = 0;
        setGateState("locked");
        setAuthError("use_password");
      } else {
        failureCountRef.current += 1;
        void vibrate([50, 100, 50], "heavy");
        setGateState("locked");

        if (failureCountRef.current >= MAX_AUTO_FAILURES) {
          setAuthError("use_password");
          failureCountRef.current = 0;
        } else {
          setAuthError("failed");
        }
      }
    } finally {
      // CRITICAL FIX: We add a tiny delay before releasing the lock to ensure
      // Knox has completely relinquished control of the Activity lifecycle.
      setTimeout(() => {
        isAuthenticatingRef.current = false;
      }, 300);
    }
  }, []);

  // ── Initial check ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isNative()) {
      setTimeout(() => setGateState("unavailable"), 0);
      return;
    }

    if (hasInitializedRef.current) return;
    hasInitializedRef.current = true;

    void (async () => {
      try {
        const { BiometricAuth } =
          await import("@aparajita/capacitor-biometric-auth");
        const { isAvailable } = await BiometricAuth.checkBiometry();

        if (!isAvailable) {
          setGateState("unavailable");
          return;
        }

        const { Preferences } = await import("@capacitor/preferences");
        const { value } = await Preferences.get({ key: ENROLLED_KEY });

        if (value === "true") {
          // 1. Check if we just logged in via password
          const shouldSkip = readSessionFlag(SKIP_BIOMETRIC_KEY);
          if (shouldSkip) {
            clearSessionFlag(SKIP_BIOMETRIC_KEY);
            await Preferences.set({
              key: "last_unlocked_at",
              value: Date.now().toString(),
            });
            setGateState("unlocked");
            return;
          }

          // 2. Check persistent grace period (prevents annoying cold-start loops)
          const { value: lastUnlocked } = await Preferences.get({
            key: "last_unlocked_at",
          });
          if (lastUnlocked) {
            const elapsed = Date.now() - parseInt(lastUnlocked, 10);
            if (elapsed < COLD_START_GRACE_PERIOD_MS) {
              setGateState("unlocked");
              return;
            }
          }

          setGateState("locked");
          await authenticate();
        } else {
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
            // CRITICAL FIX: If Knox is currently active, ignore ALL lifecycle events.
            if (isAuthenticatingRef.current) return;

            if (!isActive) {
              if (gateState === "unlocked") {
                backgroundedAtRef.current = Date.now();
                // Refresh grace period timestamp when actively backgrounded
                const { Preferences } = await import("@capacitor/preferences");
                await Preferences.set({
                  key: "last_unlocked_at",
                  value: Date.now().toString(),
                });
              }
              return;
            }

            if (backgroundedAtRef.current === null) return;
            const elapsed = Date.now() - backgroundedAtRef.current;
            backgroundedAtRef.current = null;

            if (elapsed >= LOCK_AFTER_MS && gateState === "unlocked") {
              setGateState("locked");
              setAuthError(null);
              failureCountRef.current = 0;
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

  // ── Render ────────────────────────────────────────────────────────────────
  if (gateState === "unavailable") return <>{children}</>;

  return (
    <>
      <div
        aria-hidden={gateState !== "unlocked"}
        className={cn(
          gateState !== "unlocked" && "pointer-events-none select-none",
        )}
      >
        {children}
      </div>

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

              {/* Label */}
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
                <div className="flex w-full flex-col items-center gap-3">
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
                      void vibrate(30, "light");
                      startTransition(() => {
                        void logout();
                      });
                    }}
                    disabled={isPending}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-6 py-2.5",
                      "text-xs font-bold uppercase tracking-wider",
                      "text-muted-foreground/50 transition-all",
                      "hover:bg-white/5 hover:text-muted-foreground",
                      isPending && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    {isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    {isPending ? "Unlocking..." : "Use Password"}
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
