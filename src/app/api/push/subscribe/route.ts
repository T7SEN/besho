import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { cookies } from "next/headers";
import { decrypt } from "@/lib/auth-utils";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const subscriptionKey = (author: string) => `push:subscription:${author}`;

export async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const session = await decrypt(cookieStore.get("session")?.value);
  if (!session?.author) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subscription = await req.json();
  await redis.set(
    subscriptionKey(session.author),
    JSON.stringify(subscription),
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

  await redis.del(subscriptionKey(session.author));
  return NextResponse.json({ success: true });
}
