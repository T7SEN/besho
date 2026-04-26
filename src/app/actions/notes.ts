"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { MAX_CONTENT_LENGTH, PAGE_SIZE } from "@/lib/notes-constants";
import { pushNotificationToHistory } from "@/app/actions/notifications";
import { getReactionsForNotes } from "@/app/actions/reactions";

export interface Note {
  id: string;
  content: string;
  author: string;
  createdAt: number;
  editedAt?: number;
  originalContent?: string;
  reactions?: Record<string, string>;
  pinned?: boolean;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "notes:index";
const LEGACY_KEY = "our-space-notes";
const PINNED_KEY = "notes:pinned";
const COUNTS_INIT_KEY = "notes:counts:initialized";
const noteKey = (id: string) => `note:${id}`;
const countKey = (author: string) => `notes:count:${author}`;

// ─── Session ──────────────────────────────────────────────────────────────────

async function getSessionAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;
  if (!sessionCookie) return null;
  const session = await decrypt(sessionCookie);
  return session?.author ?? null;
}

export async function getCurrentAuthor(): Promise<"T7SEN" | "Besho" | null> {
  return getSessionAuthor();
}

// ─── Replace sendPushToUser in src/app/actions/notes.ts ──────────────────────
// Also apply the same pattern to sendHugPush in src/app/actions/mood.ts
// Import pushNotificationToHistory at the top of both files:
// import { pushNotificationToHistory } from "@/app/actions/notifications";

