"use client";

import { useCallback } from "react";
import { motion } from "motion/react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePullToRefresh } from "@/hooks/use-pull-to-refresh";

export function PullToRefresh() {
  const handleRefresh = useCallback(async () => {
    window.dispatchEvent(new CustomEvent("ourspace:refresh"));
    // Hold the spinner visible while pages fetch
    await new Promise<void>((resolve) => setTimeout(resolve, 900));
  }, []);

  const { pullDistance, isRefreshing, isPulling } = usePullToRefresh({
    onRefresh: handleRefresh,
    threshold: 80,
  });

  // Architectural Fix: Decouple visual offset from raw distance
  // Start hidden at -50px. When refreshing, hold steady at 40px.
  const yOffset = isRefreshing ? 40 : Math.max(-50, pullDistance - 50);
  const rotation = isRefreshing ? 0 : (pullDistance / 80) * 180;

  return (
    <div className="pointer-events-none fixed left-0 right-0 top-0 z-60 flex justify-center">
      <motion.div
        initial={{ y: -50, opacity: 0 }}
        animate={{
          y: yOffset,
          opacity: pullDistance > 10 || isRefreshing ? 1 : 0,
        }}
        transition={{
          // Instant tracking while dragging, native spring physics on release
          type: isPulling ? "tween" : "spring",
          duration: isPulling ? 0 : undefined,
          bounce: 0.25,
        }}
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full",
          "border border-white/10 bg-card/80 shadow-lg backdrop-blur-sm",
        )}
      >
        {isRefreshing ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <motion.div
            animate={{ rotate: rotation }}
            transition={{ type: "tween", duration: 0 }} // Instant rotation tracking
          >
            <RefreshCw
              className="h-4 w-4 text-primary"
              style={{ opacity: Math.min(pullDistance / 80, 1) }}
            />
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
