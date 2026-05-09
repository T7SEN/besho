import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";
import { logger } from "@/lib/logger";
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

  // Activity-feed entry for Sir's `/admin/logs` Activity tab. Confirms
  // exactly when a device's token landed in the SET — primary
  // diagnostic for "did her phone actually reach the server?" debugging.
  // Token preview only (first 8 + last 4) so the audit trail is
  // recognizable but doesn't expose the full token in the log.
  const tokenPreview =
    token.length > 12 ? `${token.slice(0, 8)}…${token.slice(-4)}` : token;
  logger.interaction(`[fcm] Token registered for ${session.author}`, {
    author: session.author,
    totalTokens,
    tokenPreview,
  });

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
