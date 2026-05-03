// src/lib/permissions-constants.ts

export const PERMISSION_CATEGORIES = [
  "treat",
  "limit-test",
  "outing",
  "purchase",
  "social",
  "other",
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<PermissionCategory, string> = {
  treat: "Treat",
  "limit-test": "Limit-test",
  outing: "Outing",
  purchase: "Purchase",
  social: "Social",
  other: "Other",
};

/**
 * Per-category form opinionation — extra required fields, default
 * expiry hint, etc. Keep narrow: only the fields that genuinely
 * benefit from structure get listed here. Free-text "other" keeps
 * an escape hatch.
 */
export interface CategoryFieldSpec {
  /** Pre-fills the expiry input when this category is selected. */
  defaultExpiryHours?: number;
  /** Form-level required fields beyond `body`. */
  requiresPrice?: boolean;
  requiresWhoWith?: boolean;
}

export const CATEGORY_SCHEMA: Record<PermissionCategory, CategoryFieldSpec> = {
  treat: {},
  "limit-test": {},
  outing: { defaultExpiryHours: 24 },
  purchase: { requiresPrice: true },
  social: { requiresWhoWith: true },
  other: {},
};

export const DENIAL_REASONS = [
  "not_now",
  "unsafe",
  "earn_first",
  "discuss_in_person",
  "nope",
] as const;

export type DenialReason = (typeof DENIAL_REASONS)[number];

export const DENIAL_REASON_LABEL: Record<DenialReason, string> = {
  not_now: "Not now",
  unsafe: "Unsafe",
  earn_first: "Earn it first",
  discuss_in_person: "Discuss in person",
  nope: "Nope",
};

/**
 * Re-ask cooldown by denial reason. Same body hash blocked from
 * re-submission for this many hours after Sir denies. The default
 * applies when Sir denies without selecting a reason.
 */
export const DENIAL_REASON_COOLDOWN_HOURS: Record<
  DenialReason | "default",
  number
> = {
  not_now: 12,
  discuss_in_person: 24,
  earn_first: 48,
  unsafe: 72,
  nope: 168,
  default: 12,
};

/**
 * Auto-decide rule. Sir-authored deterministic predicate evaluated at
 * `createPermission` time. Conditions are AND-combined within a rule
 * (all listed conditions must hold); the rule list is OR-combined and
 * first-match-wins. Disabled rules are skipped.
 *
 * `bodyContainsAny` is OR-combined within itself: any single keyword
 * matching the body (case-insensitive) satisfies the field.
 */
export interface AutoDecideRule {
  id: string;
  enabled: boolean;

  // Conditions — undefined means "don't filter on this".
  category?: PermissionCategory;
  /** Only meaningful when category === "purchase". Matches when
   *  request price is set AND <= this value. */
  priceMax?: number;
  /** Case-insensitive. Empty array treated as "no constraint". */
  bodyContainsAny?: string[];
  /** When true, only matches requests with no expiry set. */
  noExpiry?: boolean;

  // Decision + response.
  decision: "approved" | "denied";
  /** Applied if decision === "approved". */
  terms?: string;
  /** Applied if decision === "denied"; drives re-ask cooldown. */
  denialReason?: DenialReason;
  /** Applied to either decision. */
  reply?: string;

  // Awareness backstop. Defaults true at create time so Sir gets a
  // heads-up; he can flip per-rule for genuinely stealth asks.
  notifySir?: boolean;
  createdAt: number;
}

export const MAX_AUTO_RULES = 20;
export const MAX_RULE_KEYWORDS = 10;
export const MAX_RULE_KEYWORD_LENGTH = 60;
