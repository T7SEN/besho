// src/lib/ledger-constants.ts
//
// Pure value/type definitions for /ledger. Imported by the server
// action and the page UI; no Redis or async work.

export type LedgerEntryType = "reward" | "punishment" | "violation";

export const REWARD_CATEGORIES = [
  "Obedience",
  "Devotion",
  "Effort",
  "Honesty",
  "Other",
] as const;

export const PUNISHMENT_CATEGORIES = [
  "Disobedience",
  "Attitude",
  "Neglect",
  "Dishonesty",
  "Other",
] as const;

// ── Rule-violation entries ────────────────────────────────────────────────

export type ViolationSeverity = "minor" | "moderate" | "major";

export const VIOLATION_SEVERITIES: readonly ViolationSeverity[] = [
  "minor",
  "moderate",
  "major",
] as const;

/** Capitalized display label for severity. Stored on the entry's
 *  `category` field so the existing render pipeline (which displays
 *  `entry.category` as a chip) "just works" for violation entries. */
export const VIOLATION_SEVERITY_LABEL: Record<ViolationSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
};

/** Snapshot of the rule body captured into a `violation` ledger entry
 *  at write time. Larger rule bodies are truncated to keep ledger
 *  storage bounded — the original rule remains in `rule:{ruleId}` for
 *  full-text reading. Mirrors the reward/tier emoji snapshot pattern:
 *  rule edits and deletes after the violation is logged do NOT rewrite
 *  history. */
export const MAX_VIOLATION_RULE_SNAPSHOT_BODY_LEN = 1000;
