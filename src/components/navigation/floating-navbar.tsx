// src/components/navigation/floating-navbar.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  Home,
  BookHeart,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Hand,
  ScrollText,
  Sparkles,
  Award,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavBadges } from "@/hooks/use-nav-badges";

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  badgeKey?: keyof ReturnType<typeof useNavBadges>;
}

const NAV_ITEMS: NavItem[] = [
  { name: "Home", href: "/", icon: Home },
  { name: "Notes", href: "/notes", icon: BookHeart },
  { name: "Timeline", href: "/timeline", icon: CalendarClock },
  {
    name: "Tasks",
    href: "/tasks",
    icon: CheckSquare,
    badgeKey: "pendingTasks",
  },
  {
    name: "Permissions",
    href: "/permissions",
    icon: Hand,
    badgeKey: "pendingPermissions",
  },
  {
    name: "Rules",
    href: "/rules",
    icon: ScrollText,
    badgeKey: "unacknowledgedRules",
  },
  {
    name: "Rituals",
    href: "/rituals",
    icon: Sparkles,
    badgeKey: "openRituals",
  },
  { name: "Ledger", href: "/ledger", icon: Award },
  { name: "Protocol", href: "/protocol", icon: BookOpen },
];

export function FloatingNavbar() {
  const pathname = usePathname();
  const badges = useNavBadges();

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <nav className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-3 py-2 backdrop-blur-xl shadow-2xl shadow-black/50">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
          const hasBadge = badgeCount > 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center justify-center rounded-full",
                "px-4 py-2.5 text-sm font-medium transition-colors outline-none",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="navbar-active-indicator"
                  className="absolute inset-0 rounded-full bg-primary/15"
                  transition={{
                    type: "spring",
                    bounce: 0.2,
                    duration: 0.6,
                  }}
                />
              )}

              <span className="relative z-10 flex items-center gap-2">
                {/* Icon with badge dot */}
                <span className="relative">
                  <Icon className="h-4 w-4" />
                  <AnimatePresence>
                    {hasBadge && !isActive && (
                      <motion.span
                        key="badge"
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0, opacity: 0 }}
                        transition={{
                          type: "spring",
                          bounce: 0.5,
                          duration: 0.4,
                        }}
                        className={cn(
                          "absolute -right-1 -top-1 flex h-2 w-2",
                          "items-center justify-center rounded-full",
                          "bg-destructive shadow-[0_0_6px_hsl(var(--destructive)/0.8)]",
                        )}
                        aria-label={`${badgeCount} unread`}
                      />
                    )}
                  </AnimatePresence>
                </span>

                {isActive && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    className="overflow-hidden whitespace-nowrap text-[10px] font-bold uppercase tracking-widest"
                  >
                    {item.name}
                  </motion.span>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
