"use client";

import { useState, useEffect } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { cn } from "@/lib/utils";

export function NotificationButton() {
  const [permission, setPermission] =
    useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (
      typeof Notification === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    setPermission(Notification.permission);
    navigator.serviceWorker.ready.then((reg) =>
      reg.pushManager.getSubscription().then((sub) => setIsSubscribed(!!sub)),
    );
  }, []);

  // Don't render on unsupported platforms
  if (
    typeof Notification === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window)
  ) {
    return null;
  }

  const handleUnsubscribe = async () => {
    setIsLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await fetch("/api/push/subscribe", { method: "DELETE" });
      }
      setIsSubscribed(false);
    } catch (err) {
      console.error("[push] Unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubscribe = async () => {
    setIsLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
      });

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub),
      });

      setIsSubscribed(true);
    } catch (err) {
      console.error("[push] Subscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  };

  if (permission === "denied") {
    return (
      <button
        disabled
        aria-label="Notifications blocked in browser settings"
        title="Notifications blocked"
        className="rounded-full p-2 text-muted-foreground/20"
      >
        <BellOff className="h-4 w-4" />
      </button>
    );
  }

  return (
    <button
      onClick={isSubscribed ? handleUnsubscribe : handleSubscribe}
      disabled={isLoading || undefined}
      aria-label={
        isSubscribed ? "Disable notifications" : "Enable notifications"
      }
      title={isSubscribed ? "Notifications on" : "Enable notifications"}
      className={cn(
        "rounded-full p-2 transition-all disabled:opacity-50",
        isSubscribed
          ? "text-primary hover:bg-primary/10"
          : "text-muted-foreground/30 hover:bg-muted/20 hover:text-muted-foreground",
      )}
    >
      {isSubscribed ? (
        <BellRing className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
    </button>
  );
}
