"use client";

import { motion } from "motion/react";
import { WifiOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Offline fallback page.
 * Uses 'globalThis' to safely access browser APIs during the
 * Next.js 16 build-time pre-rendering phase.
 */
export default function OfflinePage() {
  const handleRetry = () => {
    // Checks for the existence of the global object before attempting reload
    if (typeof globalThis !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).location?.reload();
    }
  };

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background p-6 text-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="max-w-md space-y-8"
      >
        {/* Visual Indicator */}
        <div className="relative mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-zinc-900/50 ring-1 ring-zinc-800">
          <WifiOff className="h-10 w-10 text-zinc-500" />
          <motion.div
            className="absolute inset-0 rounded-full border border-zinc-500/20"
            animate={{ scale: [1, 1.2, 1] }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        </div>

        {/* Content */}
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-100">
            We&apos;re currently offline
          </h1>
          <p className="text-balance text-zinc-400">
            The stars are still aligned, but your connection isn&apos;t.
            Don&apos;t worry—we&apos;ll be back as soon as you reconnect.
          </p>
        </div>

        {/* Action */}
        <div className="pt-4">
          <Button
            onClick={handleRetry}
            variant="outline"
            className="group h-12 gap-2 border-zinc-800 bg-zinc-900/50 px-8 hover:bg-zinc-800"
          >
            <RefreshCw className="h-4 w-4 transition-transform group-hover:rotate-180" />
            Try Reconnecting
          </Button>
        </div>

        {/* Brand Footer */}
        <p className="pt-12 text-xs font-medium uppercase tracking-widest text-zinc-600">
          Our Space
        </p>
      </motion.div>
    </main>
  );
}
