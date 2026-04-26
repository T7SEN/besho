"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  Bell,
  X,
  Check,
  BookHeart,
  CalendarClock,
  Home,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getNotificationHistory,
  markAllNotificationsRead,
  clearAllNotifications,
  type NotificationRecord,
} from "@/app/actions/notifications";
import { vibrate } from "@/lib/haptic";

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function NotificationIcon({ url }: { url: string }) {
  if (url === "/notes") return <BookHeart className="h-4 w-4" />;
  if (url === "/timeline") return <CalendarClock className="h-4 w-4" />;
  return <Home className="h-4 w-4" />;
}

export function NotificationDrawer() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [drawerPos, setDrawerPos] = useState({ top: 0, right: 0 });

  const router = useRouter();

  const unreadCount = notifications.filter((n) => !n.read).length;

  const load = useCallback(async () => {
    setIsLoading(true);
    const records = await getNotificationHistory();
    setNotifications(records);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      setIsMounted(true);
    }, 0);
  }, []);

  useEffect(() => {
    setTimeout(() => {
      void load();
    }, 0);
  }, [load]);

  const handleOpen = async () => {
    // Calculate position from button before opening
    if (buttonRef.current) {
      const rect = (
        buttonRef.current as unknown as {
          getBoundingClientRect: () => { bottom: number; right: number };
        }
      ).getBoundingClientRect();
      setDrawerPos({
        top: rect.bottom + 8,
        right:
          (globalThis as unknown as { innerWidth: number }).innerWidth -
          rect.right,
      });
    }
    void vibrate(50, "light");
    setIsOpen(true);
    await load();
    if (unreadCount > 0) {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    }
  };

  const handleClose = () => {
    void vibrate(30, "light");
    setIsOpen(false);
  };

  const handleNavigate = (url: string) => {
    setIsOpen(false);
    router.push(url);
  };

  const handleClear = async () => {
    void vibrate(50, "medium");
    setIsClearing(true);
    await clearAllNotifications();
    setNotifications([]);
    setIsClearing(false);
  };

  return (
    <>
      {/* Bell button with unread badge */}
      <div className="relative">
        <button
          ref={buttonRef}
          onClick={isOpen ? handleClose : handleOpen}
          aria-label={isOpen ? "Close notifications" : "Notification history"}
          title={isOpen ? "Close" : "Notifications"}
          className={cn(
            "rounded-full p-2 transition-all",
            unreadCount > 0
              ? "text-primary hover:bg-primary/10"
              : "text-muted-foreground/30 hover:bg-muted/20 hover:text-muted-foreground",
          )}
        >
          <Bell className="h-4 w-4" />
        </button>

        <AnimatePresence>
          {unreadCount > 0 && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: "spring", bounce: 0.5 }}
              className={cn(
                "absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center",
                "rounded-full bg-primary text-[9px] font-black text-primary-foreground",
              )}
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Backdrop + Drawer — portaled to body so they escape all stacking contexts */}
      {isMounted &&
        createPortal(
          <AnimatePresence>
            {isOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={handleClose}
                  className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                />
                <motion.div
                  initial={{ opacity: 0, y: -16, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -16, scale: 0.97 }}
                  transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "fixed z-50 w-96 overflow-hidden",
                    "rounded-2xl border border-white/10 bg-card/95 shadow-2xl shadow-black/40",
                    "backdrop-blur-xl",
                  )}
                  style={{
                    top: drawerPos.top,
                    right: drawerPos.right,
                  }}
                >
                  {/* Header */}
                  <div className="flex items-center justify-between border-b border-border/30 px-4 py-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      Notifications
                    </h3>
                    <div className="flex items-center gap-1">
                      {notifications.length > 0 && (
                        <button
                          onClick={handleClear}
                          disabled={isClearing || undefined}
                          title="Clear all"
                          aria-label="Clear all notifications"
                          className="rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={handleClose}
                        className="rounded-full p-1 text-muted-foreground/40 transition-colors hover:bg-muted/20 hover:text-muted-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* List */}
                  <div className="max-h-96 overflow-y-auto">
                    {isLoading ? (
                      <div className="space-y-3 p-4">
                        {[...Array(3)].map((_, i) => (
                          <div key={i} className="flex gap-3">
                            <div className="h-8 w-8 animate-pulse rounded-full bg-muted/20" />
                            <div className="flex-1 space-y-1.5">
                              <div className="h-3 w-3/4 animate-pulse rounded bg-muted/20" />
                              <div className="h-2.5 w-full animate-pulse rounded bg-muted/15" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : notifications.length === 0 ? (
                      <div className="flex flex-col items-center gap-3 py-10 text-center">
                        <Check className="h-8 w-8 text-muted-foreground/20" />
                        <p className="text-xs font-semibold text-muted-foreground/40">
                          All caught up
                        </p>
                      </div>
                    ) : (
                      <div className="divide-y divide-border/20">
                        {notifications.map((n) => (
                          <button
                            key={n.id}
                            onClick={() => handleNavigate(n.url)}
                            className={cn(
                              "flex w-full items-start gap-3 px-4 py-3 text-left",
                              "transition-colors hover:bg-white/5",
                              !n.read && "bg-primary/5",
                            )}
                          >
                            <div
                              className={cn(
                                "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                                n.read
                                  ? "bg-muted/20 text-muted-foreground/50"
                                  : "bg-primary/10 text-primary",
                              )}
                            >
                              <NotificationIcon url={n.url} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p
                                  className={cn(
                                    "text-xs font-bold truncate",
                                    n.read
                                      ? "text-foreground/60"
                                      : "text-foreground",
                                  )}
                                >
                                  {n.title}
                                </p>
                                {!n.read && (
                                  <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                                )}
                              </div>
                              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/60 line-clamp-2">
                                {n.body}
                              </p>
                              <p className="mt-1 text-[10px] font-semibold text-muted-foreground/40">
                                {formatTime(n.timestamp)}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>,
          (globalThis as unknown as { document: { body: HTMLElement } })
            .document.body,
        )}
    </>
  );
}
