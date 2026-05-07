"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, Clock } from "lucide-react";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const ZONES = {
  cairo: { id: "Africa/Cairo", label: "Cairo", short: "CAI" },
  tabuk: { id: "Asia/Riyadh", label: "Tabuk", short: "TBK" },
} as const;

type ZoneKey = keyof typeof ZONES;

function tzOffsetMinutes(zone: string, instant: number): number {
  // Returns the offset in minutes (positive = east of UTC) for the
  // given instant in the given IANA zone. Uses the same Intl
  // round-trip technique as @/lib/cairo-time.tzWallClockToUtcMs.
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
  return Math.round((formattedAsUtcMs - instant) / 60000);
}

function wallClockToUtc(
  zone: string,
  date: string, // YYYY-MM-DD
  time: string, // HH:MM
): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const naiveUtc = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  // Round-trip: figure out the actual offset for the naive guess.
  const offset = tzOffsetMinutes(zone, naiveUtc);
  return naiveUtc - offset * 60000;
}

function formatInZone(
  zone: string,
  utcMs: number,
): { date: string; time: string; full: string; offset: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const byType: Record<string, string> = {};
  for (const p of parts) byType[p.type] = p.value;
  const date = `${byType.year}-${byType.month}-${byType.day}`;
  const hourNorm = byType.hour === "24" ? "00" : byType.hour;
  const time = `${hourNorm}:${byType.minute}`;
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
    full: `${byType.weekday} ${date} ${time}`,
    offset,
  };
}

function todayInZone(zone: string, now: number): { date: string; time: string } {
  return formatInZone(zone, now);
}

export default function TimezoneConverterPage() {
  const [now, setNow] = useState(() => Date.now());
  const [source, setSource] = useState<ZoneKey>("cairo");
  const initial = todayInZone(ZONES.cairo.id, now);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);

  // Tick every minute so the "currently" line stays fresh.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useRefreshListener(() => {
    setNow(Date.now());
  });

  const target: ZoneKey = source === "cairo" ? "tabuk" : "cairo";
  const sourceZone = ZONES[source];
  const targetZone = ZONES[target];

  const { sourceFmt, targetFmt, deltaMinutes } = useMemo(() => {
    const utcMs = wallClockToUtc(sourceZone.id, date, time);
    const sFmt = formatInZone(sourceZone.id, utcMs);
    const tFmt = formatInZone(targetZone.id, utcMs);
    const sOff = tzOffsetMinutes(sourceZone.id, utcMs);
    const tOff = tzOffsetMinutes(targetZone.id, utcMs);
    return {
      sourceFmt: sFmt,
      targetFmt: tFmt,
      deltaMinutes: tOff - sOff,
    };
  }, [sourceZone, targetZone, date, time]);

  const liveSource = todayInZone(sourceZone.id, now);
  const liveTarget = todayInZone(targetZone.id, now);
  const liveDeltaMin =
    tzOffsetMinutes(targetZone.id, now) - tzOffsetMinutes(sourceZone.id, now);

  const swap = () => {
    void vibrate(20, "light");
    setSource(target);
  };

  const useNow = () => {
    void vibrate(20, "light");
    const fresh = todayInZone(sourceZone.id, Date.now());
    setDate(fresh.date);
    setTime(fresh.time);
  };

  return (
    <main className="mx-auto max-w-2xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">
        Timezone converter
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Cairo (Africa/Cairo, observes DST) ↔ Tabuk (Asia/Riyadh, no DST).
        Pick a wall-clock instant in the source zone; the target equivalent
        is computed live. Visit-planning utility — no state stored.
      </p>

      <section className="rounded-2xl border border-border/40 bg-card p-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          <Field label="From">
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as ZoneKey)}
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            >
              <option value="cairo">{ZONES.cairo.label}</option>
              <option value="tabuk">{ZONES.tabuk.label}</option>
            </select>
          </Field>
          <button
            type="button"
            onClick={swap}
            aria-label="Swap zones"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-border/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary active:scale-95"
          >
            <ArrowRightLeft className="h-4 w-4" />
          </button>
          <Field label="To">
            <input
              type="text"
              value={targetZone.label}
              readOnly
              className="w-full rounded border border-border/40 bg-card/30 px-2 py-1.5 text-sm text-muted-foreground"
            />
          </Field>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Field label={`Date (${sourceZone.label})`}>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm tabular-nums focus:border-primary focus:outline-none"
            />
          </Field>
          <Field label={`Time (${sourceZone.label})`}>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm tabular-nums focus:border-primary focus:outline-none"
            />
          </Field>
        </div>

        <button
          type="button"
          onClick={useNow}
          className="mt-3 flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95"
        >
          <Clock className="h-3 w-3" />
          Use now
        </button>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <ZoneCard
            label={sourceZone.label}
            full={sourceFmt.full}
            offset={sourceFmt.offset}
            isSource
          />
          <ZoneCard
            label={targetZone.label}
            full={targetFmt.full}
            offset={targetFmt.offset}
          />
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Delta:{" "}
          <span className="font-bold text-foreground tabular-nums">
            {formatDelta(deltaMinutes, sourceZone.label, targetZone.label)}
          </span>
        </p>
      </section>

      <section className="mt-4 rounded-2xl border border-border/40 bg-card/50 p-4 text-xs text-muted-foreground">
        <p className="mb-1 font-bold uppercase tracking-wider">
          Currently
        </p>
        <p className="tabular-nums">
          {sourceZone.label}: {liveSource.date} {liveSource.time} ·{" "}
          {targetZone.label}: {liveTarget.date} {liveTarget.time}
        </p>
        <p className="mt-1">
          {liveDeltaMin === 0
            ? "Both zones are at the same wall-clock time right now."
            : formatDelta(liveDeltaMin, sourceZone.label, targetZone.label) +
              " right now."}
        </p>
      </section>
    </main>
  );
}

function ZoneCard({
  label,
  full,
  offset,
  isSource,
}: {
  label: string;
  full: string;
  offset: string;
  isSource?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        isSource
          ? "border-primary/40 bg-primary/5"
          : "border-emerald-500/40 bg-emerald-500/5",
      )}
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 font-mono text-sm tabular-nums">{full}</p>
      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
        {offset}
      </p>
    </div>
  );
}

function formatDelta(
  minutes: number,
  sourceLabel: string,
  targetLabel: string,
): string {
  if (minutes === 0) return `${targetLabel} matches ${sourceLabel}`;
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span =
    h > 0
      ? m > 0
        ? `${h}h ${m}m`
        : `${h}h`
      : `${m}m`;
  return minutes > 0
    ? `${targetLabel} is ${span} ahead of ${sourceLabel}`
    : `${targetLabel} is ${span} behind ${sourceLabel}`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
