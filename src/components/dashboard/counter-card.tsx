"use client";

import { useState } from "react";
import { Heart } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { START_DATE } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";

type TimeUnitKey = "years" | "months" | "days" | "hours" | "mins" | "secs";

export function CounterCard({ now }: { now: Date }) {
  const [activeUnit, setActiveUnit] = useState<TimeUnitKey>("days");

  const diff = now.getTime() - START_DATE.getTime();

  const totalSeconds = Math.floor(diff / 1000);
  const totalMinutes = Math.floor(diff / (1000 * 60));
  const totalHours = Math.floor(diff / (1000 * 60 * 60));
  const totalDays = Math.floor(diff / (1000 * 60 * 60 * 24));

  let tempDateTotalMonths = new Date(START_DATE);
  let totalMonths = 0;
  while (true) {
    const nextMonth = new Date(tempDateTotalMonths);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    if (nextMonth > now) break;
    tempDateTotalMonths = nextMonth;
    totalMonths++;
  }

  let tempDateTotalYears = new Date(START_DATE);
  let totalYears = 0;
  while (true) {
    const nextYear = new Date(tempDateTotalYears);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    if (nextYear > now) break;
    tempDateTotalYears = nextYear;
    totalYears++;
  }

  const seconds = Math.floor((diff / 1000) % 60);
  const minutes = Math.floor((diff / (1000 * 60)) % 60);
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);

  let tempDateBreakdown = new Date(START_DATE);

  let breakdownYears = 0;
  while (true) {
    const nextYear = new Date(tempDateBreakdown);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    if (nextYear > now) break;
    tempDateBreakdown = nextYear;
    breakdownYears++;
  }

  let breakdownMonths = 0;
  while (true) {
    const nextMonth = new Date(tempDateBreakdown);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    if (nextMonth > now) break;
    tempDateBreakdown = nextMonth;
    breakdownMonths++;
  }

  const remainingDiff = now.getTime() - tempDateBreakdown.getTime();
  const breakdownDays = Math.floor(remainingDiff / (1000 * 60 * 60 * 24));

  const activeValueMap: Record<TimeUnitKey, number> = {
    years: totalYears,
    months: totalMonths,
    days: totalDays,
    hours: totalHours,
    mins: totalMinutes,
    secs: totalSeconds,
  };

  const activeLabelMap: Record<TimeUnitKey, string> = {
    years: "years",
    months: "months",
    days: "days",
    hours: "hours",
    mins: "minutes",
    secs: "seconds",
  };

  const formattedHeroValue = new Intl.NumberFormat("en-US").format(
    activeValueMap[activeUnit],
  );

  const handleUnitChange = (unit: TimeUnitKey) => {
    void vibrate(50, "medium");
    setActiveUnit(unit);
  };

  return (
    <div
      className={cn(
        "relative flex w-full flex-col justify-between overflow-hidden",
        "rounded-[2.5rem] border border-white/5 bg-card/40 p-10",
        "backdrop-blur-xl shadow-2xl shadow-black/40 transition-colors",
        "hover:border-primary/20",
      )}
    >
      <div className="absolute -right-20 -top-20 h-72 w-72">
        <div className="h-full w-full rounded-full bg-primary/10 blur-3xl" />
      </div>

      <div className="relative z-10 mb-16">
        <div className="mb-6 flex items-center gap-3">
          <Heart className="h-5 w-5 text-primary" fill="currentColor" />
          <h2
            className={cn(
              "text-sm font-bold uppercase tracking-[0.25em]",
              "text-muted-foreground",
            )}
          >
            Total Time Together
          </h2>
        </div>

        <div className="flex h-24 items-baseline gap-4 md:h-32">
          <AnimatePresence mode="popLayout">
            <motion.span
              key={activeUnit}
              initial={{ y: 20, opacity: 0, filter: "blur(4px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: -20, opacity: 0, filter: "blur(4px)" }}
              transition={{ type: "spring", bounce: 0, duration: 0.4 }}
              className={cn(
                "inline-block text-7xl font-black tracking-tighter md:text-8xl",
                (activeUnit === "secs" || activeUnit === "mins") &&
                  "text-5xl md:text-7xl",
              )}
            >
              {formattedHeroValue}
            </motion.span>
          </AnimatePresence>
          <AnimatePresence mode="popLayout">
            <motion.span
              key={`${activeUnit}-label`}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ type: "spring", bounce: 0, duration: 0.4 }}
              className="inline-block text-xl font-medium text-muted-foreground md:text-2xl"
            >
              {activeLabelMap[activeUnit]}
            </motion.span>
          </AnimatePresence>
        </div>

        <p className="mt-2 text-xs font-medium text-muted-foreground/30">
          Since{" "}
          {new Intl.DateTimeFormat("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
          }).format(START_DATE)}
        </p>
      </div>

      <div
        className={cn(
          "relative z-10 grid grid-cols-3 gap-2 gap-y-8",
          "md:grid-cols-6 md:gap-4",
        )}
      >
        <TimeUnit
          label="Years"
          value={breakdownYears}
          isActive={activeUnit === "years"}
          onClick={() => handleUnitChange("years")}
        />
        <TimeUnit
          label="Months"
          value={breakdownMonths}
          isActive={activeUnit === "months"}
          onClick={() => handleUnitChange("months")}
        />
        <TimeUnit
          label="Days"
          value={breakdownDays}
          isActive={activeUnit === "days"}
          onClick={() => handleUnitChange("days")}
        />
        <TimeUnit
          label="Hours"
          value={hours}
          isActive={activeUnit === "hours"}
          onClick={() => handleUnitChange("hours")}
        />
        <TimeUnit
          label="Mins"
          value={minutes}
          isActive={activeUnit === "mins"}
          onClick={() => handleUnitChange("mins")}
        />
        <TimeUnit
          label="Secs"
          value={seconds}
          color="text-primary"
          isActive={activeUnit === "secs"}
          onClick={() => handleUnitChange("secs")}
        />
      </div>
    </div>
  );
}

function TimeUnit({
  label,
  value,
  color = "text-foreground",
  isActive,
  onClick,
}: {
  label: string;
  value: number;
  color?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex w-full flex-col items-center justify-center",
        "rounded-xl py-3 transition-all duration-300 focus-visible:outline-none",
        isActive ? "opacity-100" : "opacity-50 hover:opacity-100",
        !isActive && "hover:-translate-y-1",
      )}
    >
      {isActive && (
        <motion.div
          layoutId="active-indicator"
          className="absolute inset-0 rounded-xl bg-primary/10"
          transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
        />
      )}
      <span
        className={cn("relative z-10 text-3xl font-bold tracking-tight", color)}
      >
        {value}
      </span>
      <span
        className={cn(
          "relative z-10 mt-1 text-[10px] font-bold uppercase tracking-[0.2em] transition-colors",
          isActive ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </button>
  );
}
