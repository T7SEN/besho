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
  CalendarClock,
  ChevronUp,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addMilestone,
  deleteMilestone,
  getMilestones,
  type Milestone,
} from "@/app/actions/timeline";
import { getCurrentAuthor } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { START_DATE } from "@/lib/constants";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useKeyboardHeight } from "@/hooks/use-keyboard";
import { logger } from "@/lib/logger";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

const EMOJI_OPTIONS = [
  "✨",
  "❤️",
  "📞",
  "✈️",
  "🏠",
  "🎉",
  "🎂",
  "🌹",
  "💌",
  "📸",
  "☕",
  "🎬",
  "🌙",
  "🥂",
  "🤝",
  "🌅",
  "🎵",
  "📖",
  "🗺️",
  "💍",
  "🌊",
  "🏖️",
  "🎭",
  "👋",
];

function formatEventDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function formatRelativeToStart(timestamp: number): string {
  const diff = timestamp - START_DATE.getTime();
  if (diff < 0) return "Before we started";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Day one ❤️";
  if (days < 30) return `Day ${days}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Month ${months}`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths > 0 ? `Year ${years}, month ${remMonths}` : `Year ${years}`;
}

export default function TimelinePage() {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [selectedEmoji, setSelectedEmoji] = useState("✨");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [state, action, isPending] = useActionState(addMilestone, null);
  const formRef = useRef<HTMLFormElement>(null);

  // Pushes the milestone form above the software keyboard on Android
  const keyboardHeight = useKeyboardHeight();

  usePresence("/timeline", !!currentAuthor);

  const handleRefresh = useCallback(async () => {
    const items = await getMilestones();
    setTimeout(() => setMilestones(items), 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getMilestones(), getCurrentAuthor()]).then(
      ([items, author]) => {
        setMilestones(items);
        setCurrentAuthor(author);
        setIsLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    if (!state?.success) return;
    const form = formRef.current as unknown as { reset: () => void } | null;
    form?.reset();
    Promise.resolve().then(() => {
      setSelectedEmoji("✨");
      setShowForm(false);
    });
    getMilestones()
      .then(setMilestones)
      .catch((err) => logger.error("Failed to fetch milestones:", err));
  }, [state]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    const result = await deleteMilestone(id);
    if (result.success) {
      setMilestones((prev) => prev.filter((m) => m.id !== id));
    }
    setDeletingId(null);
  };

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[150px]" />
      </div>

      <div
        className="relative z-10 mx-auto max-w-2xl space-y-10 pt-4"
        style={{
          paddingBottom: keyboardHeight > 0 ? keyboardHeight + 96 : undefined,
        }}
      >
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
              Our Timeline
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {milestones.length}{" "}
              {milestones.length === 1 ? "milestone" : "milestones"}
            </span>
          </div>
          <button
            onClick={() => setShowForm((v) => !v)}
            aria-label={showForm ? "Close form" : "Add milestone"}
            className={cn(
              "rounded-full p-2 transition-all",
              showForm
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground/50 hover:bg-primary/10 hover:text-primary",
            )}
          >
            {showForm ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Add milestone form */}
        <AnimatePresence>
          {showForm && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <form
                ref={formRef}
                action={action}
                className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-xl shadow-2xl shadow-black/40"
              >
                <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                  Add a Milestone
                </h2>

                <div>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                    Emoji
                  </p>
                  <input type="hidden" name="emoji" value={selectedEmoji} />
                  <div className="flex flex-wrap gap-2">
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => setSelectedEmoji(emoji)}
                        className={cn(
                          "flex h-9 w-9 items-center justify-center rounded-xl text-lg transition-all",
                          selectedEmoji === emoji
                            ? "bg-primary/20 ring-1 ring-primary/40"
                            : "bg-black/20 hover:bg-black/40",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="timeline-title"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Title *
                  </label>
                  <input
                    id="timeline-title"
                    name="title"
                    type="text"
                    placeholder="Our first video call"
                    required
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "placeholder:text-muted-foreground/40 outline-none",
                      "focus:border-primary/40 transition-colors",
                    )}
                  />
                </div>

                <div>
                  <label
                    htmlFor="timeline-desc"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Description
                  </label>
                  <RichTextEditor
                    id="timeline-desc"
                    name="description"
                    placeholder="A short description…"
                    rows={2}
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "placeholder:text-muted-foreground/40 outline-none",
                      "focus:border-primary/40 transition-colors",
                    )}
                  />
                </div>

                <div>
                  <label
                    htmlFor="timeline-date"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Date *
                  </label>
                  <input
                    id="timeline-date"
                    name="date"
                    type="date"
                    required
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "outline-none focus:border-primary/40 transition-colors",
                      "scheme-dark",
                    )}
                  />
                </div>

                {state?.error && (
                  <p className="text-xs font-medium text-destructive">
                    {state.error}
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
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
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Add milestone"
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Timeline */}
        <div className="space-y-0 pb-24">
          {isLoading ? (
            <div className="space-y-6">
              {[...Array(3)].map((_, i) => (
                <MilestoneSkeleton key={i} />
              ))}
            </div>
          ) : milestones.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-6 py-24 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
                <CalendarClock className="h-8 w-8 text-primary/30" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground/50">
                  No milestones yet
                </h3>
                <p className="text-sm text-muted-foreground/50">
                  Add your first milestone to start your story.
                </p>
              </div>
            </motion.div>
          ) : (
            milestones.map((milestone, index) => (
              <MilestoneItem
                key={milestone.id}
                milestone={milestone}
                index={index}
                isLast={index === milestones.length - 1}
                currentAuthor={currentAuthor}
                isDeleting={deletingId === milestone.id}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MilestoneItem({
  milestone,
  index,
  isLast,
  currentAuthor,
  isDeleting,
  onDelete,
}: {
  milestone: Milestone;
  index: number;
  isLast: boolean;
  currentAuthor: string | null;
  isDeleting: boolean;
  onDelete: (id: string) => void;
}) {
  const isOwn = milestone.author === currentAuthor;
  const isPartner = milestone.author === "Besho";
  const [showDelete, setShowDelete] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.06, 0.4), duration: 0.4 }}
      className={cn(
        "relative pl-12",
        !isLast &&
          "before:absolute before:left-4 before:top-8 before:h-full before:w-0.5 before:bg-border/30",
      )}
    >
      <div className="absolute left-0 top-1 flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-card/60 text-base backdrop-blur-sm">
        {milestone.emoji}
      </div>

      <div
        className={cn(
          "group mb-6 rounded-2xl border bg-card/20 p-5 backdrop-blur-sm",
          "transition-colors hover:border-white/10",
          isPartner ? "border-primary/10" : "border-white/5",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <p className="text-base font-bold leading-snug text-foreground">
              {milestone.title}
            </p>

            {milestone.description && (
              <MarkdownRenderer
                content={milestone.description}
                className="mt-1 text-base leading-relaxed text-muted-foreground/99 prose-p:my-1 prose-p:last:mb-0"
              />
            )}

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-widest",
                  isPartner ? "text-primary/70" : "text-foreground/50",
                )}
              >
                {formatEventDate(milestone.date)}
              </span>
              <span className="text-[10px] text-muted-foreground/30">·</span>
              <span className="text-[10px] font-semibold text-muted-foreground/50">
                {formatRelativeToStart(milestone.date)}
              </span>
              <span className="text-[10px] text-muted-foreground/30">·</span>
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-widest",
                  isPartner ? "text-primary/60" : "text-foreground/40",
                )}
              >
                {milestone.author}
              </span>
            </div>
          </div>

          {isOwn && !showDelete && (
            <button
              onClick={() => setShowDelete(true)}
              aria-label="Delete milestone"
              className="rounded-full p-1.5 text-muted-foreground/20 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          {isOwn && showDelete && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowDelete(false)}
                className="text-[10px] font-semibold text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                onClick={() => onDelete(milestone.id)}
                disabled={isDeleting || undefined}
                className="flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-destructive transition-all hover:bg-destructive/20 disabled:opacity-50"
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
      </div>
    </motion.div>
  );
}

function MilestoneSkeleton() {
  return (
    <div className="relative mb-6 pl-12">
      <div className="absolute left-0 top-1 h-8 w-8 animate-pulse rounded-full bg-muted/30" />
      <div className="space-y-3 rounded-2xl border border-white/5 bg-card/20 p-5">
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted/30" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
        <div className="flex gap-2">
          <div className="h-2 w-20 animate-pulse rounded bg-muted/20" />
          <div className="h-2 w-16 animate-pulse rounded bg-muted/15" />
        </div>
      </div>
    </div>
  );
}
