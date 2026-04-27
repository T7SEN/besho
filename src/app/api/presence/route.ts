import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const PRESENCE_TTL = 10; // seconds — must be longer than the heartbeat interval in usePresence
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
