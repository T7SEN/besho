// src/components/games/truth-or-dare/page-header.tsx
"use client";

import Link from "next/link";
import { ArrowLeft, MessageCircleQuestion } from "lucide-react";

/** Canonical page header for the user-facing TOD page. Mirrors the
 *  shape used on directive/punishment admin pages — `ArrowLeft` +
 *  group-hover translate on the back link. Back lands on the
 *  games launcher. */
export function PageHeader() {
  return (
    <header className="mb-6">
      <Link
        href="/games"
        className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
        Games
      </Link>
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
          <MessageCircleQuestion className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Truth or Dare</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One round: a truth and a dare. They pick.
          </p>
        </div>
      </div>
    </header>
  );
}
