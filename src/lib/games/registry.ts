// src/lib/games/registry.ts
//
// Registry of games surfaced by the /games launcher. Adding a new game
// later: register a descriptor here, scaffold src/app/games/{slug}/ +
// src/app/actions/games/{slug}.ts + src/lib/games/{slug}-constants.ts,
// add obedience event types in reward-types.ts, namespace Redis keys
// with a unique prefix. The launcher reads this list and renders tiles.

import type { LucideIcon } from "lucide-react";
import { MessageCircleQuestion } from "lucide-react";

/** Metadata for one entry in the launcher. The launcher iterates over
 *  `GAMES` and renders one tile per descriptor; the slug becomes the
 *  URL segment under `/games/`. */
export interface GameDescriptor {
  /** URL segment under `/games/` and `/admin/games/`. Must be kebab-case
   *  and stable — changing it after release breaks deep links. */
  slug: string;
  /** Display title rendered on launcher tiles + admin landing tiles. */
  title: string;
  /** One-line description shown under the title. Should fit a card
   *  without wrapping more than ~2 lines on mobile. */
  description: string;
  /** Lucide icon component shown on launcher + admin tiles. */
  Icon: LucideIcon;
  /** When false, the tile renders disabled with a "coming soon" pill. */
  available: boolean;
}

/** The launcher catalog. Order here is render order on `/games`. Adding
 *  a new game later is registering one entry — no launcher rewrite. */
export const GAMES: readonly GameDescriptor[] = [
  {
    slug: "truth-or-dare",
    title: "Truth or Dare",
    description:
      "Take turns. Either of you can dare the other or ask a truth.",
    Icon: MessageCircleQuestion,
    available: true,
  },
] as const;

/** Resolve a registry entry by slug. Returns null when the slug isn't
 *  registered — callers (e.g. dynamic route handlers, sub-pages) should
 *  treat null as a 404 rather than rendering with placeholder data. */
export function getGameDescriptor(slug: string): GameDescriptor | null {
  return GAMES.find((g) => g.slug === slug) ?? null;
}
