"use client";

import { useEffect, useRef, useState, useCallback } from "react";

interface UsePullToRefreshOptions {
  onRefresh: () => Promise<void>;
  /** Drag distance in px required to trigger refresh. Default: 80 */
  threshold?: number;
  enabled?: boolean;
}

export interface PullToRefreshState {
  pullDistance: number;
  isRefreshing: boolean;
  isPulling: boolean;
}

export function usePullToRefresh({
  onRefresh,
  threshold = 80,
  enabled = true,
}: UsePullToRefreshOptions): PullToRefreshState {
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const startYRef = useRef(0);
  const pullRef = useRef(0);
  const isRefreshingRef = useRef(false);
  const isPullingRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    pullRef.current = 0;
    isPullingRef.current = false;

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    requestAnimationFrame(() => {
      setPullDistance(0);
      setIsPulling(false);
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const handleTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 5) return;
      startYRef.current = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (window.scrollY > 5 || isRefreshingRef.current) return;

      const distance = e.touches[0].clientY - startYRef.current;
      if (distance <= 0) return;

      // Architectural Upgrade: Elastic Friction
      // Makes the pull feel heavier the further down you drag.
      const friction = 0.45;
      const elasticDistance = distance * friction;
      const clamped = Math.min(elasticDistance, threshold * 1.5);

      pullRef.current = clamped;

      if (!isPullingRef.current) {
        isPullingRef.current = true;
        requestAnimationFrame(() => setIsPulling(true));
      }

      // Architectural Upgrade: Sync with browser paint cycle
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = requestAnimationFrame(() => {
        setPullDistance(clamped);
      });
    };

    const handleTouchEnd = async () => {
      if (isRefreshingRef.current || pullRef.current < threshold) {
        reset();
        return;
      }

      isRefreshingRef.current = true;
      isPullingRef.current = false;
      pullRef.current = 0;

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }

      requestAnimationFrame(() => {
        setIsPulling(false);
        setPullDistance(0);
        setIsRefreshing(true);
      });

      try {
        await onRefresh();
      } finally {
        isRefreshingRef.current = false;
        requestAnimationFrame(() => setIsRefreshing(false));
      }
    };

    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    window.addEventListener("touchend", handleTouchEnd);

    return () => {
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [enabled, threshold, onRefresh, reset]);

  return { pullDistance, isRefreshing, isPulling };
}
