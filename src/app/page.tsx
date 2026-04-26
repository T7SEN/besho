"use client";

import { useEffect, useState } from "react";
import { WeatherCard } from "@/components/dashboard/weather-card";
import { CounterCard } from "@/components/dashboard/counter-card";
import { TimezoneCard } from "@/components/dashboard/timezone-card";
import { QuoteCard } from "@/components/dashboard/quote-card";
import { BirthdayCard } from "@/components/dashboard/birthday-card";
import { DistanceCard } from "@/components/dashboard/distance-card";
import { NotebookCard } from "@/components/dashboard/notebook-card";
import { NextVisitCard } from "@/components/dashboard/next-visit-card";
import { MoonPhaseCard } from "@/components/dashboard/moon-phase-card";
import { MoodCard } from "@/components/dashboard/mood-card";
import { Header } from "@/components/dashboard/header";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { getCurrentAuthor } from "@/app/actions/auth";
import { usePresence } from "@/hooks/use-presence";
import { SafeWordCard } from "@/components/dashboard/safeword-card";

function DashboardSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-1 gap-6 md:grid-cols-12">
      <div className="h-72 rounded-3xl bg-muted/20 md:col-span-12" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-6" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-6" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-48 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-64 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-64 rounded-3xl bg-muted/20 md:col-span-4" />
      <div className="h-64 rounded-3xl bg-muted/20 md:col-span-4" />
    </div>
  );
}

export default function DashboardPage() {
  const [now, setNow] = useState<Date | null>(null);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);

  // Handle presence tracking
  usePresence("/dashboard", !!currentAuthor);

  useEffect(() => {
    getCurrentAuthor().then(setCurrentAuthor);
    setTimeout(() => {
      setNow(new Date());
    }, 0);
    const interval = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/8 blur-[160px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[160px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-6xl space-y-8 pb-32">
        <Header now={now ?? new Date()} author={currentAuthor} />

        {!now ? (
          <DashboardSkeleton />
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
            {/* Counter — full width */}
            <div className="md:col-span-12">
              <CounterCard now={now} />
            </div>

            {/* Weather | Quote */}
            <div className="md:col-span-6">
              <ErrorBoundary label="WeatherCard">
                <WeatherCard />
              </ErrorBoundary>
            </div>
            <div className="md:col-span-6">
              <ErrorBoundary label="QuoteCard">
                <QuoteCard />
              </ErrorBoundary>
            </div>

            {/* Notebook | Distance | Next Visit */}
            <div className="md:col-span-4">
              <NotebookCard />
            </div>
            <div className="md:col-span-4">
              <DistanceCard />
            </div>
            <div className="md:col-span-4">
              <NextVisitCard now={now} />
            </div>

            {/* Timezone | Birthday | Moon */}
            <div className="md:col-span-4">
              <TimezoneCard now={now} />
            </div>
            <div className="md:col-span-4">
              <BirthdayCard now={now} />
            </div>
            <div className="md:col-span-4">
              <MoonPhaseCard now={now} />
            </div>

            {/* Mood check-in — full width on mobile, 6 cols on desktop */}
            <div className="md:col-span-6">
              <MoodCard currentAuthor={currentAuthor} />
            </div>
            {/* Safe Word - full width on mobile, 6 cols on desktop  */}
            <div className="md:col-span-6">
              <SafeWordCard currentAuthor={currentAuthor} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
