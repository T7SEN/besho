// src/app/actions/admin/permissions.ts
"use server";

import { revalidatePath } from "next/cache";
import { logger } from "@/lib/logger";
import { sendNotification } from "../notifications";
import type {
  PermissionRequest,
  PermissionQuotas,
} from "../permissions";
import {
  PERMISSION_CATEGORIES,
  DENIAL_REASONS,
  DENIAL_REASON_COOLDOWN_HOURS,
  type AutoDecideRule,
  type DenialReason,
  type PermissionCategory,
  MAX_AUTO_RULES,
  MAX_RULE_KEYWORDS,
  MAX_RULE_KEYWORD_LENGTH,
  matchesAutoRule,
} from "@/lib/permissions-constants";
import { recordObedienceEvent } from "@/lib/obedience";
import { redis, requireSir } from "./_shared";

// ──────────────────────────────────────────────────────────────────
// Permissions admin — auto-rules + quotas read/write via JSON, plus
// bulk force-decide for the pending queue. The /permissions modals
// stay; this is an additional path for power-user editing.
// ──────────────────────────────────────────────────────────────────

const PERMISSIONS_INDEX = "permissions:index";
const QUOTAS_KEY = "permissions:quotas";
const AUTO_RULES_KEY = "permissions:auto-rules";
const DENIED_HASHES_KEY = "permissions:denied-hashes";
const permissionRecordKey = (id: string) => `permission:${id}`;
const reaskBlockKey = (bodyHash: string) =>
  `permission:reask-block:${bodyHash}`;

function permissionBodyHash(body: string): string {
  const normalized = body.toLowerCase().trim().replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

export interface PermissionsAdminBundle {
  autoRules: AutoDecideRule[];
  quotas: PermissionQuotas;
  pendingCount: number;
  pendingByCategory: Partial<Record<PermissionCategory, number>>;
}

export async function getPermissionsAdminBundle(): Promise<{
  bundle?: PermissionsAdminBundle;
  error?: string;
}> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  try {
    const [rules, quotas, ids] = await Promise.all([
      redis.get<AutoDecideRule[]>(AUTO_RULES_KEY),
      redis.get<PermissionQuotas>(QUOTAS_KEY),
      redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, { rev: true }),
    ]);
    const idStrs = (ids ?? []).map(String);
    const records = idStrs.length
      ? ((await redis.mget<PermissionRequest[]>(
          ...idStrs.map((id) => permissionRecordKey(id)),
        )) ?? [])
      : [];
    let pendingCount = 0;
    const pendingByCategory: Partial<Record<PermissionCategory, number>> = {};
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      pendingCount++;
      if (r.category) {
        pendingByCategory[r.category] =
          (pendingByCategory[r.category] ?? 0) + 1;
      }
    }
    return {
      bundle: {
        autoRules: rules ?? [],
        quotas: quotas ?? { monthlyLimits: {} },
        pendingCount,
        pendingByCategory,
      },
    };
  } catch (err) {
    logger.error("[admin] permissions bundle read failed", err);
    return { error: "Failed to load permissions admin bundle." };
  }
}

/**
 * Validates and saves a JSON-encoded auto-rules array. Mirrors the
 * inline validator in `permissions.saveAutoRules` but operates on a
 * raw JSON string so the `/admin/permissions` page can offer a
 * power-user textarea + import path.
 */
