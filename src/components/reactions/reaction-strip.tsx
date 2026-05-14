// src/components/reactions/reaction-strip.tsx
"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { REACTION_OPTIONS, type ReactionEmoji } from "@/lib/reaction-constants";
import { vibrate } from "@/lib/haptic";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ReactionStripProps {
  /** Current reactions map: { author: emoji }. */
  reactions: Record<string, string>;
  /** Who's looking — needed to compute "my reaction" highlight + the
   *  optimistic toggle. Null when unauth (Add-reaction is hidden in
   *  that case). */
  currentAuthor: string | null;
  /** Generic server action — called with the toggled emoji. Implements
   *  the same add/remove/replace toggle semantics as the notes path
   *  (delegate to `reactToTarget` / `reactToNote`). */
  onToggle: (
    emoji: ReactionEmoji,
  ) => Promise<{ reactions: Record<string, string>; error?: string }>;
  /** Local-state setter for optimistic updates. */
  onReactionsChange: (reactions: Record<string, string>) => void;
  /** Visual density. `"default"` matches the notes feed; `"compact"`
   *  shrinks chips + button for use inside denser cards (e.g. the TOD
   *  history list). */
  variant?: "default" | "compact";
}

function groupReactions(
  reactions: Record<string, string>,
): { emoji: string; label: string; count: number; authors: string[] }[] {
  const groups: Record<string, string[]> = {};
  for (const [author, emoji] of Object.entries(reactions)) {
    if (!groups[emoji]) groups[emoji] = [];
    groups[emoji].push(author);
  }
  return Object.entries(groups).map(([emoji, authors]) => ({
    emoji,
    label: REACTION_OPTIONS.find((r) => r.emoji === emoji)?.label ?? emoji,
    count: authors.length,
    authors,
  }));
}

/** Mirrors the server-side toggle in `reactToTarget`:
 *   - Same emoji as existing → remove the author's entry.
 *   - Different emoji → replace.
 *   - No existing → add. */
function applyToggle(
  reactions: Record<string, string>,
  author: string,
  emoji: string,
): Record<string, string> {
  const existing = reactions[author];
  const next = { ...reactions };
  if (existing === emoji) {
    delete next[author];
  } else {
    next[author] = emoji;
  }
  return next;
}

/**
 * Generic reaction strip — feature-agnostic. Renders existing reaction
 * pills + an "Add reaction" button that opens a 15-emoji picker
 * sourced from `REACTION_OPTIONS`. Uses the codebase's standard
 * snapshot/rollback optimistic-UI pattern (see
 * `references/coding-patterns.md` § "Optimistic UI with Snapshot
 * Rollback"). The caller supplies the server action via `onToggle`,
 * so the same UI backs both notes and TOD challenges.
 */
export function ReactionStrip({
  reactions,
  currentAuthor,
  onToggle,
  onReactionsChange,
  variant = "default",
}: ReactionStripProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const grouped = groupReactions(reactions);
  const myReaction = currentAuthor ? reactions[currentAuthor] : null;

  const handleReact = async (emoji: string) => {
    if (isSubmitting) return;
    if (!currentAuthor) return;

    void vibrate(50, "light");
    setShowPicker(false);

    const snapshot = reactions;
    const optimistic = applyToggle(reactions, currentAuthor, emoji);
    onReactionsChange(optimistic);

    setIsSubmitting(true);
    try {
      const result = await onToggle(emoji as ReactionEmoji);
      if (result.error) {
        onReactionsChange(snapshot);
      } else {
        onReactionsChange(result.reactions);
      }
    } catch {
      onReactionsChange(snapshot);
    } finally {
      setIsSubmitting(false);
    }
  };

  const compact = variant === "compact";

  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      <AnimatePresence>
        {grouped.map(({ emoji, label, count, authors }) => {
          const isMyReaction = currentAuthor
            ? authors.includes(currentAuthor)
            : false;
          return (
            <Tooltip key={emoji} delayDuration={200}>
              <TooltipTrigger asChild>
                <motion.button
                  initial={{ opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.7 }}
                  whileTap={{ scale: 0.85 }}
                  transition={{ type: "spring", bounce: 0.4, duration: 0.3 }}
                  onClick={() => handleReact(emoji)}
                  className={cn(
                    "flex items-center gap-1 rounded-full border font-bold transition-all",
                    compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
                    isMyReaction
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/30 bg-black/20 text-muted-foreground hover:border-primary/20",
                  )}
                >
                  <span>{emoji}</span>
                  {!compact && (
                    <span
                      className={cn(
                        "text-[10px] font-semibold",
                        isMyReaction
                          ? "text-primary/80"
                          : "text-muted-foreground/60",
                      )}
                    >
                      {label}
                    </span>
                  )}
                  {count > 1 && (
                    <span
                      className={cn(
                        "ml-0.5 text-[10px]",
                        isMyReaction
                          ? "text-primary/60"
                          : "text-muted-foreground/40",
                      )}
                    >
                      {count}
                    </span>
                  )}
                </motion.button>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="border-white/10 bg-black/80 text-[10px] backdrop-blur-md"
              >
                {authors.join(", ")}
                {compact && ` · ${label}`}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </AnimatePresence>

      <div className="relative">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => {
            void vibrate(30, "light");
            setShowPicker((v) => !v);
          }}
          aria-label="Add reaction"
          className={cn(
            "flex items-center gap-1 rounded-full border font-bold uppercase tracking-wider transition-all",
            compact ? "h-6 px-2 text-[9px]" : "h-7 px-2.5 text-[10px]",
            "border-border/30 bg-black/20 text-muted-foreground/50",
            "hover:border-primary/20 hover:text-primary/60",
            showPicker && "border-primary/30 bg-primary/10 text-primary/70",
          )}
        >
          {myReaction ? (
            <span>{myReaction}</span>
          ) : (
            <span className="text-base leading-none">+</span>
          )}
          <span>React</span>
        </motion.button>

        <AnimatePresence>
          {showPicker && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 4 }}
              transition={{ type: "spring", bounce: 0.3, duration: 0.25 }}
              className={cn(
                "absolute bottom-9 left-0 z-50 w-72 rounded-2xl border",
                "border-white/10 bg-card/95 p-3 shadow-xl shadow-black/30",
                "backdrop-blur-md",
              )}
            >
              <p className="mb-2 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
                React
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {REACTION_OPTIONS.map((option) => (
                  <motion.button
                    key={option.emoji}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleReact(option.emoji)}
                    className={cn(
                      "flex items-center gap-2 rounded-xl px-2.5 py-2",
                      "text-left transition-all hover:bg-primary/10",
                      myReaction === option.emoji &&
                        "bg-primary/15 ring-1 ring-primary/30",
                    )}
                  >
                    <span className="text-xl leading-none">{option.emoji}</span>
                    <span
                      className={cn(
                        "text-[10px] font-semibold",
                        myReaction === option.emoji
                          ? "text-primary"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {option.label}
                    </span>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
