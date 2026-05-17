import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

// seconds — must exceed the 8s usePresence heartbeat so the key
// survives between ticks. Raised 6→15 in the Redis-cost audit
// (alongside the 4s→8s heartbeat) to cut presence SET volume.
const PRESENCE_TTL = 15;
const presenceKey = (author: string) => `presence:${author}`;

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get("session")?.value);
  if (!session?.author) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { page } = await req.json();
  if (!page || typeof page !== "string") {
    return NextResponse.json({ error: "Invalid page." }, { status: 400 });
  }

  // Store current page with TTL — if heartbeat stops, presence expires
  await redis.set(
    presenceKey(session.author),
    JSON.stringify({ page, ts: Date.now() }),
    { ex: PRESENCE_TTL },
  );

  return NextResponse.json({ success: true });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function DELETE(_req: NextRequest) {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get("session")?.value);
  if (!session?.author) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await redis.del(presenceKey(session.author));
  return NextResponse.json({ success: true });
}
