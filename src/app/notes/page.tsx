"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  ArrowUp,
  Loader2,
  Send,
  Pencil,
  Check,
  X,
  History,
  ChevronDown,
  RefreshCw,
  PenLine,
  Copy,
  CheckCheck,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getNotes,
  saveNote,
  editNote,
  getCurrentAuthor,
  getLatestNoteTimestamp,
  getNoteCount,
  type Note,
} from "@/app/actions/notes";
import { MAX_CONTENT_LENGTH, PAGE_SIZE } from "@/lib/notes-constants";
import { START_DATE } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  const elem = el as HTMLElement;
  elem.style.height = "auto";
  elem.style.height = `${Math.max(el.scrollHeight, minHeight)}px`;
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
  const [filter, setFilter] = useState<Filter>("all");
  const [composeContent, setComposeContent] = useState("");
  const [newerNotesAvailable, setNewerNotesAvailable] = useState(false);
  const [justConfirmedId, setJustConfirmedId] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Derived — no separate state needed
  const charCount = composeContent.length;

  const [state, action, isPending] = useActionState(saveNote, null);
  const formRef = useRef<HTMLFormElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);

  // Ref so the polling interval can read latest notes without re-subscribing
  const notesRef = useRef<Note[]>([]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  // ── Initial load ──
  useEffect(() => {
    Promise.all([getNotes(0), getCurrentAuthor(), getNoteCount()]).then(
      ([{ notes: initial, hasMore: more }, author, count]) => {
        setNotes(initial);
        setHasMore(more);
        setCurrentAuthor(author);
        setNoteCount(count);
        setIsLoading(false);
      },
    );
  }, []);

  // ── Scroll-to-top visibility ──
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 500);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ── 30s polling for new notes ──
  useEffect(() => {
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const latest = await getLatestNoteTimestamp();
      const current = notesRef.current;
      if (latest && current.length > 0 && latest > current[0].createdAt) {
        setNewerNotesAvailable(true);
      }
    };

    const id = setInterval(poll, 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Post-save ──
  // DOM mutations happen synchronously; all setState calls are deferred into
  // the .then() callback to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!state?.success) return;

    formRef.current?.reset();
    if (composeRef.current) composeRef.current.style.height = "auto";
    window.scrollTo({ top: 0, behavior: "smooth" });

    getNotes(0).then(({ notes: refreshed, hasMore: more }) => {
      setNotes(refreshed);
      setHasMore(more);
      setPage(0);
      setOptimisticNotes([]);
      setComposeContent("");
      setNewerNotesAvailable(false);
      // Pulse the confirmed note briefly
      const confirmedId = refreshed[0]?.id ?? null;
      setJustConfirmedId(confirmedId);
      setTimeout(() => setJustConfirmedId(null), 2000);
    });

    getNoteCount().then(setNoteCount);
  }, [state]);

  // ── Optimistic submit ──
  const handleFormSubmit = useCallback(() => {
    const content = composeContent.trim();
    if (!content || !currentAuthor) return;

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

  // ── Refresh ──
  const handleRefresh = async () => {
    setIsRefreshing(true);
    const [{ notes: refreshed, hasMore: more }, count] = await Promise.all([
      getNotes(0),
      getNoteCount(),
    ]);
    setNotes(refreshed);
    setHasMore(more);
    setPage(0);
    setNoteCount(count);
    setNewerNotesAvailable(false);
    setIsRefreshing(false);
  };

  // ── Filter change ──
  const handleFilterChange = async (newFilter: Filter) => {
    setFilter(newFilter);

    if (newFilter !== "all" && hasMore) {
      setIsLoadingMore(true);
      let currentPage = page;
      let stillHasMore: boolean = hasMore;
      const allNotes = [...notes];

      while (stillHasMore) {
        currentPage++;
        const { notes: more, hasMore: moreExists } =
          await getNotes(currentPage);
        allNotes.push(...more);
        stillHasMore = moreExists;
      }

      setNotes(allNotes);
      setHasMore(false);
      setPage(currentPage);
      setIsLoadingMore(false);
    }
  };

  // ── Load more ──
  // Records scroll position before the update and restores it after so the
  // viewport doesn't jump when new items append below the fold.
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

  // ── Edit ──
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

  const allDisplayNotes = [...optimisticNotes, ...notes];
  const filteredNotes =
    filter === "all"
      ? allDisplayNotes
      : allDisplayNotes.filter((n) => n.author === filter);

  const isOverLimit = charCount > MAX_CONTENT_LENGTH;

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      {/* Ambient glows */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[150px]" />
      </div>

      {/* ── Scroll-to-top FAB ── */}
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
              "fixed bottom-8 right-6 z-50",
              "flex h-11 w-11 items-center justify-center",
              "rounded-full border border-white/10 bg-card/80 backdrop-blur-md",
              "text-muted-foreground shadow-xl shadow-black/30",
              "transition-colors hover:border-primary/30 hover:text-primary",
            )}
          >
            <ArrowUp className="h-4 w-4" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── New notes banner ── */}
      <AnimatePresence>
        {newerNotesAvailable && (
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -16 }}
            transition={{ type: "spring", bounce: 0.3, duration: 0.5 }}
            className="fixed left-1/2 top-4 z-50 -translate-x-1/2"
          >
            <button
              onClick={handleRefresh}
              className={cn(
                "flex items-center gap-2 rounded-full border border-primary/30",
                "bg-card/90 px-4 py-2 text-xs font-bold uppercase tracking-wider",
                "text-primary shadow-lg shadow-black/30 backdrop-blur-md",
                "transition-all hover:bg-primary/10",
              )}
            >
              <Sparkles className="h-3 w-3" />
              New notes — tap to refresh
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative z-10 mx-auto max-w-3xl space-y-10 pt-4">
        {/* ── Header ── */}
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
            aria-label="Refresh notes"
            className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary disabled:opacity-30"
          >
            <RefreshCw
              className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            />
          </button>
        </div>

        {/* ── Compose Form ── */}
        <form
          ref={formRef}
          action={action}
          onSubmit={handleFormSubmit}
          className="overflow-hidden rounded-3xl border border-white/5 bg-card/40 p-2 backdrop-blur-xl shadow-2xl shadow-black/40 transition-all focus-within:border-primary/30 focus-within:bg-card/60"
        >
          <textarea
            ref={composeRef}
            name="content"
            placeholder="Write a poem, a thought, or a letter…"
            required
            disabled={isPending || undefined}
            value={composeContent}
            rows={4}
            onChange={(e) => {
              setComposeContent(e.target.value);
              resizeTextarea(e.target);
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
                  {currentAuthor}
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

        {/* ── Filter Tabs ── */}
        {!isLoading && (
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
                    transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                  />
                )}
                <span className="relative z-10 flex items-center gap-1.5">
                  {f === "all" ? "All" : f}
                  {isLoadingMore && f === filter && (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── Timeline ── */}
        <div className="space-y-5 pb-24">
          {isLoading ? (
            <div className="space-y-5">
              {[...Array(3)].map((_, i) => (
                <NoteSkeleton key={i} />
              ))}
            </div>
          ) : filteredNotes.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <>
              {filteredNotes.map((note, index) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  index={index}
                  isLast={index === filteredNotes.length - 1}
                  currentAuthor={currentAuthor}
                  isOptimistic={note.id.startsWith("optimistic-")}
                  isJustConfirmed={note.id === justConfirmedId}
                  onEdit={handleNoteEdit}
                />
              ))}

              {/* Load more */}
              {filter === "all" && hasMore && (
                <div className="flex justify-center pt-2">
                  <button
                    ref={loadMoreRef}
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

              {/* End-of-timeline marker */}
              {!hasMore && filteredNotes.length > 0 && (
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

function EmptyState({ filter }: { filter: Filter }) {
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
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(note.content);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isPartner = note.author === "Besho";
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
        textareaRef.current.focus();
        const len = textareaRef.current.value.length;
        textareaRef.current.setSelectionRange(len, len);
        resizeTextarea(textareaRef.current, 112);
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

  const handleCopy = () => {
    navigator.clipboard.writeText(note.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: isOptimistic ? 0.6 : 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.06, 0.4), duration: 0.4 }}
      className={cn(
        "relative pl-8",
        // Connector line: only render when not the last item
        !isLast &&
          "before:absolute before:left-2.75 before:top-6 before:h-[calc(100%+1.25rem)] before:w-0.5 before:bg-border/40",
      )}
    >
      {/* Timeline dot */}
      <div
        className={cn(
          "absolute left-0 top-1.5 h-6 w-6 rounded-full border-4 border-background shadow-sm",
          isOptimistic && "animate-pulse",
          isPartner ? "bg-primary" : "bg-foreground/50",
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
          isJustConfirmed ? "border-primary/30" : "border-white/5",
        )}
      >
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Author */}
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-widest",
                isPartner ? "text-primary/80" : "text-foreground/60",
              )}
            >
              {note.author ?? "Unknown"}
            </span>

            <span className="text-[10px] text-muted-foreground/30">·</span>

            {/* Relative timestamp */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default text-[10px] font-semibold text-muted-foreground/60 transition-colors hover:text-muted-foreground">
                  {formatRelativeDate(note.createdAt)}
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="text-white border-white/10 bg-black/80 text-[10px] backdrop-blur-md"
              >
                {formatAbsoluteDate(note.createdAt)}
              </TooltipContent>
            </Tooltip>

            {/* Edited badge — tap/click to expand inline, works on mobile */}
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

          {/* Action buttons */}
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
                  onClick={handleEditStart}
                  aria-label="Edit note"
                  className="rounded-full p-1.5 text-muted-foreground/40 transition-all hover:bg-primary/10 hover:text-primary"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
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
              <div className="rounded-xl border border-border/30 bg-black/20 p-4 space-y-2">
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
                <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground/60">
                  {note.originalContent}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Note body */}
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
              <textarea
                ref={textareaRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value);
                  resizeTextarea(e.target, 112);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    handleCancel();
                  }
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleSave();
                  }
                }}
                disabled={isSaving || undefined}
                className={cn(
                  "w-full resize-none rounded-xl border border-primary/20",
                  "bg-black/20 p-4 font-serif text-base leading-relaxed text-foreground outline-none",
                  "transition-colors focus:border-primary/50",
                )}
              />

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
                    className={cn(
                      "flex items-center gap-1 rounded-full border border-border/40",
                      "px-3 py-1.5 text-xs font-semibold text-muted-foreground",
                      "transition-all hover:border-border hover:text-foreground disabled:opacity-50",
                    )}
                  >
                    <X className="h-3 w-3" />
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={
                      isSaving ||
                      editContent.trim() === "" ||
                      isOverLimit ||
                      undefined
                    }
                    className={cn(
                      "flex items-center gap-1 rounded-full bg-primary",
                      "px-3 py-1.5 text-xs font-semibold text-primary-foreground",
                      "transition-all hover:scale-105 disabled:opacity-50",
                    )}
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
            <motion.p
              key="content"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="whitespace-pre-wrap font-serif text-base leading-relaxed text-foreground/90"
            >
              {note.content}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
