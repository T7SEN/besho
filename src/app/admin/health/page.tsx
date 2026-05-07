"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  getCronTelemetry,
  getHealthSnapshot,
  migrateObedienceBucketShift,
  repairIndexes,
  repairObedienceDrift,
  type BucketShiftMigrationResult,
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
  "ritual-windows": 5 * 60_000, // 5 min — runs every minute
  "obedience-sweep": 26 * 60 * 60_000, // 26h — runs daily
  "review-window-open": 26 * 60 * 60_000, // 26h — runs daily
} as const;

export default function HealthPage() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [cron, setCron] = useState<CronTelemetryResult | null>(null);
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

  const fetchHealth = useCallback(async () => {
    setRefreshing(true);
    try {
      const [healthResult, cronResult] = await Promise.all([
        getHealthSnapshot(),
        getCronTelemetry(),
      ]);
      if (healthResult.error) {
        setError(healthResult.error);
      } else if (healthResult.health) {
        setHealth(healthResult.health);
        setError(null);
      }
      setCron(cronResult);
      setNow(Date.now());
    } catch {
      setError("Failed to read health.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchHealth();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchHealth]);

  useRefreshListener(fetchHealth);

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
        await fetchHealth();
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
        await fetchHealth();
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
        await fetchHealth();
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
            void fetchHealth();
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

      <h1 className="text-2xl font-bold tracking-tight">Health &amp; repair</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Diagnostics + index reseed. Run repair after a manual purge that
        bypassed the soft-delete helpers, or if pin counts feel wrong.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!health ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
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
                health.fcm.tokensRegistered.T7SEN ? "registered" : "missing"
              }
            />
            <Diag
              label={`${TITLE_BY_AUTHOR.Besho} token`}
              ok={health.fcm.tokensRegistered.Besho}
              detail={
                health.fcm.tokensRegistered.Besho ? "registered" : "missing"
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
                    <li>Migrated (shifted +7d): {shiftResult.migratedKeys ?? 0}</li>
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
        </div>
      )}
    </main>
  );
}

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
          <span className={cn(last.ok ? "text-emerald-400" : "text-destructive")}>
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

