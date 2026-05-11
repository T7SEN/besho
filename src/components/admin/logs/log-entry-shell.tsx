"use client";

// src/components/admin/logs/log-entry-shell.tsx
//
// Shared visual shell for every kind of log entry across all four
// tabs. Renders:
//   - severity stripe on the left edge (Sentry-style 4px)
//   - header row: pill (left) + relative time + copy button (right)
//   - summary line (always visible)
//   - optional expanded detail (toggled by clicking the row)
//
// Time shows the relative label by default and the full ISO timestamp
// on hover via `title` (Vercel-style — exact timestamps are one
// pointer-hover away without occupying the layout).
//
// Parent owns the expanded state via a Set keyed by entry id so it
// survives refetches (Live mode tick won't collapse what Sir was
// reading).

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export type LogSeverity =
  | "interaction"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "danger"
  | "success"
  | "neutral";

const STRIPE_CLASS: Record<LogSeverity, string> = {
  interaction: "border-l-primary/60",
  info: "border-l-muted-foreground/40",
  warn: "border-l-amber-400/70",
  error: "border-l-destructive/80",
  fatal: "border-l-destructive",
  danger: "border-l-destructive/70",
  success: "border-l-emerald-500/70",
  neutral: "border-l-border",
};

const HOVER_BG: Record<LogSeverity, string> = {
  interaction: "hover:bg-primary/5",
  info: "hover:bg-muted/40",
  warn: "hover:bg-amber-400/5",
  error: "hover:bg-destructive/5",
  fatal: "hover:bg-destructive/10",
  danger: "hover:bg-destructive/5",
  success: "hover:bg-emerald-500/5",
  neutral: "hover:bg-muted/40",
};

export function formatRelativeTs(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1_000) return "just now";
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function LogEntryShell({
  severity,
  pill,
  timestamp,
  now,
  copyText,
  summary,
  expandedContent,
  expanded,
  onToggle,
}: {
  severity: LogSeverity;
  /** The colored chip (left of header). Caller controls text + style. */
  pill: ReactNode;
  timestamp: number;
  now: number;
  /** Text written to the clipboard when Sir hits Copy. */
  copyText: string;
  summary: ReactNode;
  /** When set, the row becomes clickable and shows a chevron. Pass
   *  null/undefined to disable expansion entirely (auth failures etc.
   *  where every field already shows). */
  expandedContent?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const canExpand = expandedContent !== undefined && expandedContent !== null;
  const isoStamp = new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);

  return (
    <li
      onClick={canExpand ? onToggle : undefined}
      className={cn(
        "group rounded-xl border border-l-4 border-border/40 bg-card p-3 transition-colors",
        STRIPE_CLASS[severity],
        canExpand && [
          "cursor-pointer",
          HOVER_BG[severity],
        ],
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {canExpand &&
            (expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            ))}
          {pill}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="font-mono text-[10px] tabular-nums text-muted-foreground"
            title={isoStamp + " UTC"}
          >
            {formatRelativeTs(timestamp, now)}
          </span>
          <CopyButton text={copyText} size="xs" />
        </div>
      </div>
      <div className="mt-1.5 pl-0">{summary}</div>
      {canExpand && expanded && (
        <div
          // Don't toggle the row when the user selects/copies inside the
          // expanded content.
          onClick={(e) => e.stopPropagation()}
          className="mt-2 border-t border-border/30 pt-2"
        >
          {expandedContent}
        </div>
      )}
    </li>
  );
}
