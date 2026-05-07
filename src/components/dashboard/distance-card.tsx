"use client";

import { useCallback, useEffect, useState } from "react";
import { MapPin, Navigation2 } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  DISTANCE_KM,
  MY_LABEL,
  PARTNER_COORDS,
  PARTNER_LABEL,
} from "@/lib/constants";
import { isNative } from "@/lib/native";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { logger } from "@/lib/logger";

type DistanceStatus = "loading" | "live" | "fallback";

const POSITION_MAX_AGE_MS = 5 * 60_000;
const POSITION_TIMEOUT_MS = 10_000;

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function DistanceCard() {
  const [liveKm, setLiveKm] = useState<number | null>(null);
  const [status, setStatus] = useState<DistanceStatus>("loading");

  const fetchLivePosition = useCallback(async () => {
    if (!isNative()) {
      setStatus("fallback");
      return;
    }
    try {
      const { Geolocation } = await import("@capacitor/geolocation");
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== "granted" && perm.coarseLocation !== "granted") {
        const req = await Geolocation.requestPermissions();
        if (req.location !== "granted" && req.coarseLocation !== "granted") {
          setStatus("fallback");
          return;
        }
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: POSITION_TIMEOUT_MS,
        maximumAge: POSITION_MAX_AGE_MS,
      });
      const km = haversineKm(
        pos.coords.latitude,
        pos.coords.longitude,
        PARTNER_COORDS.lat,
        PARTNER_COORDS.lng,
      );
      setLiveKm(km);
      setStatus("live");
    } catch (err) {
      logger.error("[distance] geolocation failed:", err);
      setStatus("fallback");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchLivePosition();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchLivePosition]);

  useRefreshListener(() => {
    void fetchLivePosition();
  });

  const km =
    status === "live" && liveKm !== null ? Math.round(liveKm) : DISTANCE_KM;
  const miles = Math.round(km * 0.621371);
  const flightPath = "M 0 35 Q 50 5 100 35";

  return (
    <div
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-md shadow-xl shadow-black/20 transition-colors",
        "hover:border-primary/20",
      )}
    >
      <div className="relative z-10 flex items-center justify-between">
        <h2
          className={cn(
            "text-xs font-bold uppercase tracking-[0.2em]",
            "text-muted-foreground",
          )}
        >
          Distance
        </h2>
        <div className="rounded-full bg-primary/10 p-2 text-primary">
          <Navigation2 className="h-4 w-4" />
        </div>
      </div>

      <div className="relative z-10 mt-6">
        <div className="flex items-baseline gap-2">
          <motion.span
            key={km}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
            className="text-6xl font-black tracking-tighter"
          >
            {km}
          </motion.span>
          <span className="text-xl font-bold text-muted-foreground">km</span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <p className="text-sm font-medium text-muted-foreground/60">
            {miles} miles away
          </p>
          <StatusBadge status={status} />
        </div>
      </div>

      {/* Visual Connection Map */}
      <div className="relative mt-8 h-20 w-full rounded-2xl bg-black/20 p-4">
        <div className="flex h-full items-center justify-between px-2">
          {/* Origin point */}
          <div className="flex flex-col items-center gap-2">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="text-[10px] font-bold uppercase tracking-tight text-muted-foreground/50">
              {MY_LABEL}
            </span>
          </div>

          {/* Connection arc */}
          <div className="relative flex-1 px-4">
            <svg
              viewBox="0 0 100 40"
              className="h-12 w-full overflow-visible"
              preserveAspectRatio="none"
            >
              <motion.path
                d={flightPath}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="4 4"
                className="text-primary/30"
                vectorEffect="non-scaling-stroke"
              />
              <motion.path
                d={flightPath}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="text-primary"
                vectorEffect="non-scaling-stroke"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 2, ease: "easeOut" }}
              />
              <circle
                r="2.5"
                fill="currentColor"
                className="text-primary drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]"
              >
                <animateMotion
                  dur="3s"
                  repeatCount="indefinite"
                  path={flightPath}
                />
              </circle>
            </svg>
          </div>

          {/* Destination point */}
          <div className="flex flex-col items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            <span className="text-[10px] font-bold uppercase tracking-tight text-primary/50">
              {PARTNER_LABEL}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: DistanceStatus }) {
  if (status === "loading") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
        <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/40" />
        Locating
      </span>
    );
  }

  if (status === "live") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-primary/80">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-primary" />
        </span>
        Live
      </span>
    );
  }

  return (
    <span className="rounded-full bg-muted/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
      Approx
    </span>
  );
}
