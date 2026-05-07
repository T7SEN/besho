"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CalendarRange,
  ClipboardList,
  FileText,
  Loader2,
  ScrollText,
  Search,
} from "lucide-react";
import {
  searchAcrossFeatures,
  type CrossFeatureHit,
  type CrossFeatureKind,
} from "@/app/actions/admin";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<CrossFeatureKind, string> = {
  note: "Note",
  rule: "Rule",
  task: "Task",
  ledger: "Ledger",
};

const KIND_ICON: Record<CrossFeatureKind, typeof FileText> = {
  note: FileText,
  rule: ScrollText,
  task: ClipboardList,
  ledger: CalendarRange,
};

const KIND_BORDER: Record<CrossFeatureKind, string> = {
  note: "border-sky-500/40 bg-sky-500/5",
  rule: "border-violet-500/40 bg-violet-500/5",
  task: "border-amber-500/40 bg-amber-500/5",
  ledger: "border-emerald-500/40 bg-emerald-500/5",
};

export function CrossFeatureSearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CrossFeatureHit[] | null>(null);
  const [scanned, setScanned] = useState<{
    notes: number;
    rules: number;
    tasks: number;
    ledger: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSearch = async () => {
    const q = query.trim();
    if (q.length < 2) {
      setErr("At least 2 characters.");
      return;
    }
    setBusy(true);
    setErr(null);
    void vibrate(20, "light");
    const result = await searchAcrossFeatures(q);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setHits(result.hits ?? []);
    setScanned(result.scanned ?? null);
  };

  return (
    <section className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSearch();
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, rules, tasks, ledger…"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            dir="auto"
            className="w-full rounded-full border border-border/40 bg-input/40 py-2 pl-10 pr-3 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={busy || query.trim().length < 2}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Search
        </button>
      </form>

      {err && (
        <p className="mt-2 text-xs text-destructive">{err}</p>
      )}

      {hits && hits.length === 0 && !err && (
        <p className="mt-3 text-xs text-muted-foreground">
          No matches.{" "}
          {scanned && (
            <span className="text-muted-foreground/60">
              Scanned {scanned.notes + scanned.rules + scanned.tasks + scanned.ledger} records.
            </span>
          )}
        </p>
      )}

      {hits && hits.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {hits.map((h) => {
            const Icon = KIND_ICON[h.kind];
            return (
              <li key={`${h.kind}:${h.id}`}>
                <Link
                  href={h.href}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs transition-colors hover:border-primary/40",
                    KIND_BORDER[h.kind],
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate font-semibold">
                      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span
                        className="rounded bg-card/40 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground"
                      >
                        {KIND_LABEL[h.kind]}
                      </span>
                      <span className="truncate" dir="auto">
                        {h.label}
                      </span>
                    </span>
                  </div>
                  <p
                    className="text-muted-foreground line-clamp-2"
                    dir="auto"
                  >
                    {h.preview}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