export async function adminSaveAutoRulesJson(
  json: string,
): Promise<{ success?: boolean; error?: string; count?: number }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (typeof json !== "string" || json.trim().length === 0) {
    return { error: "JSON payload required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      error: `Invalid JSON: ${err instanceof Error ? err.message : "parse error"}.`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { error: "Top-level value must be an array." };
  }
  if (parsed.length > MAX_AUTO_RULES) {
    return { error: `Too many rules (max ${MAX_AUTO_RULES}).` };
  }
  for (const rawRule of parsed) {
    const rule = rawRule as AutoDecideRule;
    if (!rule || typeof rule !== "object") {
      return { error: "Every rule must be an object." };
    }
    if (!rule.id || typeof rule.id !== "string") {
      return { error: "Every rule needs a string id." };
    }
    if (typeof rule.enabled !== "boolean") {
      return { error: `Rule ${rule.id} missing 'enabled' boolean.` };
    }
    if (rule.decision !== "approved" && rule.decision !== "denied") {
      return { error: `Rule ${rule.id} decision must be approved or denied.` };
    }
    if (
      rule.category !== undefined &&
      !PERMISSION_CATEGORIES.includes(rule.category)
    ) {
      return { error: `Rule ${rule.id} has invalid category.` };
    }
    if (rule.priceMax !== undefined) {
      if (
        typeof rule.priceMax !== "number" ||
        !Number.isFinite(rule.priceMax) ||
        rule.priceMax < 0
      ) {
        return { error: `Rule ${rule.id} priceMax must be non-negative number.` };
      }
    }
    if (rule.bodyContainsAny !== undefined) {
      if (!Array.isArray(rule.bodyContainsAny)) {
        return { error: `Rule ${rule.id} bodyContainsAny must be an array.` };
      }
      if (rule.bodyContainsAny.length > MAX_RULE_KEYWORDS) {
        return {
          error: `Rule ${rule.id} has too many keywords (max ${MAX_RULE_KEYWORDS}).`,
        };
      }
      for (const kw of rule.bodyContainsAny) {
        if (typeof kw !== "string" || kw.length === 0) {
          return { error: `Rule ${rule.id} keywords must be non-empty strings.` };
        }
        if (kw.length > MAX_RULE_KEYWORD_LENGTH) {
          return {
            error: `Rule ${rule.id} keyword too long (max ${MAX_RULE_KEYWORD_LENGTH}).`,
          };
        }
      }
    }
    if (
      rule.denialReason !== undefined &&
      !DENIAL_REASONS.includes(rule.denialReason)
    ) {
      return { error: `Rule ${rule.id} has invalid denial reason.` };
    }
    if (typeof rule.createdAt !== "number") {
      return { error: `Rule ${rule.id} missing createdAt number.` };
    }
  }
  try {
    await redis.set(AUTO_RULES_KEY, parsed);
    logger.interaction("[admin] auto-rules saved via JSON", {
      by: guard.session.author,
      count: (parsed as AutoDecideRule[]).length,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, count: (parsed as AutoDecideRule[]).length };
  } catch (err) {
    logger.error("[admin] auto-rules JSON save failed", err);
    return { error: "Save failed." };
  }
}

/**
 * Validates and saves a JSON-encoded quotas object. Same shape as
 * `PermissionQuotas`. Empty `monthlyLimits` is valid (clears every cap).
 */
export async function adminSaveQuotasJson(
  json: string,
): Promise<{ success?: boolean; error?: string }> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (typeof json !== "string" || json.trim().length === 0) {
    return { error: "JSON payload required." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      error: `Invalid JSON: ${err instanceof Error ? err.message : "parse error"}.`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Top-level value must be an object." };
  }
  const obj = parsed as Partial<PermissionQuotas>;
  const monthlyLimits = obj.monthlyLimits ?? {};
  if (typeof monthlyLimits !== "object" || Array.isArray(monthlyLimits)) {
    return { error: "monthlyLimits must be an object." };
  }
  const cleanLimits: Partial<Record<PermissionCategory, number>> = {};
  for (const [k, v] of Object.entries(monthlyLimits)) {
    if (!PERMISSION_CATEGORIES.includes(k as PermissionCategory)) {
      return { error: `Unknown category: ${k}.` };
    }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 999) {
      return { error: `Limit for ${k} must be integer 0-999.` };
    }
    if (v > 0) cleanLimits[k as PermissionCategory] = v;
  }
  let maxPending: number | undefined;
  if (obj.maxPending !== undefined) {
    if (
      typeof obj.maxPending !== "number" ||
      !Number.isInteger(obj.maxPending) ||
      obj.maxPending < 0 ||
      obj.maxPending > 99
    ) {
      return { error: "maxPending must be integer 0-99." };
    }
    if (obj.maxPending > 0) maxPending = obj.maxPending;
  }
  try {
    const next: PermissionQuotas = {
      monthlyLimits: cleanLimits,
      ...(maxPending !== undefined && { maxPending }),
    };
    await redis.set(QUOTAS_KEY, next);
    logger.interaction("[admin] quotas saved via JSON", {
      by: guard.session.author,
      monthlyLimits: cleanLimits,
      maxPending,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true };
  } catch (err) {
    logger.error("[admin] quotas JSON save failed", err);
    return { error: "Save failed." };
  }
}

export interface BulkDecideArgs {
  /** Approve: minimum age in hours; pending requests older than this
   *  get approved. Deny: ignored. */
  olderThanHours?: number;
  /** Deny only — narrows to a single category. */
  category?: PermissionCategory;
  /** Optional reply applied to every approved/denied record. */
  reply?: string;
  /** Deny only — drives re-ask cooldown via DENIAL_REASON_COOLDOWN_HOURS. */
  reason?: DenialReason;
}

export interface BulkDecideResult {
  success?: boolean;
  error?: string;
  approved?: number;
  denied?: number;
}

/**
 * Walks pending permission requests older than `olderThanHours`,
 * mutates each to approved in a single pipeline. Optional reply
 * applied verbatim. Auto-emit obedience event +1 per record (idempotent
 * on id). One summary FCM to Besho instead of N per-claim FCMs.
 */
export async function bulkApprovePendingOlderThan(
  args: BulkDecideArgs,
): Promise<BulkDecideResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  const hours = Number(args.olderThanHours);
  if (!Number.isFinite(hours) || hours < 1) {
    return { error: "olderThanHours must be ≥ 1." };
  }
  const reply = (args.reply ?? "").trim().slice(0, 1000);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  try {
    const ids =
      ((await redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return { success: true, approved: 0 };
    const records =
      (await redis.mget<PermissionRequest[]>(
        ...ids.map((id) => permissionRecordKey(id)),
      )) ?? [];
    const targets: PermissionRequest[] = [];
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      if (r.requestedAt > cutoff) continue;
      targets.push(r);
    }
    if (targets.length === 0) return { success: true, approved: 0 };

    const decidedAt = Date.now();
    const pipeline = redis.pipeline();
    for (const r of targets) {
      const updated: PermissionRequest = {
        ...r,
        status: "approved",
        decidedAt,
        decidedBy: "T7SEN",
      };
      delete updated.reply;
      delete updated.terms;
      delete updated.denialReason;
      if (reply) updated.reply = reply;
      pipeline.set(permissionRecordKey(r.id), updated);
    }
    await pipeline.exec();

    // Obedience: +1 per approval, fire-and-forget. eventId = request id
    // so retries are idempotent at the ZSET layer.
    for (const r of targets) {
      void recordObedienceEvent(
        "Besho",
        "permission_approved",
        r.id,
        decidedAt,
      );
    }

    // Single summary FCM.
    const noun = targets.length === 1 ? "request" : "requests";
    void sendNotification("Besho", {
      title: `✓ ${targets.length} ${noun} approved`,
      body: reply
        ? `${targets.length} pending ${noun} bulk-approved. Sir's note: "${reply.slice(0, 120)}"`
        : `${targets.length} pending ${noun} bulk-approved by Sir.`,
      url: "/permissions",
    }).catch(() => {});

    logger.interaction("[admin] bulk approved pending permissions", {
      by: guard.session.author,
      count: targets.length,
      olderThanHours: hours,
      withReply: reply.length > 0,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, approved: targets.length };
  } catch (err) {
    logger.error("[admin] bulk approve failed", err);
    return { error: "Bulk approve failed." };
  }
}

/**
 * Denies every pending request matching `category`. Optional `reason`
 * drives the re-ask cooldown per `DENIAL_REASON_COOLDOWN_HOURS`. One
 * summary FCM to Besho.
 */
export async function bulkDenyPendingByCategory(
  args: BulkDecideArgs,
): Promise<BulkDecideResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };
  if (!args.category || !PERMISSION_CATEGORIES.includes(args.category)) {
    return { error: "Valid category required." };
  }
  let reason: DenialReason | undefined;
  if (args.reason) {
    if (!DENIAL_REASONS.includes(args.reason)) {
      return { error: "Invalid denial reason." };
    }
    reason = args.reason;
  }
  const reply = (args.reply ?? "").trim().slice(0, 1000);
  try {
    const ids =
      ((await redis.zrange<unknown[]>(PERMISSIONS_INDEX, 0, -1, {
        rev: true,
      })) ?? []).map(String);
    if (!ids.length) return { success: true, denied: 0 };
    const records =
      (await redis.mget<PermissionRequest[]>(
        ...ids.map((id) => permissionRecordKey(id)),
      )) ?? [];
    const targets: PermissionRequest[] = [];
    for (const r of records) {
      if (!r) continue;
      if (r.status !== "pending") continue;
      if (r.category !== args.category) continue;
      targets.push(r);
    }
    if (targets.length === 0) return { success: true, denied: 0 };

    const decidedAt = Date.now();
    const cooldownHours =
      DENIAL_REASON_COOLDOWN_HOURS[reason ?? "default"] ?? 12;
    const pipeline = redis.pipeline();
    for (const r of targets) {
      const updated: PermissionRequest = {
        ...r,
        status: "denied",
        decidedAt,
        decidedBy: "T7SEN",
      };
      delete updated.reply;
      delete updated.terms;
      delete updated.denialReason;
      if (reply) updated.reply = reply;
      if (reason) updated.denialReason = reason;
      pipeline.set(permissionRecordKey(r.id), updated);
      const bodyHash = permissionBodyHash(r.body);
      pipeline.sadd(DENIED_HASHES_KEY, bodyHash);
      if (cooldownHours > 0) {
        pipeline.set(reaskBlockKey(bodyHash), "1", {
          ex: cooldownHours * 3600,
        });
      }
    }
    await pipeline.exec();

    const noun = targets.length === 1 ? "request" : "requests";
    void sendNotification("Besho", {
      title: `✗ ${targets.length} ${args.category} ${noun} denied`,
      body: reply
        ? `${targets.length} ${args.category} ${noun} denied by Sir. "${reply.slice(0, 120)}"`
        : `${targets.length} ${args.category} ${noun} denied in bulk by Sir.`,
      url: "/permissions",
    }).catch(() => {});

    logger.interaction("[admin] bulk denied pending by category", {
      by: guard.session.author,
      count: targets.length,
      category: args.category,
      reason,
      withReply: reply.length > 0,
    });
    revalidatePath("/admin/permissions");
    revalidatePath("/permissions");
    return { success: true, denied: targets.length };
  } catch (err) {
    logger.error("[admin] bulk deny failed", err);
    return { error: "Bulk deny failed." };
  }
}

