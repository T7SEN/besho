import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { addFcmToken, fcmKey } from "@/lib/fcm-tokens";

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get("session")?.value);
  if (!session?.author) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { token } = await req.json();
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Invalid token." }, { status: 400 });
  }

  // Multi-token semantics: SADD the token (and migrate legacy STRING
  // shape if encountered). Idempotent — re-registering an existing
  // token is a no-op via SET dedup.
  const totalTokens = await addFcmToken(redis, session.author, token);
  return NextResponse.json({ success: true, totalTokens });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function DELETE(_req: NextRequest) {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get("session")?.value);
  if (!session?.author) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Clears every device's token for the caller. Per-token unsubscribe
  // would require the client to send the specific token in the body;
  // current callers don't, so the existing semantic is preserved.
  await redis.del(fcmKey(session.author));
  return NextResponse.json({ success: true });
}
