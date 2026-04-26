export interface ReactionOption {
  emoji: string;
  label: string;
}

export type ReactionEmoji =
  | "🔥"
  | "💦"
  | "👅"
  | "🍑"
  | "😈"
  | "🫦"
  | "🥵"
  | "💋"
  | "😏"
  | "🤤"
  | "❤️‍🔥"
  | "💢"
  | "👑"
  | "🐱"
  | "🥴";

export const REACTION_OPTIONS: ReactionOption[] = [
  { emoji: "🔥", label: "Hot" },
  { emoji: "💦", label: "Wet" },
  { emoji: "👅", label: "Lick" },
  { emoji: "🍑", label: "Cute" },
  { emoji: "😈", label: "Devil" },
  { emoji: "🫦", label: "Kiss" },
  { emoji: "🥵", label: "Flustered" },
  { emoji: "💋", label: "Smooch" },
  { emoji: "😏", label: "Smirk" },
  { emoji: "🤤", label: "Drool" },
  { emoji: "❤️‍🔥", label: "Burning" },
  { emoji: "💢", label: "Grr" },
  { emoji: "👑", label: "King" },
  { emoji: "🐱", label: "Kitty" },
  { emoji: "🥴", label: "Dizzy" },
];

export const REACTION_EMOJIS = REACTION_OPTIONS.map(
  (r) => r.emoji,
) as ReactionEmoji[];
