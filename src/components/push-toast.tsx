/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bell, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";

export interface ToastPayload {
  title: string;
  body: string;
  url?: string;
}

// Global event name used to trigger the toast from useFCMRegistration
export const PUSH_TOAST_EVENT = "push-toast";

let toastId = 0;

interface ToastItem {
  id: number;
  payload: ToastPayload;
}

const AUTO_DISMISS_MS = 5_000;

export function PushToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<ToastPayload>).detail;
      const id = ++toastId;
      setToasts((prev) => [...prev, { id, payload }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);

      // Haptic feedback
      void vibrate(50, "heavy");

      // Subtle notification sound via Web Audio API
      try {
        const AudioContext =
          (
            globalThis as unknown as {
              AudioContext?: new () => {
                createOscillator: () => any;
                createGain: () => any;
                destination: any;
                currentTime: number;
              };
              webkitAudioContext?: new () => {
                createOscillator: () => any;
                createGain: () => any;
                destination: any;
                currentTime: number;
              };
            }
          ).AudioContext ??
          (
            globalThis as unknown as {
              webkitAudioContext?: new () => {
                createOscillator: () => any;
                createGain: () => any;
                destination: any;
                currentTime: number;
              };
            }
          ).webkitAudioContext;

        if (AudioContext) {
          const ctx = new AudioContext();
          const oscillator = ctx.createOscillator();
          const gainNode = ctx.createGain();

          oscillator.connect(gainNode);
          gainNode.connect(ctx.destination);

          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(880, ctx.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(
            440,
            ctx.currentTime + 0.15,
          );

          gainNode.gain.setValueAtTime(0.15, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(
            0.001,
            ctx.currentTime + 0.3,
          );

          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        }
      } catch {
        // Audio API unavailable — silent fallback
      }
    };

    const win = globalThis as unknown as {
      addEventListener: (type: string, handler: EventListener) => void;
      removeEventListener: (type: string, handler: EventListener) => void;
      dispatchEvent: (event: Event) => void;
    };
    win.addEventListener(PUSH_TOAST_EVENT, handler);
    return () => win.removeEventListener(PUSH_TOAST_EVENT, handler);
  }, [dismiss]);

  return (
    <div
      className="fixed left-1/2 z-100 flex -translate-x-1/2 flex-col gap-2"
      style={{ top: "calc(env(safe-area-inset-top) + 1rem)" }}
    >
      <AnimatePresence mode="sync">
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.4 }}
            className={cn(
              "flex w-80 items-start gap-3 rounded-2xl border border-white/10",
              "bg-card/95 p-4 shadow-xl shadow-black/30 backdrop-blur-md",
            )}
          >
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bell className="h-4 w-4" />
            </div>

            <button
              onClick={() => {
                if (toast.payload.url) {
                  (
                    globalThis as unknown as { location: { href: string } }
                  ).location.href = toast.payload.url;
                }
                dismiss(toast.id);
              }}
              className="flex-1 text-left"
            >
              <p
                dir="auto"
                className="text-sm font-bold text-foreground"
              >
                {toast.payload.title}
              </p>
              <p
                dir="auto"
                className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70"
              >
                {toast.payload.body}
              </p>
            </button>

            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="mt-0.5 shrink-0 rounded-full p-2 text-muted-foreground/40 transition-colors hover:bg-muted/20 hover:text-muted-foreground active:scale-95"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Dispatches a push toast event from anywhere in the app.
 * Used by useFCMRegistration when a foreground notification arrives.
 */
export function dispatchPushToast(payload: ToastPayload) {
  (
    globalThis as unknown as { dispatchEvent: (e: Event) => void }
  ).dispatchEvent(
    new CustomEvent<ToastPayload>(PUSH_TOAST_EVENT, { detail: payload }),
  );
}
