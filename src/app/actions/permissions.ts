// src/app/actions/permissions.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import {
  PERMISSION_CATEGORIES,
  type PermissionCategory,
  CATEGORY_SCHEMA,
  CATEGORY_LABEL,
  DENIAL_REASONS,
  DENIAL_REASON_COOLDOWN_HOURS,
  type DenialReason,
  type AutoDecideRule,
  MAX_AUTO_RULES,
  MAX_RULE_KEYWORDS,
  MAX_RULE_KEYWORD_LENGTH,
} from "@/lib/permissions-constants";

export type PermissionStatus =
  | "pending"
  | "approved"
  | "denied"
  | "queued"
  | "withdrawn";

export interface PermissionRequest {
  id: string;
  /** Always Besho — only kitten can submit requests. */
  requestedBy: "Besho";
  body: string;
  category?: PermissionCategory;
  /** Optional ms timestamp. UI shows "Expired" but status stays
   *  pending until Sir acts — there is no cron auto-decider. */
  expiresAt?: number;
  status: PermissionStatus;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: "T7SEN";
  reply?: string;
  /** Sir's conditions on an approval ("only this weekend", "max $30"). */
  terms?: string;
  /** Sir's reason chip on a denial — drives the re-ask cooldown. */
  denialReason?: DenialReason;
  /** Set on withdraw. Distinct from decidedAt because withdrawal is
   *  Besho's choice, not Sir's decision. */
  withdrawnAt?: number;
  /** Required for category=purchase. */
  price?: number;
  /** Required for category=social. */
  whoWith?: string;
  /** Optional protocol heading reference ("ref §Soft Limits"). */
  protocolRef?: string;
  /**
   * Set when the request was auto-decided by one of Sir's auto-decide
   * rules (feature 17). The id is the rule's id at decide-time —
   * doesn't follow the rule if Sir later renames or reorders.
   */
  decidedByRuleId?: string;
  /**
   * Set on create when this body's normalized hash matches a
   * previously-denied request. Survives even after the re-ask block
   * cooldown expires — the persistence pattern is what Sir is
   * watching for, not active blocks. Set once, never recomputed.
   */
  wasReasked?: boolean;
  /**
   * Number of prior decisions on this request — i.e. the length of the
   * audit log list. Computed at fetch time, not persisted on the
   * record itself. Surfaces in the UI as a "Decision changed Nx" chip.
   */
  auditCount?: number;
}

/**
 * Snapshot of a previous decision, captured before it gets overwritten
 * by a re-decide. Stored in `permission:audit:{id}` LIST, capped at 20.
 */
export interface PermissionAuditEntry {
  status: PermissionStatus;
  decidedAt?: number;
  decidedBy?: "T7SEN";
  reply?: string;
  terms?: string;
  denialReason?: DenialReason;
}

/**
 * Per-category monthly caps and overall pending-queue cap. Categories
 * absent from the map have no cap. Stored at `permissions:quotas`
 * as a single JSON blob.
 */
export interface PermissionQuotas {
  monthlyLimits: Partial<Record<PermissionCategory, number>>;
  /**
   * Maximum simultaneous pending requests. When Besho is at-cap, new
   * requests that would land in pending are rejected. Auto-decided
   * requests bypass this check — they don't add backlog pressure.
   */
  maxPending?: number;
}

