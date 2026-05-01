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
  AlertTriangle,
  ArrowLeft,
  Award,
  ChevronUp,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createLedgerEntry,
  deleteLedgerEntry,
  getLedgerEntries,
  type LedgerEntry,
} from "@/app/actions/ledger";
import {
  PUNISHMENT_CATEGORIES,
  REWARD_CATEGORIES,
  type LedgerEntryType,
} from "@/lib/ledger-constants";
import { getCurrentAuthor } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { vibrate } from "@/lib/haptic";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

type Filter = "all" | "reward" | "punishment";

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function dateInputDefault() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

export default function LedgerPage() {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<LedgerEntryType>("reward");
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [state, action, isPending] = useActionState(createLedgerEntry, null);
  const formRef = useRef<HTMLFormElement & { reset: () => void }>(null);

  usePresence("/ledger", !!currentAuthor);

  const handleRefresh = useCallback(async () => {
    const list = await getLedgerEntries();
    setTimeout(() => setEntries(list), 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getLedgerEntries(), getCurrentAuthor()]).then(
      ([list, author]) => {
        setEntries(list);
        setCurrentAuthor(author);
        setIsLoading(false);
      },
    );
  }, []);

  const isT7SEN = currentAuthor === "T7SEN";

  useEffect(() => {
    if (!state?.success) return;
    setTimeout(() => {
      formRef.current?.reset();
      setShowForm(false);
      void vibrate(50, "medium");
      getLedgerEntries().then(setEntries);
    }, 0);
  }, [state]);

  const handleDelete = async (id: string) => {
    void vibrate(50, "heavy");
    setBusyId(id);
    const result = await deleteLedgerEntry(id);
    if (result.success) {
      setEntries((prev) => prev.filter((e) => e.id !== id));
    }
    setBusyId(null);
  };

  const filtered =
    filter === "all" ? entries : entries.filter((e) => e.type === filter);

  const rewardCount = entries.filter((e) => e.type === "reward").length;
  const punishmentCount = entries.filter((e) => e.type === "punishment").length;

  const categories =
    type === "reward" ? REWARD_CATEGORIES : PUNISHMENT_CATEGORIES;

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-destructive/3 blur-[150px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-2xl space-y-8 pt-4">
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
              Ledger
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {rewardCount}✨ · {punishmentCount}⚠️
            </span>
          </div>

          {isT7SEN ? (
            <button
              onClick={() => {
                void vibrate(30, "light");
                setShowForm((v) => !v);
              }}
              aria-label={showForm ? "Close form" : "Add entry"}
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
          ) : (
            <div className="w-8" />
          )}
        </div>

        {/* Create entry form — Sir only */}
        <AnimatePresence>
          {showForm && isT7SEN && (
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
                  Log Entry for {TITLE_BY_AUTHOR.Besho}
                </h2>

                {/* Type toggle */}
                <div className="flex gap-2">
                  {(["reward", "punishment"] as LedgerEntryType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      className={cn(
                        "flex flex-1 items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-bold uppercase tracking-wider transition-all",
                        type === t
                          ? t === "reward"
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-destructive/40 bg-destructive/10 text-destructive"
                          : "border-white/10 bg-black/20 text-muted-foreground hover:border-white/20",
                      )}
                    >
                      {t === "reward" ? (
                        <Sparkles className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {t}
                    </button>
                  ))}
                </div>
                <input type="hidden" name="type" value={type} />

                {/* Category */}
                <div>
                  <label
                    htmlFor="ledger-category"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Category *
                  </label>
                  <select
                    id="ledger-category"
                    name="category"
                    required
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "outline-none focus:border-primary/40 transition-colors",
                      "scheme-dark",
                    )}
                  >
                    <option value="">Select a category…</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Title */}
                <div>
                  <label
                    htmlFor="ledger-title"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Title *
                  </label>
                  <input
                    id="ledger-title"
                    name="title"
                    type="text"
                    placeholder="Brief description…"
                    required
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "placeholder:text-muted-foreground/40 outline-none",
                      "focus:border-primary/40 transition-colors",
                    )}
                  />
                </div>

                {/* Description */}
                <div>
                  <label
                    htmlFor="ledger-desc"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Details
                  </label>
                  <RichTextEditor
                    id="ledger-desc"
                    name="description"
                    placeholder="Additional context…"
                    rows={2}
                    disabled={isPending || undefined}
                    className={cn(
                      "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                      "placeholder:text-muted-foreground/40 outline-none",
                      "focus:border-primary/40 transition-colors",
                    )}
                  />
                </div>

                {/* Timestamp */}
                <div>
                  <label
                    htmlFor="ledger-timestamp"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Date & Time
                  </label>
                  <input
                    id="ledger-timestamp"
                    name="timestamp"
                    type="datetime-local"
                    defaultValue={dateInputDefault()}
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
                      "Log entry"
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Filter tabs */}
        {!isLoading && entries.length > 0 && (
          <div className="flex items-center gap-2">
            {(["all", "reward", "punishment"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "relative rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider transition-all",
                  filter === f
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {filter === f && (
                  <motion.div
                    layoutId="ledger-filter-pill"
                    className="absolute inset-0 rounded-full bg-primary/80"
                    transition={{
                      type: "spring",
                      bounce: 0.2,
                      duration: 0.4,
                    }}
                  />
                )}
                <span className="relative z-10">
                  {f === "all"
                    ? "All"
                    : f === "reward"
                      ? "Rewards"
                      : "Punishments"}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Entry list */}
        <div className="space-y-4 pb-24">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <EntrySkeleton key={i} />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-6 py-24 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
                <Award className="h-8 w-8 text-primary/30" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground/50">
                  {entries.length === 0
                    ? "No entries yet"
                    : "Nothing in this filter"}
                </h3>
                <p className="text-sm text-muted-foreground/50">
                  Keep a private record between you both.
                </p>
              </div>
            </motion.div>
          ) : (
            filtered.map((entry, index) => (
              <EntryItem
                key={entry.id}
                entry={entry}
                index={index}
                canDelete={isT7SEN}
                isBusy={busyId === entry.id}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EntryItem({
  entry,
  index,
  canDelete,
  isBusy,
  onDelete,
}: {
  entry: LedgerEntry;
  index: number;
  canDelete: boolean;
  isBusy: boolean;
  onDelete: (id: string) => void;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const isReward = entry.type === "reward";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className={cn(
        "group relative rounded-2xl border p-5 transition-colors",
        isReward
          ? "border-primary/15 bg-primary/5 hover:border-primary/25"
          : "border-destructive/15 bg-destructive/5 hover:border-destructive/25",
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
            isReward
              ? "bg-primary/15 text-primary"
              : "bg-destructive/15 text-destructive",
          )}
        >
          {isReward ? (
            <Sparkles className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
                isReward
                  ? "bg-primary/15 text-primary"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {entry.category}
            </span>
          </div>

          <p className="mt-1.5 text-sm font-bold text-foreground">
            {entry.title}
          </p>

          {entry.description && (
            <MarkdownRenderer
              content={entry.description}
              className={cn(
                "mt-1 text-base leading-relaxed text-muted-foreground/99",
                "prose-p:my-1 prose-p:last:mb-0",
                "prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
              )}
            />
          )}

          <p className="mt-2 text-[10px] font-semibold text-muted-foreground/40">
            {formatDateTime(entry.timestamp)}
          </p>
        </div>

        {canDelete && !showDelete && (
          <button
            onClick={() => {
              void vibrate(30, "light");
              setShowDelete(true);
            }}
            aria-label="Delete entry"
            className="shrink-0 rounded-full p-1.5 text-muted-foreground/20 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        {canDelete && showDelete && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => setShowDelete(false)}
              className="text-[10px] font-semibold text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                void vibrate(50, "heavy");
                onDelete(entry.id);
              }}
              disabled={isBusy || undefined}
              className="flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-destructive transition-all hover:bg-destructive/20 disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Trash2 className="h-2.5 w-2.5" />
              )}
              Delete
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}

function EntrySkeleton() {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-white/5 bg-card/20 p-5">
      <div className="h-9 w-9 animate-pulse rounded-full bg-muted/30" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-16 animate-pulse rounded-full bg-muted/20" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted/30" />
        <div className="h-3 w-24 animate-pulse rounded bg-muted/15" />
      </div>
    </div>
  );
}
