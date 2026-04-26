"use client";

import { usePathname } from "next/navigation";
import { Heart } from "lucide-react";
import { NotificationDrawer } from "@/components/dashboard/notification-drawer";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { getCurrentAuthor } from "@/app/actions/auth";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const HIDDEN_ON = ["/login"];

export function TopNavbar() {
  const pathname = usePathname();
  const [author, setAuthor] = useState<string | null>(null);

  useEffect(() => {
    setTimeout(() => {
      getCurrentAuthor().then(setAuthor);
    }, 0);
  }, []);

  if (HIDDEN_ON.includes(pathname)) return null;

  return (
    <div
      className="sticky top-0 z-50 w-full border-b border-white/4 bg-background/80 backdrop-blur-xl"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="mx-auto flex h-13 max-w-6xl items-center justify-between px-6 md:px-12">
        {/* Left — App name */}
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/20">
            <Heart className="h-3 w-3 text-primary" fill="currentColor" />
          </div>
          <span className="text-xs font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase">
            Our Space
          </span>
        </div>

        {/* Center — Author pill */}
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1.5",
            "border-white/8 bg-white/3 transition-opacity",
            !author && "opacity-0",
          )}
        >
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              author === "Besho" ? "bg-primary" : "bg-foreground/50",
            )}
          />
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground/60">
            {author}
          </span>
        </div>

        {/* Right — Actions */}
        <div className="flex items-center gap-0.5">
          <NotificationDrawer />
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
