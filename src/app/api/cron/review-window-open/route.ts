// src/app/api/cron/review-window-open/route.ts
//
// Fires once per Saturday Cairo to announce that the /review submission
// window has opened. Saturday 00:00 → Sunday 23:59 Cairo is the window
// (per `@/lib/review-utils.isWithinSubmissionWindow`); the page already
// surfaces "🪞 Review revealed" when both authors submit, but until this
// endpoint there was no signal that the window had even opened.
//
// Triggered by cron-job.org daily; the endpoint short-circuits on
// non-Saturdays so a single daily entry suffices. Dedup via
// `review:fcm:opener:{weekDate}` (SET NX EX 25h) — even if the cron is
// configured hourly or fires twice for any reason, only one FCM goes
// out per Saturday.

import { NextRequest } from "next/server";
import { Redis } from "@upstash/redis";
import { sendNotification } from "@/app/actions/notifications";
import { logger } from "@/lib/logger";
import {
  currentReviewWeekDate,
  formatWeekLabel,
} from "@/lib/review-utils";
import { todayKeyCairo, weekdayOfDateKey } from "@/lib/cairo-time";

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

/** Cover the full Sat→Sun window plus a bit of slack so a hot redeploy
 *  on Sunday morning doesn't re-fire the opener for the same week. */
const DEDUP_TTL_SECONDS = 25 * 60 * 60;
const dedupKey = (weekDate: string) => `review:fcm:opener:${weekDate}`;

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.warn("[cron/review-window-open] CRON_SECRET not set; refusing run");
    return unauthorized();
  }
  if (auth !== `Bearer ${expected}`) return unauthorized();

  const startedAt = Date.now();
  try {
    const today = todayKeyCairo();
    const dow = weekdayOfDateKey(today); // 0=Sun..6=Sat
    if (dow !== 6) {
      return Response.json({
        ok: true,
        fired: false,
        reason: "not_saturday",
        dayOfWeek: dow,
        durationMs: Date.now() - startedAt,
      });
    }

    const weekDate = currentReviewWeekDate(Date.now());
    let claim: string | null;
    try {
      claim = (await redis.set(dedupKey(weekDate), "1", {
        nx: true,
        ex: DEDUP_TTL_SECONDS,
      })) as string | null;
    } catch (err) {
      logger.error("[cron/review-window-open] dedup SET failed", err, {
        weekDate,
      });
      return Response.json(
        {
          ok: false,
          error: "dedup_failed",
          durationMs: Date.now() - startedAt,
        },
        { status: 500 },
      );
    }
    if (claim !== "OK") {
      return Response.json({
        ok: true,
        fired: false,
        reason: "already_fired",
        weekDate,
        durationMs: Date.now() - startedAt,
      });
    }

    const label = formatWeekLabel(weekDate);
    try {
      await Promise.all([
        sendNotification("T7SEN", {
          title: "🪞 Review window open",
          body: `Reflect on ${label}. Window closes Sunday 23:59 Cairo.`,
          url: "/review",
        }),
        sendNotification("Besho", {
          title: "🪞 Review window open",
          body: `Reflect on ${label}. Window closes Sunday 23:59 Cairo.`,
          url: "/review",
        }),
      ]);
      logger.interaction("[cron/review-window-open] FCMs fired", {
        weekDate,
        label,
      });
      return Response.json({
        ok: true,
        fired: true,
        weekDate,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // Best-effort. Dedup key already claimed — we accept "no
      // notification this week" rather than risking duplicates after a
      // transient FCM hiccup.
      logger.error("[cron/review-window-open] FCM send failed", err, {
        weekDate,
      });
      return Response.json(
        {
          ok: false,
          error: "fcm_failed",
          weekDate,
          durationMs: Date.now() - startedAt,
        },
        { status: 500 },
      );
    }
  } catch (err) {
    logger.error("[cron/review-window-open] tick failed", err);
    return Response.json(
      {
        ok: false,
        error: "Tick failed.",
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}
