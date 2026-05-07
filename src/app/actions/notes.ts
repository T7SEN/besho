"use server";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { decrypt } from "@/lib/auth-utils";
import {
  MAX_CONTENT_LENGTH,
  MAX_PINS_PER_AUTHOR,
  PAGE_SIZE,
} from "@/lib/notes-constants";
import { sendNotification } from "@/app/actions/notifications";
import { getReactionsForNotes } from "@/app/actions/reactions";
import { logger } from "@/lib/logger";
import { moveToTrash, moveManyToTrash } from "@/lib/trash";
import { assertWriteAllowed } from "@/lib/restraint";

export interface Note {
  id: string;
  content: string;
  author: string;
  createdAt: number;
  editedAt?: number;
  originalContent?: string;
  reactions?: Record<string, string>;
  pinned?: boolean;
  /** ms timestamp when pinned. Set on pin, ignored when `pinned=false`.
   *  Used for sorting within a per-author pin group (newest pin first). */
  pinnedAt?: number;
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
  logger.info(`[notes] Migrated ${legacyNotes.length} legacy notes.`);
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
    logger.error("[notes] Failed to fetch notes:", error);
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

export async function saveNote(
  prevState: unknown,
  formData: FormData,
): Promise<{ success?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(author);
  if (block) return block;

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

    // Fire-and-forget push to the other user.
    const other = author === "T7SEN" ? "Besho" : "T7SEN";
    await sendNotification(other, {
      title: `${author} wrote a note`,
      body: newNote.content.slice(0, 100),
      url: "/notes",
    });

    return { success: true };
  } catch (error) {
    logger.error("[notes] Failed to save note:", error);
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

  const block = await assertWriteAllowed(author);
  if (block) return block;

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
    logger.error("[notes] Failed to edit note:", error);
    return { error: "Failed to edit note. Please try again." };
  }
}

// ─── togglePinNote ────────────────────────────────────────────────────────────

export async function togglePinNote(
  id: string,
): Promise<{ pinned?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };

  const block = await assertWriteAllowed(author);
  if (block) return block;

  // Per-author lock around count-then-write. Upstash REST has no
  // WATCH/MULTI, so two concurrent toggles can both observe count=4
  // and each write to land at 5. SETNX with a 5s TTL serializes the
  // critical section without a schema change; auto-expiry guards
  // against orphan locks if the request crashes mid-flight.
  const lockKey = `notes:pin-lock:${author}`;
  const lockAcquired = await redis.set(lockKey, "1", { nx: true, ex: 5 });
  if (!lockAcquired) {
    return { error: "Another pin operation is in progress. Try again." };
  }

  try {
    const existing = await redis.get<Note>(noteKey(id));
    if (!existing) return { error: "Note not found." };
    if (existing.author !== author) {
      return { error: "You can only pin your own notes." };
    }

    const nowPinned = !existing.pinned;

    if (nowPinned) {
      // Cap of MAX_PINS_PER_AUTHOR per author. Walk all notes once to
      // count this author's currently-pinned. N is small (a 2-user
      // app); a single mget is fine.
      const allIds = (await redis.zrange(INDEX_KEY, 0, -1)) as string[];
      if (allIds.length > 0) {
        const allNotes = await redis.mget<(Note | null)[]>(
          ...allIds.map(noteKey),
        );
        const pinnedByAuthor = allNotes.filter(
          (n): n is Note =>
            n !== null && n.author === author && n.pinned === true,
        );
        if (pinnedByAuthor.length >= MAX_PINS_PER_AUTHOR) {
          return {
            error: `You can pin up to ${MAX_PINS_PER_AUTHOR} notes. Unpin one first.`,
          };
        }
      }
    }

    const updatedNote: Note = nowPinned
      ? { ...existing, pinned: true, pinnedAt: Date.now() }
      : { ...existing, pinned: false };

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
    logger.error("[notes] Failed to toggle pin:", error);
    return { error: "Failed to pin note." };
  } finally {
    // Best-effort unlock; if this fails the TTL auto-clears in 5s.
    await redis.del(lockKey).catch(() => {});
  }
}

// ─── Sir-only destructive ─────────────────────────────────────────────────────

export async function deleteNote(
  id: string,
): Promise<{ success?: boolean; error?: string }> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };
  if (author !== "T7SEN") return { error: "Only Sir can delete notes." };

  try {
    const note = await redis.get<Note>(noteKey(id));
    if (!note) return { error: "Note not found." };

    const score = await redis.zscore(INDEX_KEY, id);
    await moveToTrash(redis, {
      feature: "notes",
      id,
      label: note.content.slice(0, 80),
      deletedBy: author,
      payload: note,
      indexScore: typeof score === "number" ? score : Number(score) || note.createdAt,
      recordKey: noteKey(id),
      indexKey: INDEX_KEY,
    });

    const pipeline = redis.pipeline();
    pipeline.del(noteKey(id));
    pipeline.del(`reactions:${id}`);
    pipeline.zrem(INDEX_KEY, id);
    pipeline.srem(PINNED_KEY, id);
    if (note.author === "T7SEN" || note.author === "Besho") {
      pipeline.decr(countKey(note.author));
    }
    await pipeline.exec();

    revalidatePath("/notes");
    logger.warn(`[notes] Sir deleted note ${id} by ${note.author}.`);
    return { success: true };
  } catch (err) {
    logger.error("[notes] deleteNote failed:", err);
    return { error: "Failed to delete note." };
  }
}

export async function purgeAllNotes(): Promise<{
  success?: boolean;
  error?: string;
  deletedCount?: number;
}> {
  const author = await getSessionAuthor();
  if (!author) return { error: "Not authenticated." };
  if (author !== "T7SEN") return { error: "Only Sir can purge notes." };

  try {
    const raw =
      ((await redis.zrange<(string | number)[]>(INDEX_KEY, 0, -1, {
        withScores: true,
      })) as (string | number)[]) ?? [];
    const pairs: { id: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      pairs.push({
        id: String(raw[i]),
        score: Number(raw[i + 1]) || 0,
      });
    }
    const ids = pairs.map((p) => p.id);

    if (ids.length > 0) {
      const records = (await redis.mget<Note[]>(...ids.map(noteKey))) ?? [];
      await moveManyToTrash(
        redis,
        pairs.map((p, i) => {
          const note = records[i];
          return {
            feature: "notes" as const,
            id: p.id,
            label: note?.content?.slice(0, 80) ?? p.id,
            deletedBy: author,
            payload: note ?? null,
            indexScore: p.score,
            recordKey: noteKey(p.id),
            indexKey: INDEX_KEY,
          };
        }),
      );
    }

    const pipeline = redis.pipeline();
    for (const id of ids) {
      pipeline.del(noteKey(id));
      pipeline.del(`reactions:${id}`);
    }
    pipeline.del(INDEX_KEY);
    pipeline.del(PINNED_KEY);
    pipeline.del(LEGACY_KEY);
    pipeline.set(countKey("T7SEN"), 0);
    pipeline.set(countKey("Besho"), 0);
    if (ids.length > 0) await pipeline.exec();

    revalidatePath("/notes");
    logger.warn(`[notes] Sir purged ${ids.length} notes.`);
    return { success: true, deletedCount: ids.length };
  } catch (err) {
    logger.error("[notes] purgeAllNotes failed:", err);
    return { error: "Purge failed." };
  }
}
