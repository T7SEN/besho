"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, Hourglass } from "lucide-react";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const ZONES = {
  cairo: { id: "Africa/Cairo", label: "Cairo", short: "CAI" },
  tabuk: { id: "Asia/Riyadh", label: "Tabuk", short: "TBK" },
} as const;

const DAY_MS = 86_400_000;

function tzOffsetMinutes(zone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  const formattedHour = Number(byType.hour) === 24 ? 0 : Number(byType.hour);
  const formattedAsUtcMs = Date.UTC(
    Number(byType.year),
    Number(byType.month) - 1,
    Number(byType.day),
    formattedHour,
    Number(byType.minute),
    Number(byType.second),
  );
  return Math.round((formattedAsUtcMs - instant) / 60_000);
}

function tzWallClockToUtcMs(
  zone: string,
  date: string,
  time: string,
): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naiveUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  const offset = tzOffsetMinutes(zone, naiveUtc);
  return naiveUtc - offset * 60_000;
}

function formatInZone(zone: string, utcMs: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  const date = `${byType.year}-${byType.month}-${byType.day}`;
  const hourNorm = byType.hour === "24" ? "00" : byType.hour;
  const time = `${hourNorm}:${byType.minute}:${byType.second}`;
  const offsetMin = tzOffsetMinutes(zone, utcMs);
  const sign = offsetMin >= 0 ? "+" : "−";
  const absMin = Math.abs(offsetMin);
  const offsetH = Math.floor(absMin / 60);
  const offsetM = absMin % 60;
  const offset = `UTC${sign}${String(offsetH).padStart(2, "0")}${
    offsetM > 0 ? `:${String(offsetM).padStart(2, "0")}` : ""
  }`;
  return {
    date,
    time,
    weekday: byType.weekday ?? "",
    full: `${byType.weekday} ${date} ${time}`,
    offset,
  };
}

function dateKeyInZone(zone: string, utcMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcMs));
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  return `${byType.year}-${byType.month}-${byType.day}`;
}

/** JS-style weekday index (Sun=0, Sat=6) for a YYYY-MM-DD date key.
 *  Calendar weekday is timezone-independent for a fully-qualified date. */
function weekdayOfDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function addDaysToKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = Date.UTC(y, (m ?? 1) - 1, d ?? 1) + n * DAY_MS;
  const out = new Date(utc);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, "0")}-${String(out.getUTCDate()).padStart(2, "0")}`;
}

/** Sun→Sat Cairo week — returns the date key of the Sunday containing
 *  `cairoToday`. Mirrors `currentReviewWeekDate` on the server. */
function currentWeekKeyForCairoDate(cairoToday: string): string {
  const dow = weekdayOfDateKey(cairoToday);
  return addDaysToKey(cairoToday, -dow);
}

function formatHM(ms: number): string {
  if (ms < 0) return "0h 0m";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatHMS(ms: number): string {
  if (ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatWeekLabelLocal(weekDate: string): string {
  // "Apr 27" style — week starts on this Sunday.
  const [y, m, d] = weekDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  const month = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(date);
  return `${month} ${d}`;
}

export default function SystemTimePage() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useRefreshListener(() => setNow(Date.now()));

  const computed = useMemo(() => {
    const cairo = formatInZone(ZONES.cairo.id, now);
    const tabuk = formatInZone(ZONES.tabuk.id, now);
    const cairoToday = dateKeyInZone(ZONES.cairo.id, now);
    const weekKey = currentWeekKeyForCairoDate(cairoToday);
    const weekLabel = formatWeekLabelLocal(weekKey);
    const cairoWeekday = weekdayOfDateKey(cairoToday);

    // Next Cairo midnight = midnight of (cairoToday + 1 day) in Cairo.
    const tomorrow = addDaysToKey(cairoToday, 1);
    const nextMidnightUtc = tzWallClockToUtcMs(
      ZONES.cairo.id,
      tomorrow,
      "00:00",
    );
    const msToMidnight = nextMidnightUtc - now;

    // Next Sunday rollover = midnight of the next Sunday in Cairo. If
    // today IS Sunday and we're past midnight, rollover is in 7 days.
    const daysToNextSunday =
      cairoWeekday === 0 ? 7 : 7 - cairoWeekday;
    const nextSundayKey = addDaysToKey(cairoToday, daysToNextSunday);
    const nextSundayUtc = tzWallClockToUtcMs(
      ZONES.cairo.id,
      nextSundayKey,
      "00:00",
    );
    const msToRollover = nextSundayUtc - now;

    return {
      cairo,
      tabuk,
      cairoToday,
      weekKey,
      weekLabel,
      cairoWeekday,
      msToMidnight,
      msToRollover,
      nextMidnightUtc,
      nextSundayUtc,
      nextSundayKey,
    };
  }, [now]);

  const weekdayName = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ][computed.cairoWeekday];

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">System time</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Live snapshot of the time primitives any admin override touches.
        Read this before recompute, week-finalize, or date-key edits.
        Updates every second.
      </p>

      <section className="rounded-2xl border border-border/40 bg-card p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <ZoneCard
            label="Cairo"
            sub="Africa/Cairo · observes DST"
            full={computed.cairo.full}
            offset={computed.cairo.offset}
            primary
          />
          <ZoneCard
            label="Tabuk"
            sub="Asia/Riyadh · no DST"
            full={computed.tabuk.full}
            offset={computed.tabuk.offset}
          />
        </div>

        <hr className="my-5 border-border/30" />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-3">
          <Stat
            label="Cairo today key"
            value={computed.cairoToday}
            mono
          />
          <Stat
            label="Cairo weekday"
            value={`${weekdayName} (${computed.cairoWeekday})`}
          />
          <Stat
            label="Current weekKey"
            value={`${computed.weekKey} · ${computed.weekLabel}`}
            mono
          />
          <Stat
            label="Next Cairo midnight"
            value={formatHMS(computed.msToMidnight)}
            icon={Clock}
          />
          <Stat
            label={`Next Sunday rollover (${computed.nextSundayKey})`}
            value={formatHM(computed.msToRollover)}
            icon={Hourglass}
          />
          <Stat
            label="UTC now"
            value={new Date(now).toISOString().replace("T", " ").slice(0, 19)}
            mono
          />
        </dl>
      </section>

      <p className="mt-3 text-[10px] text-muted-foreground/60">
        weekKey aligns with{" "}
        <code className="font-mono">currentReviewWeekDate</code> — the
        Sunday containing today in Cairo. Rollover happens at 00:00 Cairo
        on the next Sunday.
      </p>
    </main>
  );
}

function ZoneCard({
  label,
  sub,
  full,
  offset,
  primary,
}: {
  label: string;
  sub: string;
  full: string;
  offset: string;
  primary?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border p-3 " +
        (primary
          ? "border-primary/40 bg-primary/5"
          : "border-emerald-500/40 bg-emerald-500/5")
      }
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm tabular-nums">{full}</p>
      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
        {offset} · {sub}
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: typeof Clock;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd
        className={
          "mt-0.5 flex items-center gap-1.5 truncate text-sm font-bold " +
          (mono ? "font-mono tabular-nums" : "tabular-nums")
        }
      >
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />}
        {value}
      </dd>
    </div>
  );
}
