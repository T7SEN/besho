"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  CheckSquare,
  Hand,
  ScrollText,
  SmilePlus,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useNavBadges } from "@/hooks/use-nav-badges";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { getTodayMoods } from "@/app/actions/mood";
import { logger } from "@/lib/logger";

interface ChipDef {
  label: string;
  icon: React.ElementType;
  href: string | null;
  pending: boolean;
  count?: number;
}

export function TodayStrip() {
  const badges = useNavBadges();
  const [moodLogged, setMoodLogged] = useState<boolean | null>(null);

  const refreshMood = useCallback(() => {
    void getTodayMoods()
      .then((d) => setMoodLogged(d.myMood !== null))
      .catch((err) => logger.error("[today-strip] mood fetch failed:", err));
  }, []);

  useEffect(() => {
    setTimeout(refreshMood, 0);
  }, [refreshMood]);

  useRefreshListener(refreshMood);

  const chips: ChipDef[] = [
    {
      label: "Tasks",
      icon: CheckSquare,
      href: "/tasks",
      pending: badges.pendingTasks > 0,
      count: badges.pendingTasks,
    },
    {
      label: "Rules",
      icon: ScrollText,
      href: "/rules",
      pending: badges.unacknowledgedRules > 0,
      count: badges.unacknowledgedRules,
    },
    {
      label: "Permits",
      icon: Hand,
      href: "/permissions",
      pending: badges.pendingPermissions > 0,
      count: badges.pendingPermissions,
    },
    {
      label: "Rituals",
      icon: Sparkles,
      href: "/rituals",
      pending: badges.openRituals > 0,
      count: badges.openRituals,
    },
    {
      label: "Mood",
      icon: SmilePlus,
      href: null,
      pending: moodLogged === false,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className={cn(
        "rounded-3xl border border-white/5 bg-card/30 p-3 backdrop-blur-md",
        "shadow-xl shadow-black/20",
      )}
    >
      <div className="grid grid-cols-5 gap-1.5">
        {chips.map((chip) => (
          <Chip key={chip.label} {...chip} />
        ))}
      </div>
    </motion.div>
  );
}

function Chip({ label, icon: Icon, href, pending, count }: ChipDef) {
  const body = (
    <>
      <span className="relative">
        <Icon className="h-4 w-4" />
        <AnimatePresence>
          {pending && typeof count === "number" && count > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", bounce: 0.5, duration: 0.4 }}
              className={cn(
                "absolute -right-2 -top-2 flex h-3.5 min-w-3.5 items-center justify-center",
                "rounded-full bg-destructive px-1 text-[9px] font-black text-white",
                "shadow-[0_0_6px_hsl(var(--destructive)/0.8)]",
              )}
              aria-label={`${count} pending`}
            >
              {count > 9 ? "9+" : count}
            </motion.span>
          )}
          {pending && typeof count !== "number" && (
            <motion.span
              key="dot"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", bounce: 0.5, duration: 0.4 }}
              className={cn(
                "absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive",
                "shadow-[0_0_6px_hsl(var(--destructive)/0.8)]",
              )}
              aria-label="needs attention"
            />
          )}
        </AnimatePresence>
      </span>
      <span className="text-[9px] font-bold uppercase tracking-widest">
        {label}
      </span>
    </>
  );

  const baseClasses = cn(
    "relative flex flex-col items-center gap-1.5 rounded-2xl px-2 py-2.5",
    "transition-colors outline-none",
    pending
      ? "text-primary"
      : "text-muted-foreground/40",
  );

  if (href === null) {
    return <div className={baseClasses}>{body}</div>;
  }

  return (
    <Link
      href={href}
      onClick={() => void vibrate(20, "light")}
      className={cn(
        baseClasses,
        "active:scale-[0.95]",
        pending ? "hover:bg-primary/10" : "hover:text-muted-foreground",
      )}
    >
      {body}
    </Link>
  );
}
