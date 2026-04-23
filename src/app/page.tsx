"use client";

import { useState, useEffect } from "react";
import { Heart, Plane, Clock, CalendarHeart, Sparkles } from "lucide-react";

// We will eventually move this to a database, but let's set a target date for now!
const NEXT_VISIT_DATE = new Date("2024-12-25T00:00:00");

// Replace these with your actual timezones
const MY_TIMEZONE = "America/New_York";
const PARTNER_TIMEZONE = "Europe/Paris";

export default function Dashboard() {
  const [now, setNow] = useState(new Date());
  const [isPingSending, setIsPingSending] = useState(false);

  // Update the clocks every minute
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Calculate countdown
  const timeDiff = NEXT_VISIT_DATE.getTime() - now.getTime();
  const daysUntil = Math.ceil(timeDiff / (1000 * 3600 * 24));

  // Time formatters
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const myTime = timeFormatter.format(
    new Date(now.toLocaleString("en-US", { timeZone: MY_TIMEZONE })),
  );
  const partnerTime = timeFormatter.format(
    new Date(now.toLocaleString("en-US", { timeZone: PARTNER_TIMEZONE })),
  );

  const handleSendPing = () => {
    setIsPingSending(true);
    // We will implement the actual WebSocket/Server Action later
    setTimeout(() => setIsPingSending(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background pb-20 pt-8 px-4 sm:px-8 transition-colors duration-500">
      <main className="mx-auto max-w-2xl space-y-8">
        {/* Header Greeting */}
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Our Space
            </h1>
            <p className="text-muted-foreground mt-1">
              It is {partnerTime} for them right now.
            </p>
          </div>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Heart className="h-6 w-6" fill="currentColor" />
          </div>
        </header>

        {/* The Countdown Card */}
        <section className="relative overflow-hidden rounded-3xl bg-card border border-border p-8 shadow-sm">
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/5 blur-3xl" />
          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Plane className="h-7 w-7" />
            </div>
            <h2 className="text-5xl font-bold tracking-tight text-foreground">
              {daysUntil > 0 ? daysUntil : 0}
            </h2>
            <p className="mt-2 text-lg font-medium text-muted-foreground">
              days until we meet again
            </p>
          </div>
        </section>

        {/* Interactive Grid */}
        <section className="grid grid-cols-2 gap-4">
          {/* Dual Clocks */}
          <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2 text-muted-foreground mb-4">
              <Clock className="h-5 w-5" />
              <span className="text-sm font-medium">Timezones</span>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-end">
                <span className="text-sm text-muted-foreground">You</span>
                <span className="text-lg font-semibold text-foreground">
                  {myTime}
                </span>
              </div>
              <div className="h-px w-full bg-border" />
              <div className="flex justify-between items-end">
                <span className="text-sm text-muted-foreground">Them</span>
                <span className="text-lg font-semibold text-primary">
                  {partnerTime}
                </span>
              </div>
            </div>
          </div>

          {/* The 'Thinking of You' Action */}
          <button
            onClick={handleSendPing}
            disabled={isPingSending}
            className="group flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm transition-all hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70 disabled:cursor-not-allowed"
          >
            <div
              className={`rounded-full bg-accent/10 p-3 text-accent transition-transform ${isPingSending ? "animate-ping" : "group-hover:scale-110"}`}
            >
              <Sparkles className="h-8 w-8" />
            </div>
            <span className="text-sm font-medium text-foreground">
              {isPingSending ? "Sending love..." : "Send a Ping"}
            </span>
          </button>
        </section>

        {/* Quick Links / Future Features */}
        <section className="rounded-2xl border border-border bg-card shadow-sm">
          <button className="flex w-full items-center justify-between p-5 hover:bg-muted/50 transition-colors rounded-2xl">
            <div className="flex items-center gap-4">
              <div className="rounded-lg bg-secondary p-2 text-secondary-foreground">
                <CalendarHeart className="h-5 w-5" />
              </div>
              <div className="text-left">
                <h3 className="font-medium text-foreground">Our Timeline</h3>
                <p className="text-sm text-muted-foreground">
                  Look back at our memories
                </p>
              </div>
            </div>
            <span className="text-muted-foreground">&rarr;</span>
          </button>
        </section>
      </main>
    </div>
  );
}