async function sendPushToUser(
  toAuthor: "T7SEN" | "Besho",
  payload: { title: string; body: string; url: string },
): Promise<void> {
  if (
    !process.env.VAPID_EMAIL ||
    !process.env.VAPID_PUBLIC_KEY ||
    !process.env.VAPID_PRIVATE_KEY
  ) {
    console.error("[push] Missing VAPID env vars.");
    return;
  }

  // ── Presence check ────────────────────────────────────────────────────────
  let currentPage: string | null = null;
  try {
    currentPage = await redis.get<string>(`presence:${toAuthor}`);
    if (currentPage === payload.url) {
      console.log(`[push] Skipping — ${toAuthor} is on ${payload.url}.`);
      return;
    }
  } catch (err) {
    console.warn("[push] Presence check failed, proceeding:", err);
  }

  const isAppOpen = currentPage !== null;

  // ── Write to notification history ─────────────────────────────────────────
  // Always record — regardless of whether the push sends successfully
  try {
    await pushNotificationToHistory(toAuthor, {
      title: payload.title,
      body: payload.body,
      url: payload.url,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[push] Failed to write notification history:", err);
  }

  // ── FCM (native Android) ──────────────────────────────────────────────────
  const fcmToken = await redis.get<string>(`push:fcm:${toAuthor}`);
  if (fcmToken) {
    try {
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
        // App open: data-only (Capacitor intercepts, shows in-app toast)
        // App closed: notification message (OS shows natively)
        ...(isAppOpen
          ? {
              data: {
                url: payload.url,
                title: payload.title,
                body: payload.body,
              },
            }
          : {
              notification: {
                title: payload.title,
                body: payload.body,
              },
              data: { url: payload.url },
              android: { priority: "high" },
            }),
      });

      console.log(`[push] FCM sent to ${toAuthor}.`);
      return;
    } catch (err) {
      console.error("[push] FCM failed, falling back to Web Push:", err);
    }
  }

  // ── Web Push fallback (PWA) ───────────────────────────────────────────────
  const subscription = await redis.get(`push:subscription:${toAuthor}`);
  if (!subscription) {
    console.log(`[push] No subscription for ${toAuthor}.`);
    return;
  }

  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  await webpush.sendNotification(
    subscription as Parameters<typeof webpush.sendNotification>[0],
    JSON.stringify(payload),
  );

  console.log(`[push] Web Push sent to ${toAuthor}.`);
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

async function migrateLegacyNotes(): Promise<void> {
  const legacyNotes = await redis.lrange<Note>(LEGACY_KEY, 0, -1);
  if (!legacyNotes.length) return;

  const pipeline = redis.pipeline();
  for (const note of legacyNotes) {
    const normalized: Note = {
      id: note.id ?? crypto.randomUUID(),
      content: note.content,
      author: note.author ?? "Unknown",
      createdAt: note.createdAt ?? Date.now(),
      ...(note.editedAt !== undefined && { editedAt: note.editedAt }),
      ...(note.originalContent !== undefined && {
        originalContent: note.originalContent,
      }),
    };
    pipeline.set(noteKey(normalized.id), normalized);
    pipeline.zadd(INDEX_KEY, {
      score: normalized.createdAt,
      member: normalized.id,
    });
  }

  await pipeline.exec();
  await redis.del(LEGACY_KEY);
  console.log(`[notes] Migrated ${legacyNotes.length} legacy notes.`);
}

// ─── Author count initialization ─────────────────────────────────────────────
// Runs once to back-fill counts for notes written before this feature.

async function ensureAuthorCountsInitialized(): Promise<void> {
  const initialized = await redis.exists(COUNTS_INIT_KEY);
  if (initialized) return;

  const allIds = (await redis.zrange(INDEX_KEY, 0, -1)) as string[];
  let t7sen = 0;
  let besho = 0;

  if (allIds.length) {
    const allNotes = await redis.mget<(Note | null)[]>(...allIds.map(noteKey));
    for (const note of allNotes) {
      if (!note) continue;
      if (note.author === "T7SEN") t7sen++;
      else if (note.author === "Besho") besho++;
    }
  }

  const pipeline = redis.pipeline();
  pipeline.set(countKey("T7SEN"), t7sen);
  pipeline.set(countKey("Besho"), besho);
  pipeline.set(COUNTS_INIT_KEY, "1");
  await pipeline.exec();
}

// ─── getNotes ─────────────────────────────────────────────────────────────────

export async function getNotes(
  page = 0,
): Promise<{ notes: Note[]; hasMore: boolean }> {
  try {
    const legacyExists = await redis.exists(LEGACY_KEY);
    if (legacyExists) await migrateLegacyNotes();

    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE;

    const ids = (await redis.zrange(INDEX_KEY, start, end, {
      rev: true,
    })) as string[];

    if (!ids.length) return { notes: [], hasMore: false };

    const hasMore = ids.length > PAGE_SIZE;
    const pageIds = ids.slice(0, PAGE_SIZE);

    const rawNotes = await redis.mget<(Note | null)[]>(...pageIds.map(noteKey));
    const notes = rawNotes.filter((n): n is Note => n !== null);

    // Merge reactions from separate Redis hashes into each note
    const reactionsMap = await getReactionsForNotes(notes.map((n) => n.id));
    const notesWithReactions = notes.map((n) => ({
      ...n,
      reactions: reactionsMap[n.id] ?? {},
    }));

    return { notes: notesWithReactions, hasMore };
  } catch (error) {
    console.error("[notes] Failed to fetch notes:", error);
    return { notes: [], hasMore: false };
  }
}

// ─── getLatestNoteTimestamp ───────────────────────────────────────────────────

export async function getLatestNoteTimestamp(): Promise<number | null> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, 0, {
      rev: true,
    })) as string[];
    if (!ids.length) return null;
    const note = await redis.get<Note>(noteKey(ids[0]));
    return note?.createdAt ?? null;
  } catch {
    return null;
  }
}

// ─── getNoteCount ─────────────────────────────────────────────────────────────

export async function getNoteCount(): Promise<number> {
  try {
    const [indexCount, legacyCount] = await Promise.all([
      redis.zcard(INDEX_KEY),
      redis.llen(LEGACY_KEY),
    ]);
    return indexCount + legacyCount;
  } catch {
    return 0;
  }
}

// ─── getNoteCountByAuthor ─────────────────────────────────────────────────────

