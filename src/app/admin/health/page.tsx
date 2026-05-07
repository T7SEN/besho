"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Hash,
  Hourglass,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Timer,
  Wrench,
  XCircle,
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
  migrateObedienceBucketShift,
  repairIndexes,
  repairObedienceDrift,
  type BucketShiftMigrationResult,
  type CooldownState,
  type CronTelemetryResult,
  type HealthSnapshot,
  type ObedienceDriftRepairSummary,
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
} as const;

export default function HealthPage() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [cron, setCron] = useState<CronTelemetryResult | null>(null);
  const [cooldown, setCooldown] = useState<CooldownState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [confirmingRepair, setConfirmingRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState<
    RepairResult["repaired"] | null
  >(null);

  const [confirmingObedience, setConfirmingObedience] = useState(false);
  const [obedienceRepairing, setObedienceRepairing] = useState(false);
  const [obedienceResult, setObedienceResult] =
    useState<ObedienceDriftRepairSummary | null>(null);

  const [confirmingShift, setConfirmingShift] = useState(false);
  const [shifting, setShifting] = useState(false);
  const [shiftResult, setShiftResult] =
    useState<BucketShiftMigrationResult | null>(null);

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
  // time tab.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!confirmingRepair) return;
    const id = setTimeout(
      () => setConfirmingRepair(false),
      CONFIRM_TIMEOUT_MS,
    );
    return () => clearTimeout(id);
  }, [confirmingRepair]);

  useEffect(() => {
    if (!confirmingObedience) return;
    const id = setTimeout(
      () => setConfirmingObedience(false),
      CONFIRM_TIMEOUT_MS,
    );
    return () => clearTimeout(id);
  }, [confirmingObedience]);

  useEffect(() => {
    if (!confirmingShift) return;
    const id = setTimeout(() => setConfirmingShift(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirmingShift]);

  const handleRepair = async () => {
    void vibrate([100, 50, 100], "heavy");
    setRepairing(true);
    setError(null);
    try {
      const result = await repairIndexes();
      if (result.error) {
        setError(result.error);
      } else {
        setRepairResult(result.repaired ?? null);
        setConfirmingRepair(false);
        await fetchAll();
      }
    } finally {
      setRepairing(false);
    }
  };

  const handleObedienceRepair = async () => {
    void vibrate([100, 50, 100], "heavy");
    setObedienceRepairing(true);
    setError(null);
    try {
      const result = await repairObedienceDrift();
      if (result.error) {
        setError(result.error);
      } else {
        setObedienceResult(result.summary ?? null);
        setConfirmingObedience(false);
        await fetchAll();
      }
    } finally {
      setObedienceRepairing(false);
    }
  };

  const handleBucketShift = async () => {
    void vibrate([120, 50, 120], "heavy");
    setShifting(true);
    setError(null);
    try {
      const result = await migrateObedienceBucketShift();
      if (result.error) {
        setError(result.error);
      } else {
        setShiftResult(result);
        setConfirmingShift(false);
        await fetchAll();
      }
    } finally {
      setShifting(false);
    }
  };

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

              {obedienceResult && (
                <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs text-emerald-400">
                  Obedience drift repaired:
                  <ul className="mt-1 space-y-0.5">
                    <li>
                      Events → audit re-added:{" "}
                      {obedienceResult.totals.eventsToAuditAdded}
                    </li>
                    <li>
                      Audit orphans removed:{" "}
                      {obedienceResult.totals.auditOrphansRemoved}
                    </li>
                    <li>
                      Weeks scanned: {obedienceResult.totals.weeksScanned}
                    </li>
                  </ul>
                </div>
              )}

              {repairResult && (
                <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs text-emerald-400">
                  Repaired:
                  <ul className="mt-1 space-y-0.5">
                    <li>
                      {TITLE_BY_AUTHOR.T7SEN}:{" "}
                      {repairResult.countT7SEN.before} →{" "}
                      {repairResult.countT7SEN.after}
                    </li>
                    <li>
                      {TITLE_BY_AUTHOR.Besho}:{" "}
                      {repairResult.countBesho.before} →{" "}
                      {repairResult.countBesho.after}
                    </li>
                    <li>Stale pinned removed: {repairResult.pinnedRemoved}</li>
                  </ul>
                </div>
              )}

              {shiftResult && (
                <div
                  className={cn(
                    "rounded-lg border p-3 text-xs",
                    shiftResult.alreadyDone
                      ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-300"
                      : "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
                  )}
                >
                  {shiftResult.alreadyDone ? (
                    <span>
                      Bucket shift migration already completed — sentinel
                      present, no-op.
                    </span>
                  ) : (
                    <>
                      Bucket shift migration completed:
                      <ul className="mt-1 space-y-0.5">
                        <li>Scanned: {shiftResult.scannedKeys ?? 0}</li>
                        <li>
                          Migrated (shifted +7d):{" "}
                          {shiftResult.migratedKeys ?? 0}
                        </li>
                        <li>Skipped: {shiftResult.skippedKeys ?? 0}</li>
                      </ul>
                    </>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                {confirmingShift ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void vibrate(20, "light");
                        setConfirmingShift(false);
                      }}
                      disabled={shifting}
                      className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleBucketShift()}
                      disabled={shifting}
                      className="flex items-center gap-1.5 rounded-full bg-rose-500 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-rose-500/90 active:scale-95 disabled:opacity-60"
                    >
                      {shifting ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wrench className="h-3 w-3" />
                      )}
                      Confirm bucket shift (+7d)
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void vibrate(50, "medium");
                      setConfirmingShift(true);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-rose-400 transition-colors hover:bg-rose-500/20 active:scale-95"
                  >
                    <Wrench className="h-3 w-3" />
                    Bucket shift (one-time)
                  </button>
                )}
                {confirmingObedience ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void vibrate(20, "light");
                        setConfirmingObedience(false);
                      }}
                      disabled={obedienceRepairing}
                      className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleObedienceRepair()}
                      disabled={obedienceRepairing}
                      className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 disabled:opacity-60"
                    >
                      {obedienceRepairing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3 w-3" />
                      )}
                      Confirm obedience repair
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void vibrate(50, "medium");
                      setConfirmingObedience(true);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 transition-colors hover:bg-amber-500/20 active:scale-95"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    Repair obedience drift
                  </button>
                )}
                {confirmingRepair ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void vibrate(20, "light");
                        setConfirmingRepair(false);
                      }}
                      disabled={repairing}
                      className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRepair()}
                      disabled={repairing}
                      className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 disabled:opacity-60"
                    >
                      {repairing ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Wrench className="h-3 w-3" />
                      )}
                      Confirm repair
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      void vibrate(50, "medium");
                      setConfirmingRepair(true);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary transition-colors hover:bg-primary/20 active:scale-95"
                  >
                    <Wrench className="h-3 w-3" />
                    Reseed indexes
                  </button>
                )}
              </div>
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
