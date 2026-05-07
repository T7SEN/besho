"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarHeart, Loader2, Save } from "lucide-react";
import {
  getRelationshipDates,
  setRelationshipDates,
} from "@/app/actions/admin";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

interface Dates {
  relationshipStart: string | null;
  birthdayT7SEN: string | null;
  birthdayBesho: string | null;
}

export default function DatesPage() {
  const [dates, setDates] = useState<Dates | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [state, action, pending] = useActionState(setRelationshipDates, {
    success: undefined,
    error: undefined,
  });

  const refresh = useCallback(async () => {
    try {
      const result = await getRelationshipDates();
      if (result.error) {
        setReadError(result.error);
      } else if (result.dates) {
        setDates(result.dates);
        setReadError(null);
      }
    } catch {
      setReadError("Failed to load.");
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  useRefreshListener(refresh);

  useEffect(() => {
    if (state.success) {
      setFlash("Saved.");
      void hideKeyboard();
      void vibrate(50, "medium");
      void refresh();
      const id = setTimeout(() => setFlash(null), 2_500);
      return () => clearTimeout(id);
    }
    if (state.error) {
      void vibrate(80, "medium");
    }
  }, [state, refresh]);

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

      <h1 className="text-2xl font-bold tracking-tight">Anniversary &amp; birthdays</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Backs the dashboard <strong>CounterCard</strong> and birthday banners.
        Empty values clear the corresponding key.
      </p>

      {readError && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {readError}
        </div>
      )}

      {dates == null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <form action={action} className="space-y-4">
          <DateField
            id="relationshipStart"
            label="Relationship start"
            description="The CounterCard's anchor."
            initial={dates.relationshipStart}
          />
          <DateField
            id="birthdayT7SEN"
            label={`${TITLE_BY_AUTHOR.T7SEN}'s birthday`}
            description="Drives the dashboard birthday banner for Sir."
            initial={dates.birthdayT7SEN}
          />
          <DateField
            id="birthdayBesho"
            label={`${TITLE_BY_AUTHOR.Besho}'s birthday`}
            description="Drives the dashboard birthday banner for kitten."
            initial={dates.birthdayBesho}
          />

          {state.error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
            >
              {state.error}
            </p>
          )}
          {flash && (
            <p className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-2.5 text-xs text-emerald-400">
              {flash}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.99] disabled:opacity-60"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save dates
          </button>
        </form>
      )}
    </main>
  );
}

function DateField({
  id,
  label,
  description,
  initial,
}: {
  id: string;
  label: string;
  description: string;
  initial: string | null;
}) {
  return (
    <label className="block rounded-2xl border border-border/40 bg-card p-4">
      <span className="flex items-center gap-2">
        <CalendarHeart className="h-3.5 w-3.5 text-primary/70" />
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </span>
      <span className="mt-1 block text-[10px] text-muted-foreground/60">
        {description}
      </span>
      <input
        type="date"
        name={id}
        id={id}
        defaultValue={initial ?? ""}
        className="mt-3 w-full rounded-xl border border-border/40 bg-background px-3 py-2.5 text-sm focus-visible:border-primary focus-visible:outline-none"
      />
    </label>
  );
}
