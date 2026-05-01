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
  CheckCircle2,
  Check,
  Circle,
  ChevronUp,
  Clock,
  Flag,
  Hourglass,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  submitTask,
  approveTask,
  rejectTask,
  createTask,
  deleteTask,
  getTasks,
  type Task,
  type TaskPriority,
} from "@/app/actions/tasks";
import { getCurrentAuthor } from "@/app/actions/auth";
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

const PRIORITY_CONFIG: Record<
  TaskPriority,
  { label: string; color: string; bg: string }
> = {
  low: {
    label: "Low",
    color: "text-muted-foreground/60",
    bg: "bg-muted/20",
  },
  medium: {
    label: "Medium",
    color: "text-blue-400/80",
    bg: "bg-blue-500/10",
  },
  high: {
    label: "High",
    color: "text-yellow-500/80",
    bg: "bg-yellow-500/10",
  },
  urgent: {
    label: "Urgent",
    color: "text-destructive/80",
    bg: "bg-destructive/10",
  },
};

function formatDeadline(timestamp: number): string {
  const diff = timestamp - Date.now();
  const days = Math.floor(diff / 86_400_000);
  const abs = Math.abs(days);
  if (days < 0) return `${abs}d overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days}d`;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const [state, action, isPending] = useActionState(createTask, null);
  const formRef = useRef<HTMLFormElement & { reset: () => void }>(null);

  const { schedule, cancel } = useLocalNotifications();

  usePresence("/tasks", !!currentAuthor);

  const handleRefresh = useCallback(async () => {
    const list = await getTasks();
    setTimeout(() => setTasks(list), 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([getTasks(), getCurrentAuthor()]).then(([taskList, author]) => {
      setTasks(taskList);
      setCurrentAuthor(author);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!state?.success) return;

    setTimeout(() => {
      formRef.current?.reset();
      setShowForm(false);
      void vibrate(50, "medium");
    }, 0);

    getTasks().then((fresh) => {
      setTasks(fresh);
      const newest = fresh[0];
      if (newest?.deadline && newest.status !== "completed") {
        const notifTime = newest.deadline - 60 * 60 * 1_000;
        void schedule({
          id: NOTIF_ID.taskDeadline(idToNumeric(newest.id)),
          title: "📋 Task due soon",
          body: newest.title,
          atMs: notifTime,
        });
      }
    });
  }, [state, schedule]);

  const isT7SEN = currentAuthor === "T7SEN";
  const isBesho = currentAuthor === "Besho";

  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const reviewTasks = tasks.filter((t) => t.status === "in_review");
  const completedTasks = tasks.filter((t) => t.status === "completed");

  const handleSubmit = async (id: string) => {
    void vibrate(50, "medium");
    setProcessingId(id);
    const result = await submitTask(id);
    if (result.success) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: "in_review", submittedAt: Date.now() }
            : t,
        ),
      );
    }
    setProcessingId(null);
  };

  const handleApprove = async (id: string) => {
    void vibrate(50, "medium");
    setProcessingId(id);
    const result = await approveTask(id);
    if (result.success) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, status: "completed", completedAt: Date.now() }
            : t,
        ),
      );
      void cancel([NOTIF_ID.taskDeadline(idToNumeric(id))]);
    }
    setProcessingId(null);
  };

  const handleReject = async (id: string) => {
    void vibrate(50, "medium");
    setProcessingId(id);
    const result = await rejectTask(id);
    if (result.success) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, status: "pending", submittedAt: undefined } : t,
        ),
      );
    }
    setProcessingId(null);
  };

  const handleDelete = async (id: string) => {
    void vibrate(50, "heavy");
    setDeletingId(id);
    const result = await deleteTask(id);
    if (result.success) {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      void cancel([NOTIF_ID.taskDeadline(idToNumeric(id))]);
    }
    setDeletingId(null);
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
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-125 w-125 rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-125 w-125 rounded-full bg-blue-500/5 blur-[150px]" />
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
              Tasks
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {pendingTasks.length} pending · {reviewTasks.length} in review
            </span>
          </div>

          {isT7SEN ? (
            <button
              onClick={() => {
                void vibrate(30, "light");
                setShowForm((v) => !v);
              }}
              aria-label={showForm ? "Close form" : "Add task"}
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

        {/* Create task form — T7SEN only */}
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
                  New Task for Besho
                </h2>

                <div>
                  <label
                    htmlFor="task-title"
                    className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                  >
                    Task *
                  </label>
                  <input
                    id="task-title"
                    name="title"
                    type="text"
                    placeholder="Write what you want her to do…"
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
                    htmlFor="task-desc"
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
                      id="task-desc"
                      name="description"
                      placeholder="Additional details…"
                      rows={2}
                      disabled={isPending || undefined}
                      className={cn(
                        "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                        "placeholder:text-muted-foreground/40 outline-none",
                        "focus:border-primary/40 transition-colors",
                      )}
                    />
                  </motion.div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="task-priority"
                      className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                    >
                      Priority
                    </label>
                    <select
                      id="task-priority"
                      name="priority"
                      defaultValue="medium"
                      disabled={isPending || undefined}
                      className={cn(
                        "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                        "outline-none focus:border-primary/40 transition-colors",
                        "scheme-dark",
                      )}
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="task-deadline"
                      className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
                    >
                      Deadline
                    </label>
                    <input
                      id="task-deadline"
                      name="deadline"
                      type="date"
                      disabled={isPending || undefined}
                      className={cn(
                        "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                        "outline-none focus:border-primary/40 transition-colors",
                        "scheme-dark",
                      )}
                    />
                  </div>
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
                      "Assign task"
                    )}
                  </Button>
                </div>
              </form>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Task list */}
        <div className="space-y-10 pb-24">
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <TaskSkeleton key={i} />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col items-center gap-6 py-24 text-center"
            >
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
                <CheckCircle2 className="h-8 w-8 text-primary/30" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-semibold text-foreground/50">
                  No tasks yet
                </h3>
                <p className="text-sm text-muted-foreground/50">
                  {isT7SEN
                    ? "Assign Besho her first task."
                    : "Sir hasn't assigned any tasks yet."}
                </p>
              </div>
            </motion.div>
          ) : (
            <>
              {pendingTasks.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                    Pending — {pendingTasks.length}
                  </p>
                  {pendingTasks.map((task, index) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      index={index}
                      isBesho={isBesho}
                      isT7SEN={isT7SEN}
                      isProcessing={processingId === task.id}
                      now={now}
                      isDeleting={deletingId === task.id}
                      onSubmit={handleSubmit}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}

              {reviewTasks.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-yellow-500/50">
                    In Review — {reviewTasks.length}
                  </p>
                  {reviewTasks.map((task, index) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      index={index}
                      isBesho={isBesho}
                      isT7SEN={isT7SEN}
                      isProcessing={processingId === task.id}
                      now={now}
                      isDeleting={deletingId === task.id}
                      onSubmit={handleSubmit}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}

              {completedTasks.length > 0 && (
                <div className="space-y-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/30">
                    Completed — {completedTasks.length}
                  </p>
                  {completedTasks.map((task, index) => (
                    <TaskItem
                      key={task.id}
                      task={task}
                      index={index}
                      isBesho={isBesho}
                      isT7SEN={isT7SEN}
                      isProcessing={false}
                      now={now}
                      isDeleting={deletingId === task.id}
                      onSubmit={handleSubmit}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TaskItem({
  task,
  index,
  isBesho,
  isT7SEN,
  isProcessing,
  isDeleting,
  now,
  onSubmit,
  onApprove,
  onReject,
  onDelete,
}: {
  task: Task;
  index: number;
  isBesho: boolean;
  isT7SEN: boolean;
  isProcessing: boolean;
  isDeleting: boolean;
  now: number;
  onSubmit: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const priority = PRIORITY_CONFIG[task.priority];

  const isPending = task.status === "pending";
  const isInReview = task.status === "in_review";
  const isCompleted = task.status === "completed";
  const isOverdue = !!task.deadline && !isCompleted && task.deadline < now;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: isCompleted ? 0.5 : 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className={cn(
        "group relative flex items-start gap-4 rounded-2xl border p-5 transition-colors",
        isCompleted
          ? "border-white/5 bg-card/10"
          : isInReview
            ? "border-yellow-500/20 bg-yellow-500/5"
            : isOverdue
              ? "border-destructive/20 bg-destructive/5"
              : "border-white/5 bg-card/20 hover:border-white/10",
      )}
    >
      {/* Overdue pulse ring */}
      {isOverdue && !isCompleted && (
        <span className="pointer-events-none absolute inset-0 rounded-2xl">
          <span className="absolute inset-0 animate-ping rounded-2xl border border-destructive/30" />
        </span>
      )}

      {/* Left Indicator Column */}
      <div className="relative z-10 mt-0.5 shrink-0">
        {isProcessing ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
        ) : isCompleted ? (
          <CheckCircle2 className="h-5 w-5 text-primary/50" />
        ) : isInReview ? (
          <Hourglass className="h-5 w-5 text-yellow-500/50" />
        ) : isBesho ? (
          <button
            onClick={() => onSubmit(task.id)}
            disabled={isProcessing || undefined}
            aria-label="Submit for review"
            className="text-muted-foreground/30 transition-colors hover:text-primary disabled:opacity-50"
          >
            <Circle className="h-5 w-5" />
          </button>
        ) : (
          <button
            onClick={() => onApprove(task.id)}
            disabled={isProcessing || undefined}
            aria-label="Mark complete directly"
            className="text-muted-foreground/30 transition-colors hover:text-primary disabled:opacity-50"
          >
            <Circle className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="relative z-10 min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p
            className={cn(
              "text-sm font-bold",
              isCompleted
                ? "text-foreground/40 line-through"
                : "text-foreground",
            )}
          >
            {task.title}
          </p>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider",
              priority.color,
              priority.bg,
            )}
          >
            <Flag className="mr-1 inline h-2 w-2" />
            {priority.label}
          </span>
          {isOverdue && !isCompleted && (
            <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-destructive">
              <AlarmClock className="h-2 w-2" />
              Overdue
            </span>
          )}
        </div>

        {task.description && (
          <MarkdownRenderer
            content={task.description}
            className={cn(
              "mt-1 text-base leading-relaxed text-muted-foreground/99",
              "prose-p:my-1 prose-p:last:mb-0",
              "prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
            )}
          />
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {task.deadline && (
            <span
              className={cn(
                "flex items-center gap-1 text-[10px] font-semibold",
                isOverdue && !isCompleted
                  ? "text-destructive/70"
                  : "text-muted-foreground/40",
              )}
            >
              <Clock className="h-2.5 w-2.5" />
              {isCompleted
                ? formatDate(task.deadline)
                : formatDeadline(task.deadline)}
            </span>
          )}

          {isCompleted && task.completedAt && (
            <span className="text-[10px] font-semibold text-primary/50">
              ✓ Completed {formatDate(task.completedAt)}
            </span>
          )}

          {isInReview && task.submittedAt && (
            <span className="text-[10px] font-semibold text-yellow-500/50">
              Submitted {formatDate(task.submittedAt)}
            </span>
          )}

          {isPending && (
            <span className="text-[10px] text-muted-foreground/30">
              Assigned {formatDate(task.createdAt)}
            </span>
          )}
        </div>

        {/* The Review Action Row (Only visible during review) */}
        {isInReview && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            {isT7SEN ? (
              <>
                <button
                  onClick={() => onApprove(task.id)}
                  disabled={isProcessing || undefined}
                  className="flex items-center gap-1.5 rounded-full bg-green-500/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-green-500 transition-all hover:bg-green-500/25 disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  Approve Task
                </button>
                <button
                  onClick={() => onReject(task.id)}
                  disabled={isProcessing || undefined}
                  className="flex items-center gap-1.5 rounded-full bg-destructive/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-all hover:bg-destructive/25 disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                  Reject
                </button>
              </>
            ) : (
              <span className="text-[10px] font-semibold text-yellow-500/50">
                Waiting for Sir&apos;s review...
              </span>
            )}
          </div>
        )}
      </div>

      {/* Delete — T7SEN only */}
      {isT7SEN && !showDelete && (
        <button
          onClick={() => setShowDelete(true)}
          aria-label="Delete task"
          className="relative z-10 shrink-0 rounded-full p-1.5 text-muted-foreground/20 opacity-0 transition-all group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}

      {isT7SEN && showDelete && (
        <div className="relative z-10 flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setShowDelete(false)}
            className="text-[10px] font-semibold text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => onDelete(task.id)}
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
    </motion.div>
  );
}

function TaskSkeleton() {
  return (
    <div className="flex items-start gap-4 rounded-2xl border border-white/5 bg-card/20 p-5">
      <div className="mt-0.5 h-5 w-5 animate-pulse rounded-full bg-muted/30" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-3/5 animate-pulse rounded bg-muted/30" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
        <div className="h-2.5 w-24 animate-pulse rounded bg-muted/15" />
      </div>
    </div>
  );
}
