"use client";

import { Plane, CalendarCheck, HeartHandshake } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { NEXT_VISIT_DATE } from "@/lib/constants";

interface NextVisitCardProps {
  now: Date;
}

export function NextVisitCard({ now }: NextVisitCardProps) {
  // ── No date set ──
  if (!NEXT_VISIT_DATE) {
    return (
      <div
        className={cn(
          "flex flex-col justify-between overflow-hidden",
          "rounded-3xl border border-white/5 bg-card/40 p-8",
          "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
          "hover:border-primary/20",
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Next Visit
          </h2>
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <Plane className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-6">
          <p className="text-2xl font-bold tracking-tight text-foreground/40">
            No date yet
          </p>
          <p className="mt-1 text-sm text-muted-foreground/50">
            Update NEXT_VISIT_DATE in constants.ts
          </p>
        </div>
      </div>
    );
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const visitDay = new Date(
    NEXT_VISIT_DATE.getFullYear(),
    NEXT_VISIT_DATE.getMonth(),
    NEXT_VISIT_DATE.getDate(),
  );

  const diffMs = visitDay.getTime() - today.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  const formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(NEXT_VISIT_DATE);

  // ── Visit is today ──
  if (diffDays === 0) {
    return (
      <div
        className={cn(
          "flex flex-col justify-between overflow-hidden",
          "rounded-3xl border border-primary/30 bg-primary/5 p-8",
          "backdrop-blur-xl shadow-xl shadow-primary/10",
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-primary/80">
            Next Visit
          </h2>
          <div className="rounded-full bg-primary/20 p-2 text-primary">
            <HeartHandshake className="h-4 w-4" />
          </div>
        </div>
        <motion.div
          className="mt-6"
          animate={{ scale: [1, 1.02, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          <p className="text-3xl font-black tracking-tighter text-primary">
            Today! 🎉
          </p>
          <p className="mt-1 text-sm font-semibold text-primary/70">
            {formattedDate}
          </p>
        </motion.div>
      </div>
    );
  }

  // ── Visit has passed ──
  if (diffDays < 0) {
    return (
      <div
        className={cn(
          "flex flex-col justify-between overflow-hidden",
          "rounded-3xl border border-white/5 bg-card/40 p-8",
          "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
          "hover:border-primary/20",
        )}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Next Visit
          </h2>
          <div className="rounded-full bg-primary/10 p-2 text-primary">
            <CalendarCheck className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-6">
          <p className="text-2xl font-bold tracking-tight text-muted-foreground">
            {Math.abs(diffDays)}d ago
          </p>
          <p className="mt-1 text-sm text-muted-foreground/50">
            {formattedDate} · Update the date
          </p>
        </div>
      </div>
    );
  }

  // ── Upcoming visit ──
  return (
    <div
      className={cn(
        "flex flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
        "hover:border-primary/20",
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Next Visit
        </h2>
        <div className="rounded-full bg-primary/10 p-2 text-primary">
          <Plane className="h-4 w-4 -rotate-45" />
        </div>
      </div>

      <div className="mt-6">
        <div className="flex items-baseline gap-2">
          <motion.span
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-6xl font-black tracking-tighter text-primary"
          >
            {diffDays}
          </motion.span>
          <span className="text-xl font-bold text-muted-foreground">
            {diffDays === 1 ? "day" : "days"}
          </span>
        </div>
        <p className="mt-1 text-sm font-semibold text-muted-foreground/60">
          {formattedDate}
        </p>
      </div>

      {/* Progress bar — shows how close the visit is (relative to today vs 90d) */}
      <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-black/20">
        <motion.div
          initial={{ width: 0 }}
          animate={{
            width: `${Math.max(5, 100 - (diffDays / 90) * 100)}%`,
          }}
          transition={{ duration: 1, ease: "easeOut" }}
          className="h-full rounded-full bg-primary/60"
        />
      </div>
    </div>
  );
}
