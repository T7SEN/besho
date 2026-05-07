"use server";

import { todayKeyCairo } from "@/lib/cairo-time";
import { logger } from "@/lib/logger";

export type QuoteData = {
  text: string;
  author: string;
};

/**
 * Fetches a quote from the cached JSON file.
 *
 * Default behavior: the same quote is shown all day, seeded by the current
 * date (YYYYMMDD). Passing `forceRandom = true` bypasses this and returns a
 * random quote — used by the manual refresh button in QuoteCard.
 */
export async function fetchRandomQuote(
  forceRandom = false,
): Promise<QuoteData> {
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/btford/philosobot/master/quotes/love.json",
      {
        next: { revalidate: 86400 }, // Cache the JSON file for 24 hours
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      throw new Error(`GitHub CDN returned status: ${res.status}`);
    }

    const json = await res.json();

    if (json.quotes && json.quotes.length > 0) {
      let index: number;

      if (forceRandom) {
        index = Math.floor(Math.random() * json.quotes.length);
      } else {
        // Deterministic daily seed: same quote for everyone on the same
        // Cairo day. Was computed from the server-local Date (UTC on
        // Vercel) so Cairo got the new daily quote 2-3h after midnight
        // local. `todayKeyCairo()` returns YYYY-MM-DD in Cairo TZ;
        // collapse to a numeric seed via the same shape as before.
        const todayKey = todayKeyCairo();
        const [yyyy, mm, dd] = todayKey.split("-").map(Number);
        const seed = yyyy * 10000 + mm * 100 + dd;
        index = seed % json.quotes.length;
      }

      const quote = json.quotes[index];
      const cleanText = quote.quote.replace(/<br\s*\/?>/gi, "\n");

      return {
        text: cleanText,
        author: quote.author || "Unknown",
      };
    }

    throw new Error("JSON returned empty array");
  } catch (error) {
    logger.error("Quote API error:", error);
    return {
      text: `Could not load quote: ${error instanceof Error ? error.message : "Unknown error"}`,
      author: "Error",
    };
  }
}
