"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Loader2 } from "lucide-react";
import { exportSnapshot } from "@/app/actions/admin";
import { vibrate } from "@/lib/haptic";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useRouter } from "next/navigation";

function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}`;
}

export default function ExportPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSize, setLastSize] = useState<number | null>(null);
  const router = useRouter();
  // Page is button-only with no displayed server state; refresh
  // re-renders any Server-Component dependencies.
  useRefreshListener(() => router.refresh());

  const handleExport = async () => {
    void vibrate(50, "medium");
    setBusy(true);
    setError(null);
    try {
      const result = await exportSnapshot();
      if (result.error || !result.payload) {
        setError(result.error ?? "Export failed.");
        return;
      }
      const json = JSON.stringify(result.payload, null, 2);
      setLastSize(json.length);

      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `our-space-export-${timestamp()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Export</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Generates a JSON snapshot of every feature&apos;s index plus per-record
        payloads. Pair with the trash window before destructive operations.
      </p>

      <div className="rounded-2xl border border-border/40 bg-card p-4">
        <h2 className="text-sm font-semibold">What&apos;s included</h2>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          <li>· Notes (records, reactions, pin counts)</li>
          <li>· Rules, Tasks, Ledger, Timeline milestones</li>
          <li>· Permissions (records, audits, quotas, auto-rules)</li>
          <li>· Rituals (records, occurrences, streaks)</li>
          <li>· Review weeks (per-author per-week records)</li>
          <li>· System (presence, FCM tokens, session epochs)</li>
        </ul>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {lastSize != null && !error && (
          <p className="mt-4 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-2.5 text-xs text-emerald-400">
            Exported. {(lastSize / 1024).toFixed(1)} KB.
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.99] disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Generate &amp; download
        </button>
      </div>
    </main>
  );
}
