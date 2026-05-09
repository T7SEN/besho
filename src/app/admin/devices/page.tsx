"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  MapPin,
  RefreshCw,
  Smartphone,
  Trash2,
} from "lucide-react";
import {
  forceLogoutAuthor,
  getInspectorSnapshot,
  getSessionEpochs,
  listDevices,
  type DeviceListItem,
  type InspectorSnapshot,
} from "@/app/actions/admin";
import { forgetDevice } from "@/app/actions/devices";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const POLL_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 5_000;

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatAge(ts: number | null, now: number): string {
  if (ts == null) return "—";
  return formatRelative(ts, now);
}

function formatCoords(lat: number, lng: number): string {
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function mapsHref(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=14/${lat}/${lng}`;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceListItem[] | null>(null);
  const [snapshot, setSnapshot] = useState<InspectorSnapshot | null>(null);
  const [epochs, setEpochs] = useState<Record<Author, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Sessions section state — separate confirm/busy keys from device
  // forget so taps on one don't reset the other.
  const [confirmingLogout, setConfirmingLogout] = useState<Author | null>(null);
  const [logoutBusy, setLogoutBusy] = useState<Author | null>(null);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [inspectorResult, devicesResult, sessionsResult] =
        await Promise.all([
          getInspectorSnapshot(),
          listDevices(),
          getSessionEpochs(),
        ]);
      if (inspectorResult.error) {
        setError(inspectorResult.error);
      } else if (inspectorResult.snapshot) {
        setSnapshot(inspectorResult.snapshot);
      }
      if (devicesResult.error) {
        setError(devicesResult.error);
      } else {
        setDevices(devicesResult.devices ?? []);
      }
      if (sessionsResult.error) {
        setError(sessionsResult.error);
      } else if (sessionsResult.epochs) {
        setEpochs(sessionsResult.epochs);
      }
      if (
        !inspectorResult.error &&
        !devicesResult.error &&
        !sessionsResult.error
      ) {
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch deferred per AGENTS.md § 4 — direct setState in
    // an effect body trips react-hooks/set-state-in-effect.
    const t = setTimeout(() => void fetchAll(), 0);
    const id = setInterval(() => {
      // Skip the network round-trip when the tab is backgrounded —
      // saves Upstash REST calls and battery on Sir's phone. The tick
      // below still updates relative-time labels regardless.
      const doc = (
        globalThis as unknown as { document?: { visibilityState?: string } }
      ).document;
      if (doc?.visibilityState === "hidden") return;
      void fetchAll();
    }, POLL_MS);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [fetchAll]);

  useRefreshListener(fetchAll);

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  useEffect(() => {
    if (!confirmingLogout) return;
    const id = setTimeout(
      () => setConfirmingLogout(null),
      CONFIRM_TIMEOUT_MS,
    );
    return () => clearTimeout(id);
  }, [confirmingLogout]);

  const handleForceLogout = async (author: Author) => {
    void vibrate([100, 50, 100], "heavy");
    setLogoutBusy(author);
    try {
      const result = await forceLogoutAuthor(author);
      if (result.error) {
        setError(result.error);
      } else {
        setConfirmingLogout(null);
        await fetchAll();
      }
    } finally {
      setLogoutBusy(null);
    }
  };

  const handleForget = async (deviceId: string) => {
    void vibrate([100, 50, 100], "heavy");
    setBusy(deviceId);
    try {
      const result = await forgetDevice(deviceId);
      if (result.error) {
        setError(result.error);
      } else {
        setDevices((prev) =>
          prev ? prev.filter((d) => d.id !== deviceId) : prev,
        );
        setConfirming(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const grouped: Record<Author, DeviceListItem[]> = {
    T7SEN: [],
    Besho: [],
  };
  for (const d of devices ?? []) {
    grouped[d.author]?.push(d);
  }

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

      <h1 className="text-2xl font-bold tracking-tight">Devices &amp; sessions</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Live presence + FCM token state at the top, persistent device
        records below. Polls every {POLL_MS / 1000}s. Presence is fresh
        inside 12 seconds; device heartbeats land every 60s and stay
        &ldquo;online&rdquo; for 90s after the last ping.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* ── Right now (was /admin/inspector) ── */}
      <section className="mb-6">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Right now
        </h2>
        {!snapshot ? (
          <div className="grid gap-3 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-24 animate-pulse rounded-2xl border border-border/40 bg-card"
              />
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.presence.map((p) => (
                <div
                  key={p.author}
                  className="rounded-2xl border border-border/40 bg-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      {TITLE_BY_AUTHOR[p.author as Author]}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider",
                        p.fresh ? "text-emerald-400" : "text-muted-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          p.fresh
                            ? "bg-emerald-400 animate-pulse"
                            : "bg-muted-foreground/40",
                        )}
                      />
                      {p.fresh ? "live" : "stale"}
                    </span>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs">
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Page</dt>
                      <dd className="truncate text-right font-mono">
                        {p.page ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Last seen</dt>
                      <dd className="text-right">{formatAge(p.ts, tick)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {snapshot.push.map((p) => (
                <div
                  key={p.author}
                  className="rounded-2xl border border-border/40 bg-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      {TITLE_BY_AUTHOR[p.author as Author]} · FCM
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                        p.hasToken
                          ? "bg-emerald-400/10 text-emerald-400"
                          : "bg-destructive/10 text-destructive",
                      )}
                    >
                      {p.hasToken
                        ? `${p.tokenCount} device${p.tokenCount === 1 ? "" : "s"}`
                        : "missing"}
                    </span>
                  </div>
                  {p.previews.length > 0 ? (
                    <ul className="mt-3 space-y-1">
                      {p.previews.map((preview, i) => (
                        <li
                          key={`${p.author}:${preview}:${i}`}
                          className="truncate font-mono text-xs text-muted-foreground"
                        >
                          {preview}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
                      —
                    </p>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </section>

      {/* ── Sessions (force-logout per author) ── */}
      <section className="mb-6">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Sessions
        </h2>
        {!epochs ? (
          <div className="grid gap-2 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="h-20 animate-pulse rounded-2xl border border-border/40 bg-card"
              />
            ))}
          </div>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {(["T7SEN", "Besho"] as const).map((author) => (
              <li
                key={author}
                className="rounded-2xl border border-border/40 bg-card p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {TITLE_BY_AUTHOR[author]}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      Last revoked:{" "}
                      {epochs[author]
                        ? new Date(epochs[author]).toLocaleString()
                        : "Never"}
                    </p>
                  </div>
                  {confirmingLogout === author ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          void vibrate(20, "light");
                          setConfirmingLogout(null);
                        }}
                        disabled={logoutBusy === author}
                        className="rounded-full border border-border/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleForceLogout(author)}
                        disabled={logoutBusy === author}
                        className="flex items-center gap-1 rounded-full bg-destructive px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
                      >
                        {logoutBusy === author ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <KeyRound className="h-3 w-3" />
                        )}
                        Confirm
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        void vibrate(50, "medium");
                        setConfirmingLogout(author);
                      }}
                      className="flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
                    >
                      <KeyRound className="h-3 w-3" />
                      Force logout
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground/70">
          Force-logout invalidates every JWT issued before now for that
          author. Existing devices redirect to login on their next request.
        </p>
      </section>

      {/* ── Registered devices (existing list) ── */}
      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          Registered devices
        </h2>
        {devices == null ? (
          <DevicesSkeleton />
        ) : devices.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border/40 p-8 text-center text-sm text-muted-foreground">
            No devices have registered yet.
          </p>
        ) : (
          <div className="space-y-6">
            {(["T7SEN", "Besho"] as const).map((author) => (
              <section key={author}>
                <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  {TITLE_BY_AUTHOR[author]} ({grouped[author].length})
                </h3>
                {grouped[author].length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border/40 p-4 text-center text-xs text-muted-foreground/70">
                    No devices on file.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    <AnimatePresence initial={false}>
                      {grouped[author].map((d) => {
                        const isConfirming = confirming === d.id;
                        const isBusy = busy === d.id;
                        return (
                          <motion.li
                            key={d.id}
                            layout
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, x: -8 }}
                            className="rounded-xl border border-border/40 bg-card p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                                      d.isOnline
                                        ? "bg-emerald-400/10 text-emerald-400"
                                        : "bg-muted text-muted-foreground",
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        "h-1.5 w-1.5 rounded-full",
                                        d.isOnline
                                          ? "bg-emerald-400 animate-pulse"
                                          : "bg-muted-foreground/40",
                                      )}
                                    />
                                    {d.isOnline ? "online" : "offline"}
                                  </span>
                                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                    {d.platform === "web" ? (
                                      <Globe className="h-3 w-3" />
                                    ) : (
                                      <Smartphone className="h-3 w-3" />
                                    )}
                                    {d.platform}
                                  </span>
                                </div>
                                <p className="mt-1.5 truncate text-sm font-semibold">
                                  {d.fingerprint}
                                </p>
                                <dl className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                                  <Row
                                    label="Last seen"
                                    value={formatRelative(d.lastSeenAt, tick)}
                                  />
                                  {d.lastPage && (
                                    <Row
                                      label="Last page"
                                      value={d.lastPage}
                                      mono
                                    />
                                  )}
                                  {d.lastLat != null && d.lastLng != null && (
                                    <div className="flex items-baseline justify-between gap-2">
                                      <dt className="text-muted-foreground/70">
                                        Location
                                      </dt>
                                      <dd className="flex items-center gap-1 font-mono text-right">
                                        <MapPin className="h-3 w-3 text-primary/70" />
                                        <a
                                          href={mapsHref(d.lastLat, d.lastLng)}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="text-primary/90 hover:underline"
                                        >
                                          {formatCoords(d.lastLat, d.lastLng)}
                                        </a>
                                        <ExternalLink className="h-2.5 w-2.5 text-primary/50" />
                                        {d.lastLocationAt && (
                                          <span className="text-muted-foreground/50">
                                            (
                                            {formatRelative(
                                              d.lastLocationAt,
                                              tick,
                                            )}
                                            )
                                          </span>
                                        )}
                                      </dd>
                                    </div>
                                  )}
                                  <Row
                                    label="First seen"
                                    value={formatRelative(d.firstSeenAt, tick)}
                                  />
                                  <Row label="ID" value={d.id} mono />
                                </dl>
                              </div>
                            </div>
                            <div className="mt-3 flex items-center justify-end gap-1.5">
                              {isConfirming ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void vibrate(20, "light");
                                      setConfirming(null);
                                    }}
                                    disabled={isBusy}
                                    className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleForget(d.id)}
                                    disabled={isBusy}
                                    className="flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
                                  >
                                    {isBusy ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Trash2 className="h-3 w-3" />
                                    )}
                                    Confirm forget
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => {
                                    void vibrate(50, "medium");
                                    setConfirming(d.id);
                                  }}
                                  className="flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  Forget
                                </button>
                              )}
                            </div>
                          </motion.li>
                        );
                      })}
                    </AnimatePresence>
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function DevicesSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 w-24 rounded bg-muted-foreground/10" />
          <div className="h-32 animate-pulse rounded-xl border border-border/40 bg-card" />
        </div>
      ))}
    </div>
  );
}
