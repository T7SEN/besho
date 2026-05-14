"use client";

// src/app/games/truth-or-dare/page.tsx
//
// Truth or Dare game page. Client component owning bundle state. Both
// authors see both directions of active play; either can issue when
// their outgoing slot is empty. Sir-only per-item delete on terminal-
// state history rows; restraint blocks Kitten from issuing + withdrawing.
//
// Composition: the active/issue/history/stats sections live as
// extracted components under `src/components/games/truth-or-dare/*`.
// This file owns:
//   - bundle fetch + state + refresh-on-event/pull
//   - 1Hz tick driving the countdown chips
//   - history pagination + per-row delete reconciliation
//   - subscriptions: useRefreshListener (pull-to-refresh) +
//     TOD_ARRIVED_EVENT (FCMProvider dispatches when a new challenge
//     push arrives while the app is foregrounded)

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { type Author } from "@/lib/constants";
import {
  TOD_ARRIVED_EVENT,
  TOD_HISTORY_PAGE_SIZE,
} from "@/lib/games/truth-or-dare-constants";
import {
  deleteChallenge,
  getChallengeHistory,
  getTodBundle,
  type TodBundle,
} from "@/app/actions/games/truth-or-dare";
import { PageHeader } from "@/components/games/truth-or-dare/page-header";
import { IncomingCard } from "@/components/games/truth-or-dare/incoming-card";
import { OutgoingCard } from "@/components/games/truth-or-dare/outgoing-card";
import { IssueForm } from "@/components/games/truth-or-dare/issue-form";
import { HistoryRow } from "@/components/games/truth-or-dare/history-row";
import { StatsStrip } from "@/components/games/truth-or-dare/stats-strip";

export default function TruthOrDarePage() {
  const [bundle, setBundle] = useState<TodBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [historyLoading, setHistoryLoading] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getTodBundle();
    setTimeout(() => {
      setBundle(next);
      setLoading(false);
    }, 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRefreshListener(refresh);

  // Subscribe to TOD_ARRIVED_EVENT — dispatched by `<FCMProvider>` when
  // an FCM with `data.kind === "tod_challenge"` arrives while the app
  // is foregrounded. The page is the listener (no dedicated overlay
  // component yet); on receipt we re-fetch the bundle so the new
  // challenge surfaces immediately rather than waiting for the next
  // pull-to-refresh.
  useEffect(() => {
    const handler = () => {
      void refresh();
    };
    const target = globalThis as unknown as {
      addEventListener: (type: string, handler: () => void) => void;
      removeEventListener: (type: string, handler: () => void) => void;
    };
    target.addEventListener(TOD_ARRIVED_EVENT, handler);
    return () => {
      target.removeEventListener(TOD_ARRIVED_EVENT, handler);
    };
  }, [refresh]);

  // 1Hz tick — drives the countdown chip on active cards. Gated on
  // there being any active record so we don't tick the tree when the
  // page is empty.
  useEffect(() => {
    if (!bundle?.incoming && !bundle?.outgoing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [bundle?.incoming, bundle?.outgoing]);

  const me = bundle?.me ?? null;
  const partner: Author | null =
    me === "T7SEN" ? "Besho" : me === "Besho" ? "T7SEN" : null;

  const handleLoadMoreHistory = async () => {
    if (!bundle || historyLoading) return;
    const nextOffset = bundle.history.length;
    if (nextOffset >= bundle.historyTotal) return;
    setHistoryLoading(true);
    const more = await getChallengeHistory(TOD_HISTORY_PAGE_SIZE, nextOffset);
    if (more.records.length > 0) {
      setBundle((prev) =>
        prev
          ? {
              ...prev,
              history: [...prev.history, ...more.records],
              historyTotal: more.total,
              reactions: { ...prev.reactions, ...more.reactions },
            }
          : prev,
      );
    }
    setHistoryLoading(false);
  };

  const handleDeleteHistory = async (id: string) => {
    const r = await deleteChallenge(id);
    if (r.success) {
      setBundle((prev) => {
        if (!prev) return prev;
        // Drop the deleted row's reactions slice — keeps the map from
        // accumulating stale entries across the session.
        const nextReactions = { ...prev.reactions };
        delete nextReactions[id];
        return {
          ...prev,
          history: prev.history.filter((c) => c.id !== id),
          historyTotal: Math.max(0, prev.historyTotal - 1),
          reactions: nextReactions,
        };
      });
    }
    return r;
  };

  /** Per-id reaction state setter. `<TodReactions>` calls this with
   *  the new HASH after a successful toggle (or with the snapshot on
   *  rollback). We update the bundle's reactions map in place so the
   *  re-render reflects the optimistic state without a full bundle
   *  re-fetch. */
  const handleReactionsChange = (id: string) =>
    (next: Record<string, string>) =>
      setBundle((prev) =>
        prev
          ? { ...prev, reactions: { ...prev.reactions, [id]: next } }
          : prev,
      );

  if (loading || !bundle || !me || !partner) {
    return (
      <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
        <PageHeader />
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <PageHeader />

      {/* Active section */}
      <section className="space-y-4">
        <AnimatePresence mode="wait" initial={false}>
          {bundle.incoming && (
            <IncomingCard
              key={`in-${bundle.incoming.id}`}
              challenge={bundle.incoming}
              now={now}
              onAction={refresh}
            />
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          {bundle.outgoing && (
            <OutgoingCard
              key={`out-${bundle.outgoing.id}`}
              challenge={bundle.outgoing}
              now={now}
              onAction={refresh}
            />
          )}
        </AnimatePresence>
      </section>

      {/* Issue form — disabled when an outgoing already exists */}
      <section className="mt-6">
        <IssueForm
          disabled={!!bundle.outgoing}
          partner={partner}
          onSuccess={refresh}
        />
      </section>

      {/* History */}
      <section className="mt-10 space-y-3">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            History
          </h2>
          {bundle.historyTotal > 0 && (
            <span className="text-[10px] font-semibold text-muted-foreground/60">
              {bundle.history.length} of {bundle.historyTotal}
            </span>
          )}
        </header>

        {bundle.history.length === 0 ? (
          <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
            No challenges yet.
          </p>
        ) : (
          <div className="space-y-2">
            {bundle.history.map((c) => (
              <HistoryRow
                key={c.id}
                challenge={c}
                me={me}
                now={now}
                reactions={bundle.reactions[c.id] ?? {}}
                onReactionsChange={handleReactionsChange(c.id)}
                onDelete={handleDeleteHistory}
              />
            ))}
            {bundle.history.length < bundle.historyTotal && (
              <button
                type="button"
                onClick={handleLoadMoreHistory}
                disabled={historyLoading || undefined}
                className={cn(
                  "w-full rounded-xl border border-white/10 bg-black/20 py-2.5 text-xs font-bold uppercase tracking-widest text-muted-foreground",
                  "transition-colors hover:border-white/20 hover:text-foreground active:scale-[0.99]",
                  "disabled:opacity-50",
                )}
              >
                {historyLoading ? (
                  <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" />
                ) : (
                  "Load more"
                )}
              </button>
            )}
          </div>
        )}
      </section>

      {/* Stats footer */}
      <section className="mt-10">
        <StatsStrip stats={bundle.stats} />
      </section>
    </main>
  );
}
