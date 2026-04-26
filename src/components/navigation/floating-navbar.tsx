"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Home, BookHeart, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { name: "Home", href: "/", icon: Home },
  { name: "Notes", href: "/notes", icon: BookHeart },
  { name: "Timeline", href: "/timeline", icon: CalendarClock },
];

export function FloatingNavbar() {
  const pathname = usePathname();

  return (
    <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
      <nav className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-3 py-2 backdrop-blur-xl shadow-2xl shadow-black/50">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex items-center justify-center rounded-full px-4 py-2.5 text-sm font-medium transition-colors outline-none",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="navbar-active-indicator"
                  className="absolute inset-0 rounded-full bg-primary/15"
                  transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2">
                <Icon className="h-4 w-4" />
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