// ──────────────────────────────────────────────────────────────────
// Auto-rule simulator — Sir pastes a fake permission request shape
// and sees which rule (if any) would fire and what decision the
// auto-decide path would produce. Pure read; no Redis writes; no FCM.
// ──────────────────────────────────────────────────────────────────

export interface SimulateAutoRuleArgs {
  body: string;
  category?: PermissionCategory;
  price?: number;
  expiresAt?: number;
}

export interface SimulateAutoRuleResult {
  matched?: boolean;
  /** When matched, the rule that fired (first-match-wins ordering). */
  rule?: AutoDecideRule;
  /** When matched, the decision that would be applied to the request. */
  decision?: "approved" | "denied";
  /** Optional reply / terms / denialReason from the matched rule. */
  reply?: string;
  terms?: string;
  denialReason?: DenialReason;
  /** Total enabled rules considered (helpful when matched=false). */
  rulesConsidered?: number;
  error?: string;
}

export async function simulateAutoRules(
  args: SimulateAutoRuleArgs,
): Promise<SimulateAutoRuleResult> {
  const guard = await requireSir();
  if (!guard.ok) return { error: guard.error };

  if (typeof args.body !== "string") {
    return { error: "body must be a string." };
  }
  if (args.body.trim().length === 0) {
    return { error: "body required." };
  }
  if (
    args.category !== undefined &&
    !PERMISSION_CATEGORIES.includes(args.category)
  ) {
    return { error: "invalid category." };
  }
  if (args.price !== undefined) {
    if (typeof args.price !== "number" || !Number.isFinite(args.price) || args.price < 0) {
      return { error: "price must be a non-negative number." };
    }
  }
  if (args.expiresAt !== undefined) {
    if (typeof args.expiresAt !== "number" || !Number.isFinite(args.expiresAt)) {
      return { error: "expiresAt must be a number." };
    }
  }

  try {
    const rules =
      (await redis.get<AutoDecideRule[]>(AUTO_RULES_KEY)) ?? [];
    let rulesConsidered = 0;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      rulesConsidered++;
      if (
        matchesAutoRule(rule, {
          body: args.body,
          category: args.category,
          price: args.price,
          expiresAt: args.expiresAt,
        })
      ) {
        return {
          matched: true,
          rule,
          decision: rule.decision,
          ...(rule.reply !== undefined && { reply: rule.reply }),
          ...(rule.terms !== undefined && { terms: rule.terms }),
          ...(rule.denialReason !== undefined && {
            denialReason: rule.denialReason,
          }),
          rulesConsidered,
        };
      }
    }
    return { matched: false, rulesConsidered };
  } catch (err) {
    logger.error("[admin] auto-rule simulation failed", err);
    return { error: "Simulation failed." };
  }
}
