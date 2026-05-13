// src/components/navigation/floating-navbar.tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { Dialog as SheetPrimitive } from "radix-ui";
import {
  Home,
  BookHeart,
  BookOpen,
  CalendarClock,
  CheckSquare,
  Gamepad2,
  Gift,
  Hand,
  ScrollText,
  Shield,
  Sparkles,
  Award,
  MessageSquareQuote,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useNavBadges } from "@/hooks/use-nav-badges";
import { getCurrentAuthor } from "@/app/actions/auth";
import {
  Sheet,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";

const DRAG_DISMISS_OFFSET_PX = 100;
const DRAG_DISMISS_VELOCITY = 500;

interface NavItem {
  name: string;
  href: string;
  icon: React.ElementType;
  badgeKey?: keyof ReturnType<typeof useNavBadges>;
}

/** Active when the pathname matches the item's href exactly OR is a
 *  sub-route of it (e.g. `/admin/directive` activates the `/admin`
 *  item). The `/` home item special-cases to exact-match only — every
 *  path technically begins with `/`, but Home should not light up on
 *  every route. */
function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  if (pathname === item.href) return true;
  return pathname.startsWith(item.href + "/");
}

const PRIMARY_ITEMS: NavItem[] = [
  { name: "Home", href: "/", icon: Home },
  { name: "Notes", href: "/notes", icon: BookHeart },
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
    name: "Rituals",
    href: "/rituals",
    icon: Sparkles,
    badgeKey: "openRituals",
  },
];

const MORE_ITEMS: NavItem[] = [
  {
    name: "Rules",
    href: "/rules",
    icon: ScrollText,
    badgeKey: "unacknowledgedRules",
  },
  { name: "Timeline", href: "/timeline", icon: CalendarClock },
  { name: "Ledger", href: "/ledger", icon: Award },
  { name: "Rewards", href: "/rewards", icon: Gift },
  { name: "Review", href: "/review", icon: MessageSquareQuote },
  { name: "Games", href: "/games", icon: Gamepad2 },
  { name: "Protocol", href: "/protocol", icon: BookOpen },
];

const ADMIN_ITEM: NavItem = { name: "Admin", href: "/admin", icon: Shield };

