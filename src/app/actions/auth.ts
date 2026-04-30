"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { encrypt, decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";

export async function getCurrentAuthor(): Promise<"T7SEN" | "Besho" | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("session")?.value;
  if (!sessionCookie) return null;
  const session = await decrypt(sessionCookie);
  return session?.author ?? null;
}

export async function login(prevState: unknown, formData: FormData) {
  const passcode = formData.get("passcode");

  let author: "T7SEN" | "Besho" | null = null;

  if (passcode === process.env.APP_PASSCODE_T7SEN) {
    author = "T7SEN";
  } else if (passcode === process.env.APP_PASSCODE_BESHO) {
    author = "Besho";
  }

  if (!author) {
    logger.warn("[auth] Failed login attempt");
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
