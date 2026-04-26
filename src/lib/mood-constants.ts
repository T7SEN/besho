export interface MoodOption {
  emoji: string;
  label: string;
}

// ── Daily mood (both users — existing) ───────────────────────────────────────

export const DAILY_MOOD_OPTIONS: MoodOption[] = [
  { emoji: "😴", label: "Tired" },
  { emoji: "😊", label: "Happy" },
  { emoji: "😍", label: "In Love" },
  { emoji: "🥺", label: "Soft" },
  { emoji: "😤", label: "Annoyed" },
  { emoji: "🥰", label: "Warm" },
  { emoji: "😂", label: "Playful" },
  { emoji: "🌟", label: "Great" },
  { emoji: "😌", label: "Calm" },
  { emoji: "🤗", label: "Cuddly" },
];

// ── Sub states (Besho only) ───────────────────────────────────────────────────

export const SUB_STATE_OPTIONS: MoodOption[] = [
  { emoji: "🥰", label: "Lovey" },
  { emoji: "😇", label: "Good Girl" },
  { emoji: "😈", label: "Bratty" },
  { emoji: "🐱", label: "Kitty" },
  { emoji: "🥺", label: "Needy" },
  { emoji: "😳", label: "Shy" },
  { emoji: "💤", label: "Sleepy" },
  { emoji: "😤", label: "Huffy" },
  { emoji: "🤤", label: "Thirsty" },
  { emoji: "🥵", label: "Flustered" },
  { emoji: "🫦", label: "Wanting" },
  { emoji: "💦", label: "Wet" },
  { emoji: "😵‍💫", label: "Subspace" },
  { emoji: "🙈", label: "Embarrassed" },
  { emoji: "💜", label: "Subby" },
  { emoji: "🖤", label: "Moody" },
  { emoji: "🦋", label: "Floaty" },
  { emoji: "😏", label: "Playful" },
  { emoji: "👅", label: "Cheeky" },
  { emoji: "🔥", label: "Burning" },
];

// ── Dom states (T7SEN only) ───────────────────────────────────────────────────

export const DOM_STATE_OPTIONS: MoodOption[] = [
  { emoji: "😏", label: "Smug" },
  { emoji: "👑", label: "Dominant" },
  { emoji: "🔥", label: "Intense" },
  { emoji: "😈", label: "Strict" },
  { emoji: "❤️‍🔥", label: "Possessive" },
  { emoji: "🤌", label: "Pleased" },
  { emoji: "💪", label: "In Control" },
  { emoji: "🫡", label: "Commanding" },
  { emoji: "😤", label: "Stern" },
  { emoji: "🖤", label: "Dark" },
  { emoji: "⛓️", label: "Controlling" },
  { emoji: "👁️", label: "Watching" },
  { emoji: "🌡️", label: "Testing" },
  { emoji: "🎯", label: "Focused" },
  { emoji: "💜", label: "Proud" },
  { emoji: "😌", label: "Satisfied" },
];
