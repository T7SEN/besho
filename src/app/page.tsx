"use client";

import { useState, useEffect } from "react";
import {
  Heart,
  Clock,
  CalendarHeart,
  Sparkles,
  Stars,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { sendLovePing } from "./actions/dashboard";
import { cn } from "@/lib/utils";

const OUR_START_DATE = new Date("2026-02-08T00:00:00");
const MY_TIMEZONE = "Africa/Cairo";
const PARTNER_TIMEZONE = "Asia/Riyadh";

export default function Dashboard() {
  const [now, setNow] = useState(new Date());
  const [isPingSending, setIsPingSending] = useState(false);
  const [isDetailed, setIsDetailed] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleSendPing = async () => {
    setIsPingSending(true);
    await sendLovePing();
    setTimeout(() => setIsPingSending(false), 2000);
  };

  const toggleDetailed = () => setIsDetailed(!isDetailed);

  const getTimeTogether = () => {
    const diff = now.getTime() - OUR_START_DATE.getTime();

    const seconds = Math.floor((diff / 1000) % 60);
    const minutes = Math.floor((diff / (1000 * 60)) % 60);
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);

    const totalDays = Math.floor(diff / (1000 * 60 * 60 * 24));

    let tempDate = new Date(OUR_START_DATE);
    let months = 0;
    while (true) {
      const nextMonth = new Date(tempDate);
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      if (nextMonth > now) break;
      tempDate = nextMonth;
      months++;
    }

    const remainingDiff = now.getTime() - tempDate.getTime();
    const days = Math.floor(remainingDiff / (1000 * 60 * 60 * 24));
    const weeks = Math.floor(days / 7);
    const remainingDays = days % 7;

    return {
      totalDays,
      months,
      weeks,
      remainingDays,
      hours,
      minutes,
      seconds,
    };
  };

  const time = getTimeTogether();
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const partnerTime = timeFormatter.format(
    new Date(now.toLocaleString("en-US", { timeZone: PARTNER_TIMEZONE })),
  );

  return (
    <div className="min-h-screen bg-background pb-20 pt-8 px-4 sm:px-8 transition-colors duration-500">
      <main className="mx-auto max-w-2xl space-y-8">
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

        {/* The "Love Counter" Card */}
        <button
          onClick={toggleDetailed}
          className="w-full text-left relative overflow-hidden rounded-3xl bg-card border border-border p-8 shadow-sm transition-all hover:border-primary/50 group"
        >
          <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/5 blur-3xl" />

          <div className="relative z-10 flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-110">
              <Stars className="h-7 w-7" />
            </div>

            {!isDetailed ? (
              <div className="animate-in fade-in zoom-in-95 duration-700 ease-in-out">
                <h2 className="text-6xl font-bold tracking-tighter text-foreground">
                  {time.totalDays}
                </h2>
                <p className="mt-2 text-lg font-medium text-muted-foreground">
                  beautiful days together
                </p>
              </div>
            ) : (
              <div className="w-full space-y-6 animate-in fade-in slide-in-from-top-4 duration-700 ease-out">
                <div className="flex flex-col items-center space-y-5">
                  <TimeUnit label="Months" value={time.months} />
                  <TimeUnit label="Weeks" value={time.weeks} />
                  <TimeUnit label="Days" value={time.remainingDays} />
                  <TimeUnit label="Hours" value={time.hours} />
                  <TimeUnit label="Minutes" value={time.minutes} />
                  <TimeUnit
                    label="Seconds"
                    value={time.seconds}
                    color="text-primary"
                  />
                </div>
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary pt-4 opacity-80">
                  Since our story began
                </p>
              </div>
            )}

            <div className="mt-8 text-muted-foreground/30 transition-colors group-hover:text-primary/50">
              {isDetailed ? (
                <ChevronUp className="h-6 w-6" />
              ) : (
                <ChevronDown className="h-6 w-6" />
              )}
            </div>
          </div>
        </button>

        {/* Timezone and Ping Grid */}
        <section className="grid grid-cols-2 gap-4">
          <div className="flex flex-col justify-between rounded-2xl border border-border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2 text-muted-foreground mb-4">
              <Clock className="h-5 w-5" />
              <span className="text-sm font-medium">Timezones</span>
            </div>
            <div className="space-y-3">
              <div className="flex justify-between items-end">
                <span className="text-sm text-muted-foreground">You</span>
                <span className="text-lg font-semibold text-foreground">
                  {timeFormatter.format(
                    new Date(
                      now.toLocaleString("en-US", { timeZone: MY_TIMEZONE }),
                    ),
                  )}
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

          <button
            onClick={handleSendPing}
            disabled={isPingSending}
            className="group flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card p-5 shadow-sm transition-all hover:border-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-70"
          >
            <div
              className={cn(
                "rounded-full bg-accent/10 p-3 text-accent transition-transform",
                isPingSending ? "animate-ping" : "group-hover:scale-110",
              )}
            >
              <Sparkles className="h-8 w-8" />
            </div>
            <span className="text-sm font-medium text-foreground">
              {isPingSending ? "Sent!" : "Send a Ping"}
            </span>
          </button>
        </section>
      </main>
    </div>
  );
}

function TimeUnit({
  label,
  value,
  color = "text-foreground",
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <span
        className={cn(
          "text-3xl font-bold tracking-tighter leading-none",
          color,
        )}
      >
        {value}
      </span>
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mt-1">
        {label}
      </span>
    </div>
  );
}
