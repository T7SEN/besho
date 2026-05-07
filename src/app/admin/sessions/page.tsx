"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  getSessionEpochs,
  forceLogoutAuthor,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const CONFIRM_TIMEOUT_MS = 5_000;

function formatRevoked(ts: number): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString();
}

export default function SessionsPage() {
  const [epochs, setEpochs] = useState<Record<Author, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState<Author | null>(null);
  const [busy, setBusy] = useState<Author | null>(null);

  const fetchEpochs = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getSessionEpochs();
      if (result.error) {
        setError(result.error);
      } else if (result.epochs) {
        setEpochs(result.epochs);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchEpochs();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchEpochs]);

  useRefreshListener(fetchEpochs);

  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const handleFirstTap = (author: Author) => {
    void vibrate(50, "medium");
    setError(null);
    setConfirming(author);
  };

  const handleConfirm = async (author: Author) => {
    void vibrate([100, 50, 100], "heavy");
    setBusy(author);
    try {
      const result = await forceLogoutAuthor(author);
      if (result.error) {
        setError(result.error);
      } else {
        setConfirming(null);
        await fetchEpochs();
      }
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = () => {
    void vibrate(20, "light");
    setConfirming(null);
  };

  return (
    <main className="mx-auto max-w-xl p-4 pb-28 md:p-12 md:pb-32">
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
          onClick={() => void fetchEpochs()}
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

      <h1 className="text-2xl font-bold tracking-tight">Sessions</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Force-logout invalidates every JWT issued before now for that author.
        Existing devices will be redirected to login on their next request.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!epochs ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <ul className="space-y-3">
          {(["T7SEN", "Besho"] as const).map((author) => (
            <li
              key={author}
              className="rounded-2xl border border-border/40 bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">
                    {TITLE_BY_AUTHOR[author]}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Last revoked: {formatRevoked(epochs[author])}
                  </p>
                </div>
                {confirming === author ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleCancel}
                      disabled={busy === author}
                      className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleConfirm(author)}
                      disabled={busy === author}
                      className="flex items-center gap-1.5 rounded-full bg-destructive px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white transition-colors hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
                    >
                      {busy === author ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <KeyRound className="h-3 w-3" />
                      )}
                      Confirm logout
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleFirstTap(author)}
                    className="flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/20 active:scale-95"
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
    </main>
  );
}
