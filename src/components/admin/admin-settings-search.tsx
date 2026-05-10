"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import {
  ADMIN_SETTINGS,
  type AdminSettingEntry,
} from "@/lib/admin-settings-index";
import { vibrate } from "@/lib/haptic";

// Real-time settings search across `/admin/*` controls. Mirrors
// Windows / Android Settings: filters as you type against a static
// catalog (`ADMIN_SETTINGS`) — no server roundtrip, no submit button.
//
// Match algorithm: lowercase the query, split on whitespace; every
// term must hit at least one indexed field on a candidate. Per-term
// score weights:
//   • title         +10
//   • page/section  + 5
//   • description   + 3
//   • keywords      + 2
// Final entries sort by score desc, capped at RESULT_CAP. The "every
// term must hit" rule is the same shape Windows/Android uses — typing
// "rewards streak" excludes entries that only match one of the terms.

const RESULT_CAP = 20;

interface ScoredEntry {
  entry: AdminSettingEntry;
  score: number;
}

function scoreEntry(
  entry: AdminSettingEntry,
  terms: string[],
): number {
  if (terms.length === 0) return 0;
  const title = entry.title.toLowerCase();
  const description = entry.description.toLowerCase();
  const page = entry.page.toLowerCase();
  const section = (entry.section ?? "").toLowerCase();
  const keywords = entry.keywords.toLowerCase();
  let total = 0;
  for (const term of terms) {
    let termScore = 0;
    if (title.includes(term)) termScore += 10;
    if (page.includes(term) || section.includes(term)) termScore += 5;
    if (description.includes(term)) termScore += 3;
    if (keywords.includes(term)) termScore += 2;
    if (termScore === 0) return 0; // every term must hit somewhere
    total += termScore;
  }
  return total;
}

export function AdminSettingsSearch() {
  const [query, setQuery] = useState("");

  const results = useMemo<ScoredEntry[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored: ScoredEntry[] = [];
    for (const entry of ADMIN_SETTINGS) {
      const score = scoreEntry(entry, terms);
      if (score > 0) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, RESULT_CAP);
  }, [query]);

  const trimmed = query.trim();
  const showEmpty = trimmed.length > 0 && results.length === 0;

  return (
    <section className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          dir="auto"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search admin settings…"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Search admin settings"
          className="w-full rounded-full border border-border/40 bg-input/40 py-2 pl-10 pr-10 text-sm focus:border-primary focus:outline-none"
        />
        {trimmed.length > 0 && (
          <button
            type="button"
            onClick={() => {
              void vibrate(10, "light");
              setQuery("");
            }}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground transition-colors hover:text-foreground active:scale-95"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showEmpty && (
        <p className="mt-3 text-xs text-muted-foreground">
          No matching settings.
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-1.5" role="listbox">
          {results.map(({ entry }) => {
            const Icon = entry.Icon;
            return (
              <li key={entry.id} role="option" aria-selected="false">
                <Link
                  href={entry.href}
                  className="group flex items-start gap-3 rounded-lg border border-border/30 bg-card/40 px-3 py-2 transition-colors hover:border-primary/40 hover:bg-card/60 active:scale-[0.99]"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted/40 text-muted-foreground transition-colors group-hover:text-primary">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-foreground">
                        {entry.title}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/70">
                        {entry.page}
                        {entry.section ? ` · ${entry.section}` : ""}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">
                      {entry.description}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
