// src/app/protocol/page.tsx
"use client";

import {
  Suspense,
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  BookOpen,
  History,
  Loader2,
  Pencil,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getProtocolBundle,
  markProtocolSeen,
  revertProtocol,
  updateProtocol,
  type Protocol,
  type ProtocolBundle,
} from "@/app/actions/protocol";
import { getCurrentAuthor } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { vibrate } from "@/lib/haptic";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useKeyboardHeight } from "@/hooks/use-keyboard";
import { diffLines, diffStats, type DiffLine } from "@/lib/text-diff";

function formatRelative(timestamp: number, now: number): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return diff > 0 ? `in ${days}d` : `${days}d ago`;
  if (hours >= 1) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  return diff > 0 ? `in ${minutes}m` : `${minutes}m ago`;
}

const STARTER_TEMPLATE = `# Protocol

## Hard limits
- ...

## Soft limits
- ...

## Safe-word
- Word: ...
- Effect: ...

## Escalation procedure
1. ...

## Vocabulary
- **Term** — meaning.
`;

/** Parses ## headings out of markdown content for the sticky TOC. */
function getH2Headings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      const text = line.slice(3).trim();
      if (text.length > 0) headings.push(text);
    }
  }
  return headings;
}

/** Scrolls the first <h2> with matching text content into view. */
function scrollToHeading(text: string): void {
  const doc = (globalThis as unknown as { document: Document }).document;
  const headings = doc.querySelectorAll("h2");
  for (const h of Array.from(headings)) {
    if (h.textContent?.trim() === text) {
      h.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
  }
}

type PageMode = "read" | "edit" | "diff" | "history";

/**
 * Default export — Suspense wrapper. `useSearchParams()` inside the
 * inner component forces a Suspense boundary at the page level under
 * Next 16's static rendering rules; without one, the prerender bails
 * out of the whole route. The fallback is intentionally minimal —
 * the inner component shows its own skeleton once it mounts, which
 * happens on the very next tick.
 */
export default function ProtocolPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <ProtocolPageInner />
    </Suspense>
  );
}

