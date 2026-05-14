// src/components/games/truth-or-dare/stats-strip.tsx
"use client";

import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  DEFAULT_TOD_STATS,
  TOD_STAT_KEYS,
  TOD_STAT_LABELS,
  type TodStats,
} from "@/lib/games/truth-or-dare-constants";

interface StatsStripProps {
  stats: { T7SEN: TodStats; Besho: TodStats };
}

/** Both-author stats footer rendered at the bottom of the game page.
 *  Both authors see both columns (transparent — same as `/review`
 *  and `/rewards`). Falls back to `DEFAULT_TOD_STATS` zeros if a
 *  column is missing for any reason. */
export function StatsStrip({ stats }: StatsStripProps) {
  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
      <h2 className="mb-4 text-sm font-bold uppercase tracking-widest text-muted-foreground">
        Stats
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <StatsColumn author="T7SEN" stats={stats.T7SEN ?? DEFAULT_TOD_STATS} />
        <StatsColumn author="Besho" stats={stats.Besho ?? DEFAULT_TOD_STATS} />
      </div>
    </div>
  );
}

interface StatsColumnProps {
  author: Author;
  stats: TodStats;
}

/** One author's stats grid — two columns of counter cells driven by
 *  `TOD_STAT_KEYS`. The row count tracks the number of stat keys
 *  (currently 9, so 5 rows including the streak fields). Internal to
 *  StatsStrip — not consumed elsewhere. */
function StatsColumn({ author, stats }: StatsColumnProps) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-bold uppercase tracking-wider text-foreground/80">
        {TITLE_BY_AUTHOR[author]}
      </h3>
      <dl className="grid grid-cols-2 gap-2">
        {TOD_STAT_KEYS.map((key) => (
          <div
            key={key}
            className="rounded-lg border border-white/5 bg-black/20 px-3 py-2"
          >
            <dt className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground/60">
              {TOD_STAT_LABELS[key]}
            </dt>
            <dd className="text-base font-bold tabular-nums text-foreground">
              {stats[key] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
