// src/components/games/truth-or-dare/tod-reactions.tsx
"use client";

import { reactToTarget } from "@/app/actions/reactions";
import { type ReactionEmoji } from "@/lib/reaction-constants";
import { ReactionStrip } from "@/components/reactions/reaction-strip";

interface TodReactionsProps {
  challengeId: string;
  reactions: Record<string, string>;
  currentAuthor: string | null;
  onReactionsChange: (reactions: Record<string, string>) => void;
}

/**
 * Truth or Dare reaction surface. Thin wrapper around
 * `<ReactionStrip>` — supplies `reactToTarget("tod", ...)` as the
 * toggle and uses the compact variant since it sits inside dense
 * history rows alongside prompts + responses. Reactions live on
 * `reactions:tod:{challengeId}`; not preserved across soft-delete
 * restore (auxiliary state by design).
 */
export function TodReactions({
  challengeId,
  reactions,
  currentAuthor,
  onReactionsChange,
}: TodReactionsProps) {
  return (
    <ReactionStrip
      variant="compact"
      reactions={reactions}
      currentAuthor={currentAuthor}
      onReactionsChange={onReactionsChange}
      onToggle={(emoji: ReactionEmoji) =>
        reactToTarget("tod", challengeId, emoji)
      }
    />
  );
}
