"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Shield, ShieldAlert, Clock, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { triggerSafeWord, getSafeWordCooldown } from "@/app/actions/safeword";
import { vibrate } from "@/lib/haptic";

interface SafeWordCardProps {
  currentAuthor: string | null;
}

function formatCooldown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

export function SafeWordCard({ currentAuthor }: SafeWordCardProps) {
  const [cooldown, setCooldown] = useState(0);
  const [isTriggered, setIsTriggered] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);

  const isBesho = currentAuthor === "Besho";

  const loadCooldown = useCallback(async () => {
    const ttl = await getSafeWordCooldown();
    setCooldown(ttl);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      void loadCooldown();
    }, 0);
  }, [loadCooldown]);

  // Tick down the cooldown every second
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  // Auto-dismiss confirm step after 5s of inaction
  useEffect(() => {
    if (!confirmStep) return;
    const id = setTimeout(() => setConfirmStep(false), 5_000);
    return () => clearTimeout(id);
  }, [confirmStep]);

  const handleFirstTap = () => {
    void vibrate(50, "heavy");
    setConfirmStep(true);
  };

  const handleConfirm = async () => {
    void vibrate([100, 50, 100, 50, 200], "heavy");
    setIsLoading(true);
    setConfirmStep(false);

    const result = await triggerSafeWord();

    if (result.cooldown) {
      setCooldown(result.cooldown);
    } else if (result.success) {
      setIsTriggered(true);
      setCooldown(300);
      setTimeout(() => setIsTriggered(false), 5_000);
    }
    setIsLoading(false);
  };

  // ── T7SEN view — status only ──────────────────────────────────────────────
  if (!isBesho) {
    return (
      <div
        className={cn(
          "flex flex-col justify-between overflow-hidden rounded-3xl",
          "border border-white/5 bg-card/40 p-8",
          "backdrop-blur-xl shadow-xl shadow-black/20",
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Safe Word
          </h2>
          <div className="rounded-full bg-muted/20 p-2 text-muted-foreground/40">
            <Shield className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-6">
          <p className="text-sm font-semibold text-foreground/40">
            Besho&apos;s safe word button
          </p>
          <p className="mt-1 text-xs text-muted-foreground/30">
            You&apos;ll receive an immediate notification if she uses it.
          </p>
        </div>
      </div>
    );
  }

  // ── Besho view — the button ───────────────────────────────────────────────
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-3xl border p-8",
        "backdrop-blur-xl shadow-xl transition-colors",
        isTriggered
          ? "border-destructive/40 bg-destructive/5 shadow-destructive/10"
          : "border-white/5 bg-card/40 shadow-black/20 hover:border-destructive/20",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Safe Word
        </h2>
        <div
          className={cn(
            "rounded-full p-2",
            isTriggered
              ? "bg-destructive/20 text-destructive"
              : "bg-muted/20 text-muted-foreground/40",
          )}
        >
          <ShieldAlert className="h-4 w-4" />
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <p className="text-xs text-muted-foreground/50 leading-relaxed">
          Tap to immediately notify Sir that you need to stop. He will be
          alerted regardless of what he&apos;s doing.
        </p>

        <AnimatePresence mode="wait">
          {isTriggered ? (
            <motion.div
              key="triggered"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-3 rounded-2xl bg-destructive/10 px-4 py-3"
            >
              <CheckCircle2 className="h-5 w-5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-bold text-destructive">
                  Sir has been notified
                </p>
                <p className="text-[10px] text-destructive/60">
                  Help is on the way
                </p>
              </div>
            </motion.div>
          ) : cooldown > 0 ? (
            <motion.div
              key="cooldown"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex items-center gap-2 rounded-2xl bg-muted/20 px-4 py-3"
            >
              <Clock className="h-4 w-4 shrink-0 text-muted-foreground/40" />
              <p className="text-xs font-semibold text-muted-foreground/50">
                Available again in {formatCooldown(cooldown)}
              </p>
            </motion.div>
          ) : confirmStep ? (
            <motion.div
              key="confirm"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="space-y-2"
            >
              <p className="text-center text-xs font-bold uppercase tracking-widest text-destructive/80">
                Are you sure?
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setConfirmStep(false)}
                  className="flex-1 rounded-full border border-border/40 py-2.5 text-xs font-bold text-muted-foreground transition-all hover:border-border"
                >
                  Cancel
                </button>
                <motion.button
                  whileTap={{ scale: 0.95 }}
                  onClick={handleConfirm}
                  disabled={isLoading || undefined}
                  className="flex-1 rounded-full bg-destructive py-2.5 text-xs font-bold text-white transition-all hover:bg-destructive/90 disabled:opacity-50"
                >
                  {isLoading ? "Sending…" : "Yes, send"}
                </motion.button>
              </div>
            </motion.div>
          ) : (
            <motion.button
              key="button"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              onClick={handleFirstTap}
              className={cn(
                "w-full rounded-2xl border-2 border-destructive/40 bg-destructive/10",
                "py-5 text-sm font-black uppercase tracking-widest text-destructive",
                "transition-all hover:bg-destructive/20",
              )}
            >
              🔴 Safe Word
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
