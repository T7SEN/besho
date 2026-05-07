"use client";

import { useCallback, useEffect, useState } from "react";
import { WeatherCard } from "@/components/dashboard/weather-card";
import { CounterCard } from "@/components/dashboard/counter-card";
import { TimezoneCard } from "@/components/dashboard/timezone-card";
import { QuoteCard } from "@/components/dashboard/quote-card";
import { BirthdayCard } from "@/components/dashboard/birthday-card";
import { DistanceCard } from "@/components/dashboard/distance-card";
import { MoonPhaseCard } from "@/components/dashboard/moon-phase-card";
import { MoodCard } from "@/components/dashboard/mood-card";
import { MoodHistoryGrid } from "@/components/dashboard/mood-history-grid";
import { SafeWordHistory } from "@/components/dashboard/safeword-history";
import { Header } from "@/components/dashboard/header";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { getCurrentAuthor } from "@/app/actions/auth";
import { getTodayMoods } from "@/app/actions/mood";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import {
  useLocalNotifications,
  NOTIF_ID,
} from "@/hooks/use-local-notifications";
import { SafeWordCard } from "@/components/dashboard/safeword-card";
import { TodayStrip } from "@/components/dashboard/today-strip";
import { logger } from "@/lib/logger";

function DashboardSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-1 gap-4 md:grid-cols-12 md:gap-6">
      <div className="h-40 rounded-3xl bg-muted/20 md:col-span-12" />
      <div className="h-16 rounded-3xl bg-muted/20 md:col-span-12" />
      <div className="h-64 rounded-3xl bg-muted/20 md:col-span-8" />
      <div className="h-64 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-24 rounded-3xl bg-muted/20 md:col-span-12" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-6" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-6" />
      <div className="h-32 rounded-3xl bg-muted/20 md:col-span-12" />
    </div>
  );
}

export default function DashboardPage() {
  const [mounted, setMounted] = useState(false);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const { cancel, scheduleMoodNudge } = useLocalNotifications();

  usePresence("/", !!currentAuthor);

  const handleRefresh = useCallback(() => {
    setTimeout(() => setRefreshKey((k) => k + 1), 0);
  }, []);

  useRefreshListener(handleRefresh);

  // On mount and on every refresh: check if today's mood is already
  // logged. If it is, cancel the nudge notification for today — there's
  // no point reminding someone who already checked in. If it isn't,
  // ensure the nudge is scheduled (re-scheduling is idempotent).
  useEffect(() => {
    void (async () => {
      try {
        const moods = await getTodayMoods();
        if (moods.myMood !== null) {
          // Mood already logged — cancel today's nudge and reschedule
          // for tomorrow so the next-day nudge is always queued.
          await cancel([NOTIF_ID.MOOD_NUDGE]);
          await scheduleMoodNudge();
        } else {
          // Not yet logged — make sure the nudge is scheduled.
          await scheduleMoodNudge();
        }
      } catch (err) {
        logger.error("[dashboard] Mood nudge sync failed:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  useEffect(() => {
    getCurrentAuthor().then(setCurrentAuthor);
    setTimeout(() => {
      setMounted(true);
    }, 0);
  }, []);

  const isT7SEN = currentAuthor === "T7SEN";

  return (
    <div className="relative min-h-screen bg-background p-4 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/8 blur-[160px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[160px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl space-y-8 pb-28 md:pb-32">
        <Header author={currentAuthor} />

        {!mounted ? (
          <DashboardSkeleton />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:gap-6 md:items-stretch">
            {/* ── Row 1: Counter — full width, hero ── */}
            <div className="md:col-span-12">
              <CounterCard />
            </div>

            {/* ── Row 1.5: Today's attention strip ── */}
            <div className="md:col-span-12">
              <ErrorBoundary label="TodayStrip">
                <TodayStrip key={refreshKey} />
              </ErrorBoundary>
            </div>

            {/* ── Row 2: Mood (8 cols) + Birthday (4 cols) ── */}
            <div className="md:col-span-8 md:h-full">
              <ErrorBoundary label="MoodCard">
                <MoodCard key={refreshKey} currentAuthor={currentAuthor} />
              </ErrorBoundary>
            </div>
            <div className="md:col-span-4 md:h-full">
              <BirthdayCard />
            </div>

            {/* ── Row 3: Mood history — full width ── */}
            <div className="md:col-span-12">
              <ErrorBoundary label="MoodHistoryGrid">
                <MoodHistoryGrid
                  key={refreshKey}
                  currentAuthor={currentAuthor}
                />
              </ErrorBoundary>
            </div>

            {/* ── Row 4: Timezone | Weather | Moon ── */}
            <div className="md:col-span-4 md:h-full">
              <TimezoneCard />
            </div>
            <div className="md:col-span-4 md:h-full">
              <ErrorBoundary label="WeatherCard">
                <WeatherCard />
              </ErrorBoundary>
            </div>
            <div className="md:col-span-4 md:h-full">
              <MoonPhaseCard />
            </div>

            {/* ── Row 5: Distance | Quote ── */}
            <div className="md:col-span-6">
              <DistanceCard />
            </div>
            <div className="md:col-span-6">
              <ErrorBoundary label="QuoteCard">
                <QuoteCard />
              </ErrorBoundary>
            </div>

            {/* ── Row 6: Safe Word — bottom, rarely used ── */}
            <div className="md:col-span-12">
              <ErrorBoundary label="SafeWordCard">
                <SafeWordCard currentAuthor={currentAuthor} />
              </ErrorBoundary>
            </div>

            {/* ── Row 7: Safe Word History — T7SEN only ── */}
            {isT7SEN && (
              <div className="md:col-span-12">
                <ErrorBoundary label="SafeWordHistory">
                  <SafeWordHistory key={refreshKey} />
                </ErrorBoundary>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
