"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { pushNotificationToHistory } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";

export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskStatus = "pending" | "in_review" | "completed";

export interface Task {
  id: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  deadline?: number; // Unix timestamp
  completed?: boolean; // Legacy field, kept for safety
  status: TaskStatus;
  submittedAt?: number; // When it entered review
  completedAt?: number;
  createdAt: number;
  createdBy: string;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "tasks:index";
const taskKey = (id: string) => `task:${id}`;

async function getSession() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

export async function getTasks(): Promise<Task[]> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, -1, {
      rev: true,
    })) as string[];

    if (!ids.length) return [];
    const tasks = await redis.mget<(Task | null)[]>(...ids.map(taskKey));

    return tasks
      .filter((t): t is Task => t !== null)
      .map((t) => {
        // Just-in-time migration for legacy tasks
        if (!t.status) {
          t.status = t.completed ? "completed" : "pending";
        }
        return t;
      });
  } catch (error) {
    logger.error("[tasks] Failed to fetch:", error);
    return [];
  }
}

export async function createTask(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can create tasks." };

  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const priority = (formData.get("priority") as TaskPriority) ?? "medium";
  const deadlineStr = formData.get("deadline") as string;

  if (!title) return { error: "Title is required." };

  const task: Task = {
    id: crypto.randomUUID(),
    title,
    ...(description && { description }),
    priority,
    ...(deadlineStr && { deadline: new Date(deadlineStr).getTime() }),
    status: "pending",
    createdAt: Date.now(),
    createdBy: session.author,
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(taskKey(task.id), task);
    pipeline.zadd(INDEX_KEY, { score: task.createdAt, member: task.id });
    await pipeline.exec();

    // Notify Besho of new task
    await sendTaskNotification("Besho", {
      title: "📋 New Task",
      body: `Sir assigned: ${task.title}`,
      url: "/tasks",
    });

    logger.interaction("[tasks] Task created", {
      id: task.id,
      title: task.title,
      priority: task.priority,
      author: session.author,
    });

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    logger.error("[tasks] Failed to create:", error);
    return { error: "Failed to save task." };
  }
}

export async function submitTask(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  try {
    const existing = await redis.get<Task>(taskKey(id));
    if (!existing) return { error: "Task not found." };

    const updated: Task = {
      ...existing,
      status: "in_review",
      submittedAt: Date.now(),
    };

    await redis.set(taskKey(id), updated);

    // Notify T7SEN that a task needs his review
    if (session.author === "Besho") {
      await sendTaskNotification("T7SEN", {
        title: "👀 Task Ready for Review",
        body: `Besho submitted: ${existing.title}`,
        url: "/tasks",
      });
    }

    logger.interaction("[tasks] Task submitted for review", {
      id,
      title: existing.title,
      by: session.author,
    });

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    logger.error("[tasks] Failed to submit:", error);
    return { error: "Failed to submit task." };
  }
}

export async function approveTask(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can approve tasks." };

  try {
    const existing = await redis.get<Task>(taskKey(id));
    if (!existing) return { error: "Task not found." };

    const updated: Task = {
      ...existing,
      status: "completed",
      completed: true, // Keep legacy field updated just in case
      completedAt: Date.now(),
    };

    await redis.set(taskKey(id), updated);

    // Notify Besho that her task was approved
    await sendTaskNotification("Besho", {
      title: "✅ Task Approved",
      body: `Sir approved: ${existing.title}`,
      url: "/tasks",
    });

    logger.interaction("[tasks] Task approved", {
      id,
      title: existing.title,
      by: session.author,
    });

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    logger.error("[tasks] Failed to approve:", error);
    return { error: "Failed to approve task." };
  }
}

export async function rejectTask(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can reject tasks." };

  try {
    const existing = await redis.get<Task>(taskKey(id));
    if (!existing) return { error: "Task not found." };

    const updated: Task = {
      ...existing,
      status: "pending",
      submittedAt: undefined, // Clear the submission time
    };

    await redis.set(taskKey(id), updated);

    // Notify Besho that her task was rejected
    await sendTaskNotification("Besho", {
      title: "❌ Task Rejected",
      body: `Sir rejected: ${existing.title}. You have to redo it.`,
      url: "/tasks",
    });

    logger.interaction("[tasks] Task rejected", {
      id,
      title: existing.title,
      by: session.author,
    });

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    logger.error("[tasks] Failed to reject:", error);
    return { error: "Failed to reject task." };
  }
}

export async function deleteTask(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };
  if (session.author !== "T7SEN")
    return { error: "Only Sir can delete tasks." };

  try {
    const pipeline = redis.pipeline();
    pipeline.del(taskKey(id));
    pipeline.zrem(INDEX_KEY, id);
    await pipeline.exec();

    logger.interaction("[tasks] Task deleted", {
      id,
      by: session.author,
    });
    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    logger.error("[tasks] Failed to delete:", error);
    return { error: "Failed to delete task." };
  }
}

async function sendTaskNotification(
  to: string,
  payload: { title: string; body: string; url: string },
): Promise<void> {
  try {
    await pushNotificationToHistory(to, {
      ...payload,
      timestamp: Date.now(),
    });

    let currentPage: string | null = null;
    try {
      const presenceRaw = await redis.get<string>(`presence:${to}`);
      if (presenceRaw) {
        try {
          const { page, ts } = JSON.parse(presenceRaw) as {
            page: string;
            ts: number;
          };
          if (Date.now() - ts < 9_000) {
            currentPage = page;
          }
        } catch {
          currentPage = presenceRaw;
        }
      }
    } catch {
      /* proceed */
    }

    const isAppOpen = currentPage !== null;
    if (currentPage === payload.url) return; // Already on tasks page

    const fcmToken = await redis.get<string>(`push:fcm:${to}`);
    if (fcmToken) {
      const { getApps, initializeApp, cert } =
        await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");

      if (!getApps().length) {
        initializeApp({
          credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID!,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
            privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
          }),
        });
      }

      await getMessaging().send({
        token: fcmToken,
        ...(isAppOpen
          ? {
              data: {
                url: payload.url,
                title: payload.title,
                body: payload.body,
              },
            }
          : {
              notification: { title: payload.title, body: payload.body },
              data: { url: payload.url },
              android: { priority: "high" },
            }),
      });
    }
  } catch (err) {
    logger.error("[tasks] Notification failed:", err);
  }
}