export function FloatingNavbar() {
  const pathname = usePathname();
  const badges = useNavBadges();
  const [moreOpen, setMoreOpen] = useState(false);
  const [isT7SEN, setIsT7SEN] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const author = await getCurrentAuthor();
        if (!cancelled) setIsT7SEN(author === "T7SEN");
      } catch {
        // unauth or transient — leave hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const moreItems = useMemo(
    () => (isT7SEN ? [...MORE_ITEMS, ADMIN_ITEM] : MORE_ITEMS),
    [isT7SEN],
  );

  const activeMoreItem =
    moreItems.find((item) => isNavItemActive(item, pathname)) ?? null;
  const moreActive = activeMoreItem !== null;
  const moreBadgeCount = moreItems.reduce(
    (sum, item) => sum + (item.badgeKey ? badges[item.badgeKey] : 0),
    0,
  );
  const moreHasBadge = moreBadgeCount > 0;

  return (
    <>
      <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <nav className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-3 py-2 backdrop-blur-md shadow-xl shadow-black/40">
          {PRIMARY_ITEMS.map((item) => {
            const isActive = isNavItemActive(item, pathname);
            const Icon = item.icon;
            const badgeCount = item.badgeKey ? badges[item.badgeKey] : 0;
            const hasBadge = badgeCount > 0;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => void vibrate(30, "light")}
                className={cn(
                  "relative flex items-center justify-center rounded-full",
                  "px-4 py-2.5 text-sm font-medium transition-colors outline-none",
                  "active:scale-[0.95]",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="navbar-active-indicator"
                    className="absolute inset-0 rounded-full bg-primary/15 will-change-transform"
                    transition={{
                      type: "spring",
                      bounce: 0.2,
                      duration: 0.6,
                    }}
                  />
                )}

                <span className="relative z-10 flex items-center gap-2">
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

          <button
            type="button"
            onClick={() => {
              void vibrate(30, "light");
              setMoreOpen(true);
            }}
            aria-label="More destinations"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={cn(
              "relative flex items-center justify-center rounded-full",
              "px-4 py-2.5 text-sm font-medium transition-colors outline-none",
              "active:scale-[0.95]",
              moreActive
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {moreActive && (
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
              <span className="relative">
                <MoreHorizontal className="h-4 w-4" />
                <AnimatePresence>
                  {moreHasBadge && !moreActive && (
                    <motion.span
                      key="more-badge"
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
                      aria-label={`${moreBadgeCount} unread in more`}
                    />
                  )}
                </AnimatePresence>
              </span>

              {moreActive && activeMoreItem && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: "auto" }}
                  className="overflow-hidden whitespace-nowrap text-[10px] font-bold uppercase tracking-widest"
                >
                  {activeMoreItem.name}
                </motion.span>
              )}
            </span>
          </button>
        </nav>
      </div>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <AnimatePresence>
          {moreOpen && (
            <SheetPrimitive.Portal forceMount>
              <SheetPrimitive.Overlay asChild forceMount>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="fixed inset-0 z-50 bg-black/60"
                />
              </SheetPrimitive.Overlay>

              <SheetPrimitive.Content asChild forceMount>
                <motion.div
                  initial={{ y: "100%" }}
                  animate={{ y: 0 }}
                  exit={{ y: "100%" }}
                  transition={{
                    type: "spring",
                    damping: 32,
                    stiffness: 360,
                  }}
                  drag="y"
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0, bottom: 1 }}
                  dragMomentum={false}
                  onDragEnd={(_, info: PanInfo) => {
                    if (
                      info.offset.y > DRAG_DISMISS_OFFSET_PX ||
                      info.velocity.y > DRAG_DISMISS_VELOCITY
                    ) {
                      void vibrate(50, "medium");
                      setMoreOpen(false);
                    }
                  }}
                  className={cn(
                    "fixed inset-x-0 bottom-0 z-50 flex flex-col gap-4",
                    "rounded-t-3xl border-t border-white/10 bg-neutral-950",
                    "shadow-xl shadow-black/50 will-change-transform",
                    "pb-[max(env(safe-area-inset-bottom),1rem)]",
                    "touch-none",
                  )}
                >
                  <SheetTitle className="sr-only">More destinations</SheetTitle>
                  <SheetDescription className="sr-only">
                    Swipe down to dismiss, or tap a tile to navigate.
                  </SheetDescription>

                  <div className="flex cursor-grab flex-col items-center px-6 pt-3 pb-0 active:cursor-grabbing">
                    <div className="mb-1 h-1 w-10 rounded-full bg-white/20" />
                    <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground/70">
                      More
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 px-6 pb-4 sm:grid-cols-3">
                    {moreItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = isNavItemActive(item, pathname);
                      const badgeCount = item.badgeKey
                        ? badges[item.badgeKey]
                        : 0;
                      const hasBadge = badgeCount > 0;

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => {
                            void vibrate(30, "light");
                            setMoreOpen(false);
                          }}
                          className={cn(
                            "relative flex flex-col items-center justify-center gap-2",
                            "rounded-2xl border px-4 py-5 outline-none",
                            "transition-colors active:scale-[0.98]",
                            isActive
                              ? "border-primary/40 bg-primary/15 text-primary"
                              : "border-white/8 bg-white/3 text-muted-foreground hover:bg-white/6 hover:text-foreground",
                          )}
                        >
                          <span className="relative">
                            <Icon className="h-5 w-5" />
                            {hasBadge && (
                              <span
                                className={cn(
                                  "absolute -right-1.5 -top-1.5 flex h-2 w-2",
                                  "items-center justify-center rounded-full",
                                  "bg-destructive shadow-[0_0_6px_hsl(var(--destructive)/0.8)]",
                                )}
                                aria-label={`${badgeCount} unread`}
                              />
                            )}
                          </span>
                          <span className="text-[11px] font-bold uppercase tracking-widest">
                            {item.name}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </motion.div>
              </SheetPrimitive.Content>
            </SheetPrimitive.Portal>
          )}
        </AnimatePresence>
      </Sheet>
    </>
  );
}
