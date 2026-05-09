"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRightLeft,
  CalendarX,
  CheckCircle2,
  Clock,
  Database,
  Gift,
  Hash,
  Hourglass,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Smile,
  Timer,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  getCooldownState,
  getCronTelemetry,
  getHealthSnapshot,
  pruneOrphanedReactions,
  pruneOrphanedRitualOccurrences,
  reconcileFeatureIndexes,
  reconcilePendingRewardClaims,
  repairIndexes,
  repairObedienceDrift,
  type CooldownState,
  type CronTelemetryResult,
  type FeatureIndexDrift,
  type HealthSnapshot,
  type ObedienceDriftRepairSummary,
  type PendingClaimDriftEntry,
  type PruneOrphansResult,
  type ReconcileFeatureIndexesResult,
  type ReconcilePendingClaimsResult,
  type RepairResult,
} from "@/app/actions/admin";
import type { CronTelemetrySnapshot } from "@/lib/cron-telemetry";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const CONFIRM_TIMEOUT_MS = 5_000;
const CRON_FRESH_MS = {
  "ritual-windows": 5 * 60_000,
  "obedience-sweep": 26 * 60 * 60_000,
  "review-window-open": 26 * 60 * 60_000,
  // 2h fresh — cron-job.org should fire heartbeat-watch every ~30m,
  // so anything older than 2h means the watcher itself has stopped.
  "heartbeat-watch": 2 * 60 * 60_000,
} as const;

