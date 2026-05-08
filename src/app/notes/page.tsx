// src/app/notes/page.tsx
/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  History,
  Loader2,
  PenLine,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deleteNote,
  editNote,
  getCurrentAuthor,
  getNoteCount,
  getNoteCountByAuthor,
  getNotes,
  purgeAllNotes,
  saveNote,
  togglePinNote,
  type Note,
} from "@/app/actions/notes";
import {
  MAX_CONTENT_LENGTH,
  MAX_PINS_PER_AUTHOR,
  PAGE_SIZE,
} from "@/lib/notes-constants";
import {
  AUTHOR_COLORS,
  START_DATE,
  TITLE_BY_AUTHOR,
  type Author,
} from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { PurgeButton } from "@/components/admin/purge-button";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useNetwork } from "@/hooks/use-network";
import { useKeyboardHeight } from "@/hooks/use-keyboard";
import { writeToClipboard } from "@/lib/clipboard";
import { NoteReactions } from "@/components/notes/note-reactions";
import { logger } from "@/lib/logger";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

type Filter = "all" | "T7SEN" | "Besho";

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatRelativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatAbsoluteDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function resizeTextarea(el: HTMLTextAreaElement, minHeight = 120) {
  const target = el as unknown as {
    style: { height: string };
    scrollHeight: number;
  };
  target.style.height = "auto";
  target.style.height = `${Math.max(target.scrollHeight, minHeight)}px`;
}

/**
 * Sort: T7SEN-pinned at the top, then Besho-pinned, then everything else.
 * Within each pinned group, newest pin (`pinnedAt`) appears first; if a
 * legacy pinned record has no `pinnedAt`, fall back to `createdAt`. The
 * unpinned group keeps its incoming order (the index is already reverse-
 * chronological by `createdAt`).
 */
