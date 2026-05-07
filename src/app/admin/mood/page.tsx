"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Smile, X } from "lucide-react";
import {
  adminClearMoodForAuthor,
  adminClearStateForAuthor,
  adminSetMoodForAuthor,
  adminSetStateForAuthor,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  DAILY_MOOD_OPTIONS,
  DOM_STATE_OPTIONS,
  SUB_STATE_OPTIONS,
  type MoodOption,
} from "@/lib/mood-constants";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useRouter } from "next/navigation";

type Field = "mood" | "state";

const STATE_OPTIONS_BY_AUTHOR: Record<Author, MoodOption[]> = {
  T7SEN: DOM_STATE_OPTIONS,
  Besho: SUB_STATE_OPTIONS,
};

const STATE_LABEL_BY_AUTHOR: Record<Author, string> = {
  T7SEN: "Dom state",
  Besho: "Sub state",
};

export default function MoodOverridePage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  // Page is form-only with no displayed server state; refresh
  // re-renders any Server-Component dependencies.
  useRefreshListener(() => router.refresh());

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3_000);
  };

  const handleSet = async (
    author: Author,
    field: Field,
    value: string,
    label: string,
  ) => {
    void vibrate(50, "medium");
    setBusy(`${author}:${field}:${value}`);
    setError(null);
    setFlash(null);
    try {
      const action =
        field === "mood"
          ? adminSetMoodForAuthor
          : adminSetStateForAuthor;
      const result = await action(author, value);
      if (result.error) {
        setError(result.error);
      } else {
        showFlash(
          `Set ${TITLE_BY_AUTHOR[author]}'s ${field} to ${label}.`,
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const handleClear = async (author: Author, field: Field) => {
    void vibrate(50, "medium");
    setBusy(`${author}:${field}:clear`);
    setError(null);
    setFlash(null);
    try {
      const action =
        field === "mood"
          ? adminClearMoodForAuthor
          : adminClearStateForAuthor;
      const result = await action(author);
      if (result.error) {
        setError(result.error);
      } else {
        showFlash(
          `Cleared ${TITLE_BY_AUTHOR[author]}'s ${field} for today.`,
        );
      }
    } finally {
      setBusy(null);
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

      <h1 className="text-2xl font-bold tracking-tight">Mood &amp; state override</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Sir-only. Sets either author&apos;s mood or state for today (Cairo
        time). Bypasses the standard same-author check, but every override is
        logged to{" "}
        <Link href="/admin/activity" className="text-primary/80 hover:underline">
          activity
        </Link>
        . Mood is shared (10 daily options); state is per-author — Sir picks
        from Dom states, Besho from Sub states.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}
      {flash && (
        <div className="mb-4 rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-3 text-xs text-emerald-400">
          {flash}
        </div>
      )}

      <div className="space-y-4">
        {(["T7SEN", "Besho"] as const).map((author) => (
          <section
            key={author}
            className="rounded-2xl border border-border/40 bg-card p-4"
          >
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Smile className="h-4 w-4 text-primary/70" />
              {TITLE_BY_AUTHOR[author]}
            </h2>

            <Subsection
              title="Mood"
              gridCols={5}
              options={DAILY_MOOD_OPTIONS}
              author={author}
              field="mood"
              busy={busy}
              onSet={handleSet}
              onClear={handleClear}
            />

            <div className="mt-4 border-t border-border/30 pt-4">
              <Subsection
                title={STATE_LABEL_BY_AUTHOR[author]}
                gridCols={5}
                options={STATE_OPTIONS_BY_AUTHOR[author]}
                author={author}
                field="state"
                busy={busy}
                onSet={handleSet}
                onClear={handleClear}
              />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

interface SubsectionProps {
  title: string;
  gridCols: number;
  options: MoodOption[];
  author: Author;
  field: Field;
  busy: string | null;
  onSet: (
    author: Author,
    field: Field,
    value: string,
    label: string,
  ) => Promise<void>;
  onClear: (author: Author, field: Field) => Promise<void>;
}

function Subsection({
  title,
  gridCols,
  options,
  author,
  field,
  busy,
  onSet,
  onClear,
}: SubsectionProps) {
  const clearKey = `${author}:${field}:clear`;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70">
          {title}
        </h3>
        <button
          type="button"
          onClick={() => void onClear(author, field)}
          disabled={busy != null}
          className="flex items-center gap-1 rounded-full border border-border/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {busy === clearKey ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          Clear today
        </button>
      </div>
      <div
        className={cn(
          "grid gap-2",
          gridCols === 5 && "grid-cols-5",
          gridCols === 4 && "grid-cols-4",
          gridCols === 6 && "grid-cols-6",
        )}
      >
        {options.map((option) => {
          const key = `${author}:${field}:${option.emoji}`;
          const isBusy = busy === key;
          return (
            <button
              key={option.emoji}
              type="button"
              onClick={() =>
                void onSet(author, field, option.emoji, option.label)
              }
              disabled={busy != null}
              aria-label={`Set ${TITLE_BY_AUTHOR[author]}'s ${field} to ${option.label}`}
              title={option.label}
              className={cn(
                "flex aspect-square flex-col items-center justify-center gap-0.5",
                "rounded-xl border border-border/40 bg-background",
                "text-2xl transition-colors",
                "hover:border-primary/40 hover:bg-primary/5 active:scale-95",
                "disabled:opacity-40",
                isBusy && "border-primary",
              )}
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : (
                <>
                  <span>{option.emoji}</span>
                  <span className="line-clamp-1 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/70">
                    {option.label}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
