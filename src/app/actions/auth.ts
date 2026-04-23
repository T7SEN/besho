"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type AuthState = { error: string } | null;

export async function authenticate(prevState: AuthState, formData: FormData) {
  const passcode = formData.get("passcode");
  const expectedPasscode = process.env.SHARED_PASSCODE;

  if (!expectedPasscode) {
    console.error("SHARED_PASSCODE environment variable is missing");
    return {
      error: "Server misconfiguration. Please contact the administrator.",
    };
  }

  if (passcode === expectedPasscode) {
    const cookieStore = await cookies();

    cookieStore.set("besho_auth", "true", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 90,
      path: "/",
    });

    redirect("/");
  } else {
    return { error: "Incorrect passcode. Please try again." };
  }
}
