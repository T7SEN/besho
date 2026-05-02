// src/app/rituals/page.tsx
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
  Check,
  CheckCircle2,
  ChevronUp,
  Circle,
  Clock,
  Flame,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldOff,
  Skull,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createRitual,
  deleteRitual,
  getRituals,
  grantSkipDay,
  pauseRitual,
  resumeRitual,
  submitOccurrence,
  updateRitual,
  type Ritual,
  type RitualHistoryEntry,
  type RitualWithToday,
} from "@/app/actions/rituals";
import { getCurrentAuthor } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import {
  DEFAULT_EVERY_N_DAYS,
  DEFAULT_WINDOW_DURATION_MINUTES,
  DEFAULT_WINDOW_START,
  MAX_EVERY_N_DAYS,
  MAX_WINDOW_DURATION_MINUTES,
  MIN_EVERY_N_DAYS,
  MIN_WINDOW_DURATION_MINUTES,
  WEEKDAY_LABELS,
} from "@/lib/rituals-constants";
import {
  dateKeyInTz,
  formatWindowRange,
  isPrescribedDay,
  nextPrescribedDateKey,
  tzWallClockToUtcMs,
  type RitualTodayState,
} from "@/lib/rituals";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { vibrate } from "@/lib/haptic";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useKeyboardHeight } from "@/hooks/use-keyboard";
import {
  idToNumeric,
  NOTIF_ID,
  useLocalNotifications,
} from "@/hooks/use-local-notifications";

const STATE_CONFIG: Record<
  RitualTodayState,
  { label: string; color: string; bg: string; ring: string }
> = {
  open: {
    label: "Open Now",
    color: "text-primary",
    bg: "bg-primary/10",
    ring: "ring-primary/20",
  },
  upcoming: {
    label: "Upcoming Today",
    color: "text-yellow-500/80",
    bg: "bg-yellow-500/10",
    ring: "ring-yellow-500/20",
  },
  completed_today: {
    label: "Completed Today",
    color: "text-emerald-400/80",
    bg: "bg-emerald-500/10",
    ring: "ring-emerald-500/20",
  },
  missed_today: {
    label: "Missed",
    color: "text-destructive",
    bg: "bg-destructive/10",
    ring: "ring-destructive/20",
  },
  not_prescribed_today: {
    label: "Off Day",
    color: "text-muted-foreground/60",
    bg: "bg-muted/15",
    ring: "ring-white/5",
  },
  paused: {
    label: "Paused",
    color: "text-muted-foreground/60",
    bg: "bg-muted/20",
    ring: "ring-white/5",
  },
  inactive: {
    label: "Inactive",
    color: "text-muted-foreground/50",
    bg: "bg-muted/10",
    ring: "ring-white/5",
  },
};

const SECTION_ORDER: RitualTodayState[] = [
  "open",
  "upcoming",
  "completed_today",
  "missed_today",
  "not_prescribed_today",
  "paused",
  "inactive",
];

const SECTION_LABEL: Record<RitualTodayState, string> = {
  open: "Open Now",
  upcoming: "Upcoming",
  completed_today: "Completed Today",
  missed_today: "Missed Today",
  not_prescribed_today: "Off Today",
  paused: "Paused",
  inactive: "Inactive",
};

function formatRelative(timestamp: number, now: number): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) {
    const m = minutes % 60;
    const head = `${hours}h${m > 0 ? ` ${m}m` : ""}`;
    return diff > 0 ? `in ${head}` : `${head} ago`;
  }
  return diff > 0 ? `in ${minutes}m` : `${minutes}m ago`;
}

const SHORT_WEEKDAY_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/**
 * Short cadence chip text — "Daily", "Mon · Wed · Fri", "Every 3 days".
 */
function formatCadenceChip(ritual: RitualWithToday): string {
  if (ritual.cadence === "daily") return "Daily";
  if (ritual.cadence === "weekly") {
    const days = ritual.weekdays ?? [];
    if (days.length === 0) return "Weekly";
    if (days.length === 7) return "Daily";
    return days
      .slice()
      .sort((a, b) => a - b)
      .map((d) => SHORT_WEEKDAY_LABELS[d])
      .join(" · ");
  }
  return `Every ${ritual.everyNDays ?? "?"} days`;
}

/**
 * Friendly date for "Next: <date>" display. Same year → "Wed, May 6";
 * different year → "Wed, May 6 2027".
 */
