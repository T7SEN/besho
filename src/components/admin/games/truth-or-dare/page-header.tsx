// src/components/admin/games/truth-or-dare/page-header.tsx
"use client";

import Link from "next/link";
import { ArrowLeft, MessageCircleQuestion, Sliders } from "lucide-react";
import { cn } from "@/lib/utils";

/** Header for `/admin/games/truth-or-dare`. Back link routes to the
 *  games admin landing; right-side "Weights" link routes to
 *  `/admin/rewards` (TOD weights live in the existing obedience-
 *  weights surface, not duplicated here). */
export function PageHeader() {
  return (
    <header className="mb-6">
      <Link
        href="/admin/games"
        className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
        Games admin
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <MessageCircleQuestion className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Truth or Dare admin
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Force-cancel, stat edits, history purge.
            </p>
          </div>
        </div>
        <Link
          href="/admin/rewards"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-card px-3 py-2",
            "text-[11px] font-bold uppercase tracking-wider text-muted-foreground",
            "transition-colors hover:border-primary/40 hover:text-foreground active:scale-[0.97]",
          )}
        >
          <Sliders className="h-3 w-3" />
          Weights
        </Link>
      </div>
    </header>
  );
}
