"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Thin top-of-viewport progress bar that surfaces the perceived gap
 * between an internal nav tap and the next route rendering.
 *
 * Hosted-webapp means every navigation is a real network round-trip,
 * so the in-flight feedback matters. We can't get a true loading
 * signal globally without per-Link instrumentation, so we approximate:
 *
 *   1. On any internal `<a href>` click, start the bar.
 *   2. The bar creeps to ~90% on a slow ease.
 *   3. When `usePathname` reports the new path, snap to 100% and fade.
 *   4. If the click was a no-op (same path, fragment, external), the
 *      bar still appears briefly — acceptable false positive on a
 *      surface that's ambient, not noisy.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Pathname just changed — we landed. Snap-and-hide handled by exit
    // anim. Deferred via setTimeout(0) per AGENTS.md § 4 — synchronous
    // setState in an effect body trips react-hooks/set-state-in-effect.
    const t = setTimeout(() => setIsLoading(false), 0);
    return () => clearTimeout(t);
  }, [pathname]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Ignore modifier-key clicks (open in new tab etc.)
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

      const target = e.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      if (href.startsWith("http://") || href.startsWith("https://")) return;
      if (anchor.target && anchor.target !== "_self") return;

      // Same-path nav is a no-op for our purposes.
      if (href === pathname) return;

      setIsLoading(true);
    };

    document.addEventListener("click", handleClick, { capture: true });
    return () =>
      document.removeEventListener("click", handleClick, { capture: true });
  }, [pathname]);

  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          key="progress"
          initial={{ width: "0%", opacity: 1 }}
          animate={{ width: "90%" }}
          exit={{ width: "100%", opacity: 0 }}
          transition={{
            width: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.2 },
          }}
          className={cn(
            "pointer-events-none fixed left-0 z-60 h-0.5 bg-primary",
            "shadow-[0_0_8px_hsl(var(--primary)/0.6)]",
          )}
          style={{ top: "env(safe-area-inset-top)" }}
        />
      )}
    </AnimatePresence>
  );
}
