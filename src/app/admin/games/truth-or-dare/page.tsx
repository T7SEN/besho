"use client";

// src/app/admin/games/truth-or-dare/page.tsx
//
// Sir-only admin for Truth or Dare. Tabs: Active / History / Stats.
// All actions go through `@/app/actions/admin/games` (Sir-only enforced
// server-side via requireSir). Weight tuning lives at /admin/rewards;
// the header surfaces a link there rather than duplicating the surface.
//
// Composition: each tab body lives as its own component under
// `src/components/admin/games/truth-or-dare/*`. This file owns:
//   - bundle fetch + state + refresh-on-pull
//   - tab selection state
//   - 1Hz tick driving countdown rendering in the Active tab

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import {
  getTodAdminBundle,
  type TodAdminBundle,
} from "@/app/actions/admin";
import { PageHeader } from "@/components/admin/games/truth-or-dare/page-header";
import {
  TabButton,
  type AdminTodTab,
} from "@/components/admin/games/truth-or-dare/tab-button";
import { ActiveTab } from "@/components/admin/games/truth-or-dare/active-tab";
import { HistoryTab } from "@/components/admin/games/truth-or-dare/history-tab";
import { StatsTab } from "@/components/admin/games/truth-or-dare/stats-tab";

export default function AdminTruthOrDarePage() {
  const [bundle, setBundle] = useState<TodAdminBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<AdminTodTab>("active");
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const r = await getTodAdminBundle();
    setTimeout(() => {
      if (r.bundle) setBundle(r.bundle);
      setLoading(false);
      setNow(Date.now());
    }, 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useRefreshListener(refresh);

  // 1Hz tick for the Active tab's countdown. Runs unconditionally —
  // the cost is negligible at admin's polling cadence and the tick
  // also keeps `formatRelative` timestamps fresh on the History tab.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (loading || !bundle) {
    return (
      <main className="mx-auto max-w-4xl p-4 pb-28 md:p-12 md:pb-32">
        <PageHeader />
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </main>
    );
  }

  const activeCount =
    (bundle.active.sirOutgoing ? 1 : 0) +
    (bundle.active.kittenOutgoing ? 1 : 0);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-28 md:p-12 md:pb-32">
      <PageHeader />

      {/* Tab strip */}
      <nav
        role="tablist"
        aria-label="Truth or Dare admin sections"
        className="mb-6 flex flex-wrap gap-2 rounded-full border border-white/5 bg-card/40 p-1"
      >
        <TabButton tab="active" current={tab} onSelect={setTab}>
          Active
          {activeCount > 0 && (
            <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
              {activeCount}
            </span>
          )}
        </TabButton>
        <TabButton tab="history" current={tab} onSelect={setTab}>
          History
          <span className="ml-1.5 text-[10px] font-bold text-muted-foreground/60">
            {bundle.historyTotal}
          </span>
        </TabButton>
        <TabButton tab="stats" current={tab} onSelect={setTab}>
          Stats
        </TabButton>
      </nav>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {tab === "active" && (
            <ActiveTab bundle={bundle} now={now} onAction={refresh} />
          )}
          {tab === "history" && (
            <HistoryTab bundle={bundle} now={now} onAction={refresh} />
          )}
          {tab === "stats" && <StatsTab bundle={bundle} onAction={refresh} />}
        </motion.div>
      </AnimatePresence>
    </main>
  );
}
