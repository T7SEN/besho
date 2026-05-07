"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Hash,
  Loader2,
  RefreshCw,
  ShieldOff,
  Timer,
} from "lucide-react";
import {
  getCooldownState,
  type CooldownState,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

export default function CooldownsPage() {
  const [state, setState] = useState<CooldownState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const fetchState = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getCooldownState();
      if (result.error) {
        setError(result.error);
      } else if (result.state) {
        setState(result.state);
        setError(null);
        setNow(Date.now());
      }
    } catch {
      setError("Failed to read cooldown state.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchState();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchState]);

  // Tick once per second so the remaining-TTL labels count down
  // visibly without re-fetching from Redis.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useRefreshListener(fetchState);

  // Local time-elapsed since fetch — subtracted from each ttlSeconds
  // so the labels count down without polling Redis.
  const elapsedSec = state ? Math.max(0, Math.floor((now - state.generatedAt) / 1000)) : 0;

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
            void fetchState();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Re-scan
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Cooldowns &amp; rate-limits</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Read-only view of the TTL&apos;d state that&apos;s invisible in normal
        UIs: active reask blocks, safeword cooldowns, and the lifetime
        denied-hashes set size. Pre-curated for the common debug cases;
        for arbitrary keys use the Redis inspector.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!state ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-32 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <SafewordSection state={state} elapsedSec={elapsedSec} />
          <ReaskBlocksSection state={state} elapsedSec={elapsedSec} />
          <DeniedHashesSection state={state} />
        </div>
      )}
    </main>
  );
}

// ── Safeword cooldowns ──────────────────────────────────────────────────

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
          const remaining = c.ttlSeconds == null ? null : Math.max(0, c.ttlSeconds - elapsedSec);
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
                {active ? `${formatHMS(remaining)} left` : "not set"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Reask blocks ────────────────────────────────────────────────────────

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
        b.ttlSeconds < 0 ? b.ttlSeconds : Math.max(0, b.ttlSeconds - elapsedSec),
    }))
    .filter((b) => b.remaining !== 0)
    .sort((a, b) => {
      // Negative TTLs (no expire) sort to the bottom; otherwise by
      // remaining seconds desc so the longest-blocked rises to top.
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
                  : `${formatHMS(b.remaining)} left`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Denied-hashes SET ───────────────────────────────────────────────────

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
        after the per-hash reask-block expires — it&apos;s a persistent
        pattern record, not a cooldown.
      </p>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground/60">
        permissions:denied-hashes (SET, no TTL)
      </p>
    </section>
  );
}

function formatHMS(sec: number): string {
  if (sec < 0) return "no expire";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