export async function getNoteCountByAuthor(): Promise<{
  T7SEN: number;
  Besho: number;
}> {
  try {
    await ensureAuthorCountsInitialized();
    const [t7sen, besho] = await Promise.all([
      redis.get<number>(countKey("T7SEN")),
      redis.get<number>(countKey("Besho")),
    ]);
    return { T7SEN: t7sen ?? 0, Besho: besho ?? 0 };
  } catch {
    return { T7SEN: 0, Besho: 0 };
  }
}

// ─── saveNote ─────────────────────────────────────────────────────────────────

export async function saveNote(prevState: unknown, formData: FormData) {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  const content = formData.get("content") as string;

  if (!content || content.trim() === "") {
    return { error: "Your note cannot be empty." };
  }

  if (content.trim().length > MAX_CONTENT_LENGTH) {
    return { error: `Notes cannot exceed ${MAX_CONTENT_LENGTH} characters.` };
  }

  const newNote: Note = {
    id: crypto.randomUUID(),
    content: content.trim(),
    author,
    createdAt: Date.now(),
  };

  try {
    const pipeline = redis.pipeline();
    pipeline.set(noteKey(newNote.id), newNote);
    pipeline.zadd(INDEX_KEY, { score: newNote.createdAt, member: newNote.id });
    pipeline.incr(countKey(author));
    await pipeline.exec();

    revalidatePath("/notes");

    // Fire-and-forget push to the other user
    const other = author === "T7SEN" ? "Besho" : "T7SEN";
    try {
      await sendPushToUser(other, {
        title: `${author} wrote a note`,
        body: newNote.content.slice(0, 100),
        url: "/notes",
      });
    } catch (pushError) {
      console.error("[push] Failed to notify partner:", pushError);
    }

    return { success: true };
  } catch (error) {
    console.error("[notes] Failed to save note:", error);
    return { error: "Failed to save note. Please try again." };
  }
}

// ─── editNote ─────────────────────────────────────────────────────────────────

export async function editNote(
  id: string,
  newContent: string,
): Promise<{ success?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  if (!newContent || newContent.trim() === "") {
    return { error: "Note cannot be empty." };
  }

  if (newContent.trim().length > MAX_CONTENT_LENGTH) {
    return { error: `Notes cannot exceed ${MAX_CONTENT_LENGTH} characters.` };
  }

  try {
    const existing = await redis.get<Note>(noteKey(id));
    if (!existing) return { error: "Note not found." };
    if (existing.author !== author) {
      return { error: "You can only edit your own notes." };
    }

    const updatedNote: Note = {
      ...existing,
      content: newContent.trim(),
      originalContent: existing.originalContent ?? existing.content,
      editedAt: Date.now(),
    };

    await redis.set(noteKey(id), updatedNote);
    revalidatePath("/notes");
    return { success: true };
  } catch (error) {
    console.error("[notes] Failed to edit note:", error);
    return { error: "Failed to edit note. Please try again." };
  }
}

// ─── togglePinNote ────────────────────────────────────────────────────────────

export async function togglePinNote(
  id: string,
): Promise<{ pinned?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  try {
    const existing = await redis.get<Note>(noteKey(id));
    if (!existing) return { error: "Note not found." };
    if (existing.author !== author) {
      return { error: "You can only pin your own notes." };
    }

    const nowPinned = !existing.pinned;
    const updatedNote: Note = { ...existing, pinned: nowPinned };

    const pipeline = redis.pipeline();
    pipeline.set(noteKey(id), updatedNote);
    if (nowPinned) {
      pipeline.sadd(PINNED_KEY, id);
    } else {
      pipeline.srem(PINNED_KEY, id);
    }
    await pipeline.exec();

    revalidatePath("/notes");
    return { pinned: nowPinned };
  } catch (error) {
    console.error("[notes] Failed to toggle pin:", error);
    return { error: "Failed to pin note." };
  }
}
