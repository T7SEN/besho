"use server";

import { redis } from "@/lib/redis";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { encrypt, decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";

const AUTH_FAILURES_KEY = "auth:failures";
const AUTH_FAILURES_CAP = 100;

export interface AuthFailureRecord {
  ts: number;
  ip: string | null;
  ua: string | null;
  /** Length of the submitted passcode — useful to distinguish
   *  fat-finger attempts from bot probing. Never the value itself. */
  passcodeLen: number;
}

async function recordAuthFailure(passcodeLen: number): Promise<void> {
  try {
    const headersList = await headers();
    const ip =
      headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      headersList.get("x-real-ip")?.trim() ??
      null;
    const ua = headersList.get("user-agent")?.slice(0, 200) ?? null;
    const record: AuthFailureRecord = {
      ts: Date.now(),
      ip,
      ua,
      passcodeLen,
    };
    await redis
      .pipeline()
      .zadd(AUTH_FAILURES_KEY, {
        score: record.ts,
        member: JSON.stringify(record),
      })
      .zremrangebyrank(AUTH_FAILURES_KEY, 0, -AUTH_FAILURES_CAP - 1)
      .exec();
  } catch (err) {
    // Failure logging is best-effort — never block the login response.
    logger.warn("[auth] failed to record auth failure", { err: String(err) });
  }
}

export async function getCurrentAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;
  if (!sessionCookie) return null;
  const session = await decrypt(sessionCookie);
  return session?.author ?? null;
}

export async function login(prevState: unknown, formData: FormData) {
  const passcode = formData.get("passcode");
  const passcodeLen = typeof passcode === "string" ? passcode.length : 0;

  let author: "T7SEN" | "Besho" | null = null;

  if (passcode === process.env.APP_PASSCODE_T7SEN) {
    author = "T7SEN";
  } else if (passcode === process.env.APP_PASSCODE_BESHO) {
    author = "Besho";
  }

  if (!author) {
    logger.warn("[auth] Failed login attempt");
    await recordAuthFailure(passcodeLen);
    return { error: "Incorrect passcode. Please try again." };
  }

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const session = await encrypt({
    isAuthenticated: true,
    author,
    expiresAt: expiresAt.toISOString(),
  });

  const cookieStore = await cookies();

  cookieStore.set("session", session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    sameSite: "lax",
    path: "/",
  });

  logger.interaction("[auth] User logged in", { author });
  redirect("/");
}

export async function logout() {
  const cookieStore = await cookies();
  const value = cookieStore.get("session")?.value;
  if (value) {
    const session = await decrypt(value);
    logger.interaction("[auth] User logged out", { author: session?.author });
  }
  cookieStore.delete("session");
  redirect("/login");
}
