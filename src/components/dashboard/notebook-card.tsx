"use client";

import Link from "next/link";
import { BookHeart, Feather, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function NotebookCard() {
  return (
    <Link href="/notes" className="block h-full group">
      <div
        className={cn(
          "relative flex h-full flex-col justify-between overflow-hidden",
          "rounded-3xl border border-white/5 bg-card/40 p-8",
          "backdrop-blur-xl shadow-xl shadow-black/20 transition-all duration-500",
          "hover:border-primary/40 hover:bg-card/60 hover:shadow-primary/5",
        )}
      >
        <div className="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-primary/10 blur-3xl transition-all duration-500 group-hover:bg-primary/20" />

        <div className="relative z-10 flex items-center justify-between">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
            Our Notebook
          </h2>
          <div className="rounded-full bg-primary/10 p-2 text-primary transition-transform duration-500 group-hover:scale-110 group-hover:-rotate-12">
            <BookHeart className="h-4 w-4" />
          </div>
        </div>

        <div className="relative z-10 mt-8 flex flex-col">
          <Feather className="mb-4 h-8 w-8 text-primary/80 transition-transform duration-500 group-hover:-translate-y-1" />
          <div className="flex items-end justify-between">
            <div>
              <h3 className="text-2xl font-bold tracking-tight">
                Poetry & Notes
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                A private place to write to each other.
              </p>
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary opacity-0 transition-all duration-300 group-hover:opacity-100 group-hover:translate-x-1">
              <ArrowRight className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