function sortPinnedFirst(notes: Note[]): Note[] {
  const sirPinned: Note[] = [];
  const kittenPinned: Note[] = [];
  const rest: Note[] = [];
  for (const n of notes) {
    if (n.pinned) {
      if (n.author === "T7SEN") sirPinned.push(n);
      else if (n.author === "Besho") kittenPinned.push(n);
      else rest.push(n);
    } else {
      rest.push(n);
    }
  }
  const byPinnedAtDesc = (a: Note, b: Note) =>
    (b.pinnedAt ?? b.createdAt) - (a.pinnedAt ?? a.createdAt);
  sirPinned.sort(byPinnedAtDesc);
  kittenPinned.sort(byPinnedAtDesc);
  return [...sirPinned, ...kittenPinned, ...rest];
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [optimisticNotes, setOptimisticNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [authorCounts, setAuthorCounts] = useState<{
    T7SEN: number;
    Besho: number;
  } | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [composeContent, setComposeContent] = useState("");
  const [justConfirmedId, setJustConfirmedId] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const charCount = composeContent.length;
  const [state, action, isPending] = useActionState(saveNote, null);
  const formRef = useRef<HTMLFormElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<Note[]>([]);
  const initialTimestampRef = useRef<number | null>(null);

  usePresence("/notes", !!currentAuthor);

  // ── Real network status via @capacitor/network ───────────────────────────
  // Drives the offline banner and disables the submit button when offline,
  // so users don't trigger doomed server actions.
  const { connected } = useNetwork();
  const isOffline = !connected;

  // ── Keyboard height via @capacitor/keyboard ──────────────────────────────
  const keyboardHeight = useKeyboardHeight();

  // 1. Create a reference to the wrapper
  const containerRef = useRef<HTMLDivElement>(null);

  // 2. The Auto-Scroll Logic
  useEffect(() => {
    // Only trigger when the keyboard actually opens
    if (keyboardHeight > 0 && containerRef.current) {
      // A slight 50ms delay allows the Framer Motion padding animation
      // to initialize before the browser calculates the scroll position.
      const timeoutId = setTimeout(() => {
        containerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "end", // 'end' aligns the bottom of the container perfectly above the keyboard
        });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [keyboardHeight]);

  // ── Pull-to-refresh / global refresh event ───────────────────────────────
  const silentRefresh = useCallback(async () => {
    try {
      const [{ notes: refreshed, hasMore: more }, count, counts] =
        await Promise.all([
          getNotes(0),
          getNoteCount(),
          getNoteCountByAuthor(),
        ]);
      setNotes((prev) => {
        const latestKnown = prev.length > 0 ? prev[0].createdAt : 0;
        const incoming = refreshed.filter((n) => n.createdAt > latestKnown);
        return incoming.length > 0 ? [...incoming, ...prev] : prev;
      });
      setHasMore(more);
      setNoteCount(count);
      setAuthorCounts(counts);
    } catch (err) {
      logger.error("[notes] Silent refresh failed:", err);
    }
  }, []);

  useRefreshListener(silentRefresh);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      getNotes(0),
      getCurrentAuthor(),
      getNoteCount(),
      getNoteCountByAuthor(),
    ]).then(([{ notes: initial, hasMore: more }, author, count, counts]) => {
      setNotes(initial);
      setHasMore(more);
      setCurrentAuthor(author);
      setNoteCount(count);
      setAuthorCounts(counts);
      setIsLoading(false);
    });
  }, []);

  // ── Scroll to top visibility ──────────────────────────────────────────────
  useEffect(() => {
    const onScroll = () => {
      setTimeout(() => setShowScrollTop(window.scrollY > 500), 0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ── SSE real-time stream ──────────────────────────────────────────────────
  useEffect(() => {
    let eventSource: EventSource | null = null;

    const connect = () => {
      eventSource = new EventSource("/api/notes/stream");

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data as string) as {
          type: string;
          timestamp?: number;
        };
        if (data.type === "init") {
          initialTimestampRef.current = data.timestamp ?? null;
        } else if (data.type === "update") {
          void silentRefresh();
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        setTimeout(connect, 5_000);
      };
    };

    connect();
    return () => eventSource?.close();
  }, [silentRefresh]);

  // ── Share target prefill ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const parts = [
      params.get("title"),
      params.get("text"),
      params.get("url"),
    ].filter(Boolean);
    if (parts.length === 0) return;
    const prefill = parts.join("\n");
    window.history.replaceState(null, "", "/notes");
    setTimeout(() => {
      setComposeContent(prefill);
      if (composeRef.current) {
        (composeRef.current as any).focus();
        resizeTextarea(composeRef.current);
      }
    }, 0);
  }, []);

  // ── Post-save ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!state?.success) return;

    (formRef.current as any)?.reset();
    if (composeRef.current) (composeRef.current as any).style.height = "auto";
    void hideKeyboard();
    window.scrollTo({ top: 0, behavior: "smooth" });

    Promise.all([getNotes(0), getNoteCount(), getNoteCountByAuthor()]).then(
      ([{ notes: refreshed, hasMore: more }, count, counts]) => {
        setNotes(refreshed);
        setHasMore(more);
        setPage(0);
        setOptimisticNotes([]);
        setComposeContent("");
        setNoteCount(count);
        setAuthorCounts(counts);
        const confirmedId = refreshed[0]?.id ?? null;
        setJustConfirmedId(confirmedId);
        setTimeout(() => setJustConfirmedId(null), 2000);
      },
    );
  }, [state]);

  // ── Optimistic submit ─────────────────────────────────────────────────────
  const handleFormSubmit = useCallback(() => {
    const content = composeContent.trim();
    if (!content || !currentAuthor) return;
    void vibrate();
    setOptimisticNotes((prev) => [
      {
        id: `optimistic-${Date.now()}`,
        content,
        author: currentAuthor,
        createdAt: Date.now(),
      },
      ...prev,
    ]);
  }, [composeContent, currentAuthor]);

  // ── Manual refresh (header button) ───────────────────────────────────────
  const handleRefresh = async () => {
    setIsRefreshing(true);
    const [{ notes: refreshed, hasMore: more }, count, counts] =
      await Promise.all([getNotes(0), getNoteCount(), getNoteCountByAuthor()]);
    setNotes(refreshed);
    setHasMore(more);
    setPage(0);
    setNoteCount(count);
    setAuthorCounts(counts);
    setIsRefreshing(false);
  };

  // ── Load all remaining pages ──────────────────────────────────────────────
  // Used by filter change AND search focus — both surfaces need the full
  // corpus loaded so the in-memory filter / substring match is honest.
  // Re-entrancy guarded by `isLoadingMore`; no-op when already exhausted.
  const loadAllRemaining = async () => {
    if (!hasMore || isLoadingMore) return;
    setIsLoadingMore(true);
    let currentPage = page;
    let stillHasMore: boolean = hasMore;
    const allNotes = [...notes];
    while (stillHasMore) {
      currentPage++;
      const { notes: more, hasMore: moreExists } = await getNotes(currentPage);
      allNotes.push(...more);
      stillHasMore = moreExists;
    }
    setNotes(allNotes);
    setHasMore(false);
    setPage(currentPage);
    setIsLoadingMore(false);
  };

  // ── Filter change ─────────────────────────────────────────────────────────
  const handleFilterChange = async (newFilter: Filter) => {
    setFilter(newFilter);
    setSearchQuery("");
    if (newFilter !== "all") {
      await loadAllRemaining();
    }
  };

  // ── Search focus ─────────────────────────────────────────────────────────
  // Eagerly drain pagination so substring search hits the full corpus, not
  // just the first PAGE_SIZE×N already-loaded pages.
  const handleSearchFocus = () => {
    void loadAllRemaining();
  };

  // ── Load more ─────────────────────────────────────────────────────────────
  const handleLoadMore = async () => {
    const scrollY = window.scrollY;
    const prevHeight = document.body.scrollHeight;
    setIsLoadingMore(true);
    const { notes: more, hasMore: stillMore } = await getNotes(page + 1);
    setNotes((prev) => [...prev, ...more]);
    setHasMore(stillMore);
    setPage((p) => p + 1);
    setIsLoadingMore(false);
    requestAnimationFrame(() => {
      const delta = document.body.scrollHeight - prevHeight;
      window.scrollTo({ top: scrollY + delta, behavior: "instant" });
    });
  };

  // ── Edit ──────────────────────────────────────────────────────────────────
  const handleNoteEdit = async (id: string, newContent: string) => {
    const result = await editNote(id, newContent);
    if (result.success) {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? {
                ...n,
                content: newContent.trim(),
                originalContent: n.originalContent ?? n.content,
                editedAt: Date.now(),
              }
            : n,
        ),
      );
    }
    return result;
  };

  // ── Reactions change ──────────────────────────────────────────────────────
  const handleReactionsChange = (
    id: string,
    reactions: Record<string, string>,
  ) => {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, reactions } : n)),
    );
  };

  // ── Delete (Sir-only) ─────────────────────────────────────────────────────
  const handleDelete = async (id: string) => {
    void vibrate(50, "medium");
    const snapshot = notes;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    const result = await deleteNote(id);
    if (result.error) {
      setNotes(snapshot);
      return result;
    }
    void Promise.all([getNoteCount(), getNoteCountByAuthor()]).then(
      ([count, counts]) => {
        setNoteCount(count);
        setAuthorCounts(counts);
      },
    );
    return result;
  };

  const handlePurge = async () => {
    const result = await purgeAllNotes();
    if (!result.error) {
      setNotes([]);
      setOptimisticNotes([]);
      setNoteCount(0);
      setAuthorCounts({ T7SEN: 0, Besho: 0 });
    }
    return result;
  };

  // ── Pin ───────────────────────────────────────────────────────────────────
  const handlePin = async (id: string) => {
    void vibrate(50, "light");
    const result = await togglePinNote(id);
    if (result.error) {
      void vibrate([60, 40, 60], "heavy");
      setPinError(result.error);
      return;
    }
    if (result.pinned !== undefined) {
      const pinnedAt = result.pinned ? Date.now() : undefined;
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, pinned: result.pinned, pinnedAt: pinnedAt ?? n.pinnedAt }
            : n,
        ),
      );
    }
  };

  // Auto-clear pin error toast after 3s.
  useEffect(() => {
    if (!pinError) return;
    const t = setTimeout(() => setPinError(null), 3000);
    return () => clearTimeout(t);
  }, [pinError]);

  // ── Derived display ───────────────────────────────────────────────────────
  const allDisplayNotes = [...optimisticNotes, ...notes];
  const filteredNotes =
    filter === "all"
      ? allDisplayNotes
      : allDisplayNotes.filter((n) => n.author === filter);

  const searchedNotes = searchQuery
    ? filteredNotes.filter((n) =>
        n.content.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : filteredNotes;

  // Sort: T7SEN-pinned (newest pinnedAt first) → Besho-pinned (newest first)
  // → unpinned (existing order, already reverse-chronological from the index).
  const sortedNotes = sortPinnedFirst(searchedNotes);

  // Per-author pin counts derived from the loaded notes. Pins always sit
  // at the top of the index after the new sort, so the first page always
  // contains all of them — counting from local state is correct.
  const pinCounts = (() => {
    const counts = { T7SEN: 0, Besho: 0 };
    for (const n of notes) {
      if (n.pinned && (n.author === "T7SEN" || n.author === "Besho")) {
        counts[n.author]++;
      }
    }
    return counts;
  })();

  const isOverLimit = charCount > MAX_CONTENT_LENGTH;

  return (
    <div className="relative min-h-screen bg-background p-4 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[150px]" />
      </div>

      {/* Scroll-to-top FAB */}
      <AnimatePresence>
        {showScrollTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 8 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.4 }}
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="Scroll to top"
            className={cn(
              "fixed bottom-8 right-6 z-50 flex h-11 w-11 items-center justify-center",
              "rounded-full border border-white/10 bg-card/80 backdrop-blur-md",
              "text-muted-foreground shadow-xl shadow-black/30",
              "transition-colors hover:border-primary/30 hover:text-primary",
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* Offline banner — informational only; no queueing happens */}
      <AnimatePresence>
        {isOffline && (
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            className="fixed left-1/2 top-4 z-50 -translate-x-1/2"
          >
            <div className="flex items-center gap-2 rounded-full border border-yellow-500/30 bg-card/90 px-4 py-2 text-xs font-bold uppercase tracking-wider text-yellow-500/80 shadow-lg backdrop-blur-md">
              <WifiOff className="h-3 w-3" />
              Offline
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pin cap / pin-error transient banner */}
      <AnimatePresence>
        {pinError && (
          <motion.div
            key="pin-error"
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            className="fixed left-1/2 top-4 z-50 -translate-x-1/2"
          >
            <div
              role="alert"
              className="flex items-center gap-2 rounded-full border border-destructive/30 bg-card/90 px-4 py-2 text-xs font-semibold text-destructive shadow-lg backdrop-blur-md"
            >
              <Pin className="h-3 w-3" />
              {pinError}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative z-10 mx-auto max-w-3xl space-y-10 pt-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            Back
          </Link>

          <div className="flex flex-col items-center gap-0.5">
            <h1 className="text-xl font-bold tracking-widest uppercase text-primary/80">
              Our Notebook
            </h1>
            {noteCount !== null && (
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                {noteCount} {noteCount === 1 ? "note" : "notes"}
              </span>
            )}
          </div>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing || undefined}
            aria-busy={isRefreshing || undefined}
            aria-label={isRefreshing ? "Refreshing notes" : "Refresh notes"}
            className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary disabled:opacity-30"
          >
            <RefreshCw
              className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            />
          </button>
        </div>

        {/* Author counts + per-author pin usage */}
        {authorCounts && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/40">
                {TITLE_BY_AUTHOR.T7SEN}: {authorCounts.T7SEN}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest",
                  pinCounts.T7SEN >= MAX_PINS_PER_AUTHOR
                    ? "text-destructive"
                    : "text-foreground/40",
                )}
                aria-label={`${TITLE_BY_AUTHOR.T7SEN} has ${pinCounts.T7SEN} of ${MAX_PINS_PER_AUTHOR} pins used`}
              >
                <Pin className="h-2.5 w-2.5" />
                {pinCounts.T7SEN}/{MAX_PINS_PER_AUTHOR}
              </span>
              <span className="text-[10px] text-muted-foreground/20">·</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-primary/50">
                {TITLE_BY_AUTHOR.Besho}: {authorCounts.Besho}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest",
                  pinCounts.Besho >= MAX_PINS_PER_AUTHOR
                    ? "text-destructive"
                    : "text-primary/50",
                )}
                aria-label={`${TITLE_BY_AUTHOR.Besho} has ${pinCounts.Besho} of ${MAX_PINS_PER_AUTHOR} pins used`}
              >
                <Pin className="h-2.5 w-2.5" />
                {pinCounts.Besho}/{MAX_PINS_PER_AUTHOR}
              </span>
            </div>
            {currentAuthor === "T7SEN" && (
              <PurgeButton
                label="Purge all notes"
                onPurge={handlePurge}
              />
            )}
          </div>
        )}

        {/* Compose form */}
        <form
          ref={formRef}
          action={action}
          onSubmit={handleFormSubmit}
          className="overflow-hidden rounded-3xl border border-white/5 bg-card/40 p-2 backdrop-blur-md shadow-xl shadow-black/30 transition-all focus-within:border-primary/30 focus-within:bg-card/60"
        >
          <div ref={containerRef}>
            <RichTextEditor
              ref={composeRef}
              name="content"
              placeholder="Write a poem, a thought, or a letter…"
              required
              disabled={isPending || undefined}
              value={composeContent}
              rows={4}
              onChange={(e) => {
                const target = e.target;
                setComposeContent(target.value);
                resizeTextarea(target, 120);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              className={cn(
                "w-full resize-none bg-transparent p-6 text-base outline-none",
                "font-serif leading-relaxed placeholder:text-muted-foreground/50",
              )}
            />
          </div>

          <div className="flex items-center justify-between border-t border-border/40 px-4 py-3">
            {currentAuthor ? (
              <div className="flex items-center gap-2 rounded-full bg-black/20 px-4 py-1.5">
                <div
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    currentAuthor === "Besho"
                      ? "bg-primary"
                      : "bg-foreground/50",
                  )}
                />
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                  {currentAuthor === "T7SEN" || currentAuthor === "Besho"
                    ? TITLE_BY_AUTHOR[currentAuthor]
                    : currentAuthor}
                </span>
              </div>
            ) : (
              <div className="h-8 w-24 animate-pulse rounded-full bg-muted/20" />
            )}

            <div className="flex items-center gap-3">
              <AnimatePresence>
                {charCount > 0 && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className={cn(
                      "text-xs font-medium tabular-nums transition-colors",
                      isOverLimit
                        ? "text-destructive"
                        : charCount > MAX_CONTENT_LENGTH * 0.85
                          ? "text-yellow-500/80"
                          : "text-muted-foreground/50",
                    )}
                  >
                    {charCount}/{MAX_CONTENT_LENGTH}
                  </motion.span>
                )}
              </AnimatePresence>

              {state?.error && (
                <p className="text-xs font-medium text-destructive">
                  {state.error}
                </p>
              )}

              <Button
                type="submit"
                disabled={
                  isPending ||
                  isOverLimit ||
                  !composeContent.trim() ||
                  isOffline ||
                  undefined
                }
                className="rounded-full px-5 transition-all hover:scale-105"
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    Save
                    <Send className="ml-1.5 h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>

          <p className="px-6 pb-3 text-[10px] font-medium uppercase tracking-widest text-muted-foreground/30">
            ⌘ + Enter to save
          </p>
        </form>

        {/* Filter + Search */}
        {!isLoading && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              {(["all", "T7SEN", "Besho"] as Filter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => handleFilterChange(f)}
                  disabled={isLoadingMore || undefined}
                  className={cn(
                    "relative rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider",
                    "transition-all disabled:opacity-50",
                    filter === f
                      ? "text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {filter === f && (
                    <motion.div
                      layoutId="filter-pill"
                      className="absolute inset-0 rounded-full bg-primary/80"
                      transition={{
                        type: "spring",
                        bounce: 0.2,
                        duration: 0.4,
                      }}
                    />
                  )}
                  <span className="relative z-10 flex items-center gap-1.5">
                    {f === "all" ? "All" : TITLE_BY_AUTHOR[f]}
                    {isLoadingMore && f === filter && (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    )}
                  </span>
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
              <input
                type="search"
                placeholder="Search notes…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={handleSearchFocus}
                inputMode="search"
                enterKeyHint="search"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label="Search notes"
                className={cn(
                  "w-full rounded-full border border-white/5 bg-card/40 py-2 pl-9 pr-10",
                  "text-xs placeholder:text-muted-foreground/30 outline-none backdrop-blur-sm",
                  "transition-colors focus:border-primary/30",
                )}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-white/5 hover:text-muted-foreground active:scale-95"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {searchQuery && (
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                {searchedNotes.length} result
                {searchedNotes.length !== 1 ? "s" : ""}
                {isLoadingMore && hasMore && " (loading more…)"}
              </p>
            )}
          </div>
        )}

        {/* Timeline */}
        <div className="space-y-5 pb-24">
          {isLoading ? (
            <div className="space-y-5">
              {[...Array(3)].map((_, i) => (
                <NoteSkeleton key={i} />
              ))}
            </div>
          ) : searchedNotes.length === 0 ? (
            <EmptyState filter={filter} searchQuery={searchQuery} />
          ) : (
            <>
              {sortedNotes.map((note, index) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  index={index}
                  isLast={index === sortedNotes.length - 1}
                  currentAuthor={currentAuthor}
                  isOptimistic={note.id.startsWith("optimistic-")}
                  isJustConfirmed={note.id === justConfirmedId}
                  onEdit={handleNoteEdit}
                  onReactionsChange={handleReactionsChange}
                  onPin={handlePin}
                  onDelete={handleDelete}
                />
              ))}

              {filter === "all" && !searchQuery && hasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    onClick={handleLoadMore}
                    disabled={isLoadingMore || undefined}
                    className={cn(
                      "flex items-center gap-2 rounded-full border border-border/40",
                      "bg-card/40 px-6 py-2.5 text-sm font-semibold text-muted-foreground",
                      "backdrop-blur-sm transition-all hover:border-primary/30 hover:text-foreground",
                      "disabled:opacity-50",
                    )}
                  >
                    {isLoadingMore ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                    Load {PAGE_SIZE} more
                  </button>
                </div>
              )}

              {!hasMore && searchedNotes.length > 0 && !searchQuery && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.3 }}
                  className="flex items-center gap-3 py-4"
                >
                  <div className="h-px flex-1 bg-border/30" />
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/30">
                    Since{" "}
                    {new Intl.DateTimeFormat("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    }).format(START_DATE)}
                  </span>
                  <div className="h-px flex-1 bg-border/30" />
                </motion.div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({
  filter,
  searchQuery,
}: {
  filter: Filter;
  searchQuery: string;
}) {
  if (searchQuery) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center gap-6 py-24 text-center"
      >
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
          <Search className="h-8 w-8 text-primary/30" />
        </div>
        <div className="space-y-2">
          <h3 className="text-base font-semibold text-foreground/50">
            No results for &quot;{searchQuery}&quot;
          </h3>
          <p className="text-sm text-muted-foreground/50">
            Try a different search term.
          </p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center gap-6 py-24 text-center"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
        <PenLine className="h-8 w-8 text-primary/30" />
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground/50">
          {filter === "all"
            ? "The notebook is empty"
            : `No notes from ${filter} yet`}
        </h3>
        <p className="text-sm text-muted-foreground/50">
          {filter === "all"
            ? "Be the first to write something."
            : "Notes written by this person will appear here."}
        </p>
      </div>
    </motion.div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function NoteSkeleton() {
  return (
    <div className="relative pl-8">
      <div className="absolute left-0 top-1.5 h-6 w-6 animate-pulse rounded-full bg-muted/30" />
      <div className="space-y-3 rounded-2xl border border-white/5 bg-card/20 p-6">
        <div className="flex items-center gap-2">
          <div className="h-2 w-10 animate-pulse rounded-full bg-muted/30" />
          <div className="h-2 w-20 animate-pulse rounded-full bg-muted/20" />
        </div>
        <div className="space-y-2 pt-1">
          <div className="h-4 w-full animate-pulse rounded bg-muted/20" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-muted/20" />
          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/15" />
        </div>
      </div>
    </div>
  );
}

// ─── NoteItem ─────────────────────────────────────────────────────────────────

function NoteItem({
  note,
  index,
  isLast,
  currentAuthor,
  isOptimistic,
  isJustConfirmed,
  onEdit,
  onPin,
  onReactionsChange,
  onDelete,
}: {
  note: Note;
  index: number;
  isLast: boolean;
  currentAuthor: string | null;
  isOptimistic: boolean;
  isJustConfirmed: boolean;
  onEdit: (
    id: string,
    content: string,
  ) => Promise<{ success?: boolean; error?: string }>;
  onReactionsChange: (id: string, reactions: Record<string, string>) => void;
  onPin: (id: string) => void;
  onDelete: (id: string) => Promise<{ success?: boolean; error?: string }>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(note.content);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isSir = currentAuthor === "T7SEN";

  useEffect(() => {
    if (!confirmingDelete) return;
    const id = setTimeout(() => setConfirmingDelete(false), 5000);
    return () => clearTimeout(id);
  }, [confirmingDelete]);

  const isEdited = !!note.editedAt;
  const isOwnNote = note.author === currentAuthor;
  const editCharCount = editContent.length;
  const isOverLimit = editCharCount > MAX_CONTENT_LENGTH;

  const handleEditStart = () => {
    setEditContent(note.content);
    setIsEditing(true);
    setShowOriginal(false);
    setTimeout(() => {
      if (textareaRef.current) {
        const target = textareaRef.current;
        target.focus();
        const len = target.value.length;
        target.setSelectionRange(len, len);
        resizeTextarea(target, 112);
      }
    }, 50);
  };

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditContent(note.content);
    setEditError(null);
  }, [note.content]);

  const handleSave = useCallback(async () => {
    if (editContent.trim() === note.content) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    const result = await onEdit(note.id, editContent);
    setIsSaving(false);
    if (result.error) {
      setEditError(result.error);
    } else {
      setIsEditing(false);
      setEditError(null);
    }
  }, [editContent, note.content, note.id, onEdit]);

  // Uses @capacitor/clipboard on native, navigator.clipboard on web
  const handleCopy = async () => {
    await writeToClipboard(note.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const keyboardHeight = useKeyboardHeight();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (keyboardHeight > 0 && containerRef.current) {
      const timeoutId = setTimeout(() => {
        containerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "end",
        });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [keyboardHeight]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: isOptimistic ? 0.6 : 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.06, 0.4), duration: 0.4 }}
      className={cn(
        "relative pl-8",
        !isLast &&
          "before:absolute before:left-2.75 before:top-6 before:h-[calc(100%+1.25rem)] before:w-0.5 before:bg-border/40",
      )}
    >
      {/* Timeline dot */}
      <div
        className={cn(
          "absolute left-0 top-1.5 h-6 w-6 rounded-full border-4 border-background shadow-sm",
          isOptimistic && "animate-pulse",
          note.pinned && "ring-1 ring-primary/40",
          note.author === "T7SEN" || note.author === "Besho"
            ? AUTHOR_COLORS[note.author as Author].bg
            : "bg-foreground/50",
        )}
      />

      {/* Card */}
      <motion.div
        animate={
          isJustConfirmed
            ? {
                boxShadow: [
                  "0 0 0 0 rgba(139,92,246,0)",
                  "0 0 0 6px rgba(139,92,246,0.25)",
                  "0 0 0 0 rgba(139,92,246,0)",
                ],
              }
            : {}
        }
        transition={{ duration: 1.5 }}
        className={cn(
          "group flex flex-col gap-3 rounded-2xl border bg-card/20 p-5 backdrop-blur-sm",
          "transition-colors hover:border-white/10",
          note.pinned ? "border-primary/20 bg-primary/5" : "border-white/5",
          isJustConfirmed && "border-primary/30",
        )}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {note.pinned && <Pin className="h-2.5 w-2.5 text-primary/60" />}
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest",
                note.author === "T7SEN" || note.author === "Besho"
                  ? AUTHOR_COLORS[note.author as Author].textSoft
                  : "text-foreground/60",
              )}
            >
              {note.author === "T7SEN" || note.author === "Besho"
                ? TITLE_BY_AUTHOR[note.author]
                : (note.author ?? "Unknown")}
            </span>

            <span className="text-[10px] text-muted-foreground/30">·</span>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-[10px] font-semibold text-muted-foreground/60 transition-colors hover:text-muted-foreground">
                  {formatRelativeDate(note.createdAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="border-white/10 bg-black/80 text-[10px] backdrop-blur-md"
              >
                {formatAbsoluteDate(note.createdAt)}
              </TooltipContent>
            </Tooltip>

            {isEdited && (
              <button
                onClick={() => setShowOriginal((v) => !v)}
                className={cn(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors",
                  showOriginal
                    ? "border-primary/30 bg-primary/5 text-primary"
                    : "border-border/40 bg-muted/20 text-muted-foreground hover:border-primary/30 hover:bg-primary/5",
                )}
              >
                <History className="h-2.5 w-2.5" />
                <span className="text-[9px] font-bold uppercase tracking-widest">
                  Edited
                </span>
              </button>
            )}
          </div>

          {!isEditing && !isOptimistic && (
            <div className="flex items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
              <button
                onClick={handleCopy}
                aria-label="Copy note"
                className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:bg-muted/20 hover:text-muted-foreground"
              >
                {copied ? (
                  <CheckCheck className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>

              {isOwnNote && (
                <button
                  onClick={() => onPin(note.id)}
                  aria-label={note.pinned ? "Unpin note" : "Pin note"}
                  className={cn(
                    "rounded-full p-1.5 transition-all",
                    note.pinned
                      ? "text-primary hover:bg-primary/10"
                      : "text-muted-foreground/40 hover:bg-primary/10 hover:text-primary",
                  )}
                >
                  {note.pinned ? (
                    <PinOff className="h-3.5 w-3.5" />
                  ) : (
                    <Pin className="h-3.5 w-3.5" />
                  )}
                </button>
              )}

              {isOwnNote && (
                <button
                  onClick={handleEditStart}
                  aria-label="Edit note"
                  className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:bg-primary/10 hover:text-primary"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}

              {isSir && !confirmingDelete && (
                <button
                  onClick={() => {
                    void vibrate(30, "light");
                    setConfirmingDelete(true);
                  }}
                  aria-label="Delete note"
                  className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:bg-destructive/10 hover:text-destructive active:scale-95"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}

              {isSir && confirmingDelete && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    disabled={isDeleting || undefined}
                    className="rounded-full border border-border/40 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground active:scale-95 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      void vibrate(50, "heavy");
                      setIsDeleting(true);
                      const r = await onDelete(note.id);
                      setIsDeleting(false);
                      if (!r.error) setConfirmingDelete(false);
                    }}
                    disabled={isDeleting || undefined}
                    className="flex items-center gap-1 rounded-full bg-destructive px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-destructive/90 active:scale-95 disabled:opacity-60"
                  >
                    {isDeleting ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-2.5 w-2.5" />
                    )}
                    Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Original content expander */}
        <AnimatePresence>
          {showOriginal && isEdited && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-2 rounded-xl border border-border/30 bg-black/20 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
                    Original
                  </p>
                  {note.editedAt && (
                    <p className="text-[9px] font-medium text-muted-foreground/40">
                      Edited {formatAbsoluteDate(note.editedAt)}
                    </p>
                  )}
                </div>
                <MarkdownRenderer
                  content={note.originalContent || ""}
                  className="text-sm leading-relaxed text-foreground/70"
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Body */}
        <AnimatePresence mode="wait">
          {isEditing ? (
            <motion.div
              key="editing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="space-y-3"
            >
              <div ref={containerRef}>
                <RichTextEditor
                  ref={textareaRef}
                  value={editContent}
                  onChange={(e) => {
                    const target = e.target;
                    setEditContent(target.value);
                    resizeTextarea(target, 112);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      handleCancel();
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void handleSave();
                    }
                  }}
                  disabled={isSaving || undefined}
                  className={cn(
                    "w-full resize-none rounded-xl border border-primary/20",
                    "bg-black/20 p-4 font-serif text-base leading-relaxed text-foreground outline-none",
                    "transition-colors focus:border-primary/50",
                  )}
                />
              </div>
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    "text-[10px] font-medium tabular-nums transition-colors",
                    isOverLimit
                      ? "text-destructive"
                      : editCharCount > MAX_CONTENT_LENGTH * 0.85
                        ? "text-yellow-500/80"
                        : "text-muted-foreground/30",
                  )}
                >
                  {editCharCount}/{MAX_CONTENT_LENGTH}
                </span>
                <div className="flex items-center gap-2">
                  {editError && (
                    <p className="text-xs font-medium text-destructive">
                      {editError}
                    </p>
                  )}
                  <button
                    onClick={handleCancel}
                    disabled={isSaving || undefined}
                    className="flex items-center gap-1 rounded-full border border-border/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-all hover:border-border hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-3 w-3" />
                    Cancel
                  </button>
                  <button
                    onClick={() => void handleSave()}
                    disabled={
                      isSaving ||
                      editContent.trim() === "" ||
                      isOverLimit ||
                      undefined
                    }
                    className="flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-all hover:scale-105 disabled:opacity-50"
                  >
                    {isSaving ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Check className="h-3 w-3" />
                    )}
                    Save
                  </button>
                </div>
              </div>
              <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/25">
                Esc to cancel · ⌘ + Enter to save
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <MarkdownRenderer
                content={note.content}
                className="text-base leading-relaxed text-foreground/90 prose-p:my-1"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Reactions footer */}
        {!isEditing && !isOptimistic && (
          <div className="border-t border-border/20 pt-2">
            <NoteReactions
              noteId={note.id}
              reactions={
                typeof note.reactions === "object" && note.reactions !== null
                  ? (note.reactions as Record<string, string>)
                  : {}
              }
              currentAuthor={currentAuthor}
              onReactionsChange={(reactions) =>
                onReactionsChange(note.id, reactions)
              }
            />
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
