"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import { MAX_CONTENT_LENGTH, PAGE_SIZE } from "@/lib/notes-constants";

export interface Note {
  id: string;
  content: string;
  author: string;
  createdAt: number;
  editedAt?: number;
  originalContent?: string;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const INDEX_KEY = "notes:index";
const LEGACY_KEY = "our-space-notes";
const noteKey = (id: string) => `note:${id}`;

// ─── Session helper ───────────────────────────────────────────────────────────

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

// ─── One-time lazy migration ──────────────────────────────────────────────────

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

    return { notes, hasMore };
  } catch (error) {
    console.error("Failed to fetch notes:", error);
    return { notes: [], hasMore: false };
  }
}

// ─── getLatestNoteTimestamp ───────────────────────────────────────────────────
// Lightweight poll target — fetches only the newest note's createdAt.
// Used by the 30s polling interval to detect new notes without a full reload.

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
// Returns total note count across both the new ZSET index and any unmigrated
// legacy list entries so the count is accurate immediately after deployment.

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
    pipeline.zadd(INDEX_KEY, {
      score: newNote.createdAt,
      member: newNote.id,
    });
    await pipeline.exec();

    revalidatePath("/notes");
    return { success: true };
  } catch (error) {
    console.error("Failed to save note:", error);
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
    console.error("Failed to edit note:", error);
    return { error: "Failed to edit note. Please try again." };
  }
}
