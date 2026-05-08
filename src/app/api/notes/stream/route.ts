import type { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { decrypt } from "@/lib/auth-utils";

export const runtime = "edge";

const INDEX_KEY = "notes:index";
const POLL_INTERVAL_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
// Stream lifetime before graceful close (client auto-reconnects via EventSource)
const MAX_STREAM_AGE_MS = 45_000;

async function getLatestTimestamp(): Promise<number | null> {
  try {
    const ids = (await redis.zrange(INDEX_KEY, 0, 0, {
      rev: true,
    })) as string[];
    if (!ids.length) return null;
    const note = await redis.get<{ createdAt: number }>(`note:${ids[0]}`);
    return note?.createdAt ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const sessionCookie = request.cookies.get("session")?.value;
  const session = sessionCookie ? await decrypt(sessionCookie) : null;

  if (!session?.isAuthenticated) {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // ── Initial state ──
      let lastTimestamp = await getLatestTimestamp();
      send({ type: "init", timestamp: lastTimestamp });

      // ── Poll ──
      const pollId = setInterval(async () => {
        if (closed) {
          clearInterval(pollId);
          return;
        }
        const current = await getLatestTimestamp();
        if (current !== null && current !== lastTimestamp) {
          lastTimestamp = current;
          send({ type: "update", timestamp: current });
        }
      }, POLL_INTERVAL_MS);

      // ── Keepalive — prevents proxies from closing idle connections ──
      const keepaliveId = setInterval(() => {
        if (closed) {
          clearInterval(keepaliveId);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          closed = true;
        }
      }, KEEPALIVE_INTERVAL_MS);

      // ── Graceful close — EventSource auto-reconnects after ~3s ──
      const closeId = setTimeout(() => {
        clearInterval(pollId);
        clearInterval(keepaliveId);
        close();
      }, MAX_STREAM_AGE_MS);

      // ── Client disconnect cleanup ──
      request.signal.addEventListener("abort", () => {
        clearInterval(pollId);
        clearInterval(keepaliveId);
        clearTimeout(closeId);
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells Nginx not to buffer the stream
      "X-Accel-Buffering": "no",
    },
  });
}
