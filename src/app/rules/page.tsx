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
  AlarmClock,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronUp,
  Circle,
  Clock,
  Loader2,
  Plus,
  RotateCcw,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  acknowledgeRule,
  completeRule,
  createRule,
  deleteRule,
  getRules,
  reopenRule,
  type Rule,
  type RuleStatus,
} from "@/app/actions/rules";
import { getCurrentAuthor } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import {
  idToNumeric,
  NOTIF_ID,
  useLocalNotifications,
} from "@/hooks/use-local-notifications";
import { vibrate } from "@/lib/haptic";
import { Button } from "@/components/ui/button";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { useKeyboardHeight } from "@/hooks/use-keyboard";

const STATUS_CONFIG: Record<
  RuleStatus,
  { label: string; color: string; bg: string; ring: string }
> = {
  pending: {
    label: "Pending Acknowledgement",
    color: "text-yellow-500/80",
    bg: "bg-yellow-500/10",
    ring: "ring-yellow-500/20",
  },
  active: {
    label: "Active",
    color: "text-primary",
    bg: "bg-primary/10",
    ring: "ring-primary/20",
  },
  completed: {
    label: "Completed",
    color: "text-muted-foreground/60",
    bg: "bg-muted/20",
    ring: "ring-white/5",
  },
};

// ─── Acknowledgement deadline urgency ─────────────────────────────────────────

type UrgencyLevel = "none" | "low" | "medium" | "high" | "overdue";

const URGENCY_STYLES: Record<
  UrgencyLevel,
  { border: string; badge: string; pulse: boolean }
> = {
  none: { border: "", badge: "", pulse: false },
  low: {
    border: "ring-1 ring-yellow-500/20",
    badge: "bg-yellow-500/10 text-yellow-400/80",
    pulse: false,
  },
  medium: {
    border: "ring-1 ring-orange-500/30",
    badge: "bg-orange-500/10 text-orange-400",
    pulse: false,
  },
  high: {
    border: "ring-2 ring-destructive/40",
    badge: "bg-destructive/10 text-destructive",
    pulse: true,
  },
  overdue: {
    border: "ring-2 ring-destructive/60",
    badge: "bg-destructive/20 text-destructive",
    pulse: true,
  },
};

