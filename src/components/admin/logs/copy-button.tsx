"use client";

// src/components/admin/logs/copy-button.tsx
//
// Per-log-entry copy button. Click → writes `text` to the system
// clipboard (Capacitor on native, navigator.clipboard on web) and
// flashes a check icon for 1.5s. Failure shows a red "Failed" pill
// for the same duration.
//
// Sized for inline use in the entry-card header. Keep visual weight
// low — it's a utility action, not a primary control.

import { useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";

export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
}: {
  text: string;
  /** Aria label + tooltip — defaults to "Copy". */
  label?: string;
  size?: "sm" | "xs";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const handleClick = async (e: React.MouseEvent) => {
    // Don't bubble up to the parent row's expand/collapse toggle.
    e.stopPropagation();
    void vibrate(15, "light");
    const ok = await writeToClipboard(text);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 1_500);
  };

  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border transition-all active:scale-95",
        size === "sm"
          ? "px-1.5 py-0.5 text-[10px]"
          : "h-5 w-5 justify-center p-0",
        state === "copied"
          ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
          : state === "failed"
            ? "border-destructive/60 bg-destructive/15 text-destructive"
            : "border-border/40 bg-transparent text-muted-foreground hover:border-primary/40 hover:bg-primary/5 hover:text-primary",
      )}
    >
      {state === "copied" ? (
        <Check className="h-3 w-3" />
      ) : state === "failed" ? (
        <X className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {size === "sm" && (
        <span className="font-bold uppercase tracking-wider">
          {state === "copied" ? "Copied" : state === "failed" ? "Failed" : label}
        </span>
      )}
    </button>
  );
}
