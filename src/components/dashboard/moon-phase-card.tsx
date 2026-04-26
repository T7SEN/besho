"use client";

import { cn } from "@/lib/utils";

interface MoonData {
  phase: number;
  name: string;
  emoji: string;
  illumination: number;
}

function getMoonPhase(date: Date): MoonData {
  // Reference new moon: 6 Jan 2000 18:14 UTC
  const KNOWN_NEW_MOON = new Date("2000-01-06T18:14:00Z").getTime();
  const SYNODIC_MS = 29.530588853 * 24 * 60 * 60 * 1000;

  const elapsed = date.getTime() - KNOWN_NEW_MOON;
  const phase =
    (((elapsed % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS) / SYNODIC_MS;

  const illumination = Math.round(
    ((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100,
  );

  let name: string;
  let emoji: string;

  if (phase < 0.0625) {
    name = "New Moon";
    emoji = "🌑";
  } else if (phase < 0.1875) {
    name = "Waxing Crescent";
    emoji = "🌒";
  } else if (phase < 0.3125) {
    name = "First Quarter";
    emoji = "🌓";
  } else if (phase < 0.4375) {
    name = "Waxing Gibbous";
    emoji = "🌔";
  } else if (phase < 0.5625) {
    name = "Full Moon";
    emoji = "🌕";
  } else if (phase < 0.6875) {
    name = "Waning Gibbous";
    emoji = "🌖";
  } else if (phase < 0.8125) {
    name = "Last Quarter";
    emoji = "🌗";
  } else if (phase < 0.9375) {
    name = "Waning Crescent";
    emoji = "🌘";
  } else {
    name = "New Moon";
    emoji = "🌑";
  }

  return { phase, name, emoji, illumination };
}

export function MoonPhaseCard({ now }: { now: Date }) {
  const moon = getMoonPhase(now);

  const isFullMoon = moon.phase >= 0.4375 && moon.phase < 0.5625;
  const isNewMoon = moon.phase < 0.0625 || moon.phase >= 0.9375;

  return (
    <div
      className={cn(
        "flex flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
        isFullMoon ? "hover:border-yellow-500/20" : "hover:border-primary/20",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Moon Phase
        </h2>
        <span className="text-lg" aria-hidden="true">
          {moon.emoji}
        </span>
      </div>

      <div className="mt-6 flex items-end justify-between">
        <div>
          <div
            className="text-7xl leading-none"
            role="img"
            aria-label={moon.name}
          >
            {moon.emoji}
          </div>
          <p
            className={cn(
              "mt-4 text-lg font-bold tracking-tight",
              isFullMoon && "text-yellow-400/90",
              isNewMoon && "text-muted-foreground",
              !isFullMoon && !isNewMoon && "text-foreground",
            )}
          >
            {moon.name}
          </p>
          <p className="mt-1 text-sm text-muted-foreground/60">
            {moon.illumination}% illuminated
          </p>
        </div>
      </div>
    </div>
  );
}
