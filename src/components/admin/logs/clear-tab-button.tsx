"use client";

// src/components/admin/logs/clear-tab-button.tsx
//
// Two-tap confirm clear button shared across log tabs. Each tab passes
// its own onClear callback so destructive ops are scoped to that tab's
// dataset — never global. Mirrors the existing PurgeButton confirm
// pattern (timeout-reverts after 5s).
//
// Disabled when `count` is 0 so Sir can see at a glance whether there's
// anything to clear.

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { vibrate } from "@/lib/haptic";

const CONFIRM_TIMEOUT_MS = 5_000;

export function ClearTabButton({
  label,
  count,
  onClear,
}: {
  /** Singular noun, e.g. "activity", "auth log". Used in the confirm
   *  button label ("Clear N activity"). */
  label: string;
  count: number;
  onClear: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleClick = async () => {
    if (!confirming) {
      void vibrate(50, "medium");
      setConfirming(true);
      return;
    }
    void vibrate([100, 50, 100], "heavy");
    setClearing(true);
    try {
      await onClear();
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={count === 0}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95 disabled:opacity-40"
      >
        <Trash2 className="h-3 w-3" />
        Clear
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={clearing}
      className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
    >
      {clearing ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Trash2 className="h-3 w-3" />
      )}
      Clear {count} {label}
    </button>
  );
}
