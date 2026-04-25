/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect } from "react";
import { motion, type Variants } from "motion/react";
import { cn } from "@/lib/utils";
import { Header } from "@/components/dashboard/header";
import { CounterCard } from "@/components/dashboard/counter-card";
import { WeatherCard } from "@/components/dashboard/weather-card";
import { QuoteCard } from "@/components/dashboard/quote-card";
import { TimezoneCard } from "@/components/dashboard/timezone-card";
import { DistanceCard } from "@/components/dashboard/distance-card";
import { BirthdayCard } from "@/components/dashboard/birthday-card";

// 1. Explicitly type the orchestration timing
const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.05,
    },
  } as any,
};

// 2. Explicitly type the spring physics
const itemVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 40,
    filter: "blur(8px)",
  },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: {
      type: "spring",
      bounce: 0,
      duration: 0.8,
    },
  } as any,
};

export default function Dashboard() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    const timeoutId = setTimeout(tick, 0);
    const intervalId = setInterval(tick, 1000);

    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, []);

  if (!now) {
    return <SkeletonLoader />;
  }

  return (
    <div
      className={cn(
        "relative min-h-screen bg-background p-6 md:p-12",
        "overflow-hidden selection:bg-primary/30",
      )}
    >
      {/* Ambient Background Glows */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "absolute left-[-10%] top-0 h-150 w-150",
            "rounded-full bg-primary/10 blur-[150px]",
          )}
        />
        <div
          className={cn(
            "absolute right-[-10%] bottom-0 h-150 w-150",
            "rounded-full bg-blue-500/5 blur-[150px]",
          )}
        />
      </div>

      {/* Wrap the main layout in a motion container to trigger 
			  the staggered children effects automatically.
			*/}
      <motion.main
        variants={containerVariants}
        initial="hidden"
        animate="show"
        className="relative z-10 mx-auto max-w-6xl space-y-10 pt-4 pb-24"
      >
        <motion.div variants={itemVariants}>
          <Header now={now} />
        </motion.div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
          {/* Main Hero Section - 8 columns */}
          <div className="flex flex-col gap-6 lg:col-span-8 lg:gap-8">
            <motion.div variants={itemVariants} className="h-full">
              <CounterCard now={now} />
            </motion.div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:gap-8">
              <motion.div variants={itemVariants} className="h-full">
                <WeatherCard />
              </motion.div>
              <motion.div variants={itemVariants} className="h-full">
                <QuoteCard />
              </motion.div>
            </div>
          </div>

          {/* Sidebar Layout - 4 columns */}
          <div className="flex flex-col gap-6 lg:col-span-4 lg:gap-8">
            <motion.div variants={itemVariants} className="h-full">
              <TimezoneCard now={now} />
            </motion.div>

            {/* Added the new BirthdayCard here */}
            <motion.div variants={itemVariants} className="h-full">
              <BirthdayCard now={now} />
            </motion.div>

            <motion.div variants={itemVariants} className="h-full">
              <DistanceCard />
            </motion.div>
          </div>
        </div>
      </motion.main>
    </div>
  );
}

function SkeletonLoader() {
  return (
    <div className="min-h-screen bg-background p-6 md:p-12">
      <div className="mx-auto max-w-6xl space-y-10 pt-4 pb-24 animate-pulse">
        <div className="h-20 w-64 rounded-xl bg-card/50" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:gap-8">
          <div className="flex flex-col gap-6 lg:col-span-8 lg:gap-8">
            <div className="h-100 rounded-[2.5rem] bg-card/50" />
            <div className="grid grid-cols-2 gap-6 lg:gap-8">
              <div className="h-48 rounded-3xl bg-card/50" />
              <div className="h-48 rounded-3xl bg-card/50" />
            </div>
          </div>
          <div className="flex flex-col gap-6 lg:col-span-4 lg:gap-8">
            <div className="h-64 rounded-3xl bg-card/50" />
            <div className="h-48 rounded-3xl bg-card/50" />
          </div>
        </div>
      </div>
    </div>
  );
}
