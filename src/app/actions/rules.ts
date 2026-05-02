"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";

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

  try {
    const existing = await redis.get<Rule>(ruleKey(id));
    if (!existing) return { error: "Rule not found." };
    if (existing.status !== "pending")
      return { error: "Rule is not pending acknowledgement." };

    const updated: Rule = {
      ...existing,
      status: "active",
      acknowledgedAt: Date.now(),
    };
    await redis.set(ruleKey(id), updated);

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
