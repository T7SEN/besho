// src/components/admin/games/truth-or-dare/history-tab.tsx
"use client";

import { useMemo, useState } from "react";
import { Loader2, Search, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import {
  STATUS_CHIP,
  STATUS_LABELS,
  type TodChallenge,
} from "@/lib/games/truth-or-dare-constants";
import { formatRelative } from "@/lib/games/truth-or-dare-utils";
import {
  purgeAllTodChallenges,
  type TodAdminBundle,
} from "@/app/actions/admin";
import { deleteChallenge } from "@/app/actions/games/truth-or-dare";
import { PurgeButton } from "@/components/admin/purge-button";

/** Lower-cased substring check across every text field a challenge
 *  carries — prompts, response, all three reason fields. Returns true
 *  when the query is empty (no filter). */
function matchesQuery(challenge: TodChallenge, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [
    challenge.truthPrompt,
    challenge.darePrompt,
    challenge.response ?? "",
    challenge.refuseReason ?? "",
    challenge.withdrawReason ?? "",
    challenge.adminCancelReason ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

interface HistoryTabProps {
  bundle: TodAdminBundle;
  now: number;
  onAction: () => void;
}

/** Admin history list. Renders all loaded records with per-row
 *  soft-delete (terminal-state only), a search input that filters
 *  pure client-side across every text field, and a global purge-all
 *  button. Filtering is non-destructive — clearing the query restores
 *  the full list without a refetch. */
export function HistoryTab({ bundle, now, onAction }: HistoryTabProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const handleDelete = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    void vibrate(50, "heavy");
    const r = await deleteChallenge(id);
    if (r.success) onAction();
    setBusyId(null);
  };

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return bundle.history;
    return bundle.history.filter((c) => matchesQuery(c, q));
  }, [bundle.history, query]);

  const filtering = query.trim().length > 0;

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/70">
          {filtering ? (
            <>
              {filtered.length} match
              {filtered.length === 1 ? "" : "es"} ·{" "}
              {bundle.history.length} loaded of {bundle.historyTotal}
            </>
          ) : (
            <>
              All challenges · {bundle.history.length} loaded of{" "}
              {bundle.historyTotal}
            </>
          )}
        </h3>
        {bundle.historyTotal > 0 && (
          <PurgeButton
            label="Purge all challenges"
            onPurge={async () => {
              const r = await purgeAllTodChallenges();
              if (r.success) onAction();
              return r;
            }}
          />
        )}
      </header>

      {/* Search input — pure client-side filter across prompts +
          response + all reason fields. Disabled when nothing is
          loaded yet (the input is still rendered so the layout stays
          stable but it'd produce zero matches against an empty list). */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
        <input
          dir="auto"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by prompt, response, or reason…"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "w-full rounded-xl border border-white/10 bg-black/20 py-2 pl-9 pr-9 text-xs",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-primary/40 transition-colors",
          )}
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground/60",
              "transition-colors hover:bg-white/5 hover:text-foreground active:scale-95",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {bundle.history.length === 0 ? (
        <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
          No challenges yet.
        </p>
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
          No matches for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <AdminHistoryRow
              key={c.id}
              challenge={c}
              now={now}
              busy={busyId === c.id}
              onDelete={() => handleDelete(c.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface AdminHistoryRowProps {
  challenge: TodChallenge;
  now: number;
  busy: boolean;
  onDelete: () => void;
}

/** Compact admin history row — denser than the user-facing equivalent
 *  (single-line prompt preview via `line-clamp-2`, inline reasons).
 *  Internal to HistoryTab. */
function AdminHistoryRow({
  challenge,
  now,
  busy,
  onDelete,
}: AdminHistoryRowProps) {
  const ts =
    challenge.closedAt ??
    challenge.respondedAt ??
    challenge.pickedAt ??
    challenge.createdAt;
  const isTerminal =
    challenge.status !== "pending" && challenge.status !== "picked";
  return (
    <div className="group rounded-2xl border border-white/5 bg-card/20 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                STATUS_CHIP[challenge.status],
              )}
            >
              {STATUS_LABELS[challenge.status]}
            </span>
            {challenge.pick && (
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                {challenge.pick}
              </span>
            )}
            <span className="text-[10px] font-semibold text-muted-foreground/40">
              {TITLE_BY_AUTHOR[challenge.issuer]} →{" "}
              {TITLE_BY_AUTHOR[challenge.recipient]}
            </span>
            <span className="text-[10px] font-semibold text-muted-foreground/40">
              · {formatRelative(ts, now)}
            </span>
          </div>
          <p
            dir="auto"
            className="mt-1 line-clamp-2 text-xs text-foreground/80"
          >
            <span className="font-bold uppercase tracking-wider text-muted-foreground/60">
              T:{" "}
            </span>
            {challenge.truthPrompt}
            <span className="ml-2 font-bold uppercase tracking-wider text-muted-foreground/60">
              D:{" "}
            </span>
            {challenge.darePrompt}
          </p>
          {challenge.response && (
            <p
              dir="auto"
              className="mt-1 line-clamp-2 text-[11px] text-emerald-400/90"
            >
              ↩ {challenge.response}
            </p>
          )}
          {challenge.refuseReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-rose-400/80"
            >
              Refused: {challenge.refuseReason}
            </p>
          )}
          {challenge.adminCancelReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-muted-foreground/70"
            >
              Cancelled: {challenge.adminCancelReason}
            </p>
          )}
          {challenge.withdrawReason && (
            <p
              dir="auto"
              className="mt-1 text-[11px] italic text-muted-foreground/70"
            >
              Withdrawn: {challenge.withdrawReason}
            </p>
          )}
        </div>

        {isTerminal && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy || undefined}
            aria-label="Delete challenge"
            className={cn(
              "shrink-0 rounded-full p-2 text-muted-foreground/40 transition-all",
              "hover:bg-destructive/10 hover:text-destructive active:scale-95",
              "md:opacity-0 md:group-hover:opacity-100",
              "disabled:opacity-50",
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
