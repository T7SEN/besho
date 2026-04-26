"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { reactToNote } from "@/app/actions/reactions";
import { REACTION_EMOJIS, type ReactionEmoji } from "@/lib/reaction-constants";
import { vibrate } from "@/lib/haptic";

interface NoteReactionsProps {
  noteId: string;
  reactions: Record<string, string>;
  currentAuthor: string | null;
  onReactionsChange: (reactions: Record<string, string>) => void;
}

// Group reactions by emoji for display
function groupReactions(
  reactions: Record<string, string>,
): { emoji: string; count: number; authors: string[] }[] {
  const groups: Record<string, string[]> = {};
  for (const [author, emoji] of Object.entries(reactions)) {
    if (!groups[emoji]) groups[emoji] = [];
    groups[emoji].push(author);
  }
  return Object.entries(groups).map(([emoji, authors]) => ({
    emoji,
    count: authors.length,
    authors,
  }));
}

export function NoteReactions({
  noteId,
  reactions,
  currentAuthor,
  onReactionsChange,
}: NoteReactionsProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const grouped = groupReactions(reactions);
  const myReaction = currentAuthor ? reactions[currentAuthor] : null;

  const handleReact = async (emoji: ReactionEmoji) => {
    if (isSubmitting) return;
    void vibrate(50, "light");
    setIsSubmitting(true);
    setShowPicker(false);

    const result = await reactToNote(noteId, emoji);
    if (!result.error) {
      onReactionsChange(result.reactions);
    }
    setIsSubmitting(false);
  };

  return (
    <div className="relative flex items-center gap-1.5 flex-wrap">
      {/* Existing reaction pills */}
      <AnimatePresence mode="popLayout">
        {grouped.map(({ emoji, count, authors }) => {
          const isMyReaction = currentAuthor
            ? authors.includes(currentAuthor)
            : false;
          return (
            <motion.button
              key={emoji}
              initial={{ opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.7 }}
              whileTap={{ scale: 0.85 }}
              transition={{ type: "spring", bounce: 0.4, duration: 0.3 }}
              onClick={() => handleReact(emoji as ReactionEmoji)}
              disabled={isSubmitting || undefined}
              title={authors.join(", ")}
              className={cn(
                "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold",
                "border transition-all disabled:opacity-50",
                isMyReaction
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border/30 bg-black/20 text-muted-foreground hover:border-primary/20 hover:bg-primary/5",
              )}
            >
              <span>{emoji}</span>
              {count > 1 && <span>{count}</span>}
            </motion.button>
          );
        })}
      </AnimatePresence>

      {/* Add reaction button */}
      <div className="relative">
        <motion.button
          whileTap={{ scale: 0.85 }}
          onClick={() => {
            void vibrate(30, "light");
            setShowPicker((v) => !v);
          }}
          aria-label="Add reaction"
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full border text-[10px]",
            "border-border/30 bg-black/20 text-muted-foreground/50 transition-all",
            "hover:border-primary/20 hover:bg-primary/5 hover:text-primary/60",
            showPicker && "border-primary/30 bg-primary/10 text-primary/70",
          )}
        >
          {myReaction ?? "+"}
        </motion.button>

        {/* Emoji picker popover */}
        <AnimatePresence>
          {showPicker && (
            <motion.div
              initial={{ opacity: 0, scale: 0.85, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 4 }}
              transition={{ type: "spring", bounce: 0.3, duration: 0.25 }}
              className={cn(
                "absolute bottom-8 left-0 z-50 flex gap-1 rounded-2xl border",
                "border-white/10 bg-card/95 p-2 shadow-2xl shadow-black/40",
                "backdrop-blur-xl",
              )}
            >
              {REACTION_EMOJIS.map((emoji) => (
                <motion.button
                  key={emoji}
                  whileHover={{ scale: 1.25 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => handleReact(emoji)}
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-xl text-xl",
                    "transition-all hover:bg-primary/10",
                    myReaction === emoji &&
                      "bg-primary/15 ring-1 ring-primary/30",
                  )}
                >
                  {emoji}
                </motion.button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