function ProtocolPageInner() {
  const [bundle, setBundle] = useState<ProtocolBundle>({
    current: null,
    history: [],
    lastSeen: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [mode, setMode] = useState<PageMode>("read");
  const [revertingIndex, setRevertingIndex] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  // Captured ONCE on mount, never updated by refresh. Used to compute
  // whether the diff banner should appear.
  const [initialLastSeen, setInitialLastSeen] = useState<number | null>(null);

  const searchParams = useSearchParams();

  const [updateState, updateAction, isUpdatePending] = useActionState(
    updateProtocol,
    null,
  );

  usePresence("/protocol", !!currentAuthor);

  const keyboardHeight = useKeyboardHeight();
  const editContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (keyboardHeight > 0 && editContainerRef.current) {
      const timeoutId = setTimeout(() => {
        editContainerRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "end",
        });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [keyboardHeight]);

  // Refresh handler — fetches current+history but PRESERVES original
  // lastSeen value so the diff banner doesn't disappear when SSE pushes
  // an unrelated update through.
  const handleRefresh = useCallback(async () => {
    const data = await getProtocolBundle();
    setTimeout(() => {
      setBundle((prev) => ({
        current: data.current,
        history: data.history,
        lastSeen: prev.lastSeen,
      }));
    }, 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getProtocolBundle(), getCurrentAuthor()]).then(
      ([data, author]) => {
        setBundle(data);
        setInitialLastSeen(data.lastSeen);
        setCurrentAuthor(author);
        setIsLoading(false);
        // Fire-and-forget — order matters only relative to the
        // initialLastSeen capture above, which has already happened.
        void markProtocolSeen();
      },
    );
  }, []);

  // Deep-link focus — when navigated from a permission card's protocol
  // ref chip (`/protocol?focus=Heading%20Name`), scroll to that heading
  // after the markdown is in the DOM. Small timeout because content
  // mounts on the same tick that isLoading flips to false.
  useEffect(() => {
    if (isLoading) return;
    if (mode !== "read") return;
    const focus = searchParams.get("focus");
    if (!focus) return;
    const timeoutId = setTimeout(() => {
      scrollToHeading(focus);
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [isLoading, mode, searchParams]);

  useEffect(() => {
    if (!updateState?.success) return;
    setTimeout(() => {
      setMode("read");
      void vibrate(50, "medium");
    }, 0);
    void handleRefresh();
  }, [updateState, handleRefresh]);

  const isT7SEN = currentAuthor === "T7SEN";
  // Destructure once for stable useMemo deps. ESLint's exhaustive-deps
  // lint flags `bundle.current` as a "mutable nested value" — passing
  // the parent state slot instead resolves it cleanly. Locals also
  // make the JSX terser below.
  const { current, history } = bundle;
  const hasContent = !!current?.content;

  const hasUnreadChanges = useMemo(() => {
    if (!current || initialLastSeen === null) return false;
    return current.updatedAt > initialLastSeen;
  }, [current, initialLastSeen]);

  // Find the version that was current at initialLastSeen — i.e. the
  // most recent history entry whose updatedAt <= initialLastSeen.
  // Falls back to oldest available entry when lastSeen predates
  // everything in the (capped) history list.
  const previousVersion = useMemo<Protocol | null>(() => {
    if (!hasUnreadChanges || initialLastSeen === null) return null;
    if (history.length === 0) return null;
    for (const h of history) {
      if (h.updatedAt <= initialLastSeen) return h;
    }
    return history[history.length - 1] ?? null;
  }, [history, initialLastSeen, hasUnreadChanges]);

  const headings = useMemo(
    () => (current ? getH2Headings(current.content) : []),
    [current],
  );

  const handleRevert = useCallback(
    async (index: number) => {
      void vibrate(50, "medium");
      setRevertingIndex(index);
      setRevertError(null);
      try {
        const result = await revertProtocol(index);
        if (result.error) {
          setRevertError(result.error);
        } else {
          setMode("read");
          await handleRefresh();
        }
      } finally {
        setTimeout(() => setRevertingIndex(null), 0);
      }
    },
    [handleRefresh],
  );

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-purple-500/5 blur-[150px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl space-y-6 pt-4">
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
              Protocol
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {mode === "edit"
                ? "Editing"
                : mode === "diff"
                  ? "Changes"
                  : mode === "history"
                    ? "History"
                    : hasContent
                      ? "Reference"
                      : "Not set"}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {mode === "read" && hasContent && history.length > 0 && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setMode("history");
                }}
                aria-label="View history"
                className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {mode === "read" && isT7SEN && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setMode("edit");
                }}
                aria-label="Edit protocol"
                className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
            {mode !== "read" && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setMode("read");
                  setRevertError(null);
                }}
                aria-label="Back to current"
                className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Sticky TOC — read mode only, when there are 2+ ## headings */}
        {mode === "read" && hasContent && headings.length >= 2 && (
          <TOCBar headings={headings} />
        )}

        {/* "Show changes since last view" pill — read mode, when applicable */}
        {mode === "read" && hasUnreadChanges && previousVersion && (
          <UnreadDiffPill
            onClick={() => {
              void vibrate(30, "light");
              setMode("diff");
            }}
          />
        )}

        {/* Body */}
        <div className="space-y-6 pb-24">
          {isLoading ? (
            <ProtocolSkeleton />
          ) : mode === "edit" && isT7SEN ? (
            <EditForm
              initialContent={current?.content ?? STARTER_TEMPLATE}
              dispatch={updateAction}
              state={updateState}
              isPending={isUpdatePending}
              onCancel={() => setMode("read")}
              keyboardHeight={keyboardHeight}
              keyboardContainerRef={editContainerRef}
            />
          ) : mode === "diff" && current && previousVersion ? (
            <DiffView
              oldVersion={previousVersion}
              newVersion={current}
              now={now}
            />
          ) : mode === "history" ? (
            <HistoryView
              current={current}
              history={history}
              isT7SEN={isT7SEN}
              now={now}
              revertingIndex={revertingIndex}
              revertError={revertError}
              onRevert={handleRevert}
            />
          ) : !hasContent ? (
            <EmptyState isT7SEN={isT7SEN} />
          ) : (
            <ReadView protocol={current!} now={now} />
          )}
        </div>
      </div>
    </div>
  );
}

function TOCBar({ headings }: { headings: string[] }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="sticky top-2 z-20 -mx-2"
    >
      <div className="overflow-x-auto rounded-full border border-white/5 bg-card/60 px-2 py-1.5 backdrop-blur-xl shadow-lg shadow-black/30">
        <div className="flex gap-1 whitespace-nowrap">
          {headings.map((h) => (
            <button
              key={h}
              onClick={() => {
                void vibrate(20, "light");
                scrollToHeading(h);
              }}
              className={cn(
                "shrink-0 rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-widest",
                "text-muted-foreground/60 transition-colors hover:bg-primary/10 hover:text-primary",
              )}
            >
              {h}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function UnreadDiffPill({ onClick }: { onClick: () => void }) {
  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-center gap-2 rounded-full",
        "border border-primary/20 bg-primary/10 px-4 py-2.5 text-xs font-bold uppercase tracking-widest",
        "text-primary transition-all hover:bg-primary/15",
      )}
    >
      <Sparkles className="h-3.5 w-3.5" />
      Show changes since your last view
    </motion.button>
  );
}

function ProtocolSkeleton() {
  return (
    <div className="rounded-3xl border border-white/5 bg-card/20 p-6 backdrop-blur-xl">
      <div className="space-y-3">
        <div className="h-5 w-2/5 animate-pulse rounded bg-muted/30" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-muted/20" />
        <div className="h-3 w-3/5 animate-pulse rounded bg-muted/20" />
        <div className="mt-6 h-4 w-1/3 animate-pulse rounded bg-muted/30" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted/20" />
      </div>
    </div>
  );
}

function EmptyState({ isT7SEN }: { isT7SEN: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-6 py-24 text-center"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
        <BookOpen className="h-8 w-8 text-primary/30" />
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground/50">
          No protocol set
        </h3>
        <p className="text-sm text-muted-foreground/50">
          {isT7SEN
            ? `Set the protocol — hard limits, soft limits, safeword, escalation, vocabulary. ${TITLE_BY_AUTHOR.Besho} will be notified.`
            : `${TITLE_BY_AUTHOR.T7SEN} hasn't set the protocol yet.`}
        </p>
      </div>
    </motion.div>
  );
}

function ReadView({ protocol, now }: { protocol: Protocol; now: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >
      <div className="rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-xl shadow-2xl shadow-black/40">
        <MarkdownRenderer
          content={protocol.content}
          className={cn(
            "text-base leading-relaxed text-foreground/90",
            "prose-headings:text-primary/80 prose-headings:font-bold",
            "prose-headings:tracking-wide prose-headings:uppercase",
            "prose-h1:text-lg prose-h2:text-sm prose-h3:text-xs",
            "prose-h2:scroll-mt-20",
            "prose-strong:text-foreground prose-em:text-foreground/80",
            "prose-li:my-0.5 prose-ul:my-2 prose-ol:my-2",
            "prose-p:my-2",
          )}
        />
      </div>

      <p className="text-right text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
        Updated by {TITLE_BY_AUTHOR[protocol.updatedBy]} ·{" "}
        {formatRelative(protocol.updatedAt, now)}
      </p>
    </motion.div>
  );
}

function DiffView({
  oldVersion,
  newVersion,
  now,
}: {
  oldVersion: Protocol;
  newVersion: Protocol;
  now: number;
}) {
  const diff = useMemo(
    () => diffLines(oldVersion.content, newVersion.content),
    [oldVersion, newVersion],
  );
  const stats = useMemo(() => diffStats(diff), [diff]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-4"
    >
      <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-card/40 px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 backdrop-blur-xl">
        <span>
          {formatRelative(oldVersion.updatedAt, now)} →{" "}
          {formatRelative(newVersion.updatedAt, now)}
        </span>
        <span className="flex gap-3">
          <span className="text-emerald-400">+{stats.added}</span>
          <span className="text-rose-400">−{stats.removed}</span>
        </span>
      </div>

      <div className="overflow-hidden rounded-3xl border border-white/5 bg-card/40 backdrop-blur-xl shadow-2xl shadow-black/40">
        <div className="font-mono text-[12px] leading-relaxed">
          {diff.map((line, i) => (
            <DiffLineRow key={i} line={line} />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const display = line.text.length === 0 ? "\u00A0" : line.text;
  if (line.type === "add") {
    return (
      <div className="flex items-stretch border-l-2 border-emerald-500/60 bg-emerald-500/10">
        <span className="select-none px-2 py-0.5 text-emerald-400/80">+</span>
        <span className="flex-1 whitespace-pre-wrap py-0.5 pr-3 text-emerald-200/90">
          {display}
        </span>
      </div>
    );
  }
  if (line.type === "remove") {
    return (
      <div className="flex items-stretch border-l-2 border-rose-500/60 bg-rose-500/10">
        <span className="select-none px-2 py-0.5 text-rose-400/80">−</span>
        <span className="flex-1 whitespace-pre-wrap py-0.5 pr-3 text-rose-200/80 line-through decoration-rose-500/40">
          {display}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-stretch border-l-2 border-transparent">
      <span className="select-none px-2 py-0.5 text-muted-foreground/30">
        &nbsp;
      </span>
      <span className="flex-1 whitespace-pre-wrap py-0.5 pr-3 text-foreground/60">
        {display}
      </span>
    </div>
  );
}

function HistoryView({
  current,
  history,
  isT7SEN,
  now,
  revertingIndex,
  revertError,
  onRevert,
}: {
  current: Protocol | null;
  history: Protocol[];
  isT7SEN: boolean;
  now: number;
  revertingIndex: number | null;
  revertError: string | null;
  onRevert: (index: number) => void;
}) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="space-y-3"
    >
      {current && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-primary/80">
            Current
          </p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Updated by {TITLE_BY_AUTHOR[current.updatedBy]} ·{" "}
            {formatRelative(current.updatedAt, now)}
          </p>
        </div>
      )}

      {history.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground/50">
          No previous versions yet.
        </p>
      ) : (
        history.map((entry, index) => {
          const isExpanded = expandedIndex === index;
          const isReverting = revertingIndex === index;
          return (
            <div
              key={`${entry.updatedAt}-${index}`}
              className="rounded-2xl border border-white/5 bg-card/30 backdrop-blur-xl"
            >
              <button
                onClick={() => {
                  void vibrate(20, "light");
                  setExpandedIndex(isExpanded ? null : index);
                }}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                    Version {history.length - index}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground/70">
                    {TITLE_BY_AUTHOR[entry.updatedBy]} ·{" "}
                    {formatRelative(entry.updatedAt, now)}
                  </p>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                  {isExpanded ? "Hide" : "View"}
                </span>
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="border-t border-white/5 px-4 py-4">
                      <MarkdownRenderer
                        content={entry.content}
                        className={cn(
                          "text-sm leading-relaxed text-foreground/80",
                          "prose-headings:text-primary/70 prose-headings:font-bold",
                          "prose-headings:tracking-wide prose-headings:uppercase",
                          "prose-h1:text-base prose-h2:text-xs prose-h3:text-[10px]",
                          "prose-li:my-0.5 prose-ul:my-1.5 prose-ol:my-1.5",
                          "prose-p:my-1.5",
                        )}
                      />
                      {isT7SEN && (
                        <div className="mt-4 flex justify-end">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={isReverting || revertingIndex !== null}
                            onClick={() => onRevert(index)}
                            className="rounded-full px-4 text-xs"
                          >
                            {isReverting ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <>
                                <RotateCcw className="mr-1.5 h-3 w-3" />
                                Revert to this version
                              </>
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })
      )}

      {revertError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {revertError}
        </p>
      )}
    </motion.div>
  );
}

function EditForm({
  initialContent,
  dispatch,
  state,
  isPending,
  onCancel,
  keyboardHeight,
  keyboardContainerRef,
}: {
  initialContent: string;
  dispatch: (formData: FormData) => void;
  state: { success?: boolean; error?: string } | null;
  isPending: boolean;
  onCancel: () => void;
  keyboardHeight: number;
  keyboardContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <form
        action={dispatch}
        className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-xl shadow-2xl shadow-black/40"
      >
        <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
          Edit Protocol
        </h2>

        <motion.div
          ref={keyboardContainerRef}
          animate={{
            paddingBottom: keyboardHeight > 0 ? keyboardHeight + 16 : 0,
          }}
          transition={{ type: "spring", bounce: 0, duration: 0.3 }}
        >
          <RichTextEditor
            id="protocol-content"
            name="content"
            placeholder="Hard limits, soft limits, safeword, escalation, vocabulary…"
            rows={20}
            defaultValue={initialContent}
            disabled={isPending || undefined}
            className={cn(
              "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-sm",
              "placeholder:text-muted-foreground/40 outline-none",
              "focus:border-primary/40 transition-colors",
              "font-mono leading-relaxed",
            )}
          />
        </motion.div>

        {state?.error && (
          <p className="text-xs font-medium text-destructive">{state.error}</p>
        )}

        <p className="text-[10px] text-muted-foreground/40">
          Saving notifies {TITLE_BY_AUTHOR.Besho}. The previous version is
          archived in history. Markdown supported.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending || undefined}
            className="flex items-center gap-1.5 rounded-full border border-border/40 px-4 py-2 text-xs font-semibold text-muted-foreground transition-all hover:text-foreground"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
          <Button
            type="submit"
            disabled={isPending || undefined}
            className="rounded-full px-5"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </form>
    </motion.div>
  );
}
