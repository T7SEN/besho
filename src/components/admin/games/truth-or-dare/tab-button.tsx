// src/components/admin/games/truth-or-dare/tab-button.tsx
"use client";

import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";

/** The three valid tabs on the admin TOD page. Exported so the page
 *  + sibling components can share the union without duplication. */
export type AdminTodTab = "active" | "history" | "stats";

interface TabButtonProps {
  tab: AdminTodTab;
  current: AdminTodTab;
  onSelect: (t: AdminTodTab) => void;
  children: React.ReactNode;
}

/** Pill-style tab toggle used in the admin TOD tab strip. Light haptic
 *  on tap; `aria-selected` reflects state for screen readers. */
export function TabButton({ tab, current, onSelect, children }: TabButtonProps) {
  const active = tab === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => {
        void vibrate(20, "light");
        onSelect(tab);
      }}
      className={cn(
        "inline-flex items-center rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-widest transition-colors",
        "active:scale-[0.97]",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
