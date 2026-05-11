"use client";

// src/components/admin/logs/search-bar.tsx
//
// Plain text search input for filtering log entries client-side.
// Parent owns the value + dispatch — this is a controlled wrapper
// with a search icon, clear button, and `dir="auto"` so RTL queries
// flip correctly (Arabic search terms are common).
//
// No debounce: we filter from an in-memory array of <500 entries, so
// per-keystroke is cheap.

import { Search, X } from "lucide-react";

export function SearchBar({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        dir="auto"
        spellCheck={false}
        autoComplete="off"
        className="w-full rounded-lg border border-border/40 bg-card py-1.5 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