function formatDateChip(dateKey: string, now: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const nowYear = new Date(now).getUTCFullYear();
  const opts: Intl.DateTimeFormatOptions =
    y === nowYear
      ? { weekday: "short", month: "short", day: "numeric" }
      : { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(
    dt,
  );
}

export default function RitualsPage() {
  const [rituals, setRituals] = useState<RitualWithToday[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRitualId, setEditingRitualId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const scheduledRemindersRef = useRef<Set<number>>(new Set());
  const firstReconcileRef = useRef(true);

  const { schedule, cancel } = useLocalNotifications();

  usePresence("/rituals", !!currentAuthor);

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

  const handleRefresh = useCallback(async () => {
    const list = await getRituals();
    setTimeout(() => setRituals(list), 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getRituals(), getCurrentAuthor()]).then(([list, author]) => {
      setRituals(list);
      setCurrentAuthor(author);
      setIsLoading(false);
    });
  }, []);

  // 30s polling — Phase 1 chose polling over SSE.
  useEffect(() => {
    const id = setInterval(() => {
      void handleRefresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [handleRefresh]);

  // ── Phase 2 / 2.5: Local-notification reminder reconciliation ─────────────
  // For every ritual the current user owns, schedule a local notification at
  // each upcoming window-open instant for the next N prescribed-and-not-
  // skipped occurrences. Re-runs on any `rituals` change (poll, create,
  // submit, pause, delete) and diff-cancels / diff-schedules so the device
  // stays in sync without thrashing.
  //
  // Cadence-aware: the cursor walks via `nextPrescribedDateKey`, so weekly
  // and every-N-days rituals only get reminders on prescribed days.
  //
  // Skip-aware (Phase 2.5): if Sir granted a future skip-day, that
  // occurrence is filtered out. The walk continues forward to compensate so
  // the horizon stays at REMINDER_HORIZON_OCCURRENCES actual reminders even
  // when skips are dense. Hard-bounded at MAX_PRESCRIBED_WALK to prevent a
  // runaway loop in degenerate cases (e.g. 30 future skips on a daily
  // ritual).
  //
  // First run blanket-cancels the entire ritual ID band [3000, 3895] to clear
  // any stale reminders left by previous sessions before installing the
  // current desired set.
  useEffect(() => {
    if (!currentAuthor) return;

    let cancelled = false;
    const REMINDER_HORIZON_OCCURRENCES = 7;
    const MAX_PRESCRIBED_WALK = 21;

    void (async () => {
      const desired: {
        id: number;
        title: string;
        body: string;
        atMs: number;
        url: string;
      }[] = [];

      const nowMs = Date.now();

      for (const r of rituals) {
        if (r.owner !== currentAuthor) continue;
        if (!r.active) continue;
        if (r.pausedUntil && nowMs < r.pausedUntil) continue;

        // Compose suffix with windowStart AND updatedAt so any edit
        // (time, title, description, owner, cadence) rotates the
        // reminder ID. Diff path then cancels the stale reminder and
        // schedules a new one with the current title/body.
        const numericId = idToNumeric(
          `${r.id}:${r.windowStart}:${r.updatedAt ?? r.createdAt}`,
        );
        const cadenceConfig = {
          cadence: r.cadence,
          weekdays: r.weekdays,
          everyNDays: r.everyNDays,
          anchorDateKey: r.anchorDateKey,
        };
        const skipSet = new Set(r.upcomingSkipDateKeys);

        // Start cursor at owningDateKey if it's prescribed (the case for
        // active rituals), otherwise advance to the next prescribed day.
        let cursor = r.owningDateKey;
        if (!isPrescribedDay(cadenceConfig, cursor)) {
          cursor = nextPrescribedDateKey(cadenceConfig, cursor);
        }

        let scheduled = 0;
        let walked = 0;
        while (
          scheduled < REMINDER_HORIZON_OCCURRENCES &&
          walked < MAX_PRESCRIBED_WALK
        ) {
          walked += 1;

          const isSkipped = skipSet.has(cursor);
          const isOwningDateToday = cursor === r.owningDateKey;
          const alreadyHandledToday =
            isOwningDateToday && r.todaySubmission !== null;
          const opensAtMs = tzWallClockToUtcMs(cursor, r.windowStart);
          const isPast = opensAtMs <= nowMs;

          if (!isSkipped && !alreadyHandledToday && !isPast) {
            const daysSinceEpoch = Math.floor(opensAtMs / 86_400_000);
            desired.push({
              id: NOTIF_ID.ritualReminder(numericId, daysSinceEpoch),
              title: "🕯️ Ritual",
              body: `Time for: ${r.title}`,
              atMs: opensAtMs,
              url: "/rituals",
            });
            scheduled += 1;
          }

          cursor = nextPrescribedDateKey(cadenceConfig, cursor);
        }
      }

      const desiredIds = new Set(desired.map((d) => d.id));

      if (firstReconcileRef.current) {
        const bandSize =
          NOTIF_ID.RITUAL_BAND_END - NOTIF_ID.RITUAL_BAND_START + 1;
        const bandIds = Array.from(
          { length: bandSize },
          (_, i) => NOTIF_ID.RITUAL_BAND_START + i,
        );
        await cancel(bandIds);
        if (cancelled) return;
        for (const d of desired) {
          if (cancelled) return;
          await schedule(d);
        }
        firstReconcileRef.current = false;
      } else {
        const toCancel = Array.from(scheduledRemindersRef.current).filter(
          (id) => !desiredIds.has(id),
        );
        const toSchedule = desired.filter(
          (d) => !scheduledRemindersRef.current.has(d.id),
        );
        if (toCancel.length > 0) await cancel(toCancel);
        if (cancelled) return;
        for (const d of toSchedule) {
          if (cancelled) return;
          await schedule(d);
        }
      }

      if (!cancelled) {
        scheduledRemindersRef.current = desiredIds;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rituals, currentAuthor, schedule, cancel]);

  // Form success handler for both create and edit. The RitualForm
  // component manages its own dispatch + pending state internally; this
  // closes the form and refreshes the list once the action succeeds.
  const handleFormSuccess = useCallback(() => {
    setTimeout(() => {
      setEditingRitualId(null);
      setShowForm(false);
      void vibrate(50, "medium");
    }, 0);
    void handleRefresh();
  }, [handleRefresh]);

  const handleFormCancel = useCallback(() => {
    setEditingRitualId(null);
    setShowForm(false);
  }, []);

  const handleStartEdit = useCallback((ritual: RitualWithToday) => {
    void vibrate(30, "light");
    setEditingRitualId(ritual.id);
    setShowForm(true);
  }, []);

  const isT7SEN = currentAuthor === "T7SEN";

  const editingRitual = editingRitualId
    ? (rituals.find((r) => r.id === editingRitualId) ?? null)
    : null;

  const grouped: Record<RitualTodayState, RitualWithToday[]> = {
    open: [],
    upcoming: [],
    completed_today: [],
    missed_today: [],
    not_prescribed_today: [],
    paused: [],
    inactive: [],
  };
  for (const r of rituals) grouped[r.todayState].push(r);

  const handlePause = async (id: string) => {
    void vibrate(40, "medium");
    setBusyId(id);
    await pauseRitual(id);
    await handleRefresh();
    setBusyId(null);
  };

  const handleResume = async (id: string) => {
    void vibrate(40, "medium");
    setBusyId(id);
    await resumeRitual(id);
    await handleRefresh();
    setBusyId(null);
  };

  const handleGrantSkip = async (id: string, dateKey: string) => {
    void vibrate(40, "light");
    setBusyId(id);
    await grantSkipDay(id, dateKey);
    await handleRefresh();
    setBusyId(null);
  };

  const handleDelete = async (id: string) => {
    void vibrate(50, "heavy");
    setBusyId(id);
    const result = await deleteRitual(id);
    if (result.success) {
      setRituals((prev) => prev.filter((r) => r.id !== id));
    }
    setBusyId(null);
  };

  const totalCount = rituals.length;
  const openCount = grouped.open.length;
  const completedTodayCount = grouped.completed_today.length;

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-purple-500/5 blur-[150px]" />
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
              Rituals
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {totalCount} total · {openCount} open · {completedTodayCount} done
            </span>
          </div>

          {isT7SEN ? (
            <button
              onClick={() => {
                void vibrate(30, "light");
                setShowForm((v) => !v);
              }}
              aria-label={showForm ? "Close form" : "Add ritual"}
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

        {/* Create / edit ritual form — Sir only */}
        <AnimatePresence>
          {showForm && isT7SEN && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <RitualForm
                key={editingRitual?.id ?? "create"}
                mode={editingRitual ? "edit" : "create"}
                existingRitual={editingRitual}
                onSuccess={handleFormSuccess}
                onCancel={handleFormCancel}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* List */}
        <div className="space-y-10 pb-24">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <RitualSkeleton key={i} />
              ))}
            </div>
          ) : rituals.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-6 py-24 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
                <Sparkles className="h-8 w-8 text-primary/30" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground/50">
                  No rituals yet
                </h3>
                <p className="text-sm text-muted-foreground/50">
                  {isT7SEN
                    ? `Set ${TITLE_BY_AUTHOR.Besho} her first ritual.`
                    : `${TITLE_BY_AUTHOR.T7SEN} hasn't set any rituals yet.`}
                </p>
              </div>
            </motion.div>
          ) : (
            <>
              {SECTION_ORDER.map((sectionKey) => {
                const items = grouped[sectionKey];
                if (items.length === 0) return null;
                return (
                  <RitualSection
                    key={sectionKey}
                    title={`${SECTION_LABEL[sectionKey]} — ${items.length}`}
                  >
                    {items.map((r, index) => (
                      <RitualItem
                        key={r.id}
                        ritual={r}
                        index={index}
                        isT7SEN={isT7SEN}
                        currentAuthor={currentAuthor}
                        isBusy={busyId === r.id}
                        now={now}
                        onPause={handlePause}
                        onResume={handleResume}
                        onGrantSkip={handleGrantSkip}
                        onDelete={handleDelete}
                        onStartEdit={handleStartEdit}
                        onSubmitted={handleRefresh}
                      />
                    ))}
                  </RitualSection>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RitualSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
        {title}
      </p>
      {children}
    </div>
  );
}

function RitualItem({
  ritual,
  index,
  isT7SEN,
  currentAuthor,
  isBusy,
  now,
  onPause,
  onResume,
  onGrantSkip,
  onDelete,
  onStartEdit,
  onSubmitted,
}: {
  ritual: RitualWithToday;
  index: number;
  isT7SEN: boolean;
  currentAuthor: string | null;
  isBusy: boolean;
  now: number;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onGrantSkip: (id: string, dateKey: string) => void;
  onDelete: (id: string) => void;
  onStartEdit: (ritual: RitualWithToday) => void;
  onSubmitted: () => Promise<void>;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [expandedDateKey, setExpandedDateKey] = useState<string | null>(null);

  const cfg = STATE_CONFIG[ritual.todayState];
  const isOwner = currentAuthor === ritual.owner;
  const canSubmit = isOwner && ritual.todayState === "open";
  const isSkipped = !!ritual.todaySubmission?.skippedBy;

  // Stable refs for SubmitForm so its useEffect doesn't re-fire on every
  // parent re-render — would otherwise double-call onSubmitted on success.
  const handleSubmitCancel = useCallback(() => {
    setShowSubmit(false);
  }, []);
  const handleSubmitSuccess = useCallback(async () => {
    setShowSubmit(false);
    await onSubmitted();
  }, [onSubmitted]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{
        opacity:
          ritual.todayState === "completed_today" ||
          ritual.todayState === "paused" ||
          ritual.todayState === "inactive"
            ? 0.7
            : 1,
        y: 0,
      }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className={cn(
        "group relative rounded-2xl border p-5 transition-colors",
        ritual.todayState === "open"
          ? "border-primary/20 bg-primary/5"
          : ritual.todayState === "missed_today"
            ? "border-destructive/20 bg-destructive/5"
            : "border-white/5 bg-card/20 hover:border-white/10",
      )}
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5 shrink-0">
          {ritual.todayState === "completed_today" ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-400/70" />
          ) : ritual.todayState === "missed_today" ? (
            <Skull className="h-5 w-5 text-destructive/70" />
          ) : ritual.todayState === "paused" ? (
            <Pause className="h-5 w-5 text-muted-foreground/50" />
          ) : ritual.todayState === "open" ? (
            <Sparkles className="h-5 w-5 text-primary/80" />
          ) : (
            <Circle className="h-5 w-5 text-yellow-500/60" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-foreground">{ritual.title}</p>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ring-1",
                cfg.color,
                cfg.bg,
                cfg.ring,
              )}
            >
              {isSkipped ? "Skipped (Sir)" : cfg.label}
            </span>
            <span className="rounded-full bg-muted/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-muted-foreground/60 ring-1 ring-white/5">
              {TITLE_BY_AUTHOR[ritual.owner]}
            </span>
            <span className="rounded-full bg-muted/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-muted-foreground/50 ring-1 ring-white/5">
              {formatCadenceChip(ritual)}
            </span>
          </div>

          {ritual.description && (
            <MarkdownRenderer
              content={ritual.description}
              className={cn(
                "mt-1 text-base leading-relaxed text-muted-foreground/90",
                "prose-p:my-1 prose-p:last:mb-0",
                "prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
              )}
            />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold text-muted-foreground/40">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {formatWindowRange(
                ritual.windowStart,
                ritual.windowDurationMinutes,
              )}
            </span>
            {ritual.todayState === "upcoming" && (
              <span>Opens {formatRelative(ritual.windowOpensAtMs, now)}</span>
            )}
            {ritual.todayState === "open" && (
              <span className="text-primary/70">
                Closes {formatRelative(ritual.windowClosesAtMs, now)}
              </span>
            )}
            {ritual.todayState === "not_prescribed_today" && (
              <span>
                Next:{" "}
                {formatDateChip(
                  nextPrescribedDateKey(
                    {
                      cadence: ritual.cadence,
                      weekdays: ritual.weekdays,
                      everyNDays: ritual.everyNDays,
                      anchorDateKey: ritual.anchorDateKey,
                    },
                    ritual.owningDateKey,
                  ),
                  now,
                )}
              </span>
            )}
            {ritual.currentStreak > 0 && (
              <span className="flex items-center gap-1 text-primary/60">
                <Flame className="h-2.5 w-2.5" />
                {ritual.cadence === "daily"
                  ? `${ritual.currentStreak}-day streak`
                  : `${ritual.currentStreak} in a row`}
              </span>
            )}
            {ritual.longestStreak > 0 &&
              ritual.longestStreak !== ritual.currentStreak && (
                <span>Best: {ritual.longestStreak}</span>
              )}
            {ritual.upcomingSkipDateKeys.length > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground/60">
                <ShieldOff className="h-2.5 w-2.5" />
                Next skip:{" "}
                {formatDateChip(
                  // Sorted ascending by string compare = chronological for ISO dates.
                  ritual.upcomingSkipDateKeys.slice().sort()[0],
                  now,
                )}
                {ritual.upcomingSkipDateKeys.length > 1 &&
                  ` (+${ritual.upcomingSkipDateKeys.length - 1} more)`}
              </span>
            )}
          </div>

          {ritual.todaySubmission && !isSkipped && (
            <div className="mt-3 rounded-xl border border-white/5 bg-black/20 p-3">
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
                {TITLE_BY_AUTHOR[ritual.owner]}&rsquo;s submission
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">
                {ritual.todaySubmission.text}
              </p>
            </div>
          )}
        </div>

        {isT7SEN && !showDelete && (
          <button
            onClick={() => {
              void vibrate(30, "light");
              setShowDelete(true);
            }}
            aria-label="Delete ritual"
            className="shrink-0 rounded-full p-1.5 text-muted-foreground/20 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}

        {isT7SEN && showDelete && (
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
                onDelete(ritual.id);
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

      {/* History dot row — last 14 days, tappable; Sir can grant retro skips. */}
      <HistoryDotRow
        ritual={ritual}
        isT7SEN={isT7SEN}
        isBusy={isBusy}
        now={now}
        expandedDateKey={expandedDateKey}
        setExpandedDateKey={setExpandedDateKey}
        onGrantSkip={onGrantSkip}
      />

      {/* Action row */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        {canSubmit && !showSubmit && (
          <button
            onClick={() => {
              void vibrate(30, "light");
              setShowSubmit(true);
            }}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary transition-all hover:bg-primary/25 disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            Submit Now
          </button>
        )}

        {isT7SEN && ritual.todayState !== "paused" && (
          <button
            onClick={() => onPause(ritual.id)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground/70 transition-all hover:bg-muted/50 disabled:opacity-50"
          >
            <Pause className="h-3 w-3" />
            Pause
          </button>
        )}

        {isT7SEN && ritual.todayState === "paused" && (
          <button
            onClick={() => onResume(ritual.id)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground/70 transition-all hover:bg-muted/50 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            Resume
          </button>
        )}

        {isT7SEN && (
          <button
            onClick={() => onStartEdit(ritual)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:bg-muted/30 disabled:opacity-50"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}

        {isT7SEN &&
          (ritual.todayState === "missed_today" ||
            ritual.todayState === "open" ||
            ritual.todayState === "upcoming") &&
          !ritual.todaySubmission && (
            <button
              onClick={() => onGrantSkip(ritual.id, ritual.owningDateKey)}
              disabled={isBusy || undefined}
              className="flex items-center gap-1.5 rounded-full bg-muted/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:bg-muted/30 disabled:opacity-50"
            >
              <ShieldOff className="h-3 w-3" />
              Grant Skip
            </button>
          )}
      </div>

      {/* Inline submit form (owner only, when window is open) */}
      <AnimatePresence>
        {canSubmit && showSubmit && (
          <SubmitForm
            ritualId={ritual.id}
            isBusy={isBusy}
            onCancel={handleSubmitCancel}
            onSuccess={handleSubmitSuccess}
          />
        )}
      </AnimatePresence>

      {/* Last-edited footer — only when the ritual has been edited at
          least once. createdAt fallback intentionally omitted; "Edited
          0m ago" on every freshly-created ritual would be noise. */}
      {ritual.updatedAt && (
        <p className="mt-3 text-right text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/30">
          Edited {formatRelative(ritual.updatedAt, now)}
        </p>
      )}
    </motion.div>
  );
}

function SubmitForm({
  ritualId,
  isBusy,
  onCancel,
  onSuccess,
}: {
  ritualId: string;
  isBusy: boolean;
  onCancel: () => void;
  onSuccess: () => Promise<void> | void;
}) {
  const [state, action, isPending] = useActionState(submitOccurrence, null);

  useEffect(() => {
    if (state?.success) {
      setTimeout(() => {
        void vibrate(50, "medium");
        void onSuccess();
      }, 0);
    }
  }, [state, onSuccess]);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <form action={action} className="mt-3 space-y-3">
        <input type="hidden" name="ritualId" value={ritualId} />
        <textarea
          name="text"
          rows={3}
          required
          placeholder="Your check-in…"
          disabled={isPending || isBusy || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-primary/40 transition-colors",
          )}
        />
        {state?.error && (
          <p className="text-xs font-medium text-destructive">{state.error}</p>
        )}
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
            disabled={isPending || isBusy || undefined}
            className="rounded-full px-5"
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Submit"
            )}
          </Button>
        </div>
      </form>
    </motion.div>
  );
}

/**
 * Create / edit form for a ritual. Self-contained: manages its own
 * cadence + weekday state and the action dispatch via `useActionState`.
 *
 * Force-remounted by the parent via `key={editingRitualId ?? "create"}`
 * so uncontrolled inputs (`defaultValue`) pick up the right initial
 * values when switching modes or between rituals being edited.
 */
function RitualForm({
  mode,
  existingRitual,
  onSuccess,
  onCancel,
}: {
  mode: "create" | "edit";
  existingRitual: RitualWithToday | Ritual | null;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const initialCadence: "daily" | "weekly" | "every_n_days" =
    existingRitual?.cadence ?? "daily";
  const [cadence, setCadence] = useState<"daily" | "weekly" | "every_n_days">(
    initialCadence,
  );
  const [weekdays, setWeekdays] = useState<Set<number>>(
    new Set(existingRitual?.weekdays ?? []),
  );

  // Bind ritualId for edit mode. useActionState's action arg is read on
  // every dispatch, so we can swap the bound function across renders.
  const action =
    mode === "edit" && existingRitual
      ? updateRitual.bind(null, existingRitual.id)
      : createRitual;
  const [state, dispatch, isPending] = useActionState(action, null);

  useEffect(() => {
    if (state?.success) {
      onSuccess();
    }
  }, [state, onSuccess]);

  const isEditing = mode === "edit" && !!existingRitual;
  const submitLabel = isEditing ? "Save changes" : "Set ritual";
  const heading = isEditing ? "Edit Ritual" : "New Ritual";

  return (
    <form
      action={dispatch}
      className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-xl shadow-2xl shadow-black/40"
    >
      <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
        {heading}
      </h2>

      <div>
        <label
          htmlFor="ritual-title"
          className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
        >
          Title *
        </label>
        <input
          id="ritual-title"
          name="title"
          type="text"
          placeholder="Evening check-in…"
          required
          defaultValue={existingRitual?.title ?? ""}
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
          htmlFor="ritual-desc"
          className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
        >
          What to write
        </label>
        <RichTextEditor
          id="ritual-desc"
          name="description"
          placeholder="Mood, body, what happened today, anything you want her to reflect on…"
          rows={3}
          defaultValue={existingRitual?.description ?? ""}
          disabled={isPending || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-primary/40 transition-colors",
          )}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="ritual-owner"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            Fulfilled by
          </label>
          <select
            id="ritual-owner"
            name="owner"
            defaultValue={existingRitual?.owner ?? "Besho"}
            disabled={isPending || undefined}
            className={cn(
              "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
              "outline-none focus:border-primary/40 transition-colors",
            )}
          >
            <option value="Besho">{TITLE_BY_AUTHOR.Besho}</option>
            <option value="T7SEN">{TITLE_BY_AUTHOR.T7SEN}</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="ritual-cadence"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            Cadence
          </label>
          <select
            id="ritual-cadence"
            name="cadence"
            value={cadence}
            onChange={(e) => {
              const next = e.target.value as
                | "daily"
                | "weekly"
                | "every_n_days";
              setCadence(next);
              if (next !== "weekly") setWeekdays(new Set());
            }}
            disabled={isPending || undefined}
            className={cn(
              "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
              "outline-none focus:border-primary/40 transition-colors",
            )}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="every_n_days">Every N days</option>
          </select>
        </div>
      </div>

      {cadence === "weekly" && (
        <div>
          <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
            Days of week
          </label>
          <div className="flex gap-1.5">
            {WEEKDAY_LABELS.map((label, idx) => {
              const selected = weekdays.has(idx);
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    void vibrate(20, "light");
                    setWeekdays((prev) => {
                      const next = new Set(prev);
                      if (next.has(idx)) next.delete(idx);
                      else next.add(idx);
                      return next;
                    });
                  }}
                  disabled={isPending || undefined}
                  className={cn(
                    "flex-1 rounded-lg border py-2 text-xs font-bold transition-colors",
                    selected
                      ? "border-primary/40 bg-primary/15 text-primary"
                      : "border-white/10 bg-black/20 text-muted-foreground/60 hover:border-white/20",
                  )}
                  aria-pressed={selected}
                  aria-label={`Toggle weekday ${idx}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {Array.from(weekdays).map((d) => (
            <input key={d} type="hidden" name="weekdays" value={String(d)} />
          ))}
        </div>
      )}

      {cadence === "every_n_days" && (
        <div>
          <label
            htmlFor="ritual-every-n"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            Every N days
          </label>
          <input
            id="ritual-every-n"
            name="everyNDays"
            type="number"
            min={MIN_EVERY_N_DAYS}
            max={MAX_EVERY_N_DAYS}
            step={1}
            defaultValue={existingRitual?.everyNDays ?? DEFAULT_EVERY_N_DAYS}
            required
            disabled={isPending || undefined}
            className={cn(
              "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
              "outline-none focus:border-primary/40 transition-colors",
            )}
          />
          <p className="mt-1 text-[10px] text-muted-foreground/40">
            {isEditing &&
            existingRitual?.cadence === "every_n_days" &&
            existingRitual?.anchorDateKey
              ? `Phased to ${existingRitual.anchorDateKey}.`
              : "Phased to today. Next prescribed day will be N days from now."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="ritual-window-start"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            Window opens (Cairo)
          </label>
          <input
            id="ritual-window-start"
            name="windowStart"
            type="time"
            defaultValue={existingRitual?.windowStart ?? DEFAULT_WINDOW_START}
            required
            disabled={isPending || undefined}
            className={cn(
              "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
              "outline-none focus:border-primary/40 transition-colors",
              "scheme-dark",
            )}
          />
        </div>
        <div>
          <label
            htmlFor="ritual-duration"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            Window length (min)
          </label>
          <input
            id="ritual-duration"
            name="windowDurationMinutes"
            type="number"
            min={MIN_WINDOW_DURATION_MINUTES}
            max={MAX_WINDOW_DURATION_MINUTES}
            step={15}
            defaultValue={
              existingRitual?.windowDurationMinutes ??
              DEFAULT_WINDOW_DURATION_MINUTES
            }
            required
            disabled={isPending || undefined}
            className={cn(
              "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
              "outline-none focus:border-primary/40 transition-colors",
            )}
          />
        </div>
      </div>

      {state?.error && (
        <p className="text-xs font-medium text-destructive">{state.error}</p>
      )}

      {isEditing && (
        <p className="text-[10px] text-muted-foreground/50">
          Changing cadence, weekdays, or every-N value resets the current
          streak. Longest streak is preserved.
        </p>
      )}

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
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </form>
  );
}

function RitualSkeleton() {
  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 h-5 w-5 animate-pulse rounded-full bg-muted/30" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/5 animate-pulse rounded bg-muted/30" />
          <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
          <div className="h-2.5 w-24 animate-pulse rounded bg-muted/15" />
        </div>
      </div>
    </div>
  );
}

type HistoryDotStatus =
  | "before_creation"
  | "completed"
  | "skipped"
  | "missed"
  | "off_day"
  | "today_open"
  | "today_upcoming"
  | "today_completed"
  | "today_missed"
  | "today_off";

function classifyHistoryDot(args: {
  entry: RitualHistoryEntry;
  isOwningDate: boolean;
  todayState: RitualTodayState;
  prescribed: boolean;
  beforeCreation: boolean;
}): HistoryDotStatus {
  const { entry, isOwningDate, todayState, prescribed, beforeCreation } = args;

  if (isOwningDate) {
    if (todayState === "completed_today") return "today_completed";
    if (todayState === "missed_today") return "today_missed";
    if (todayState === "open") return "today_open";
    if (todayState === "upcoming") return "today_upcoming";
    if (todayState === "not_prescribed_today") return "today_off";
    // paused/inactive — treat the dot as off
    return "today_off";
  }

  // Pre-creation dates carry no obligation. Wins over missed/skipped/
  // completed semantics — even if a phantom skip record exists for a
  // pre-creation date, "Not yet started" is the truthful display.
  if (beforeCreation) return "before_creation";

  if (entry.skipped) return "skipped";
  if (entry.submitted) return "completed";
  if (!prescribed) return "off_day";
  return "missed";
}

// Tailwind v4's source scanner reliably detects classes that appear as
// static string values at module scope. Building className via switch/
// template-literal returns turned out to be hit-or-miss — the scanner
// missed the bg-* classes, leaving the dots transparent. This map keeps
// every class present as a literal string in the source.
//
// Palette uses Tailwind's warmer scale (rose / teal / amber / emerald)
// over the harsher red / yellow pair. Today states carry a colored
// shadow for subtle elevation.
const DOT_BG_BY_STATUS: Record<HistoryDotStatus, string> = {
  before_creation: "bg-zinc-800",
  completed: "bg-emerald-400",
  today_completed: "bg-emerald-400 shadow-md shadow-emerald-500/40",
  skipped: "bg-teal-400",
  missed: "bg-rose-400",
  today_missed: "bg-rose-400 shadow-md shadow-rose-500/40",
  today_open: "bg-primary animate-pulse shadow-md shadow-primary/40",
  today_upcoming: "bg-amber-400 shadow-md shadow-amber-500/40",
  off_day: "bg-zinc-700",
  today_off: "bg-zinc-500",
};

function dotClassesFor(status: HistoryDotStatus, isExpanded: boolean): string {
  return cn(
    "h-3.5 w-3.5 rounded-full",
    DOT_BG_BY_STATUS[status],
    isExpanded && "ring-2 ring-primary/60 ring-offset-1 ring-offset-card",
  );
}

function statusLabel(status: HistoryDotStatus): string {
  switch (status) {
    case "before_creation":
      return "Not yet started";
    case "completed":
    case "today_completed":
      return "Completed";
    case "skipped":
      return "Skipped (Sir)";
    case "missed":
    case "today_missed":
      return "Missed";
    case "today_open":
      return "Open now";
    case "today_upcoming":
      return "Upcoming today";
    case "off_day":
    case "today_off":
      return "Off day";
  }
}

/**
 * Renders the last HISTORY_DOT_ROW_DAYS days as a horizontal dot row.
 * Tap a dot → inline expansion bar shows the date and a Grant Skip
 * action when the viewer is Sir AND the date is a prescribed day with
 * no existing record. Today's dot reflects `r.todayState` rather than
 * the (possibly empty) history record.
 */
function HistoryDotRow({
  ritual,
  isT7SEN,
  isBusy,
  now,
  expandedDateKey,
  setExpandedDateKey,
  onGrantSkip,
}: {
  ritual: RitualWithToday;
  isT7SEN: boolean;
  isBusy: boolean;
  now: number;
  expandedDateKey: string | null;
  setExpandedDateKey: (next: string | null) => void;
  onGrantSkip: (id: string, dateKey: string) => void;
}) {
  if (!ritual.history || ritual.history.length === 0) return null;

  const cadenceConfig = {
    cadence: ritual.cadence,
    weekdays: ritual.weekdays,
    everyNDays: ritual.everyNDays,
    anchorDateKey: ritual.anchorDateKey,
  };

  // Cairo date the ritual was created. Any history entry strictly before
  // this date predates the ritual itself and carries no obligation.
  const createdDateKey = dateKeyInTz(ritual.createdAt);

  // Decorate each entry with its dot status for both row + expansion use.
  const decorated = ritual.history.map((entry) => {
    const isOwningDate = entry.dateKey === ritual.owningDateKey;
    const beforeCreation = entry.dateKey < createdDateKey;
    const prescribed =
      !beforeCreation && isPrescribedDay(cadenceConfig, entry.dateKey);
    const status = classifyHistoryDot({
      entry,
      isOwningDate,
      todayState: ritual.todayState,
      prescribed,
      beforeCreation,
    });
    return { entry, status, prescribed, isOwningDate, beforeCreation };
  });

  const expanded = expandedDateKey
    ? (decorated.find((d) => d.entry.dateKey === expandedDateKey) ?? null)
    : null;

  const canGrantSkipForExpanded = (() => {
    if (!isT7SEN || !expanded) return false;
    if (expanded.beforeCreation) return false;
    if (!expanded.prescribed) return false;
    if (expanded.entry.submitted) return false;
    return true;
  })();

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-1.5">
        {decorated.map(({ entry, status }) => {
          const isExpanded = expanded?.entry.dateKey === entry.dateKey;
          return (
            <button
              key={entry.dateKey}
              type="button"
              onClick={() => {
                void vibrate(20, "light");
                setExpandedDateKey(isExpanded ? null : entry.dateKey);
              }}
              aria-label={`${entry.dateKey} — ${statusLabel(status)}`}
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/5"
            >
              <span className={dotClassesFor(status, isExpanded)} />
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="flex items-center justify-between rounded-xl border border-white/5 bg-black/20 px-3 py-2">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
                  {formatDateChip(expanded.entry.dateKey, now)}
                </span>
                <span className="text-xs font-semibold text-foreground/80">
                  {statusLabel(expanded.status)}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {canGrantSkipForExpanded && (
                  <button
                    type="button"
                    onClick={() => {
                      void vibrate(40, "medium");
                      onGrantSkip(ritual.id, expanded.entry.dateKey);
                      setExpandedDateKey(null);
                    }}
                    disabled={isBusy || undefined}
                    className="flex items-center gap-1 rounded-full bg-muted/20 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:bg-muted/30 disabled:opacity-50"
                  >
                    <ShieldOff className="h-3 w-3" />
                    Grant Skip
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setExpandedDateKey(null)}
                  className="rounded-full p-1 text-muted-foreground/50 hover:text-foreground"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
