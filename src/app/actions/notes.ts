"use server";

import { Redis } from "@upstash/redis";
import { revalidatePath } from "next/cache";

export interface Note {
  id: string;
  content: string;
  createdAt: number;
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const NOTES_KEY = "our-space-notes";

export async function getNotes() {
  try {
    const notes = await redis.lrange<Note>(NOTES_KEY, 0, -1);
    return notes || [];
  } catch (error) {
    console.error("Failed to fetch notes:", error);
    return [];
  }
}

export async function saveNote(prevState: unknown, formData: FormData) {
  const content = formData.get("content") as string;

  if (!content || content.trim() === "") {
    return { error: "Your note cannot be empty." };
  }

  const newNote: Note = {
    id: crypto.randomUUID(),
    content: content.trim(),
    createdAt: Date.now(),
  };

  try {
    await redis.lpush(NOTES_KEY, newNote);
    revalidatePath("/notes");
    return { success: true };
  } catch (error) {
    console.error("Failed to save note:", error);
    return { error: "Failed to save note. Please try again." };
  }
}
