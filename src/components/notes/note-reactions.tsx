// src/components/notes/note-reactions.tsx
"use client";

import { reactToNote } from "@/app/actions/reactions";
import { type ReactionEmoji } from "@/lib/reaction-constants";
import { ReactionStrip } from "@/components/reactions/reaction-strip";

interface NoteReactionsProps {
  noteId: string;
  reactions: Record<string, string>;
  currentAuthor: string | null;
  onReactionsChange: (reactions: Record<string, string>) => void;
}

/**
 * Notes reaction surface. Thin wrapper around the generic
 * `<ReactionStrip>` — passes `reactToNote` as the server toggle. Kept
 * as a separate component so the notes page imports stay unchanged
 * post-generalization. New target types should write their own thin
 * wrapper (e.g. `<TodReactions>`) supplying the appropriate
 * `reactToTarget(...)` call.
 */
export function NoteReactions({
  noteId,
  reactions,
  currentAuthor,
  onReactionsChange,
}: NoteReactionsProps) {
  return (
    <ReactionStrip
      reactions={reactions}
      currentAuthor={currentAuthor}
      onReactionsChange={onReactionsChange}
      onToggle={(emoji: ReactionEmoji) => reactToNote(noteId, emoji)}
    />
  );
}