export default function HealthPage() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [cron, setCron] = useState<CronTelemetryResult | null>(null);
  const [cooldown, setCooldown] = useState<CooldownState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [now, setNow] = useState(() => Date.now());

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [healthResult, cronResult, cooldownResult] = await Promise.all([
        getHealthSnapshot(),
        getCronTelemetry(),
        getCooldownState(),
      ]);
      if (healthResult.error) {
        setError(healthResult.error);
      } else if (healthResult.health) {
        setHealth(healthResult.health);
        setError(null);
      }
      setCron(cronResult);
      if (cooldownResult.error) {
        setError(cooldownResult.error);
      } else if (cooldownResult.state) {
        setCooldown(cooldownResult.state);
      }
      setNow(Date.now());
    } catch {
      setError("Failed to read diagnostics.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchAll();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchAll]);

  useRefreshListener(fetchAll);

  // Once-per-second tick drives both cooldown countdowns AND the live
  // time tab. Gated on tab visibility — when the page is backgrounded
  // there's nothing to re-render and the per-second wakeup is wasted.
  useEffect(() => {
    const id = setInterval(() => {
      const doc = (
        globalThis as unknown as { document?: { visibilityState?: string } }
      ).document;
      if (doc?.visibilityState === "hidden") return;
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, []);

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
        <button
          type="button"
          onClick={() => {
            void vibrate(20, "light");
            void fetchAll();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Diagnostics</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        System health (Redis, FCM, cron telemetry, repair operations) +
        TTL&apos;d cooldown viewer + live system time. Read this before
        any time-sensitive admin work.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <Tabs defaultValue="health">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="cooldowns">Cooldowns</TabsTrigger>
          <TabsTrigger value="time">Time</TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="space-y-4">
          {!health ? (
            <SkeletonCards />
          ) : (
            <>
              <Section title="Redis">
                <Diag
                  label="Connection"
                  ok={health.redis.ok}
                  detail={
                    health.redis.latencyMs != null
                      ? `${health.redis.latencyMs}ms`
                      : "—"
                  }
                />
              </Section>

              <Section title="Push (FCM)">
                <Diag
                  label="Credentials"
                  ok={health.fcm.credentialsPresent}
                  detail={
                    health.fcm.credentialsPresent
                      ? "env vars set"
                      : "missing FIREBASE_*"
                  }
                />
                <Diag
                  label={`${TITLE_BY_AUTHOR.T7SEN} token`}
                  ok={health.fcm.tokensRegistered.T7SEN}
                  detail={
                    health.fcm.tokensRegistered.T7SEN
                      ? "registered"
                      : "missing"
                  }
                />
                <Diag
                  label={`${TITLE_BY_AUTHOR.Besho} token`}
                  ok={health.fcm.tokensRegistered.Besho}
                  detail={
                    health.fcm.tokensRegistered.Besho
                      ? "registered"
                      : "missing"
                  }
                />
              </Section>

              <Section title="Cron auth">
                <Diag
                  label="CRON_SECRET"
                  ok={health.cron.secretSet}
                  detail={
                    health.cron.secretSet
                      ? "env set — crons will run"
                      : "MISSING — every /api/cron/* returns 401"
                  }
                />
              </Section>

              <Section title="Recent severities (24h)">
                <Diag
                  label="Errors"
                  ok={health.errorsLast24h === 0}
                  detail={`${health.errorsLast24h}`}
                />
                <Diag
                  label="Warnings"
                  ok={health.warningsLast24h === 0}
                  detail={`${health.warningsLast24h}`}
                />
              </Section>

              <Section title="Cron last runs">
                {cron?.snapshots && cron.snapshots.length > 0 ? (
                  cron.snapshots.map((snap) => (
                    <CronRow key={snap.name} snap={snap} now={now} />
                  ))
                ) : (
                  <li className="text-xs text-muted-foreground">
                    No telemetry yet. The crons write here on each tick;
                    cron-job.org may not have fired since this feature
                    deployed.
                  </li>
                )}
              </Section>

              <Section title="Time integrity">
                <TimeIntegrity now={now} />
              </Section>

              <Section title="Notes index integrity">
                <Diag
                  label="Index size"
                  ok
                  detail={`${health.countKeysVsIndex.indexTotal}`}
                />
                <Diag
                  label={`Stored ${TITLE_BY_AUTHOR.T7SEN}`}
                  ok={
                    health.countKeysVsIndex.storedT7SEN ===
                    health.countKeysVsIndex.expectedT7SEN
                  }
                  detail={`${health.countKeysVsIndex.storedT7SEN} stored / ${health.countKeysVsIndex.expectedT7SEN} expected`}
                />
                <Diag
                  label={`Stored ${TITLE_BY_AUTHOR.Besho}`}
                  ok={
                    health.countKeysVsIndex.storedBesho ===
                    health.countKeysVsIndex.expectedBesho
                  }
                  detail={`${health.countKeysVsIndex.storedBesho} stored / ${health.countKeysVsIndex.expectedBesho} expected`}
                />
                <Diag
                  label="Pinned set size"
                  ok
                  detail={`${health.pinnedSetSize}`}
                />
              </Section>

              <RepairOperations
                onError={(msg) => setError(msg)}
                onComplete={fetchAll}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="cooldowns" className="space-y-4">
          <CooldownsTabBody cooldown={cooldown} now={now} />
        </TabsContent>

        <TabsContent value="time" className="space-y-4">
          <TimeTabBody now={now} />
        </TabsContent>
      </Tabs>
    </main>
  );
}

// ── Cooldowns tab ────────────────────────────────────────────────────────

function CooldownsTabBody({
  cooldown,
  now,
}: {
  cooldown: CooldownState | null;
  now: number;
}) {
  if (!cooldown) {
    return <SkeletonCards />;
  }
  const elapsedSec = Math.max(
    0,
    Math.floor((now - cooldown.generatedAt) / 1000),
  );
  return (
    <>
      <SafewordSection state={cooldown} elapsedSec={elapsedSec} />
      <ReaskBlocksSection state={cooldown} elapsedSec={elapsedSec} />
      <DeniedHashesSection state={cooldown} />
    </>
  );
}

function SafewordSection({
  state,
  elapsedSec,
}: {
  state: CooldownState;
  elapsedSec: number;
}) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldOff className="h-4 w-4 text-rose-400/80" />
        Safeword cooldowns (5-min spam shield)
      </h2>
      <ul className="space-y-1.5">
        {state.safewordCooldowns.map((c) => {
          const remaining =
            c.ttlSeconds == null ? null : Math.max(0, c.ttlSeconds - elapsedSec);
          const active = remaining != null && remaining > 0;
          return (
            <li
              key={c.author}
              className={cn(
                "flex items-baseline justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                active
                  ? "border-rose-500/40 bg-rose-500/5"
                  : "border-border/30 bg-card/40",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "font-bold",
                    active ? "text-rose-400" : "text-muted-foreground",
                  )}
                >
                  {TITLE_BY_AUTHOR[c.author] ?? c.author}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  safeword:cooldown:{c.author}
                </span>
              </span>
              <span
                className={cn(
                  "tabular-nums",
                  active ? "text-rose-400" : "text-muted-foreground/70",
                )}
              >
                {active ? `${formatHMSCompact(remaining)} left` : "not set"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ReaskBlocksSection({
  state,
  elapsedSec,
}: {
  state: CooldownState;
  elapsedSec: number;
}) {
  const visible = state.reaskBlocks
    .map((b) => ({
      bodyHash: b.bodyHash,
      remaining:
        b.ttlSeconds < 0
          ? b.ttlSeconds
          : Math.max(0, b.ttlSeconds - elapsedSec),
    }))
    .filter((b) => b.remaining !== 0)
    .sort((a, b) => {
      const ar = a.remaining < 0 ? -1 : a.remaining;
      const br = b.remaining < 0 ? -1 : b.remaining;
      return br - ar;
    });
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Timer className="h-4 w-4 text-amber-400/80" />
        Active reask blocks ({visible.length})
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Each entry is a denied permission body whose normalized hash is
        currently blocked from re-submission. Cooldown by denial reason:
        not_now 12h · discuss_in_person 24h · earn_first 48h · unsafe 72h ·
        nope 168h.
      </p>
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No active reask blocks.
        </p>
      ) : (
        <ul className="space-y-1">
          {visible.map((b) => (
            <li
              key={b.bodyHash}
              className="grid grid-cols-[auto_1fr_auto] items-baseline gap-2 rounded border border-border/30 bg-card/40 px-2.5 py-1.5 text-xs"
            >
              <Hash className="h-3 w-3 text-muted-foreground/70" />
              <span
                className="truncate font-mono text-muted-foreground"
                title={b.bodyHash}
              >
                {b.bodyHash}
              </span>
              <span className="tabular-nums text-amber-400">
                {b.remaining < 0
                  ? "no expire"
                  : `${formatHMSCompact(b.remaining)} left`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DeniedHashesSection({ state }: { state: CooldownState }) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Hash className="h-4 w-4 text-violet-400/80" />
        Lifetime denied-hashes set
      </h2>
      <p className="text-sm text-muted-foreground">
        <span className="font-bold tabular-nums text-foreground">
          {state.deniedHashesCount}
        </span>{" "}
        unique body-hash{state.deniedHashesCount === 1 ? "" : "es"} ever
        denied. Drives the &quot;previously denied&quot; chip on{" "}
        <code className="font-mono">/permissions</code>. Survives even
        after the per-hash reask-block expires.
      </p>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">
        permissions:denied-hashes (SET, no TTL)
      </p>
    </section>
  );
}

// ── Time tab ─────────────────────────────────────────────────────────────

const ZONES = {
  cairo: { id: "Africa/Cairo", label: "Cairo" },
  tabuk: { id: "Asia/Riyadh", label: "Tabuk" },
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

function clientWeekdayOfDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

function addDaysToKey(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const utc = Date.UTC(y, (m ?? 1) - 1, d ?? 1) + n * DAY_MS;
  const out = new Date(utc);
  return `${out.getUTCFullYear()}-${String(out.getUTCMonth() + 1).padStart(2, "0")}-${String(out.getUTCDate()).padStart(2, "0")}`;
}

function currentWeekKeyForCairoDate(cairoToday: string): string {
  const dow = clientWeekdayOfDateKey(cairoToday);
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

function formatHMSMs(ms: number): string {
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
  const [y, m, d] = weekDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  const month = new Intl.DateTimeFormat("en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(date);
  return `${month} ${d}`;
}

function TimeTabBody({ now }: { now: number }) {
  return (
    <>
      <TimeSnapshot now={now} />
      <TimezoneConverter now={now} />
    </>
  );
}

function TimeSnapshot({ now }: { now: number }) {
  const computed = useMemo(() => {
    const cairo = formatInZone(ZONES.cairo.id, now);
    const tabuk = formatInZone(ZONES.tabuk.id, now);
    const cairoToday = dateKeyInZone(ZONES.cairo.id, now);
    const weekKey = currentWeekKeyForCairoDate(cairoToday);
    const weekLabel = formatWeekLabelLocal(weekKey);
    const cairoWeekday = clientWeekdayOfDateKey(cairoToday);

    const tomorrow = addDaysToKey(cairoToday, 1);
    const nextMidnightUtc = tzWallClockToUtcMs(
      ZONES.cairo.id,
      tomorrow,
      "00:00",
    );
    const msToMidnight = nextMidnightUtc - now;

    const daysToNextSunday = cairoWeekday === 0 ? 7 : 7 - cairoWeekday;
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
        <Stat label="Cairo today key" value={computed.cairoToday} mono />
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
          value={formatHMSMs(computed.msToMidnight)}
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

      <p className="mt-4 text-[10px] text-muted-foreground/60">
        weekKey is the Sunday containing today in Cairo. Rollover happens
        at 00:00 Cairo on the next Sunday.
      </p>
    </section>
  );
}

// ── Timezone converter (Cairo ↔ Tabuk) ────────────────────────────────

type ZoneKey = keyof typeof ZONES;

function formatHHMM(utcMs: number, zone: string): string {
  const f = formatInZone(zone, utcMs);
  return f.time.slice(0, 5); // strip seconds
}

function dateInZone(utcMs: number, zone: string): string {
  return formatInZone(zone, utcMs).date;
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
    h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  return minutes > 0
    ? `${targetLabel} is ${span} ahead of ${sourceLabel}`
    : `${targetLabel} is ${span} behind ${sourceLabel}`;
}

function TimezoneConverter({ now }: { now: number }) {
  const [source, setSource] = useState<ZoneKey>("cairo");
  const [date, setDate] = useState(() => dateInZone(now, ZONES.cairo.id));
  const [time, setTime] = useState(() => formatHHMM(now, ZONES.cairo.id));

  const target: ZoneKey = source === "cairo" ? "tabuk" : "cairo";
  const sourceZone = ZONES[source];
  const targetZone = ZONES[target];

  const { sourceFmt, targetFmt, deltaMinutes } = useMemo(() => {
    const utcMs = tzWallClockToUtcMs(sourceZone.id, date, time);
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

  const liveSourceDate = dateInZone(now, sourceZone.id);
  const liveSourceTime = formatHHMM(now, sourceZone.id);
  const liveTargetDate = dateInZone(now, targetZone.id);
  const liveTargetTime = formatHHMM(now, targetZone.id);
  const liveDeltaMin =
    tzOffsetMinutes(targetZone.id, now) -
    tzOffsetMinutes(sourceZone.id, now);

  const swap = () => {
    void vibrate(20, "light");
    setSource(target);
  };

  const useNow = () => {
    void vibrate(20, "light");
    setDate(dateInZone(Date.now(), sourceZone.id));
    setTime(formatHHMM(Date.now(), sourceZone.id));
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-1 text-sm font-semibold">Converter</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        Pick a wall-clock instant in the source zone; the target equivalent
        is computed live. Visit-planning utility — no state stored.
      </p>

      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <ConverterField label="From">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as ZoneKey)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          >
            <option value="cairo">{ZONES.cairo.label}</option>
            <option value="tabuk">{ZONES.tabuk.label}</option>
          </select>
        </ConverterField>
        <button
          type="button"
          onClick={swap}
          aria-label="Swap zones"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-border/40 text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary active:scale-95"
        >
          <ArrowRightLeft className="h-4 w-4" />
        </button>
        <ConverterField label="To">
          <input
            type="text"
            value={targetZone.label}
            readOnly
            className="w-full rounded border border-border/40 bg-card/30 px-2 py-1.5 text-sm text-muted-foreground"
          />
        </ConverterField>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ConverterField label={`Date (${sourceZone.label})`}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </ConverterField>
        <ConverterField label={`Time (${sourceZone.label})`}>
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm tabular-nums focus:border-primary focus:outline-none"
          />
        </ConverterField>
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
        <ConverterZoneCard
          label={sourceZone.label}
          full={sourceFmt.full}
          offset={sourceFmt.offset}
          isSource
        />
        <ConverterZoneCard
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

      <div className="mt-3 rounded-lg border border-border/30 bg-card/40 p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-bold uppercase tracking-wider">Currently</p>
        <p className="tabular-nums">
          {sourceZone.label}: {liveSourceDate} {liveSourceTime} ·{" "}
          {targetZone.label}: {liveTargetDate} {liveTargetTime}
        </p>
        <p className="mt-1">
          {liveDeltaMin === 0
            ? "Both zones are at the same wall-clock time right now."
            : formatDelta(
                liveDeltaMin,
                sourceZone.label,
                targetZone.label,
              ) + " right now."}
        </p>
      </div>
    </section>
  );
}

function ConverterField({
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

function ConverterZoneCard({
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

// ── Shared sub-components ────────────────────────────────────────────────

function CronRow({
  snap,
  now,
}: {
  snap: CronTelemetrySnapshot;
  now: number;
}) {
  const last = snap.lastRun;
  const expectedFreshMs = CRON_FRESH_MS[snap.name];
  const ageMs = last ? now - last.ts : null;
  const fresh = ageMs != null && ageMs <= expectedFreshMs;
  const ok = !!last && last.ok && fresh;
  return (
    <li className="flex flex-col gap-1 rounded border border-border/30 bg-card/40 px-2.5 py-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 truncate">
          {ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-destructive" />
          )}
          <span className="truncate font-mono">{snap.name}</span>
        </span>
        <span
          className={cn(
            "flex items-center gap-1 font-mono text-[10px]",
            ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          <Clock className="h-3 w-3" />
          {last ? formatAge(ageMs ?? 0) : "never"}
        </span>
      </div>
      {last && (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pl-5 text-[10px] text-muted-foreground/80">
          <span className="font-bold uppercase tracking-wider">Status</span>
          <span
            className={cn(
              last.ok ? "text-emerald-400" : "text-destructive",
            )}
          >
            {last.ok ? "ok" : last.error || "error"}
          </span>
          <span className="font-bold uppercase tracking-wider">Took</span>
          <span className="tabular-nums">{last.durationMs}ms</span>
          {last.summary && Object.keys(last.summary).length > 0 && (
            <>
              <span className="font-bold uppercase tracking-wider">
                Summary
              </span>
              <span className="truncate font-mono">
                {summarize(last.summary)}
              </span>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function summarize(summary: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(summary)) {
    if (v == null || v === "") continue;
    if (typeof v === "object") parts.push(`${k}=${JSON.stringify(v)}`);
    else parts.push(`${k}=${String(v)}`);
  }
  return parts.join(" · ") || "—";
}

function formatHMSCompact(sec: number): string {
  if (sec < 0) return "no expire";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border/40 bg-card p-4">
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

// ── Time integrity ───────────────────────────────────────────────────────

/**
 * Diagnostic block confirming the server clock + Cairo offset machinery
 * is producing sensible values. Catches OS clock skew, stale ICU time
 * zone tables, or anything weird that would corrupt date keys.
 *
 * Computes:
 *   - Cairo offset right now (should be UTC+2 or UTC+3 depending on DST)
 *   - Hours-into-Cairo-day (via Date.now() − cairoMidnightMs(today))
 *   - Tomorrow's Cairo midnight (sanity check the rollover math)
 *
 * "Expected offset" hardcodes Egypt's DST rules so a mismatch flags
 * either a runtime ICU table issue or a real DST policy change.
 */
function TimeIntegrity({ now }: { now: number }) {
  const cairoOffsetMin = tzOffsetMinutes(ZONES.cairo.id, now);
  const cairoOffsetH = cairoOffsetMin / 60;
  const offsetLabel =
    cairoOffsetH === Math.floor(cairoOffsetH)
      ? `UTC+${cairoOffsetH}`
      : `UTC+${cairoOffsetH.toFixed(2)}`;

  // Egypt DST: last Friday April → last Thursday October.
  // We approximate: DST runs late-April through late-October.
  // Computed against UTC date (DST changes happen at Cairo midnight,
  // so UTC month is a close-enough proxy at this scale).
  const utcMonth = new Date(now).getUTCMonth(); // 0=Jan
  const expectedDST = utcMonth >= 3 && utcMonth <= 9; // April..October
  const expectedOffsetH = expectedDST ? 3 : 2;
  const offsetMatches = cairoOffsetH === expectedOffsetH;

  // Hours into Cairo day.
  const cairoDate = dateKeyInZone(ZONES.cairo.id, now);
  const cairoMidnightMs = tzWallClockToUtcMs(
    ZONES.cairo.id,
    cairoDate,
    "00:00",
  );
  const msIntoDay = now - cairoMidnightMs;
  const hoursIntoDay = msIntoDay / 3_600_000;
  const sensibleHours = hoursIntoDay >= 0 && hoursIntoDay < 24.001;

  const tomorrow = addDaysToKey(cairoDate, 1);
  const tomorrowMidnightMs = tzWallClockToUtcMs(
    ZONES.cairo.id,
    tomorrow,
    "00:00",
  );
  const dayLengthMs = tomorrowMidnightMs - cairoMidnightMs;
  const dayLengthHours = dayLengthMs / 3_600_000;
  // 23h or 25h on DST transition days; otherwise exactly 24h.
  const sensibleDayLength = dayLengthHours >= 23 && dayLengthHours <= 25;

  return (
    <>
      <Diag
        label="Cairo offset"
        ok={offsetMatches}
        detail={
          offsetMatches
            ? `${offsetLabel} (${expectedDST ? "EEST" : "EET"})`
            : `${offsetLabel} (expected UTC+${expectedOffsetH})`
        }
      />
      <Diag
        label="Hours into Cairo day"
        ok={sensibleHours}
        detail={`${hoursIntoDay.toFixed(2)}h`}
      />
      <Diag
        label="Cairo day length (today)"
        ok={sensibleDayLength}
        detail={
          dayLengthHours === 24
            ? "24h (no DST today)"
            : `${dayLengthHours.toFixed(2)}h (DST transition)`
        }
      />
      <Diag
        label="UTC time"
        ok
        detail={new Date(now).toISOString().replace("T", " ").slice(0, 19)}
      />
    </>
  );
}

function Diag({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-sm">
      <span className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        )}
        <span>{label}</span>
      </span>
      <span
        className={cn(
          "font-mono text-xs",
          ok ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {detail}
      </span>
    </li>
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
      className={cn(
        "rounded-lg border p-3",
        primary
          ? "border-primary/40 bg-primary/5"
          : "border-emerald-500/40 bg-emerald-500/5",
      )}
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
        className={cn(
          "mt-0.5 flex items-center gap-1.5 truncate text-sm font-bold",
          mono ? "font-mono tabular-nums" : "tabular-nums",
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />}
        {value}
      </dd>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-2xl border border-border/40 bg-card"
        />
      ))}
    </div>
  );
}

// ── Repair operations ─────────────────────────────────────────────────────
//
// Each repair lives in its own self-contained <RepairCard>. The card owns
// its confirming/busy/result state — the page-level component only hands
// down the `onError` and `onComplete` callbacks for global error
// surfacing + diagnostics refetch on success.
//
// Categories group related repairs:
//   • Index integrity — ZSET-vs-record reconciliation across every
//     feature index, plus the original notes-counts repair and the
//     pending-claim ZSET reconciliation.
//   • Orphan cleanup — auxiliary HASH keys (reactions, ritual
//     occurrences) that soft-delete intentionally doesn't preserve.
//     They linger forever without these tools.
//   • Obedience — the events↔audit ZSET drift repair.

function RepairOperations({
  onError,
  onComplete,
}: {
  onError: (msg: string) => void;
  onComplete: () => Promise<void> | void;
}) {
  return (
    <section className="space-y-5">
      <header className="flex items-center gap-2 pt-2">
        <Wrench className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Repair operations
        </h2>
      </header>

      <RepairCategory title="Index integrity">
        <RepairCard<RepairResult>
          title="Notes counts + pinned set"
          description="Recompute notes:count:{author} from the index, prune notes:pinned members whose underlying note is gone."
          icon={Wrench}
          tone="primary"
          cta="Reseed indexes"
          confirmCta="Confirm repair"
          action={repairIndexes}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) =>
            r.repaired ? (
              <RepairResultPanel
                rows={[
                  [
                    TITLE_BY_AUTHOR.T7SEN,
                    `${r.repaired.countT7SEN.before} → ${r.repaired.countT7SEN.after}`,
                  ],
                  [
                    TITLE_BY_AUTHOR.Besho,
                    `${r.repaired.countBesho.before} → ${r.repaired.countBesho.after}`,
                  ],
                  ["Stale pinned removed", `${r.repaired.pinnedRemoved}`],
                ]}
              />
            ) : null
          }
        />

        <RepairCard<ReconcileFeatureIndexesResult>
          title="Feature index ↔ record reconciliation"
          description="Walks every {feature}:index ZSET — notes, rules, tasks, ledger, permissions, rituals, milestones — and drops members whose backing record is missing."
          icon={Database}
          tone="primary"
          cta="Reconcile indexes"
          confirmCta="Confirm reconcile"
          action={reconcileFeatureIndexes}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) =>
            r.perFeature ? (
              <RepairResultPanel
                title={
                  r.totals
                    ? `Scanned ${r.totals.scanned} · removed ${r.totals.removed}`
                    : undefined
                }
                rows={r.perFeature
                  .filter(
                    (f: FeatureIndexDrift) =>
                      f.scanned > 0 || f.removed > 0,
                  )
                  .map((f: FeatureIndexDrift) => [
                    f.feature,
                    f.removed > 0
                      ? `${f.scanned} scanned, ${f.removed} removed`
                      : `${f.scanned} scanned, clean`,
                  ])}
              />
            ) : null
          }
        />

        <RepairCard<ReconcilePendingClaimsResult>
          title="Pending reward claims ZSET"
          description="Walks rewards:claims:pending — drops members whose reward:claim:{id} is missing OR whose status is no longer pending. Stops the stale-claim-nudge cron from firing on already-decided claims."
          icon={Gift}
          tone="primary"
          cta="Reconcile claims"
          confirmCta="Confirm reconcile"
          action={reconcilePendingRewardClaims}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) => {
            if (r.scanned == null) return null;
            const sample = r.removedSample ?? [];
            const missing = sample.filter(
              (s: PendingClaimDriftEntry) => s.reason === "missing",
            ).length;
            const decided = sample.filter(
              (s: PendingClaimDriftEntry) => s.reason === "decided",
            ).length;
            return (
              <RepairResultPanel
                rows={[
                  ["Scanned", `${r.scanned}`],
                  ["Removed", `${r.removed ?? 0}`],
                  ...((r.removed ?? 0) > 0
                    ? ([
                        [
                          "Breakdown",
                          `${missing} missing · ${decided} decided`,
                        ],
                      ] as [string, string][])
                    : []),
                ]}
              />
            );
          }}
        />
      </RepairCategory>

      <RepairCategory title="Orphan cleanup">
        <RepairCard<PruneOrphansResult>
          title="Orphaned reactions"
          description="Reactions are stored at reactions:{noteId} HASH. Soft-delete intentionally does NOT preserve them, so deleted notes leave reaction hashes behind. Pure waste."
          icon={Smile}
          tone="primary"
          cta="Prune reactions"
          confirmCta="Confirm prune"
          action={pruneOrphanedReactions}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) => {
            if (r.scanned == null) return null;
            return (
              <RepairResultPanel
                rows={[
                  ["Scanned", `${r.scanned}`],
                  ["Removed", `${r.removed ?? 0}`],
                  ...(r.truncated
                    ? ([["Truncated", "scan cap hit"]] as [string, string][])
                    : []),
                ]}
              />
            );
          }}
        />

        <RepairCard<PruneOrphansResult>
          title="Orphaned ritual occurrences"
          description="Per-day occurrence records at ritual:occurrence:{ritualId}:{dateKey} HASH. Linger forever after the parent ritual is deleted — the cron skips them, but they still occupy keys."
          icon={CalendarX}
          tone="primary"
          cta="Prune occurrences"
          confirmCta="Confirm prune"
          action={pruneOrphanedRitualOccurrences}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) => {
            if (r.scanned == null) return null;
            return (
              <RepairResultPanel
                rows={[
                  ["Scanned", `${r.scanned}`],
                  ["Removed", `${r.removed ?? 0}`],
                  ...(r.truncated
                    ? ([["Truncated", "scan cap hit"]] as [string, string][])
                    : []),
                ]}
              />
            );
          }}
        />
      </RepairCategory>

      <RepairCategory title="Obedience">
        <RepairCard<{
          success?: boolean;
          error?: string;
          summary?: ObedienceDriftRepairSummary;
        }>
          title="Events ↔ audit ZSET drift"
          description="Reconciles obedience:events:{author}:{weekKey} against obedience:audit:{author}:{weekKey} for both authors over the current week + 4 prior weeks. Re-adds audit entries lost to half-failed pipelines; removes audit orphans whose event vanished."
          icon={ShieldCheck}
          tone="amber"
          cta="Repair obedience drift"
          confirmCta="Confirm obedience repair"
          action={repairObedienceDrift}
          onError={onError}
          onComplete={onComplete}
          renderResult={(r) =>
            r.summary ? (
              <RepairResultPanel
                rows={[
                  [
                    "Events → audit re-added",
                    `${r.summary.totals.eventsToAuditAdded}`,
                  ],
                  [
                    "Audit orphans removed",
                    `${r.summary.totals.auditOrphansRemoved}`,
                  ],
                  ["Weeks scanned", `${r.summary.totals.weeksScanned}`],
                ]}
              />
            ) : null
          }
        />
      </RepairCategory>
    </section>
  );
}

function RepairCategory({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

type RepairTone = "primary" | "amber";

interface RepairToneClasses {
  border: string;
  bg: string;
  text: string;
  hoverBg: string;
}

const TONE_CLASSES: Record<RepairTone, RepairToneClasses> = {
  primary: {
    border: "border-primary/30",
    bg: "bg-primary/10",
    text: "text-primary",
    hoverBg: "hover:bg-primary/20",
  },
  amber: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    hoverBg: "hover:bg-amber-500/20",
  },
};

function RepairCard<R extends { error?: string }>({
  title,
  description,
  icon: Icon,
  tone,
  cta,
  confirmCta,
  action,
  onError,
  onComplete,
  renderResult,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  tone: RepairTone;
  cta: string;
  confirmCta: string;
  action: () => Promise<R>;
  onError: (msg: string) => void;
  onComplete: () => Promise<void> | void;
  renderResult: (result: R) => React.ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<R | null>(null);

  // Auto-cancel the confirming state after CONFIRM_TIMEOUT_MS so a
  // forgotten primed button doesn't fire when the user comes back.
  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const tones = TONE_CLASSES[tone];

  const handleConfirm = async () => {
    void vibrate([100, 50, 100], "heavy");
    setBusy(true);
    try {
      const r = await action();
      if (r.error) {
        onError(r.error);
      } else {
        setResult(r);
        setConfirming(false);
        await onComplete();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-2xl border border-border/40 bg-card p-4">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/40 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold">{title}</h4>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
      </header>

      {result && (
        <div className="mt-3">{renderResult(result)}</div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              onClick={() => {
                void vibrate(20, "light");
                setConfirming(false);
              }}
              disabled={busy}
              className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Icon className="h-3 w-3" />
              )}
              {confirmCta}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              void vibrate(50, "medium");
              setConfirming(true);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors active:scale-95",
              tones.border,
              tones.bg,
              tones.text,
              tones.hoverBg,
            )}
          >
            <Icon className="h-3 w-3" />
            {cta}
          </button>
        )}
      </div>
    </article>
  );
}

function RepairResultPanel({
  title,
  rows,
}: {
  title?: string;
  rows: [string, string][];
}) {
  return (
    <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs text-emerald-400">
      {title && <p className="mb-1 font-bold">{title}</p>}
      {rows.length === 0 ? (
        <p className="opacity-80">No drift detected.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(([label, value]) => (
            <li
              key={label}
              className="flex items-baseline justify-between gap-2"
            >
              <span className="opacity-80">{label}</span>
              <span className="tabular-nums">{value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
