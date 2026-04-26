"use client";

import { usePathname } from "next/navigation";
import { NotificationDrawer } from "@/components/dashboard/notification-drawer";
import { LogoutButton } from "@/components/dashboard/logout-button";

const HIDDEN_ON = ["/login"];

/**
 * Persistent top navigation bar rendered in layout.tsx.
 * Shows notification drawer and logout button on all authenticated pages.
 * Hidden on the login page and inside the BiometricGate lock screen.
 */
export function TopNavbar() {
  const pathname = usePathname();

  if (HIDDEN_ON.includes(pathname)) return null;

  return (
    <div
      className="fixed right-4 top-0 z-40 flex items-center gap-1"
      style={{ top: "calc(env(safe-area-inset-top) + 0.5rem)" }}
    >
      <NotificationDrawer />
      <LogoutButton />
    </div>
  );
}
