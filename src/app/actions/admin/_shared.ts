// src/app/actions/admin/_shared.ts
//
// Shared helpers for the admin/* bucket files. NOT a `'use server'`
// module — exposes a Redis client singleton, plain constants, and
// internal async helpers that bucket files import. Keeping this
// module non-server-marked is what allows `redis` (a non-async value)
// to be exported from here.
import "server-only";

import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt, type SessionPayload } from "@/lib/auth-utils";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export const PRESENCE_FRESH_MS = 12_000;

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (!value) return null;
  return decrypt(value);
}

export async function requireSir(): Promise<
  | { ok: true; session: SessionPayload }
  | { ok: false; error: string }
> {
  const session = await getSession();
  if (!session?.author) return { ok: false, error: "Not authenticated." };
  if (session.author !== "T7SEN") return { ok: false, error: "Forbidden." };
  return { ok: true, session };
}
