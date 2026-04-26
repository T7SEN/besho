"use client";

import { motion } from "motion/react";
import { Cake, CalendarHeart, Gift } from "lucide-react";
import { cn } from "@/lib/utils";
import { BIRTHDAYS } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function BirthdayCard({ now }: { now: Date }) {
  const calculateDaysLeft = (month: number, day: number) => {
    const currentYear = now.getFullYear();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nextBirthday = new Date(currentYear, month - 1, day);
    if (nextBirthday < today) nextBirthday.setFullYear(currentYear + 1);
    const diffTime = nextBirthday.getTime() - today.getTime();
    return Math.round(diffTime / (1000 * 60 * 60 * 24));
  };

  const myDaysLeft = calculateDaysLeft(BIRTHDAYS.me.month, BIRTHDAYS.me.day);
  const partnerDaysLeft = calculateDaysLeft(
    BIRTHDAYS.partner.month,
    BIRTHDAYS.partner.day,
  );

  const renderPerson = (
    label: string,
    daysLeft: number,
    isPartner: boolean,
    month: number,
    day: number,
    year: number,
  ) => {
    const isToday = daysLeft === 0;
    const monthName = MONTH_NAMES[month - 1];
    const monthDay = `${monthName} ${day}`;
    const fullDate = `${monthName} ${day}, ${year}`;

    return (
      <div className="flex flex-col">
        <p
          className={cn(
            "mb-4 text-xs font-bold uppercase tracking-wider",
            isPartner ? "text-primary/80" : "text-muted-foreground",
          )}
        >
          {label}
        </p>
        <div
          className="flex cursor-default items-start gap-4"
          onClick={() => isToday && vibrate([10, 50, 10])}
        >
          <motion.div
            className="mt-1"
            animate={isToday ? { y: [-2, 2, -2], rotate: [-5, 5, -5] } : {}}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          >
            {isToday ? (
              <Cake
                className={cn(
                  "h-8 w-8",
                  isPartner ? "text-primary" : "text-foreground",
                )}
              />
            ) : (
              <Gift
                className={cn(
                  "h-8 w-8",
                  isPartner ? "text-primary/60" : "text-muted-foreground/60",
                )}
              />
            )}
          </motion.div>

          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "text-3xl font-bold tracking-tighter",
                  isPartner && "text-primary",
                )}
              >
                {isToday ? "Today!" : daysLeft}
              </span>
              {!isToday && (
                <span className="text-sm font-medium text-muted-foreground">
                  days
                </span>
              )}
            </div>

            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "mt-1 cursor-help text-xs font-semibold transition-colors",
                      isPartner
                        ? "text-primary/70 hover:text-primary"
                        : "text-foreground/70 hover:text-foreground",
                    )}
                  >
                    {monthDay}
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="border-white/10 bg-black/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white shadow-xl backdrop-blur-md"
                >
                  Born in {fullDate}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className={cn(
        "relative flex h-full flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
        "hover:border-primary/20",
      )}
    >
      <div className="relative z-10 flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Upcoming Birthdays
        </h2>
        <div className="rounded-full bg-primary/10 p-2 text-primary">
          <CalendarHeart className="h-4 w-4" />
        </div>
      </div>

      <div className="relative z-10 mt-8 grid grid-cols-2 gap-6 divide-x divide-border/40">
        <div className="pr-6">
          {renderPerson(
            BIRTHDAYS.me.label,
            myDaysLeft,
            false,
            BIRTHDAYS.me.month,
            BIRTHDAYS.me.day,
            BIRTHDAYS.me.year,
          )}
        </div>
        <div className="pl-6">
          {renderPerson(
            BIRTHDAYS.partner.label,
            partnerDaysLeft,
            true,
            BIRTHDAYS.partner.month,
            BIRTHDAYS.partner.day,
            BIRTHDAYS.partner.year,
          )}
        </div>
      </div>
    </div>
  );
}
