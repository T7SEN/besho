// src/app/actions/rules.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { assertWriteAllowed } from "@/lib/restraint";
import { recordObedienceEvent } from "@/lib/obedience";

export type RuleStatus = "pending" | "active" | "completed";

export interface Rule {
  id: string;
  title: string;
  description?: string;
  status: RuleStatus;
  createdBy: "T7SEN" | "Besho";
  createdAt: number;
  acknowledgedAt?: number;
  completedAt?: number;
  acknowledgeDeadline?: number;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "rules:index";
const ruleKey = (id: string) => `rule:${id}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

export async function getRules(): Promise<Rule[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];
    if (!ids.length) return [];
    const rules = await redis.mget<(Rule | null)[]>(...ids.map(ruleKey));
    return rules.filter((r): r is Rule => r !== null);
  } catch (error) {
    logger.error("[rules] Failed to fetch:", error);
    return [];
  }
}

export async function createRule(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Only Sir can set rules." };

  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const acknowledgeDeadlineStr = formData.get("acknowledgeDeadline") as string;

  if (!title) return { error: "Rule is required." };

  const rule: Rule = {
    id: crypto.randomUUID(),
    title,
    ...(description && { description }),
    status: "pending",
    createdBy: session.author,
    createdAt: Date.now(),
    ...(acknowledgeDeadlineStr && {
      acknowledgeDeadline: new Date(acknowledgeDeadlineStr).getTime(),
    }),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(ruleKey(rule.id), rule);
    pipeline.zadd(INDEX_KEY, { score: rule.createdAt, member: rule.id });
    await pipeline.exec();

    await sendNotification("Besho", {
      title: "📜 New Rule",
      body: `Sir set a new rule: ${rule.title}`,
      url: "/rules",
    });

    logger.interaction("[rules] Rule created", {
      id: rule.id,
      title: rule.title,
      author: session.author,
    });
    revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[rules] Failed to create:", error);
    return { error: "Failed to save rule." };
  }
}

export async function acknowledgeRule(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "Besho")
    return { error: "Only kitten can acknowledge rules." };

  const block = await assertWriteAllowed(session.author);
  if (block) return block;

  try {
    const existing = await redis.get<Rule>(ruleKey(id));
    if (!existing) return { error: "Rule not found." };
    if (existing.status !== "pending")
      return { error: "Rule is not pending acknowledgement." };

    const ackedAt = Date.now();
    const updated: Rule = {
      ...existing,
      status: "active",
      acknowledgedAt: ackedAt,
    };
    await redis.set(ruleKey(id), updated);

    // Obedience emit — only credit when within the deadline. Late acks
    // don't count positively (and the cron will emit `rule_unacked` if
    // unacked at week close).
    const withinDeadline =
      typeof existing.acknowledgeDeadline !== "number" ||
      ackedAt <= existing.acknowledgeDeadline;
    if (withinDeadline) {
      void recordObedienceEvent("Besho", "rule_acked", existing.id, ackedAt);
    }

    await sendNotification("T7SEN", {
      title: "✓ Rule Acknowledged",
      body: `kitten acknowledged: ${existing.title}`,
      url: "/rules",
    });

    logger.interaction("[rules] Rule acknowledged", {
      id,
      title: existing.title,
    });
    revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[rules] Failed to acknowledge:", error);
    return { error: "Failed to acknowledge rule." };
  }
}

export async function completeRule(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can mark rules completed." };

  try {
    const existing = await redis.get<Rule>(ruleKey(id));
    if (!existing) return { error: "Rule not found." };

    const updated: Rule = {
      ...existing,
      status: "completed",
      completedAt: Date.now(),
    };
    await redis.set(ruleKey(id), updated);

    logger.interaction("[rules] Rule completed", { id, title: existing.title });
    revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[rules] Failed to complete:", error);
    return { error: "Failed to complete rule." };
  }
}

export async function reopenRule(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can reopen rules." };

  try {
    const existing = await redis.get<Rule>(ruleKey(id));
    if (!existing) return { error: "Rule not found." };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { completedAt: _removed, ...rest } = existing;
    const updated: Rule = {
      ...rest,
      status: existing.acknowledgedAt ? "active" : "pending",
    };
    await redis.set(ruleKey(id), updated);

    logger.interaction("[rules] Rule reopened", { id, title: existing.title });
    revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[rules] Failed to reopen:", error);
    return { error: "Failed to reopen rule." };
  }
}

export async function deleteRule(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete rules." };

  try {
    const existing = await redis.get<Rule>(ruleKey(id));
    if (existing) {
      const score = await redis.zscore(INDEX_KEY, id);
      await moveToTrash(redis, {
        feature: "rules",
        id,
        label: existing.title,
        deletedBy: session.author,
        payload: existing,
        indexScore:
          typeof score === "number" ? score : Number(score) || existing.createdAt,
        recordKey: ruleKey(id),
        indexKey: INDEX_KEY,
      });
    }

    const pipeline = redis.pipeline();
    pipeline.del(ruleKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[rules] Rule deleted", { id });
    revalidatePath("/rules");
    return { success: true };
  } catch (error) {
    logger.error("[rules] Failed to delete:", error);
    return { error: "Failed to delete rule." };
  }
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function purgeAllRules(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN") return { error: "Only Sir can purge rules." };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(INDEX_KEY, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { id: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({ id: String(raw[i]), score: Number(raw[i + 1]) || 0 });
    }
    const ids = pairs.map((p) => p.id);

    if (ids.length > 0) {
      const records =
        (await redis.mget<Rule[]>(...ids.map(ruleKey))) ?? [];
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const rule = records[i];
          return {
            feature: "rules" as const,
            id: p.id,
            label: rule?.title ?? p.id,
            deletedBy: session.author,
            payload: rule ?? null,
            indexScore: p.score,
            recordKey: ruleKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.del(ruleKey(id));
    pipeline.del(INDEX_KEY);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/rules");
    logger.warn(`[rules] Sir purged ${ids.length} rules.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[rules] purgeAllRules failed:", err);
    return { error: "Purge failed." };
  }
}
