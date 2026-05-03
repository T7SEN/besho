// src/app/actions/protocol.ts
"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";

export type ProtocolAuthor = "T7SEN" | "Besho";

export interface Protocol {
  content: string;
  updatedAt: number;
  updatedBy: ProtocolAuthor;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const PROTOCOL_KEY = "protocol:current";
const HISTORY_KEY = "protocol:history";
const HISTORY_LIMIT = 20;
const MAX_PROTOCOL_LENGTH = 32_000;
const lastSeenKey = (author: ProtocolAuthor) => `protocol:lastseen:${author}`;

export interface ProtocolBundle {
  current: Protocol | null;
  history: Protocol[];
  lastSeen: number | null;
}

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

/**
 * Returns the current protocol, or null if unset / not authenticated.
 * Both authors can read.
 */
export async function getProtocol(): Promise<Protocol | null> {
  const session = await getSession();
  if (!session?.author) return null;

  try {
    return await redis.get<Protocol>(PROTOCOL_KEY);
  } catch (error) {
    logger.error("[protocol] Failed to fetch:", error);
    return null;
  }
}

/**
 * Single pipelined fetch returning current + history (up to 20
 * versions, most recent first) + the caller's lastSeen timestamp.
 * Page consumes this on mount in one round-trip.
 */
export async function getProtocolBundle(): Promise<ProtocolBundle> {
  const session = await getSession();
  if (!session?.author) return { current: null, history: [], lastSeen: null };
  const author = session.author as ProtocolAuthor;

  try {
    const pipeline = redis.pipeline();
    pipeline.get<Protocol>(PROTOCOL_KEY);
    pipeline.lrange<Protocol>(HISTORY_KEY, 0, HISTORY_LIMIT - 1);
    pipeline.get<number>(lastSeenKey(author));
    const [current, history, lastSeen] = (await pipeline.exec()) as [
      Protocol | null,
      Protocol[] | null,
      number | null,
    ];
    return {
      current: current ?? null,
      history: history ?? [],
      lastSeen: lastSeen ?? null,
    };
  } catch (error) {
    logger.error("[protocol] Failed to fetch bundle:", error);
    return { current: null, history: [], lastSeen: null };
  }
}

/**
 * Marks the current author's lastseen timestamp. Fired once per page
 * mount. Diff banner uses the value captured BEFORE this call so the
 * banner remains visible after marking.
 */
export async function markProtocolSeen(): Promise<void> {
  const session = await getSession();
  if (!session?.author) return;
  const author = session.author as ProtocolAuthor;
  try {
    await redis.set(lastSeenKey(author), Date.now());
  } catch (error) {
    logger.error("[protocol] Failed to mark seen:", error);
  }
}

/**
 * Replaces the protocol content. Sir-only. Pushes the previous
 * version onto the history list (LPUSH+LTRIM to last 20). Notifies
 * Besho via FCM because protocol changes are high-significance
 * information she should be alerted to.
 */
export async function updateProtocol(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can edit the protocol." };

  const content = (formData.get("content") as string)?.trim();
  if (!content) return { error: "Protocol cannot be empty." };
  if (content.length > MAX_PROTOCOL_LENGTH) {
    return {
      error: `Protocol too long (${MAX_PROTOCOL_LENGTH} chars max).`,
    };
  }

  const next: Protocol = {
    content,
    updatedAt: Date.now(),
    updatedBy: session.author,
  };

  try {
    const existing = await redis.get<Protocol>(PROTOCOL_KEY);
    const pipeline = redis.pipeline();
    if (existing) {
      pipeline.lpush(HISTORY_KEY, existing);
      pipeline.ltrim(HISTORY_KEY, 0, HISTORY_LIMIT - 1);
    }
    pipeline.set(PROTOCOL_KEY, next);
    await pipeline.exec();

    await sendNotification("Besho", {
      title: "📜 Protocol Updated",
      body: "Sir updated the protocol.",
      url: "/protocol",
    });

    logger.interaction("[protocol] Protocol updated", {
      by: session.author,
      length: content.length,
    });
    revalidatePath("/protocol");
    return { success: true };
  } catch (error) {
    logger.error("[protocol] Failed to save:", error);
    return { error: "Failed to save protocol." };
  }
}

/**
 * Reverts to a historical version. Sir-only. Treats revert as another
 * update — current is pushed onto history, target becomes new current
 * with a fresh updatedAt and Sir as updatedBy. The reverted-to entry
 * remains in history at its original position; this is intentional —
 * history is an audit log, not a curated set, and dedup adds no value
 * when the cost is more complex Redis ops.
 */
export async function revertProtocol(
  index: number,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can revert the protocol." };

  if (!Number.isInteger(index) || index < 0) {
    return { error: "Invalid version index." };
  }

  try {
    const target = (await redis.lindex(HISTORY_KEY, index)) as Protocol | null;
    if (!target || typeof target.content !== "string") {
      return { error: "Version not found." };
    }

    const existing = await redis.get<Protocol>(PROTOCOL_KEY);

    const reverted: Protocol = {
      content: target.content,
      updatedAt: Date.now(),
      updatedBy: session.author,
    };

    const pipeline = redis.pipeline();
    if (existing) {
      pipeline.lpush(HISTORY_KEY, existing);
      pipeline.ltrim(HISTORY_KEY, 0, HISTORY_LIMIT - 1);
    }
    pipeline.set(PROTOCOL_KEY, reverted);
    await pipeline.exec();

    await sendNotification("Besho", {
      title: "📜 Protocol Reverted",
      body: "Sir reverted the protocol to a previous version.",
      url: "/protocol",
    });

    logger.interaction("[protocol] Protocol reverted", {
      by: session.author,
      fromIndex: index,
    });
    revalidatePath("/protocol");
    return { success: true };
  } catch (error) {
    logger.error("[protocol] Failed to revert:", error);
    return { error: "Failed to revert protocol." };
  }
}
