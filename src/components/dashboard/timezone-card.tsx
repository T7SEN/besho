"use client";

import { Clock, Sun, Moon, BedDouble } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { MY_TZ, PARTNER_TZ, MY_CITY, PARTNER_CITY } from "@/lib/constants";

export function TimezoneCard({ now }: { now: Date }) {
  const hourFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
  });
  const minuteFormatter = new Intl.DateTimeFormat("en-US", {
    minute: "2-digit",
  });
  const amPmFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
  });

  // ── My location ──
  const myDate = new Date(now.toLocaleString("en-US", { timeZone: MY_TZ }));
  const myHour24 = parseInt(hourFormatter.format(myDate));
  const myMinute = parseInt(minuteFormatter.format(myDate));
  const myAmPm = amPmFormatter.format(myDate).split(" ")[1];
  const myHour12 = myHour24 % 12 || 12;
  const myIsDay = myHour24 >= 6 && myHour24 < 18;
  const myIsAsleep = myHour24 >= 23 || myHour24 < 7;
  const myProgress = ((myHour24 * 60 + myMinute) / 1440) * 100;

  // ── Partner location ──
  const partnerDate = new Date(
    now.toLocaleString("en-US", { timeZone: PARTNER_TZ }),
  );
  const partnerHour24 = parseInt(hourFormatter.format(partnerDate));
  const partnerMinute = parseInt(minuteFormatter.format(partnerDate));
  const partnerAmPm = amPmFormatter.format(partnerDate).split(" ")[1];
  const partnerHour12 = partnerHour24 % 12 || 12;
  const partnerIsDay = partnerHour24 >= 6 && partnerHour24 < 18;
  const partnerIsAsleep = partnerHour24 >= 23 || partnerHour24 < 7;
  const partnerProgress = ((partnerHour24 * 60 + partnerMinute) / 1440) * 100;

  return (
    <div
      className={cn(
        "flex flex-col gap-8 rounded-3xl border border-white/5",
        "bg-card/40 p-8 backdrop-blur-xl shadow-xl shadow-black/20",
        "transition-colors hover:border-primary/20",
      )}
    >
      <div className="flex items-center justify-between">
        <h2
          className={cn(
            "text-xs font-bold uppercase tracking-[0.2em]",
            "text-muted-foreground",
          )}
        >
          Timezones
        </h2>
        <Clock className="h-4 w-4 text-muted-foreground/50" />
      </div>

      <div className="space-y-8">
        {/* My location */}
        <div className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                {MY_CITY}
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-foreground">
                  {myHour12}
                  <span className="inline-block -translate-y-0.5">:</span>
                  {myMinute.toString().padStart(2, "0")}
                </span>
                <span className="text-sm font-semibold text-muted-foreground">
                  {myAmPm}
                </span>
              </div>
              {myIsAsleep && (
                <p className="mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-400/60">
                  <BedDouble className="h-3 w-3" />
                  Probably sleeping
                </p>
              )}
            </div>
            <div className="rounded-full bg-background/50 p-2.5 shadow-inner">
              {myIsDay ? (
                <Sun className="h-5 w-5 text-yellow-500/90" />
              ) : (
                <Moon className="h-5 w-5 text-blue-400/90" />
              )}
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${myProgress}%` }}
              transition={{ duration: 1, ease: "easeOut" }}
              className={cn(
                "h-full rounded-full",
                myIsDay ? "bg-yellow-500/50" : "bg-blue-500/50",
              )}
            />
          </div>
        </div>

        <div className="h-px w-full bg-border/40" />

        {/* Partner location */}
        <div className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <p className="mb-1 text-xs font-bold uppercase tracking-wider text-primary/80">
                {PARTNER_CITY}
              </p>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold tracking-tight text-primary">
                  {partnerHour12}
                  <span className="inline-block -translate-y-0.5">:</span>
                  {partnerMinute.toString().padStart(2, "0")}
                </span>
                <span className="text-sm font-semibold text-primary/60">
                  {partnerAmPm}
                </span>
              </div>
              {partnerIsAsleep && (
                <p className="mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-blue-400/60">
                  <BedDouble className="h-3 w-3" />
                  Probably sleeping
                </p>
              )}
            </div>
            <div className="rounded-full bg-primary/10 p-2.5 shadow-inner">
              {partnerIsDay ? (
                <Sun className="h-5 w-5 text-yellow-500/90" />
              ) : (
                <Moon className="h-5 w-5 text-blue-400/90" />
              )}
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${partnerProgress}%` }}
              transition={{ duration: 1.2, ease: "easeOut" }}
              className={cn(
                "h-full rounded-full",
                partnerIsDay ? "bg-yellow-500/80" : "bg-blue-500/80",
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
