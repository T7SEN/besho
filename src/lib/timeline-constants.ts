// src/lib/timeline-constants.ts
//
// Shared constants for the /timeline feature. Promoted out of
// `src/app/timeline/page.tsx` so other surfaces (admin/export, future
// mood/ledger surfaces, etc.) can reference the same emoji set
// without duplicating the literal array.

/**
 * Curated emoji set for milestone events. Order is meaningful — the
 * picker renders left-to-right in this order, so prepend new entries
 * with intent rather than appending.
 */
export const EMOJI_OPTIONS = [
  "✨",
  "❤️",
  "📞",
  "✈️",
  "🏠",
  "🎉",
  "🎂",
  "🌹",
  "💌",
  "📸",
  "☕",
  "🎬",
  "🌙",
  "🥂",
  "🤝",
  "🌅",
  "🎵",
  "📖",
  "🗺️",
  "💍",
  "🌊",
  "🏖️",
  "🎭",
  "👋",
] as const;

export type TimelineEmoji = (typeof EMOJI_OPTIONS)[number];
