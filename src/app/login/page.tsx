"use client";

import { useActionState } from "react";
import { motion } from "motion/react";
import { Lock, ArrowRight, Loader2 } from "lucide-react";
import { login } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Must match the constant in biometric-gate.tsx
const SKIP_BIOMETRIC_KEY = "ourspace_skip_biometric";

type SessionStorageLike = {
  setItem: (k: string, v: string) => void;
};

/**
 * Sets the biometric skip flag synchronously in the form's onSubmit
 * handler — NOT in a useEffect. The login server action calls redirect()
 * which navigates the page away before any useEffect can fire, so the
 * flag would never be written that way. onSubmit fires before the action
 * starts, guaranteeing the flag is present when BiometricGate mounts on
 * the subsequent "/" route.
 */
function writeSkipFlag() {
  try {
    const ss = (
      globalThis as unknown as { sessionStorage?: SessionStorageLike }
    ).sessionStorage;
    ss?.setItem(SKIP_BIOMETRIC_KEY, "1");
  } catch {
    /* sessionStorage unavailable — gate will prompt once more, acceptable */
  }
}

export default function LoginPage() {
  const [state, action, isPending] = useActionState(login, null);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "absolute left-[-20%] top-[-10%] h-125 w-125",
            "rounded-full bg-primary/10 blur-[120px]",
          )}
        />
        <div
          className={cn(
            "absolute bottom-[-10%] right-[-20%] h-125 w-125",
            "rounded-full bg-blue-500/10 blur-[120px]",
          )}
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ duration: 0.8, type: "spring", bounce: 0 }}
        className="relative z-10 w-full max-w-md"
      >
        <div className="flex flex-col items-center justify-center space-y-8 rounded-3xl border border-white/5 bg-card/40 p-10 backdrop-blur-xl shadow-2xl shadow-black/40">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Lock className="h-8 w-8" />
          </div>

          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold tracking-tight">Our Space</h1>
            <p className="text-sm text-muted-foreground">
              Enter the passcode to unlock our digital world.
            </p>
          </div>

          <form
            action={action}
            onSubmit={writeSkipFlag}
            className="w-full space-y-4"
          >
            <div className="space-y-2">
              <input
                type="password"
                name="passcode"
                placeholder="Passcode"
                required
                disabled={isPending}
                className={cn(
                  "flex h-12 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2 text-sm",
                  "ring-offset-background placeholder:text-muted-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                  "disabled:cursor-not-allowed disabled:opacity-50 transition-all",
                )}
              />
              {state?.error && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="text-sm font-medium text-destructive"
                >
                  {state.error}
                </motion.p>
              )}
            </div>

            <Button
              type="submit"
              disabled={isPending}
              className="h-12 w-full rounded-xl font-semibold transition-all hover:scale-[1.02]"
            >
              {isPending ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <>
                  Unlock <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
