"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { pushNotificationToHistory } from "@/app/actions/notifications";

export type TaskPriority = "low" | "medium" | "high" | "urgent";

export interface Task {
  id: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  deadline?: number; // Unix timestamp
  completed: boolean;
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
    return tasks.filter((t): t is Task => t !== null);
  } catch (error) {
    console.error("[tasks] Failed to fetch:", error);
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
    completed: false,
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

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    console.error("[tasks] Failed to create:", error);
    return { error: "Failed to save task." };
  }
}

export async function completeTask(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const session = await getSession();
  if (!session?.author) return { error: "Not authenticated." };

  try {
    const existing = await redis.get<Task>(taskKey(id));
    if (!existing) return { error: "Task not found." };

    const updated: Task = {
      ...existing,
      completed: true,
      completedAt: Date.now(),
    };

    await redis.set(taskKey(id), updated);

    // Notify T7SEN when Besho completes a task
    if (session.author === "Besho") {
      await sendTaskNotification("T7SEN", {
        title: "✅ Task Complete",
        body: `Besho completed: ${existing.title}`,
        url: "/tasks",
      });
    }

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    console.error("[tasks] Failed to complete:", error);
    return { error: "Failed to complete task." };
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

    revalidatePath("/tasks");
    return { success: true };
  } catch (error) {
    console.error("[tasks] Failed to delete:", error);
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
          if (Date.now() - ts < 12_000) {
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
    console.error("[tasks] Notification failed:", err);
  }
}