function getAckUrgency(
  rule: Rule & { acknowledgeDeadline?: number },
  now: number,
): UrgencyLevel {
  if (rule.status !== "pending") return "none";
  if (!rule.acknowledgeDeadline) return "none";
  const ms = rule.acknowledgeDeadline - now;
  if (ms <= 0) return "overdue";
  if (ms <= 60 * 60 * 1_000) return "high";
  if (ms <= 6 * 60 * 60 * 1_000) return "medium";
  if (ms <= 24 * 60 * 60 * 1_000) return "low";
  return "none";
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "Overdue";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const [state, action, isPending] = useActionState(createRule, null);
  const formRef = useRef<HTMLFormElement & { reset: () => void }>(null);

  const { schedule, cancel } = useLocalNotifications();

  usePresence("/rules", !!currentAuthor);

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
    const list = await getRules();
    setTimeout(() => setRules(list), 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getRules(), getCurrentAuthor()]).then(([list, author]) => {
      setRules(list);
      setCurrentAuthor(author);
      setIsLoading(false);
    });
  }, []);

  // Schedule notification for ack deadline on new rule creation
  useEffect(() => {
    if (!state?.success) return;

    setTimeout(() => {
      formRef.current?.reset();
      setShowForm(false);
      void vibrate(50, "medium");
    }, 0);

    getRules().then((fresh) => {
      setRules(fresh);
      const newest = fresh[0] as
        | (Rule & { acknowledgeDeadline?: number })
        | undefined;
      if (newest?.acknowledgeDeadline && newest.status === "pending") {
        void schedule({
          id: NOTIF_ID.ruleAckDeadline(idToNumeric(newest.id)),
          title: "📜 Rule acknowledgement due",
          body: `"${newest.title}" needs your acknowledgement`,
          atMs: newest.acknowledgeDeadline - 30 * 60 * 1_000, // 30 min before
        });
      }
    });
  }, [state, schedule]);

  const isT7SEN = currentAuthor === "T7SEN";
  const isBesho = currentAuthor === "Besho";

  const pendingRules = rules.filter((r) => r.status === "pending");
  const activeRules = rules.filter((r) => r.status === "active");
  const completedRules = rules.filter((r) => r.status === "completed");

  const handleAcknowledge = async (id: string) => {
    void vibrate(50, "medium");
    setBusyId(id);
    const result = await acknowledgeRule(id);
    if (result.success) {
      setRules((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "active", acknowledgedAt: Date.now() }
            : r,
        ),
      );
      // Cancel ack deadline notification once acknowledged
      void cancel([NOTIF_ID.ruleAckDeadline(idToNumeric(id))]);
    }
    setBusyId(null);
  };

  const handleComplete = async (id: string) => {
    void vibrate(50, "medium");
    setBusyId(id);
    const result = await completeRule(id);
    if (result.success) {
      setRules((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "completed", completedAt: Date.now() }
            : r,
        ),
      );
    }
    setBusyId(null);
  };

  const handleReopen = async (id: string) => {
    void vibrate(50, "medium");
    setBusyId(id);
    const result = await reopenRule(id);
    if (result.success) {
      setRules((prev) =>
        prev.map((r) =>
          r.id === id
            ? {
                ...r,
                status: r.acknowledgedAt ? "active" : "pending",
                completedAt: undefined,
              }
            : r,
        ),
      );
    }
    setBusyId(null);
  };

  const handleDelete = async (id: string) => {
    void vibrate(50, "heavy");
    setBusyId(id);
    const result = await deleteRule(id);
    if (result.success) {
      setRules((prev) => prev.filter((r) => r.id !== id));
      void cancel([NOTIF_ID.ruleAckDeadline(idToNumeric(id))]);
    }
    setBusyId(null);
  };

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-yellow-500/5 blur-[150px]" />
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
              Rules
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {activeRules.length} active · {pendingRules.length} pending
            </span>
          </div>

          {isT7SEN ? (
            <button
              onClick={() => {
                void vibrate(30, "light");
                setShowForm((v) => !v);
              }}
              aria-label={showForm ? "Close form" : "Add rule"}
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

        {/* Create rule form — Sir only */}
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
                  New Rule for {TITLE_BY_AUTHOR.Besho}
                </h2>

                <div>
                  <label
                    htmlFor="rule-title"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Rule *
                  </label>
                  <input
                    id="rule-title"
                    name="title"
                    type="text"
                    placeholder="State the rule plainly…"
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
                    htmlFor="rule-desc"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Details
                  </label>
                  <motion.div
                    ref={containerRef}
                    animate={{
                      paddingBottom:
                        keyboardHeight > 0 ? keyboardHeight + 16 : 0,
                    }}
                    transition={{ type: "spring", bounce: 0, duration: 0.3 }}
                  >
                    <RichTextEditor
                      id="rule-desc"
                      name="description"
                      placeholder="Context, expectations, consequences…"
                      rows={3}
                      disabled={isPending || undefined}
                      className={cn(
                        "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                        "placeholder:text-muted-foreground/40 outline-none",
                        "focus:border-primary/40 transition-colors",
                      )}
                    />
                  </motion.div>
                </div>

                {/* Acknowledgement deadline */}
                <div>
                  <label
                    htmlFor="rule-ack-deadline"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Acknowledge by (optional)
                  </label>
                  <input
                    id="rule-ack-deadline"
                    name="acknowledgeDeadline"
                    type="datetime-local"
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
                      "Set rule"
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rule list */}
        <div className="space-y-10 pb-24">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <RuleSkeleton key={i} />
              ))}
            </div>
          ) : rules.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-6 py-24 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
                <ScrollText className="h-8 w-8 text-primary/30" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground/50">
                  No rules yet
                </h3>
                <p className="text-sm text-muted-foreground/50">
                  {isT7SEN
                    ? `Set ${TITLE_BY_AUTHOR.Besho} her first rule.`
                    : `${TITLE_BY_AUTHOR.T7SEN} hasn't set any rules yet.`}
                </p>
              </div>
            </motion.div>
          ) : (
            <>
              {pendingRules.length > 0 && (
                <RuleSection
                  title={`Pending Acknowledgement — ${pendingRules.length}`}
                >
                  {pendingRules.map((rule, index) => (
                    <RuleItem
                      key={rule.id}
                      rule={rule}
                      index={index}
                      isT7SEN={isT7SEN}
                      isBesho={isBesho}
                      isBusy={busyId === rule.id}
                      now={now}
                      onAcknowledge={handleAcknowledge}
                      onComplete={handleComplete}
                      onReopen={handleReopen}
                      onDelete={handleDelete}
                    />
                  ))}
                </RuleSection>
              )}

              {activeRules.length > 0 && (
                <RuleSection title={`Active — ${activeRules.length}`}>
                  {activeRules.map((rule, index) => (
                    <RuleItem
                      key={rule.id}
                      rule={rule}
                      index={index}
                      isT7SEN={isT7SEN}
                      isBesho={isBesho}
                      isBusy={busyId === rule.id}
                      now={now}
                      onAcknowledge={handleAcknowledge}
                      onComplete={handleComplete}
                      onReopen={handleReopen}
                      onDelete={handleDelete}
                    />
                  ))}
                </RuleSection>
              )}

              {completedRules.length > 0 && (
                <RuleSection title={`Completed — ${completedRules.length}`}>
                  {completedRules.map((rule, index) => (
                    <RuleItem
                      key={rule.id}
                      rule={rule}
                      index={index}
                      isT7SEN={isT7SEN}
                      isBesho={isBesho}
                      isBusy={busyId === rule.id}
                      now={now}
                      onAcknowledge={handleAcknowledge}
                      onComplete={handleComplete}
                      onReopen={handleReopen}
                      onDelete={handleDelete}
                    />
                  ))}
                </RuleSection>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RuleSection({
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

function RuleItem({
  rule,
  index,
  isT7SEN,
  isBesho,
  isBusy,
  now,
  onAcknowledge,
  onComplete,
  onReopen,
  onDelete,
}: {
  rule: Rule & { acknowledgeDeadline?: number };
  index: number;
  isT7SEN: boolean;
  isBesho: boolean;
  isBusy: boolean;
  now: number;
  onAcknowledge: (id: string) => void;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const cfg = STATUS_CONFIG[rule.status];
  const urgency = getAckUrgency(rule, now);
  const urgencyStyles = URGENCY_STYLES[urgency];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{
        opacity: rule.status === "completed" ? 0.55 : 1,
        y: 0,
      }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className={cn(
        "group relative rounded-2xl border p-5 transition-colors",
        rule.status === "completed"
          ? "border-white/5 bg-card/10"
          : rule.status === "pending"
            ? "border-yellow-500/15 bg-yellow-500/5"
            : "border-white/5 bg-card/20 hover:border-white/10",
        urgencyStyles.border,
      )}
    >
      <div className="flex items-start gap-4">
        <div className="mt-0.5 shrink-0">
          {rule.status === "completed" ? (
            <CheckCircle2 className="h-5 w-5 text-primary/50" />
          ) : rule.status === "active" ? (
            <ScrollText className="h-5 w-5 text-primary/70" />
          ) : (
            <Circle className="h-5 w-5 text-yellow-500/60" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p
              className={cn(
                "text-sm font-bold",
                rule.status === "completed"
                  ? "text-foreground/40 line-through"
                  : "text-foreground",
              )}
            >
              {rule.title}
            </p>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ring-1",
                cfg.color,
                cfg.bg,
                cfg.ring,
              )}
            >
              {cfg.label}
            </span>

            {/* Urgency badge */}
            {urgency !== "none" && rule.acknowledgeDeadline && (
              <motion.span
                animate={urgencyStyles.pulse ? { opacity: [1, 0.5, 1] } : {}}
                transition={{ duration: 1.4, repeat: Infinity }}
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5",
                  "text-[9px] font-black uppercase tracking-wider",
                  urgencyStyles.badge,
                )}
              >
                <AlarmClock className="h-2.5 w-2.5" />
                {formatTimeRemaining(rule.acknowledgeDeadline - now)}
              </motion.span>
            )}
          </div>

          {rule.description && (
            <MarkdownRenderer
              content={rule.description}
              className={cn(
                "mt-1 text-base leading-relaxed text-muted-foreground/99",
                "prose-p:my-1 prose-p:last:mb-0",
                "prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
              )}
            />
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold text-muted-foreground/40">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              Set {formatDate(rule.createdAt)}
            </span>
            {rule.acknowledgedAt && (
              <span className="text-primary/50">
                ✓ Acknowledged {formatDate(rule.acknowledgedAt)}
              </span>
            )}
            {rule.completedAt && (
              <span className="text-primary/40">
                ★ Completed {formatDate(rule.completedAt)}
              </span>
            )}
          </div>
        </div>

        {isT7SEN && !showDelete && (
          <button
            onClick={() => {
              void vibrate(30, "light");
              setShowDelete(true);
            }}
            aria-label="Delete rule"
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
                onDelete(rule.id);
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

      {/* Action row */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
        {isBesho && rule.status === "pending" && (
          <button
            onClick={() => onAcknowledge(rule.id)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-primary transition-all hover:bg-primary/25 disabled:opacity-50"
          >
            {isBusy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            Acknowledge
          </button>
        )}

        {isT7SEN && rule.status !== "completed" && (
          <button
            onClick={() => onComplete(rule.id)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/30 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-foreground/70 transition-all hover:bg-muted/50 disabled:opacity-50"
          >
            <CheckCircle2 className="h-3 w-3" />
            Mark Completed
          </button>
        )}

        {isT7SEN && rule.status === "completed" && (
          <button
            onClick={() => onReopen(rule.id)}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:bg-muted/30 disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" />
            Reopen
          </button>
        )}

        {isBesho && rule.status === "active" && (
          <span className="text-[10px] font-semibold text-primary/50">
            You acknowledged this rule.
          </span>
        )}
      </div>
    </motion.div>
  );
}

function RuleSkeleton() {
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
