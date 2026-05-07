"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import {
  inspectRedisKey,
  type RedisInspectResult,
} from "@/app/actions/admin";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const SAMPLE_KEYS: ReadonlyArray<{ label: string; key: string }> = [
  { label: "Restraint flag", key: "mode:restraint:Besho" },
  { label: "Push token (Sir)", key: "push:fcm:T7SEN" },
  { label: "Push token (Besho)", key: "push:fcm:Besho" },
  { label: "Notes index", key: "notes:index" },
  { label: "Reward tiers", key: "rewards:tiers" },
  { label: "Streak (Besho)", key: "obedience:streak:Besho" },
  { label: "Streak threshold", key: "obedience:streak-threshold" },
  { label: "Multipliers", key: "obedience:multipliers" },
  { label: "Trash retention days", key: "trash:retention-days" },
  { label: "Activity log", key: "activity:log" },
  { label: "Auth failures", key: "auth:failures" },
];

function formatTtl(ttl: number | undefined): string {
  if (ttl === undefined) return "—";
  if (ttl === -2) return "key missing";
  if (ttl === -1) return "no expiry";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86_400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86_400)}d`;
}

export default function RedisInspectorPage() {
  const [keyInput, setKeyInput] = useState<string>("");
  const [result, setResult] = useState<RedisInspectResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const inspect = useCallback(
    async (k: string) => {
      const trimmed = k.trim();
      if (!trimmed) {
        setErr("Enter a key.");
        return;
      }
      setBusy(true);
      setErr(null);
      void vibrate(20, "light");
      const res = await inspectRedisKey(trimmed);
      setBusy(false);
      if (res.error) {
        setErr(res.error);
        setResult(null);
        return;
      }
      setResult(res);
    },
    [],
  );

  // Re-inspect the last-probed key on pull-to-refresh. No-op when
  // nothing has been probed yet.
  useRefreshListener(() => {
    if (keyInput.trim()) void inspect(keyInput);
  });

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

      <h1 className="text-2xl font-bold tracking-tight">Redis inspector</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Read-only probe by exact key. Returns type, TTL, and a capped
        preview. Will not list, set, delete, or expire — strictly
        diagnostic.
      </p>

      <section className="rounded-2xl border border-border/40 bg-card p-5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-[16rem]">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Key
            </span>
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void inspect(keyInput);
              }}
              placeholder="e.g. obedience:streak:Besho"
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => void inspect(keyInput)}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Inspect
          </button>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {SAMPLE_KEYS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => {
                setKeyInput(s.key);
                void inspect(s.key);
              }}
              className="rounded-full border border-border/40 bg-card px-2.5 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground active:scale-95"
            >
              {s.label}
            </button>
          ))}
        </div>

        {err && (
          <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {err}
          </div>
        )}

        {result && !err && <ResultBlock result={result} />}
      </section>
    </main>
  );
}

function ResultBlock({ result }: { result: RedisInspectResult }) {
  if (result.exists === false) {
    return (
      <div className="mt-4 rounded-lg border border-border/40 bg-card/50 p-3 text-xs text-muted-foreground">
        <code className="text-foreground">{result.key}</code> — key does not
        exist.
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border/40 bg-card/50 p-3 text-xs md:grid-cols-4">
        <Stat label="Key" value={result.key ?? "—"} mono />
        <Stat label="Type" value={result.type ?? "—"} />
        <Stat label="TTL" value={formatTtl(result.ttl)} />
        <Stat
          label="Size"
          value={result.size != null ? String(result.size) : "—"}
        />
      </div>

      {result.truncated && (
        <p className="text-[10px] font-bold uppercase tracking-widest text-amber-400">
          Truncated preview — full value not shown.
        </p>
      )}

      {result.type === "string" && result.stringValue !== undefined && (
        <PreBlock>{result.stringValue}</PreBlock>
      )}

      {result.type === "list" && result.listMembers && (
        <PreBlock>{result.listMembers.map((m) => `• ${m}`).join("\n")}</PreBlock>
      )}

      {result.type === "set" && result.setMembers && (
        <PreBlock>{result.setMembers.map((m) => `• ${m}`).join("\n")}</PreBlock>
      )}

      {result.type === "zset" && result.zsetMembers && (
        <PreBlock>
          {result.zsetMembers
            .map((m) => `${String(m.score).padStart(14)} ${m.member}`)
            .join("\n")}
        </PreBlock>
      )}

      {result.type === "hash" && result.hashEntries && (
        <PreBlock>
          {Object.entries(result.hashEntries)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n")}
        </PreBlock>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 truncate font-bold",
          mono && "font-mono text-[11px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function PreBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border/40 bg-card/30 p-3 text-[11px] leading-relaxed">
      {children}
    </pre>
  );
}