export interface CategoryUsage {
  category: PermissionCategory;
  used: number;
  limit?: number;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "permissions:index";
const QUOTAS_KEY = "permissions:quotas";
const AUTO_RULES_KEY = "permissions:auto-rules";
const DENIED_HASHES_KEY = "permissions:denied-hashes";
const permissionKey = (id: string) => `permission:${id}`;
const auditKey = (id: string) => `permission:audit:${id}`;
const reaskBlockKey = (bodyHash: string) =>
  `permission:reask-block:${bodyHash}`;
const AUDIT_LIMIT = 20;
const MAX_BODY_LENGTH = 2000;
const MAX_REPLY_LENGTH = 1000;
const MAX_TERMS_LENGTH = 500;
const MAX_WHOWITH_LENGTH = 200;
const MAX_PROTOCOL_REF_LENGTH = 200;
const BODY_PREVIEW_LENGTH = 80;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

function previewBody(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (trimmed.length <= BODY_PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_LENGTH - 1)}…`;
}

/** Stable hash for re-ask block lookup. Normalized — case-insensitive,
 *  whitespace-collapsed — so trivial rewordings still hit the block. */
function bodyHashFor(body: string): string {
  const normalized = body.toLowerCase().trim().replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Friendly remaining-time label for re-ask block error message. */
function formatCooldownRemaining(seconds: number): string {
  if (seconds <= 0) return "soon";
  const hours = Math.ceil(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  const days = Math.ceil(hours / 24);
  return `${days}d`;
}

/**
 * UTC ms for the start of the current calendar month in Cairo. Used as
 * the lower bound for quota windows. Approximated at +02:00 (EET);
 * a few hours' drift across DST boundaries is acceptable for monthly
 * quotas.
 */
function startOfCairoMonthMs(now: number): number {
  const d = new Date(now);
  // Format as "YYYY-MM" in Cairo timezone.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return new Date(`${year}-${month}-01T00:00:00+02:00`).getTime();
}

/**
 * Returns all permission requests, newest first by requestedAt.
 * Both authors can read. Each record carries `auditCount` set to the
 * length of `permission:audit:{id}` — fetched in the same pipeline as
 * the GET so the round-trip stays single-shot.
 */
export async function getPermissions(): Promise<PermissionRequest[]> {
  const session = await getSession();
  if (!session?.author) return [];

  try {
    const ids = await redis.zrange<string[]>(INDEX_KEY, 0, -1, {
      rev: true,
    });
    if (ids.length === 0) return [];

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.get<PermissionRequest>(permissionKey(id));
      pipeline.llen(auditKey(id));
    }
    const results = (await pipeline.exec()) as (
      | PermissionRequest
      | number
      | null
    )[];

    const out: PermissionRequest[] = [];
    for (let i = 0; i < ids.length; i++) {
      const record = results[i * 2] as PermissionRequest | null;
      const auditLen = (results[i * 2 + 1] as number | null) ?? 0;
      if (record === null || typeof record.id !== "string") continue;
      if (auditLen > 0) record.auditCount = auditLen;
      out.push(record);
    }
    return out;
  } catch (error) {
    logger.error("[permissions] Failed to fetch:", error);
    return [];
  }
}

/**
 * Reads the audit log for a single request. Most-recent-first order
 * (LPUSH semantics). Returns at most AUDIT_LIMIT entries.
 */
export async function getPermissionAudit(
  id: string,
): Promise<PermissionAuditEntry[]> {
  const session = await getSession();
  if (!session?.author) return [];
  try {
    const entries = await redis.lrange<PermissionAuditEntry>(
      auditKey(id),
      0,
      AUDIT_LIMIT - 1,
    );
    return entries ?? [];
  } catch (error) {
    logger.error("[permissions] Failed to fetch audit:", error);
    return [];
  }
}

/**
 * Per-category usage for the current Cairo calendar month. Returns
 * one entry per category in the catalog, with `limit` set when a cap
 * exists. Both authors can read — Besho sees what's left, Sir sees
 * the same view (he can also set caps).
 */
export async function getCategoryUsage(): Promise<CategoryUsage[]> {
  const session = await getSession();
  if (!session?.author) return [];
  try {
    const monthStart = startOfCairoMonthMs(Date.now());
    const [quotas, ids] = await Promise.all([
      redis.get<PermissionQuotas>(QUOTAS_KEY),
      redis.zrange<string[]>(INDEX_KEY, monthStart, "+inf", {
        byScore: true,
      }),
    ]);

    const counts: Partial<Record<PermissionCategory, number>> = {};
    if (ids.length > 0) {
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.get<PermissionRequest>(permissionKey(id));
      const records = (await pipeline.exec()) as (PermissionRequest | null)[];
      for (const r of records) {
        if (!r || r.status !== "approved" || !r.category) continue;
        counts[r.category] = (counts[r.category] ?? 0) + 1;
      }
    }

    return PERMISSION_CATEGORIES.map((category) => ({
      category,
      used: counts[category] ?? 0,
      ...(quotas?.monthlyLimits[category] !== undefined && {
        limit: quotas.monthlyLimits[category],
      }),
    }));
  } catch (error) {
    logger.error("[permissions] Failed to fetch category usage:", error);
    return [];
  }
}

/** Returns the persisted quotas — both authors can read. */
export async function getQuotas(): Promise<PermissionQuotas> {
  const session = await getSession();
  if (!session?.author) return { monthlyLimits: {} };
  try {
    const q = await redis.get<PermissionQuotas>(QUOTAS_KEY);
    return q ?? { monthlyLimits: {} };
  } catch (error) {
    logger.error("[permissions] Failed to fetch quotas:", error);
    return { monthlyLimits: {} };
  }
}

/**
 * Sets per-category monthly limits and the global max-pending cap.
 * Sir-only. FormData fields named `limit:{category}` per category;
 * `maxPending` for the pending-queue cap. Empty/missing values clear
 * the corresponding setting.
 */
export async function setQuotas(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Only Sir can set quotas." };

  const monthlyLimits: Partial<Record<PermissionCategory, number>> = {};
  for (const cat of PERMISSION_CATEGORIES) {
    const raw = (formData.get(`limit:${cat}`) as string)?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 999) {
      return {
        error: `Invalid limit for ${CATEGORY_LABEL[cat]} — must be 0–999.`,
      };
    }
    if (n > 0) monthlyLimits[cat] = n;
  }

  const maxPendingRaw = (formData.get("maxPending") as string)?.trim();
  let maxPending: number | undefined;
  if (maxPendingRaw && maxPendingRaw.length > 0) {
    const n = Number(maxPendingRaw);
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      return { error: "Max pending must be 0–99." };
    }
    if (n > 0) maxPending = n;
  }

  try {
    const next: PermissionQuotas = {
      monthlyLimits,
      ...(maxPending !== undefined && { maxPending }),
    };
    await redis.set(QUOTAS_KEY, next);
    revalidatePath("/permissions");
    return { success: true };
  } catch (error) {
    logger.error("[permissions] Failed to set quotas:", error);
    return { error: "Failed to save quotas." };
  }
}

/**
 * Returns Sir's auto-decide rule list. Sir-only — these are private
 * authoring artifacts. Besho reading them would let her game the
 * heuristics. Returns `[]` for non-Sir or empty storage.
 */
export async function getAutoRules(): Promise<AutoDecideRule[]> {
  const session = await getSession();
  if (session?.author !== "T7SEN") return [];
  try {
    const rules = await redis.get<AutoDecideRule[]>(AUTO_RULES_KEY);
    return rules ?? [];
  } catch (error) {
    logger.error("[permissions] Failed to fetch auto-rules:", error);
    return [];
  }
}

/**
 * Replaces the auto-decide rule set wholesale. Sir-only. Validates
 * each rule's shape — anything malformed and the whole save aborts.
 * Array order = priority order; first-match-wins at decide time.
 */
export async function saveAutoRules(
  rules: AutoDecideRule[],
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can edit auto-rules." };

  if (!Array.isArray(rules)) return { error: "Invalid payload." };
  if (rules.length > MAX_AUTO_RULES) {
    return { error: `Too many rules (max ${MAX_AUTO_RULES}).` };
  }

  // Per-rule validation. Bail on first invalid rule.
  for (const rule of rules) {
    if (!rule.id || typeof rule.id !== "string") {
      return { error: "Every rule needs an id." };
    }
    if (rule.decision !== "approved" && rule.decision !== "denied") {
      return { error: "Rule decision must be approved or denied." };
    }
    if (
      rule.category !== undefined &&
      !PERMISSION_CATEGORIES.includes(rule.category)
    ) {
      return { error: "Invalid rule category." };
    }
    if (rule.priceMax !== undefined) {
      if (
        typeof rule.priceMax !== "number" ||
        !Number.isFinite(rule.priceMax) ||
        rule.priceMax < 0
      ) {
        return { error: "Rule priceMax must be a non-negative number." };
      }
    }
    if (rule.bodyContainsAny !== undefined) {
      if (!Array.isArray(rule.bodyContainsAny)) {
        return { error: "Rule keywords must be an array." };
      }
      if (rule.bodyContainsAny.length > MAX_RULE_KEYWORDS) {
        return { error: `Too many keywords (max ${MAX_RULE_KEYWORDS}).` };
      }
      for (const kw of rule.bodyContainsAny) {
        if (typeof kw !== "string" || kw.length === 0) {
          return { error: "Keywords must be non-empty strings." };
        }
        if (kw.length > MAX_RULE_KEYWORD_LENGTH) {
          return {
            error: `Keyword too long (max ${MAX_RULE_KEYWORD_LENGTH} chars).`,
          };
        }
      }
    }
    if (
      rule.denialReason !== undefined &&
      !DENIAL_REASONS.includes(rule.denialReason)
    ) {
      return { error: "Invalid rule denial reason." };
    }
    if (
      rule.terms !== undefined &&
      (typeof rule.terms !== "string" || rule.terms.length > MAX_TERMS_LENGTH)
    ) {
      return { error: `Rule terms too long (max ${MAX_TERMS_LENGTH}).` };
    }
    if (
      rule.reply !== undefined &&
      (typeof rule.reply !== "string" || rule.reply.length > MAX_REPLY_LENGTH)
    ) {
      return { error: `Rule reply too long (max ${MAX_REPLY_LENGTH}).` };
    }
  }

  try {
    await redis.set(AUTO_RULES_KEY, rules);
    revalidatePath("/permissions");
    return { success: true };
  } catch (error) {
    logger.error("[permissions] Failed to save auto-rules:", error);
    return { error: "Failed to save rules." };
  }
}

/**
 * Pure predicate — does this rule fire on this request shape?
 * Conjunctive within fields, OR within bodyContainsAny array.
 * Disabled rules never match. Lives next to the actions because
 * `createPermission` calls it inline at decide-time.
 */
function matchesAutoRule(
  rule: AutoDecideRule,
  req: {
    body: string;
    category?: PermissionCategory;
    price?: number;
    expiresAt?: number;
  },
): boolean {
  if (!rule.enabled) return false;
  if (rule.category !== undefined && rule.category !== req.category) {
    return false;
  }
  if (rule.priceMax !== undefined) {
    if (req.price === undefined) return false;
    if (req.price > rule.priceMax) return false;
  }
  if (rule.bodyContainsAny && rule.bodyContainsAny.length > 0) {
    const lower = req.body.toLowerCase();
    const hit = rule.bodyContainsAny.some((kw) =>
      lower.includes(kw.toLowerCase()),
    );
    if (!hit) return false;
  }
  if (rule.noExpiry === true && req.expiresAt !== undefined) return false;
  return true;
}

/**
 * Submits a new permission request. Besho-only — only kitten can ask
 * for things through this channel. Notifies Sir via FCM (manual path)
 * or Besho directly (auto-decide path).
 *
 * Validation order:
 *  1. Auth + role
 *  2. Body length / non-empty
 *  3. Re-ask block (recently denied body hash)
 *  4. Category + per-category required fields (price, whoWith)
 *  5. Expiry parse
 *  6. Quota check (rejects with usage detail at-cap)
 *  7. Auto-decide rule match — if any, request is inserted in the
 *     decided state with `decidedByRuleId` set, no pending phase.
 *  8. Pending-queue cap (only when no rule fired; auto-decided
 *     requests bypass since they don't add backlog).
 */
export async function createPermission(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can submit permission requests." };

  const body = (formData.get("body") as string)?.trim();
  const categoryRaw = (formData.get("category") as string)?.trim();
  const expiresAtRaw = (formData.get("expiresAt") as string)?.trim();
  const priceRaw = (formData.get("price") as string)?.trim();
  const whoWithRaw = (formData.get("whoWith") as string)?.trim();
  const protocolRefRaw = (formData.get("protocolRef") as string)?.trim();

  if (!body) return { error: "Request body is required." };
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `Request too long (${MAX_BODY_LENGTH} chars max).` };
  }

  // Re-ask block — same body recently denied?
  try {
    const bodyHash = bodyHashFor(body);
    const blockKey = reaskBlockKey(bodyHash);
    const blocked = await redis.get<string>(blockKey);
    if (blocked) {
      const ttl = await redis.ttl(blockKey);
      const remaining = formatCooldownRemaining(ttl);
      return {
        error: `Sir asked you to wait before asking this again. Try in ${remaining}.`,
      };
    }
  } catch (error) {
    // Fail open on infra errors — better a duplicate than block a real ask.
    logger.error("[permissions] Re-ask block check failed:", error);
  }

  // Persistent "asked-again" detection — survives the cooldown window
  // so Sir can spot persistence patterns even on re-asks that are
  // technically in-bounds. Distinct from the block above: this just
  // labels the request, never rejects.
  let wasReasked = false;
  try {
    const hash = bodyHashFor(body);
    const seen = await redis.sismember(DENIED_HASHES_KEY, hash);
    wasReasked = seen === 1;
  } catch (error) {
    logger.error("[permissions] Re-ask detection failed:", error);
    // Fail open — just don't mark.
  }

  let category: PermissionCategory | undefined;
  if (categoryRaw && categoryRaw.length > 0) {
    if (!PERMISSION_CATEGORIES.includes(categoryRaw as PermissionCategory)) {
      return { error: "Invalid category." };
    }
    category = categoryRaw as PermissionCategory;
  }

  // Per-category required fields.
  let price: number | undefined;
  let whoWith: string | undefined;
  if (category) {
    const spec = CATEGORY_SCHEMA[category];
    if (spec.requiresPrice) {
      if (!priceRaw) {
        return {
          error: `Price is required for ${CATEGORY_LABEL[category]}.`,
        };
      }
      const n = Number(priceRaw);
      if (!Number.isFinite(n) || n < 0 || n > 100_000) {
        return { error: "Price must be a non-negative number." };
      }
      price = n;
    }
    if (spec.requiresWhoWith) {
      if (!whoWithRaw) {
        return {
          error: `Who-with is required for ${CATEGORY_LABEL[category]}.`,
        };
      }
      if (whoWithRaw.length > MAX_WHOWITH_LENGTH) {
        return {
          error: `Who-with too long (${MAX_WHOWITH_LENGTH} chars max).`,
        };
      }
      whoWith = whoWithRaw;
    }
  }

  let expiresAt: number | undefined;
  if (expiresAtRaw && expiresAtRaw.length > 0) {
    const parsed = new Date(expiresAtRaw).getTime();
    if (!Number.isFinite(parsed)) {
      return { error: "Invalid expiry timestamp." };
    }
    if (parsed <= Date.now()) {
      return { error: "Expiry must be in the future." };
    }
    expiresAt = parsed;
  }

  let protocolRef: string | undefined;
  if (protocolRefRaw && protocolRefRaw.length > 0) {
    if (protocolRefRaw.length > MAX_PROTOCOL_REF_LENGTH) {
      return { error: "Protocol reference too long." };
    }
    protocolRef = protocolRefRaw;
  }

  // Quota check — rejects at-cap with explicit used/limit numbers.
  if (category) {
    try {
      const quotas = await redis.get<PermissionQuotas>(QUOTAS_KEY);
      const limit = quotas?.monthlyLimits[category];
      if (typeof limit === "number" && limit > 0) {
        const monthStart = startOfCairoMonthMs(Date.now());
        const monthIds = await redis.zrange<string[]>(
          INDEX_KEY,
          monthStart,
          "+inf",
          { byScore: true },
        );
        let used = 0;
        if (monthIds.length > 0) {
          const pipeline = redis.pipeline();
          for (const id of monthIds) {
            pipeline.get<PermissionRequest>(permissionKey(id));
          }
          const records =
            (await pipeline.exec()) as (PermissionRequest | null)[];
          for (const r of records) {
            if (r?.status === "approved" && r.category === category) used++;
          }
        }
        if (used >= limit) {
          return {
            error: `Monthly quota reached: ${used}/${limit} ${CATEGORY_LABEL[category]} this month. Try a different category or wait until next month.`,
          };
        }
      }
    } catch (error) {
      logger.error("[permissions] Quota check failed:", error);
      // Fail open.
    }
  }

  const requestedAt = Date.now();
  const request: PermissionRequest = {
    id: crypto.randomUUID(),
    requestedBy: "Besho",
    body,
    ...(category && { category }),
    ...(expiresAt && { expiresAt }),
    ...(price !== undefined && { price }),
    ...(whoWith && { whoWith }),
    ...(protocolRef && { protocolRef }),
    ...(wasReasked && { wasReasked: true }),
    status: "pending",
    requestedAt,
  };

  // Auto-decide rules (feature 17). First-match-wins over Sir's
  // priority-ordered rule list. Match → request goes straight to
  // decided state, Besho gets the decision FCM directly, Sir's
  // request-FCM is suppressed (he chose to delegate this shape).
  let matchedRule: AutoDecideRule | null = null;
  try {
    const rules = await redis.get<AutoDecideRule[]>(AUTO_RULES_KEY);
    if (rules && rules.length > 0) {
      matchedRule =
        rules.find((r) =>
          matchesAutoRule(r, { body, category, price, expiresAt }),
        ) ?? null;
    }
  } catch (error) {
    // Fail closed on rule lookup errors — request goes to manual
    // pending. Better to bother Sir than to silently mis-decide.
    logger.error("[permissions] Auto-rule lookup failed:", error);
    matchedRule = null;
  }

  if (matchedRule) {
    request.status = matchedRule.decision;
    request.decidedAt = requestedAt;
    request.decidedBy = "T7SEN";
    request.decidedByRuleId = matchedRule.id;
    if (matchedRule.reply) request.reply = matchedRule.reply;
    if (matchedRule.decision === "approved" && matchedRule.terms) {
      request.terms = matchedRule.terms;
    }
    if (matchedRule.decision === "denied" && matchedRule.denialReason) {
      request.denialReason = matchedRule.denialReason;
    }
  }

  // Pending-queue cap. Only checked when the request would actually
  // land in pending — auto-decided requests don't add backlog
  // pressure on Sir, so they bypass. Reuses the quotas blob already
  // fetched above only conceptually; another GET here keeps the code
  // local and avoids threading state through the auto-rule branch.
  if (!matchedRule) {
    try {
      const quotas = await redis.get<PermissionQuotas>(QUOTAS_KEY);
      const cap = quotas?.maxPending;
      if (typeof cap === "number" && cap > 0) {
        const ids = await redis.zrange<string[]>(INDEX_KEY, 0, -1);
        let pendingCount = 0;
        if (ids.length > 0) {
          const pipeline = redis.pipeline();
          for (const id of ids) {
            pipeline.get<PermissionRequest>(permissionKey(id));
          }
          const records =
            (await pipeline.exec()) as (PermissionRequest | null)[];
          for (const r of records) {
            if (r?.status === "pending") pendingCount++;
          }
        }
        if (pendingCount >= cap) {
          return {
            error: `You have ${pendingCount}/${cap} pending requests. Wait for Sir to respond before submitting more.`,
          };
        }
      }
    } catch (error) {
      // Fail open — better to let a request through than to block on
      // infra hiccups.
      logger.error("[permissions] Pending-cap check failed:", error);
    }
  }

  try {
    const pipeline = redis.pipeline();
    pipeline.set(permissionKey(request.id), request);
    pipeline.zadd(INDEX_KEY, { score: requestedAt, member: request.id });

    // Auto-denials still set the re-ask block — same body shouldn't
    // re-fire the same rule on every retry. Also record the hash in
    // the persistent denied-hashes set so the next attempt (even after
    // cooldown) gets the ↺ chip.
    if (matchedRule && matchedRule.decision === "denied") {
      const bodyHash = bodyHashFor(body);
      pipeline.sadd(DENIED_HASHES_KEY, bodyHash);
      const cooldownHours =
        DENIAL_REASON_COOLDOWN_HOURS[matchedRule.denialReason ?? "default"];
      if (cooldownHours > 0) {
        pipeline.set(reaskBlockKey(bodyHash), "1", {
          ex: cooldownHours * 3600,
        });
      }
    }

    await pipeline.exec();

    const fcmExtras: string[] = [];
    if (price !== undefined) fcmExtras.push(`$${price}`);
    if (whoWith) fcmExtras.push(`with ${whoWith}`);
    const previewExtras =
      fcmExtras.length > 0 ? ` (${fcmExtras.join(", ")})` : "";

    if (matchedRule) {
      // Decision FCM to Besho — same shape as a manual decide.
      const titleByDecision: Record<"approved" | "denied", string> = {
        approved: "✓ Auto-approved",
        denied: "✗ Auto-denied",
      };
      const notifBody = matchedRule.terms?.length
        ? `Terms: ${previewBody(matchedRule.terms)}`
        : matchedRule.reply?.length
          ? previewBody(matchedRule.reply)
          : previewBody(body);
      await sendNotification("Besho", {
        title: titleByDecision[matchedRule.decision],
        body: notifBody,
        url: "/permissions",
      });
      // Awareness backstop — Sir defaults to ON for transparency.
      // Set to false on a rule for genuinely stealth auto-decides.
      if (matchedRule.notifySir !== false) {
        await sendNotification("T7SEN", {
          title:
            matchedRule.decision === "approved"
              ? "Auto-approved request"
              : "Auto-denied request",
          body: previewBody(body) + previewExtras,
          url: "/permissions",
        });
      }
    } else {
      await sendNotification("T7SEN", {
        title: `🙏 Permission Request${category ? `: ${category}` : ""}`,
        body: previewBody(body) + previewExtras,
        url: "/permissions",
      });
    }

    logger.interaction("[permissions] Request created", {
      id: request.id,
      category,
      hasExpiry: !!expiresAt,
      hasProtocolRef: !!protocolRef,
      autoDecided: matchedRule ? matchedRule.decision : null,
      ruleId: matchedRule?.id ?? null,
    });
    revalidatePath("/permissions");
    return { success: true };
  } catch (error) {
    logger.error("[permissions] Failed to create:", error);
    return { error: "Failed to submit request." };
  }
}

export interface DecideOptions {
  reply?: string;
  /** Conditions on an approval. Ignored unless decision === "approved". */
  terms?: string;
  /** Reason chip on a denial. Drives the re-ask cooldown. Ignored
   *  unless decision === "denied". */
  reason?: DenialReason;
}

/**
 * Sir adjudicates a request. Sir-only. Re-deciding an already-decided
 * request is allowed — Sir is permitted to change his mind. The new
 * decision overwrites status, decidedAt, decidedBy, and the
 * decision-specific fields (reply, terms, denialReason).
 *
 * On denial, sets a re-ask block keyed by the normalized body hash
 * with a TTL determined by the reason (or default if no reason given).
 */
export async function decidePermission(
  id: string,
  decision: PermissionStatus,
  options: DecideOptions = {},
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can decide permission requests." };

  if (decision === "pending" || decision === "withdrawn") {
    return { error: "Invalid decision." };
  }
  if (
    decision !== "approved" &&
    decision !== "denied" &&
    decision !== "queued"
  ) {
    return { error: "Invalid decision." };
  }

  const trimmedReply = options.reply?.trim() ?? "";
  if (trimmedReply.length > MAX_REPLY_LENGTH) {
    return { error: `Reply too long (${MAX_REPLY_LENGTH} chars max).` };
  }

  const trimmedTerms = options.terms?.trim() ?? "";
  if (trimmedTerms.length > MAX_TERMS_LENGTH) {
    return { error: `Terms too long (${MAX_TERMS_LENGTH} chars max).` };
  }

  let denialReason: DenialReason | undefined;
  if (decision === "denied" && options.reason) {
    if (!DENIAL_REASONS.includes(options.reason)) {
      return { error: "Invalid denial reason." };
    }
    denialReason = options.reason;
  }

  try {
    const existing = await redis.get<PermissionRequest>(permissionKey(id));
    if (!existing) return { error: "Request not found." };

    const decidedAt = Date.now();
    const updated: PermissionRequest = {
      ...existing,
      status: decision,
      decidedAt,
      decidedBy: session.author,
    };

    // Decision-specific fields. Wholesale rewrite — re-deciding clears
    // stale terms/reason/reply that don't apply to the new decision.
    delete updated.reply;
    delete updated.terms;
    delete updated.denialReason;
    if (trimmedReply.length > 0) updated.reply = trimmedReply;
    if (decision === "approved" && trimmedTerms.length > 0) {
      updated.terms = trimmedTerms;
    }
    if (decision === "denied" && denialReason) {
      updated.denialReason = denialReason;
    }

    const pipeline = redis.pipeline();
    pipeline.set(permissionKey(id), updated);

    // Re-decide audit — push the OLD decision state onto the audit log
    // before it gets overwritten. First decisions (pending → decided)
    // don't log because there's no prior decision worth preserving.
    if (existing.status !== "pending") {
      const auditEntry: PermissionAuditEntry = {
        status: existing.status,
        ...(existing.decidedAt !== undefined && {
          decidedAt: existing.decidedAt,
        }),
        ...(existing.decidedBy && { decidedBy: existing.decidedBy }),
        ...(existing.reply && { reply: existing.reply }),
        ...(existing.terms && { terms: existing.terms }),
        ...(existing.denialReason && { denialReason: existing.denialReason }),
      };
      pipeline.lpush(auditKey(id), auditEntry);
      pipeline.ltrim(auditKey(id), 0, AUDIT_LIMIT - 1);
    }

    // Re-ask block — only on denial. Keyed by body hash so trivial
    // rewordings don't bypass. Also record the hash in the persistent
    // denied-hashes set so the next attempt (even after cooldown) gets
    // the ↺ chip in the meta row.
    if (decision === "denied") {
      const bodyHash = bodyHashFor(existing.body);
      pipeline.sadd(DENIED_HASHES_KEY, bodyHash);
      const cooldownHours =
        DENIAL_REASON_COOLDOWN_HOURS[denialReason ?? "default"];
      if (cooldownHours > 0) {
        pipeline.set(reaskBlockKey(bodyHash), "1", {
          ex: cooldownHours * 3600,
        });
      }
    }

    await pipeline.exec();

    const titleByDecision: Record<"approved" | "denied" | "queued", string> = {
      approved: "✓ Approved",
      denied: "✗ Denied",
      queued: "⏸️ Queued",
    };
    // Notification body preference: terms > reply > body excerpt.
    const notificationBody =
      trimmedTerms.length > 0
        ? `Terms: ${previewBody(trimmedTerms)}`
        : trimmedReply.length > 0
          ? previewBody(trimmedReply)
          : previewBody(existing.body);
    await sendNotification("Besho", {
      title: titleByDecision[decision as "approved" | "denied" | "queued"],
      body: notificationBody,
      url: "/permissions",
    });

    logger.interaction("[permissions] Request decided", {
      id,
      decision,
      hasReply: trimmedReply.length > 0,
      hasTerms: trimmedTerms.length > 0,
      reason: denialReason,
    });
    revalidatePath("/permissions");
    return { success: true };
  } catch (error) {
    logger.error("[permissions] Failed to decide:", error);
    return { error: "Failed to record decision." };
  }
}

/**
 * Withdraws a pending request. Besho-only, only on her own pending
 * requests. Sets status to `withdrawn` and timestamps it — the record
 * stays in the index for audit purposes. Sir doesn't get an FCM —
 * a withdrawal isn't an action he needs to be alerted about.
 */
export async function withdrawPermission(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can withdraw her own requests." };

  try {
    const existing = await redis.get<PermissionRequest>(permissionKey(id));
    if (!existing) return { error: "Request not found." };
    if (existing.requestedBy !== "Besho") {
      return { error: "Cannot withdraw — not your request." };
    }
    if (existing.status !== "pending") {
      return { error: "Cannot withdraw — already decided." };
    }

    const updated: PermissionRequest = {
      ...existing,
      status: "withdrawn",
      withdrawnAt: Date.now(),
    };
    await redis.set(permissionKey(id), updated);

    logger.interaction("[permissions] Request withdrawn", { id });
    revalidatePath("/permissions");
    return { success: true };
  } catch (error) {
    logger.error("[permissions] Failed to withdraw:", error);
    return { error: "Failed to withdraw." };
  }
}

/**
 * Counts pending requests. Used by the nav badge for Sir.
 */
export async function getPendingPermissionsCount(): Promise<number> {
  const session = await getSession();
  if (!session?.author) return 0;
  if (session.author !== "T7SEN") return 0;

  try {
    const ids = await redis.zrange<string[]>(INDEX_KEY, 0, -1);
    if (ids.length === 0) return 0;

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.get<PermissionRequest>(permissionKey(id));
    }
    const results = (await pipeline.exec()) as (PermissionRequest | null)[];
    let count = 0;
    for (const r of results) {
      if (r && r.status === "pending") count++;
    }
    return count;
  } catch (error) {
    logger.error("[permissions] Failed to count pending:", error);
    return 0;
  }
}
