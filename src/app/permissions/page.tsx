// src/app/permissions/page.tsx
"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Hand,
  Hash,
  History,
  Link2,
  Loader2,
  Pause,
  Plus,
  RotateCcw,
  Settings2,
  Shield,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  createPermission,
  decidePermission,
  getAutoRules,
  getCategoryUsage,
  getPermissionAudit,
  getPermissions,
  getQuotas,
  saveAutoRules,
  setQuotas,
  withdrawPermission,
  type CategoryUsage,
  type PermissionAuditEntry,
  type PermissionQuotas,
  type PermissionRequest,
  type PermissionStatus,
} from "@/app/actions/permissions";
import { getProtocol } from "@/app/actions/protocol";
import {
  CATEGORY_LABEL,
  CATEGORY_SCHEMA,
  DENIAL_REASONS,
  DENIAL_REASON_LABEL,
  MAX_AUTO_RULES,
  MAX_RULE_KEYWORDS,
  PERMISSION_CATEGORIES,
  type AutoDecideRule,
  type DenialReason,
  type PermissionCategory,
} from "@/lib/permissions-constants";
import { getCurrentAuthor } from "@/app/actions/auth";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { usePresence } from "@/hooks/use-presence";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { vibrate } from "@/lib/haptic";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { useKeyboardHeight } from "@/hooks/use-keyboard";

function formatRelative(timestamp: number, now: number): string {
  const diff = timestamp - now;
  const abs = Math.abs(diff);
  const minutes = Math.floor(abs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days >= 1) return diff > 0 ? `in ${days}d` : `${days}d ago`;
  if (hours >= 1) return diff > 0 ? `in ${hours}h` : `${hours}h ago`;
  if (minutes >= 1) return diff > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  return diff > 0 ? "in <1m" : "just now";
}

/** Mirrors the helper in the protocol page — kept inline to avoid a
 *  page-to-page import. Markdown is the same shape on both ends. */
function parseH2Headings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("## ") && !line.startsWith("### ")) {
      const text = line.slice(3).trim();
      if (text.length > 0) headings.push(text);
    }
  }
  return headings;
}

const STATUS_LABEL: Record<PermissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  denied: "Denied",
  queued: "Queued",
  withdrawn: "Withdrawn",
};

// Tailwind v4 source scanner needs static class strings — see the rituals
// dot-row palette comment for context. Map keeps every class literal.
const STATUS_BG: Record<PermissionStatus, string> = {
  pending: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  approved: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  denied: "bg-rose-500/10 text-rose-300 border-rose-500/20",
  queued: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
  withdrawn: "bg-zinc-500/5 text-zinc-400 border-zinc-500/10",
};

const EMPTY_STATE_TIPS_BESHO = [
  "Ask for a treat",
  "Request an outing",
  "Propose a date night",
  "Ask to try something new",
  "Request a privilege",
  "Make a small request",
  "Propose a change to the rules",
];

const PULL_TO_REFRESH_THRESHOLD = 80;

export default function PermissionsPage() {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [usage, setUsage] = useState<CategoryUsage[]>([]);
  const [quotas, setQuotas_] = useState<PermissionQuotas | null>(null);
  const [protocolHeadings, setProtocolHeadings] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentAuthor, setCurrentAuthor] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showQuotaModal, setShowQuotaModal] = useState(false);
  const [showAutoRulesModal, setShowAutoRulesModal] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"all" | "granted">("all");
  const [grantedFilter, setGrantedFilter] = useState<PermissionCategory | null>(
    null,
  );
  const [now] = useState(() => Date.now());

  // Pull-to-refresh — touch-only. Anchors the gesture at scrollY === 0
  // so it doesn't conflict with the page's normal vertical scroll.
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const pullStartYRef = useRef<number | null>(null);

  // Empty-state tip — picked once on mount, doesn't reshuffle on
  // refresh. Keeps the empty state predictable for a given session.
  const [emptyTip] = useState(
    () =>
      EMPTY_STATE_TIPS_BESHO[
        Math.floor(Math.random() * EMPTY_STATE_TIPS_BESHO.length)
      ],
  );

  const [createState, createAction, isCreatePending] = useActionState(
    createPermission,
    null,
  );
  const formRef = useRef<HTMLFormElement & { reset: () => void }>(null);

  usePresence("/permissions", !!currentAuthor);

  const handleRefresh = useCallback(async () => {
    const [data, usageData, quotasData] = await Promise.all([
      getPermissions(),
      getCategoryUsage(),
      getQuotas(),
    ]);
    setTimeout(() => {
      setRequests(data);
      setUsage(usageData);
      setQuotas_(quotasData);
    }, 0);
  }, []);

  useRefreshListener(handleRefresh);

  useEffect(() => {
    Promise.all([
      getPermissions(),
      getCategoryUsage(),
      getQuotas(),
      getCurrentAuthor(),
      getProtocol(),
    ]).then(([data, usageData, quotasData, author, protocol]) => {
      setRequests(data);
      setUsage(usageData);
      setQuotas_(quotasData);
      setCurrentAuthor(author);
      if (protocol?.content) {
        setProtocolHeadings(parseH2Headings(protocol.content));
      }
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!createState?.success) return;
    setTimeout(() => {
      formRef.current?.reset();
      setShowForm(false);
      void vibrate(50, "medium");
    }, 0);
    void handleRefresh();
  }, [createState, handleRefresh]);

  const isT7SEN = currentAuthor === "T7SEN";
  const isBesho = currentAuthor === "Besho";

  const handleDecide = useCallback(
    async (
      id: string,
      decision: PermissionStatus,
      options: { reply?: string; terms?: string; reason?: DenialReason },
    ): Promise<{ error?: string }> => {
      void vibrate(50, "medium");
      setBusyId(id);
      // Snapshot for rollback. Optimistic write applies the decision
      // shape locally so the card moves to Decided immediately;
      // server-truth reconciliation happens on success.
      const snapshot = requests;
      setRequests((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          const next: PermissionRequest = {
            ...r,
            status: decision,
            decidedAt: Date.now(),
            decidedBy: "T7SEN",
          };
          delete next.reply;
          delete next.terms;
          delete next.denialReason;
          if (options.reply?.trim().length) next.reply = options.reply.trim();
          if (decision === "approved" && options.terms?.trim().length) {
            next.terms = options.terms.trim();
          }
          if (decision === "denied" && options.reason) {
            next.denialReason = options.reason;
          }
          return next;
        }),
      );
      try {
        const result = await decidePermission(id, decision, options);
        if (result.error) {
          setRequests(snapshot);
          return { error: result.error };
        }
        await handleRefresh();
        return {};
      } finally {
        setTimeout(() => setBusyId(null), 0);
      }
    },
    [requests, handleRefresh],
  );

  const handleWithdraw = useCallback(
    async (id: string): Promise<{ error?: string }> => {
      void vibrate(40, "medium");
      setBusyId(id);
      const snapshot = requests;
      setRequests((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, status: "withdrawn", withdrawnAt: Date.now() }
            : r,
        ),
      );
      try {
        const result = await withdrawPermission(id);
        if (result.error) {
          setRequests(snapshot);
          return { error: result.error };
        }
        await handleRefresh();
        return {};
      } finally {
        setTimeout(() => setBusyId(null), 0);
      }
    },
    [requests, handleRefresh],
  );

  // Group: pending oldest-first (FIFO action queue), decided newest-first.
  const { pending, decided } = useMemo(() => {
    const pendingArr: PermissionRequest[] = [];
    const decidedArr: PermissionRequest[] = [];
    for (const r of requests) {
      if (r.status === "pending") pendingArr.push(r);
      else decidedArr.push(r);
    }
    pendingArr.sort((a, b) => a.requestedAt - b.requestedAt);
    decidedArr.sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
    return { pending: pendingArr, decided: decidedArr };
  }, [requests]);

  // Granted-only view: approved status, optionally filtered by category.
  const granted = useMemo(() => {
    return requests
      .filter(
        (r) =>
          r.status === "approved" &&
          (grantedFilter === null || r.category === grantedFilter),
      )
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  }, [requests, grantedFilter]);

  // Categories present in granted records — drives the filter chip row.
  const grantedCategories = useMemo(() => {
    const set = new Set<PermissionCategory>();
    for (const r of requests) {
      if (r.status === "approved" && r.category) set.add(r.category);
    }
    return Array.from(set);
  }, [requests]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const doc = (globalThis as unknown as { document: Document }).document;
    if (doc.documentElement.scrollTop > 0) return;
    pullStartYRef.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (pullStartYRef.current === null) return;
    const delta = e.touches[0].clientY - pullStartYRef.current;
    if (delta <= 0) {
      // User reversed direction or scrolled up — abort the pull.
      setPullDistance(0);
      return;
    }
    // Clamp at 2x threshold for visual ceiling; resists past that.
    const clamped = Math.min(delta, PULL_TO_REFRESH_THRESHOLD * 2);
    setPullDistance(clamped);
  }, []);

  const handleTouchEnd = useCallback(async () => {
    if (pullStartYRef.current === null) return;
    const triggered = pullDistance >= PULL_TO_REFRESH_THRESHOLD;
    pullStartYRef.current = null;
    if (triggered && !isRefreshing) {
      setIsRefreshing(true);
      void vibrate(60, "medium");
      try {
        await handleRefresh();
      } finally {
        setTimeout(() => {
          setIsRefreshing(false);
          setPullDistance(0);
        }, 300);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, isRefreshing, handleRefresh]);

  return (
    <div
      className="relative min-h-screen bg-background p-6 md:p-12"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {/* Pull-to-refresh indicator — slides down from the top while
          the user is pulling, locks at threshold, spins during the
          refresh round-trip. */}
      {(pullDistance > 0 || isRefreshing) && (
        <div
          className="pointer-events-none fixed left-1/2 top-0 z-50 -translate-x-1/2"
          style={{
            transform: `translate(-50%, ${Math.min(pullDistance, PULL_TO_REFRESH_THRESHOLD) - 32}px)`,
            opacity: Math.min(pullDistance / PULL_TO_REFRESH_THRESHOLD, 1),
          }}
        >
          <div
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-full",
              "border border-white/10 bg-card/80 backdrop-blur-xl shadow-lg",
              pullDistance >= PULL_TO_REFRESH_THRESHOLD
                ? "text-primary"
                : "text-muted-foreground/60",
            )}
          >
            <Loader2
              className={cn("h-4 w-4", isRefreshing && "animate-spin")}
            />
          </div>
        </div>
      )}
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
              Permissions
            </h1>
            <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
              {isT7SEN
                ? `${pending.length} pending`
                : isBesho
                  ? `${requests.length} total`
                  : ""}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {/* View toggle — both authors */}
            <button
              onClick={() => {
                void vibrate(20, "light");
                setViewMode((v) => (v === "all" ? "granted" : "all"));
                setGrantedFilter(null);
              }}
              aria-label={
                viewMode === "all"
                  ? "Show granted permissions only"
                  : "Show all requests"
              }
              className={cn(
                "rounded-full p-2 transition-all",
                viewMode === "granted"
                  ? "bg-emerald-500/10 text-emerald-300"
                  : "text-muted-foreground/50 hover:bg-emerald-500/10 hover:text-emerald-300",
              )}
            >
              <Shield className="h-4 w-4" />
            </button>

            {/* Quota gear — Sir only */}
            {isT7SEN && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setShowQuotaModal(true);
                }}
                aria-label="Set monthly quotas"
                className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-primary/10 hover:text-primary"
              >
                <Settings2 className="h-4 w-4" />
              </button>
            )}

            {/* Auto-rules — Sir only */}
            {isT7SEN && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setShowAutoRulesModal(true);
                }}
                aria-label="Manage auto-decide rules"
                className="rounded-full p-2 text-muted-foreground/50 transition-all hover:bg-amber-500/10 hover:text-amber-300"
              >
                <Zap className="h-4 w-4" />
              </button>
            )}

            {/* New request — Besho only */}
            {isBesho && (
              <button
                onClick={() => {
                  void vibrate(30, "light");
                  setShowForm((v) => !v);
                }}
                aria-label={showForm ? "Close form" : "New request"}
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
            )}
          </div>
        </div>

        {/* Create form — Besho only */}
        <AnimatePresence>
          {showForm && isBesho && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <RequestForm
                formRef={formRef}
                action={createAction}
                state={createState}
                isPending={isCreatePending}
                onCancel={() => setShowForm(false)}
                protocolHeadings={protocolHeadings}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Quota usage bar — visible when any cap (per-category OR
            pending) is set. Both authors see it; only Sir can edit. */}
        {(usage.some((u) => u.limit !== undefined) ||
          (quotas?.maxPending ?? 0) > 0) &&
          viewMode === "all" && (
            <QuotaUsageBar
              usage={usage}
              maxPending={quotas?.maxPending}
              pendingCount={pending.length}
            />
          )}

        {/* Granted-view category filter chips */}
        {viewMode === "granted" && grantedCategories.length > 1 && (
          <div className="flex flex-wrap gap-1.5 px-1">
            <button
              onClick={() => {
                void vibrate(15, "light");
                setGrantedFilter(null);
              }}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                grantedFilter === null
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                  : "border-white/10 bg-black/20 text-muted-foreground/60 hover:border-white/20",
              )}
            >
              All
            </button>
            {grantedCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => {
                  void vibrate(15, "light");
                  setGrantedFilter(cat);
                }}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                  grantedFilter === cat
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                    : "border-white/10 bg-black/20 text-muted-foreground/60 hover:border-white/20",
                )}
              >
                {CATEGORY_LABEL[cat]}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="space-y-8 pb-24">
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <RequestSkeleton key={i} />
              ))}
            </div>
          ) : viewMode === "granted" ? (
            granted.length === 0 ? (
              <GrantedEmptyState hasFilter={grantedFilter !== null} />
            ) : (
              <Section
                title={
                  grantedFilter
                    ? `Granted · ${CATEGORY_LABEL[grantedFilter]}`
                    : "Granted"
                }
                count={granted.length}
              >
                {granted.map((r) => (
                  <RequestItem
                    key={r.id}
                    request={r}
                    isT7SEN={isT7SEN}
                    isBesho={isBesho}
                    isBusy={busyId === r.id}
                    now={now}
                    onDecide={handleDecide}
                    onWithdraw={handleWithdraw}
                  />
                ))}
              </Section>
            )
          ) : requests.length === 0 ? (
            <EmptyState isBesho={isBesho} tip={emptyTip} />
          ) : (
            <>
              {pending.length > 0 && (
                <Section
                  title={isT7SEN ? "Awaiting Decision" : "Pending"}
                  count={pending.length}
                >
                  {pending.map((r, idx) => (
                    <RequestItem
                      key={r.id}
                      request={r}
                      isT7SEN={isT7SEN}
                      isBesho={isBesho}
                      isBusy={busyId === r.id}
                      now={now}
                      onDecide={handleDecide}
                      onWithdraw={handleWithdraw}
                      pendingIndex={idx}
                      pendingTotal={pending.length}
                    />
                  ))}
                </Section>
              )}
              {isT7SEN && pending.length === 0 && decided.length > 0 && (
                <AllCaughtUp />
              )}
              {decided.length > 0 && (
                <Section title="Decided" count={decided.length}>
                  {decided.map((r) => (
                    <RequestItem
                      key={r.id}
                      request={r}
                      isT7SEN={isT7SEN}
                      isBesho={isBesho}
                      isBusy={busyId === r.id}
                      now={now}
                      onDecide={handleDecide}
                      onWithdraw={handleWithdraw}
                    />
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      </div>

      {/* Quota modal — Sir only. Renders outside the main stack so it
          can overlay everything. */}
      <AnimatePresence>
        {showQuotaModal && isT7SEN && (
          <QuotaModal
            usage={usage}
            quotas={quotas}
            onClose={() => setShowQuotaModal(false)}
            onSaved={handleRefresh}
          />
        )}
      </AnimatePresence>

      {/* Auto-rules modal — Sir only. */}
      <AnimatePresence>
        {showAutoRulesModal && isT7SEN && (
          <AutoRulesModal onClose={() => setShowAutoRulesModal(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
          {title}
        </h2>
        <span className="text-[10px] font-bold text-muted-foreground/30">
          ({count})
        </span>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function RequestSkeleton() {
  return (
    <div className="rounded-2xl border border-white/5 bg-card/20 p-5">
      <div className="flex items-start gap-3">
        <div className="h-4 w-4 animate-pulse rounded bg-muted/30" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-3/5 animate-pulse rounded bg-muted/30" />
          <div className="h-3 w-full animate-pulse rounded bg-muted/20" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted/20" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({ isBesho, tip }: { isBesho: boolean; tip: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-6 py-24 text-center"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/5 ring-1 ring-primary/10">
        <Hand className="h-8 w-8 text-primary/30" />
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground/50">
          No permission requests
        </h3>
        <p className="text-sm text-muted-foreground/50">
          {isBesho
            ? `Tap + to ask ${TITLE_BY_AUTHOR.T7SEN} for something.`
            : `${TITLE_BY_AUTHOR.Besho} hasn't asked for anything yet.`}
        </p>
        {isBesho && (
          <p className="pt-2 text-xs italic text-primary/40">
            Try: &ldquo;{tip}&rdquo;
          </p>
        )}
      </div>
    </motion.div>
  );
}

function RequestItem({
  request,
  isT7SEN,
  isBesho,
  isBusy,
  now,
  onDecide,
  onWithdraw,
  pendingIndex,
  pendingTotal,
}: {
  request: PermissionRequest;
  isT7SEN: boolean;
  isBesho: boolean;
  isBusy: boolean;
  now: number;
  onDecide: (
    id: string,
    decision: PermissionStatus,
    options: { reply?: string; terms?: string; reason?: DenialReason },
  ) => Promise<{ error?: string }>;
  onWithdraw: (id: string) => Promise<{ error?: string }>;
  /** Zero-based position within the pending FIFO. Undefined for
   *  decided items (they don't show the FIFO chip). */
  pendingIndex?: number;
  pendingTotal?: number;
}) {
  const [pendingDecision, setPendingDecision] =
    useState<PermissionStatus | null>(null);
  const [reply, setReply] = useState("");
  const [terms, setTerms] = useState("");
  const [reason, setReason] = useState<DenialReason | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  // Long-press copy state. Timer ref kept in a useRef so React doesn't
  // re-render on every tick. `copied` flips true for ~1.5s on success
  // to drive the inline "Copied" affordance.
  const [copied, setCopied] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keyboard-shortcut focus state. Only shows the hint when the card
  // is genuinely focused — avoids cluttering every pending card.
  const [isCardFocused, setIsCardFocused] = useState(false);

  const isPending = request.status === "pending";
  const isExpired = !!request.expiresAt && request.expiresAt < now;
  const isOwner = request.requestedBy === "Besho" && isBesho;
  const auditCount = request.auditCount ?? 0;
  const showFifo =
    isPending &&
    pendingIndex !== undefined &&
    pendingTotal !== undefined &&
    pendingTotal > 1;
  const sirCanShortcut =
    isPending && isT7SEN && pendingDecision === null && !isBusy;

  // Long-press copy. 500ms hold; cancel on touch-move/leave/release.
  // Clipboard write needs HTTPS + a user gesture; long-press provides
  // both. Failure (denied permission, no clipboard API) silently
  // skips the success affordance.
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const startLongPress = useCallback(() => {
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const nav = (
            globalThis as unknown as {
              navigator: Navigator & { clipboard?: Clipboard };
            }
          ).navigator;
          if (!nav.clipboard?.writeText) return;
          await nav.clipboard.writeText(request.body);
          void vibrate(40, "medium");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Permission denied or unsupported — silent fail.
        }
      })();
    }, 500);
  }, [request.body, cancelLongPress]);

  useEffect(() => {
    return cancelLongPress;
  }, [cancelLongPress]);

  // Keyboard shortcuts — A/D/Q open the corresponding decide-confirm
  // panel for Sir on a focused pending card. No web-vs-native gate;
  // touch devices simply never fire keyDown for these keys.
  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sirCanShortcut) return;
    // Don't hijack typing inside an input/textarea/contentEditable.
    const tgt = e.target as HTMLElement;
    if (
      tgt.tagName === "INPUT" ||
      tgt.tagName === "TEXTAREA" ||
      tgt.isContentEditable
    ) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "a") {
      e.preventDefault();
      startDecide("approved");
    } else if (key === "d") {
      e.preventDefault();
      startDecide("denied");
    } else if (key === "q") {
      e.preventDefault();
      startDecide("queued");
    }
  };

  const startDecide = (decision: PermissionStatus) => {
    void vibrate(20, "light");
    setActionError(null);
    setPendingDecision(decision);
    // Reset decision-specific staged state when switching between
    // approve/deny/queue so old terms don't carry over to a denial.
    setTerms("");
    setReason(null);
  };

  const cancelDecide = () => {
    setPendingDecision(null);
    setReply("");
    setTerms("");
    setReason(null);
    setActionError(null);
  };

  const confirmDecide = async () => {
    if (!pendingDecision) return;
    const result = await onDecide(request.id, pendingDecision, {
      reply,
      terms: pendingDecision === "approved" ? terms : undefined,
      reason: pendingDecision === "denied" ? (reason ?? undefined) : undefined,
    });
    if (result.error) {
      setActionError(result.error);
    } else {
      setPendingDecision(null);
      setReply("");
      setTerms("");
      setReason(null);
    }
  };

  const confirmWithdraw = async () => {
    const result = await onWithdraw(request.id);
    if (result.error) {
      setActionError(result.error);
      setShowWithdrawConfirm(false);
    }
  };

  const decisionConfirmLabel =
    pendingDecision === "approved"
      ? "Confirm Approval"
      : pendingDecision === "denied"
        ? "Confirm Denial"
        : pendingDecision === "queued"
          ? "Confirm Queue"
          : "Confirm";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      tabIndex={sirCanShortcut ? 0 : -1}
      onKeyDown={handleCardKeyDown}
      onFocus={() => setIsCardFocused(true)}
      onBlur={() => setIsCardFocused(false)}
      className={cn(
        "relative rounded-2xl border bg-card/30 p-5 backdrop-blur-xl outline-none transition-shadow",
        isPending ? "border-primary/15 bg-primary/5" : "border-white/5",
        isCardFocused && sirCanShortcut && "ring-2 ring-primary/40",
      )}
    >
      {/* Long-press copy success affordance — small floating chip. */}
      <AnimatePresence>
        {copied && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-200 shadow-lg backdrop-blur-md"
          >
            <Check className="h-3 w-3" />
            Copied
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top row: status + category + chips + expiry + timestamp */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest",
            STATUS_BG[request.status],
          )}
        >
          {STATUS_LABEL[request.status]}
        </span>
        {request.category && (
          <span className="rounded-full bg-muted/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70">
            {CATEGORY_LABEL[request.category]}
          </span>
        )}
        {request.status === "denied" && request.denialReason && (
          <span className="rounded-full border border-rose-500/20 bg-rose-500/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-rose-300/80">
            {DENIAL_REASON_LABEL[request.denialReason]}
          </span>
        )}
        {isPending && isExpired && (
          <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-destructive/80">
            <Clock className="h-2.5 w-2.5" />
            Expired
          </span>
        )}
        {showFifo && (
          <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70">
            #{(pendingIndex ?? 0) + 1} of {pendingTotal}
          </span>
        )}
        {request.wasReasked && (
          <span
            className="flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-violet-300/80"
            title="Same body as a previously denied request"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Asked again
          </span>
        )}
        {request.decidedByRuleId && (
          <span className="flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300/80">
            <Zap className="h-2.5 w-2.5" />
            Auto
          </span>
        )}
        {auditCount > 0 && (
          <button
            type="button"
            onClick={() => {
              void vibrate(15, "light");
              setShowAudit((s) => !s);
            }}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest transition-colors",
              showAudit
                ? "border-primary/40 bg-primary/15 text-primary"
                : "border-white/10 bg-white/5 text-muted-foreground/60 hover:border-white/20 hover:text-foreground",
            )}
            aria-expanded={showAudit}
          >
            <History className="h-2.5 w-2.5" />
            Changed {auditCount}
            {auditCount === 1 ? "x" : "x"}
          </button>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/40">
          {formatRelative(request.requestedAt, now)}
        </span>
      </div>

      {/* Body — markdown rendered. Long-press copies the raw source
          to the clipboard. The handlers attach to the wrapper div so
          they cover the entire prose area, including links and lists. */}
      <div
        className="text-sm text-foreground/90 [&_p]:my-0 [&_p+p]:mt-2 [&_strong]:text-foreground [&_em]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-black/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]"
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onMouseDown={startLongPress}
        onMouseUp={cancelLongPress}
        onMouseLeave={cancelLongPress}
        onContextMenu={(e) => {
          // Long-press on Android WebView triggers contextmenu. Suppress
          // it so the native text-selection bubble doesn't compete.
          if (copied) e.preventDefault();
        }}
      >
        <MarkdownRenderer content={request.body} />
      </div>

      {/* Structured-field chips — price, whoWith, protocolRef */}
      {(request.price !== undefined ||
        request.whoWith ||
        request.protocolRef) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {request.price !== undefined && (
            <span className="flex items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-300/80">
              <Hash className="h-2.5 w-2.5" />${request.price}
            </span>
          )}
          {request.whoWith && (
            <span className="flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-violet-300/80">
              with {request.whoWith}
            </span>
          )}
          {request.protocolRef && (
            <Link
              href={`/protocol?focus=${encodeURIComponent(request.protocolRef)}`}
              className="flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-primary/80 transition-colors hover:border-primary/40 hover:bg-primary/10"
            >
              <Link2 className="h-2.5 w-2.5" />§ {request.protocolRef}
            </Link>
          )}
        </div>
      )}

      {/* Audit log expansion */}
      {auditCount > 0 && showAudit && (
        <AuditLogView requestId={request.id} now={now} />
      )}

      {/* Expiry meta */}
      {request.expiresAt && isPending && !isExpired && (
        <p className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground/50">
          <Clock className="h-2.5 w-2.5" />
          Expires {formatRelative(request.expiresAt, now)}
        </p>
      )}

      {/* Decided meta — terms (approval) and reply (any decision) */}
      {!isPending && (request.terms || request.reply) && (
        <div className="mt-3 space-y-2 rounded-xl border border-white/5 bg-black/20 p-3">
          {request.terms && (
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-emerald-400/70">
                Terms
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-emerald-100/90">
                {request.terms}
              </p>
            </div>
          )}
          {request.reply && (
            <div>
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
                {TITLE_BY_AUTHOR.T7SEN}
                {request.decidedAt && (
                  <> · {formatRelative(request.decidedAt, now)}</>
                )}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">
                {request.reply}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Withdrawn meta — when, by Besho */}
      {request.status === "withdrawn" && request.withdrawnAt && (
        <p className="mt-2 text-[10px] text-muted-foreground/40">
          Withdrawn by {TITLE_BY_AUTHOR.Besho} ·{" "}
          {formatRelative(request.withdrawnAt, now)}
        </p>
      )}

      {/* Sir action row — pending only */}
      {isPending && isT7SEN && !pendingDecision && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => startDecide("approved")}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 transition-all hover:bg-emerald-500/25 disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            Approve
          </button>
          <button
            onClick={() => startDecide("denied")}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-rose-500/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 transition-all hover:bg-rose-500/25 disabled:opacity-50"
          >
            <X className="h-3 w-3" />
            Deny
          </button>
          <button
            onClick={() => startDecide("queued")}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-zinc-500/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300 transition-all hover:bg-zinc-500/25 disabled:opacity-50"
          >
            <Pause className="h-3 w-3" />
            Queue
          </button>
        </div>
      )}

      {/* Keyboard-shortcut hint — surfaces only when this card is
          focused via Tab. Hidden on touch devices in practice (no
          focus events from taps). */}
      {isCardFocused && sirCanShortcut && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[9px] uppercase tracking-widest text-muted-foreground/40">
          <span className="rounded border border-white/10 bg-black/30 px-1 py-0.5 text-foreground/70">
            A
          </span>
          approve
          <span className="ml-2 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-foreground/70">
            D
          </span>
          deny
          <span className="ml-2 rounded border border-white/10 bg-black/30 px-1 py-0.5 text-foreground/70">
            Q
          </span>
          queue
        </p>
      )}

      {/* Sir confirm row — terms (approve), reason (deny), reply (any) */}
      <AnimatePresence>
        {isPending && isT7SEN && pendingDecision && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-4 space-y-3">
              {/* Terms field — approval only */}
              {pendingDecision === "approved" && (
                <div>
                  <label
                    htmlFor={`terms-${request.id}`}
                    className="mb-1 block text-[9px] font-bold uppercase tracking-widest text-emerald-400/70"
                  >
                    Terms (optional)
                  </label>
                  <input
                    id={`terms-${request.id}`}
                    type="text"
                    placeholder="e.g. only this weekend, max $30…"
                    value={terms}
                    onChange={(e) => setTerms(e.target.value)}
                    disabled={isBusy || undefined}
                    className={cn(
                      "w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm",
                      "placeholder:text-muted-foreground/40 outline-none",
                      "focus:border-emerald-500/40 transition-colors",
                    )}
                  />
                </div>
              )}

              {/* Reason chips — denial only */}
              {pendingDecision === "denied" && (
                <div>
                  <p className="mb-1.5 block text-[9px] font-bold uppercase tracking-widest text-rose-400/70">
                    Reason (optional — drives re-ask cooldown)
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {DENIAL_REASONS.map((r) => {
                      const selected = reason === r;
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => {
                            void vibrate(15, "light");
                            setReason(selected ? null : r);
                          }}
                          disabled={isBusy || undefined}
                          aria-pressed={selected}
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                            selected
                              ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                              : "border-white/10 bg-black/20 text-muted-foreground/60 hover:border-white/20",
                          )}
                        >
                          {DENIAL_REASON_LABEL[r]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Reply field — any decision */}
              <RichTextEditor
                id={`reply-${request.id}`}
                name="reply"
                placeholder="Reply (optional)…"
                rows={3}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={isBusy || undefined}
                className={cn(
                  "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm",
                  "placeholder:text-muted-foreground/40 outline-none",
                  "focus:border-primary/40 transition-colors",
                )}
              />

              {actionError && (
                <p className="text-xs font-medium text-destructive">
                  {actionError}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelDecide}
                  disabled={isBusy || undefined}
                  className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:text-foreground disabled:opacity-50"
                >
                  Cancel
                </button>
                <Button
                  type="button"
                  onClick={() => void confirmDecide()}
                  disabled={isBusy || undefined}
                  className="rounded-full px-4 text-[10px] uppercase tracking-wider"
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    decisionConfirmLabel
                  )}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Besho withdraw — pending + her own */}
      {isPending && isOwner && !showWithdrawConfirm && (
        <div className="mt-4">
          <button
            onClick={() => {
              void vibrate(20, "light");
              setActionError(null);
              setShowWithdrawConfirm(true);
            }}
            disabled={isBusy || undefined}
            className="flex items-center gap-1.5 rounded-full bg-muted/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:bg-muted/30 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            Withdraw request
          </button>
        </div>
      )}

      <AnimatePresence>
        {isPending && isOwner && showWithdrawConfirm && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-4 overflow-hidden"
          >
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3">
              <p className="text-xs text-destructive/80">
                Withdraw this request? It will stay in the audit log as
                withdrawn.
              </p>
              {actionError && (
                <p className="mt-2 text-xs font-medium text-destructive">
                  {actionError}
                </p>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowWithdrawConfirm(false);
                    setActionError(null);
                  }}
                  disabled={isBusy || undefined}
                  className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:text-foreground disabled:opacity-50"
                >
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => void confirmWithdraw()}
                  disabled={isBusy || undefined}
                  className="rounded-full bg-destructive/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-destructive transition-all hover:bg-destructive/30 disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Withdraw"
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Generic action error fallback */}
      {actionError && !pendingDecision && !showWithdrawConfirm && (
        <p className="mt-3 text-xs font-medium text-destructive">
          {actionError}
        </p>
      )}
    </motion.div>
  );
}

function RequestForm({
  formRef,
  action,
  state,
  isPending,
  onCancel,
  protocolHeadings,
}: {
  formRef: React.RefObject<(HTMLFormElement & { reset: () => void }) | null>;
  action: (formData: FormData) => void;
  state: { success?: boolean; error?: string } | null;
  isPending: boolean;
  onCancel: () => void;
  protocolHeadings: string[];
}) {
  const keyboardHeight = useKeyboardHeight();
  const containerRef = useRef<HTMLDivElement>(null);

  // Controlled category — drives schema-conditional fields below.
  const [category, setCategory] = useState<PermissionCategory | "">("");
  const [expiresAt, setExpiresAt] = useState("");

  const spec = category ? CATEGORY_SCHEMA[category] : null;

  /**
   * Auto-fills the expiry input when Besho picks a category that has
   * a default expiry — but only if she hasn't already typed something.
   * Lives in the change handler rather than an effect because the
   * trigger is genuinely event-driven (category selection), not a
   * state sync. Avoids react-hooks/set-state-in-effect.
   */
  const handleCategoryChange = (next: PermissionCategory | "") => {
    setCategory(next);
    if (!next) return;
    const nextSpec = CATEGORY_SCHEMA[next];
    if (!nextSpec.defaultExpiryHours) return;
    if (expiresAt.length > 0) return;
    const target = new Date(
      Date.now() + nextSpec.defaultExpiryHours * 3_600_000,
    );
    // <input type="datetime-local"> wants "YYYY-MM-DDTHH:MM" in local time.
    const pad = (n: number) => String(n).padStart(2, "0");
    setExpiresAt(
      `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}` +
        `T${pad(target.getHours())}:${pad(target.getMinutes())}`,
    );
  };

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
    <form
      ref={formRef}
      action={action}
      className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-xl shadow-2xl shadow-black/40"
    >
      <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
        New Request
      </h2>

      <motion.div
        ref={containerRef}
        animate={{
          paddingBottom: keyboardHeight > 0 ? keyboardHeight + 16 : 0,
        }}
        transition={{ type: "spring", bounce: 0, duration: 0.3 }}
        className="space-y-4"
      >
        <div>
          <label
            htmlFor="permission-body"
            className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
          >
            What are you asking for? *
          </label>
          <RichTextEditor
            id="permission-body"
            name="body"
            placeholder="Be specific…"
            rows={4}
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
              htmlFor="permission-category"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
            >
              Category
            </label>
            <select
              id="permission-category"
              name="category"
              value={category}
              onChange={(e) =>
                handleCategoryChange(e.target.value as PermissionCategory | "")
              }
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "outline-none focus:border-primary/40 transition-colors",
              )}
            >
              <option value="">— None —</option>
              {PERMISSION_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {CATEGORY_LABEL[cat]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="permission-expires"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50"
            >
              Expires {spec?.defaultExpiryHours ? "(auto)" : "(optional)"}
            </label>
            <input
              id="permission-expires"
              name="expiresAt"
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "outline-none focus:border-primary/40 transition-colors",
                "scheme-dark",
              )}
            />
          </div>
        </div>

        {/* Per-category required fields */}
        {spec?.requiresPrice && (
          <div>
            <label
              htmlFor="permission-price"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-amber-300/70"
            >
              Price *
            </label>
            <input
              id="permission-price"
              name="price"
              type="number"
              min={0}
              max={100_000}
              step="0.01"
              required
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm tabular-nums",
                "placeholder:text-muted-foreground/40 outline-none",
                "focus:border-amber-500/40 transition-colors",
              )}
              placeholder="e.g. 25"
            />
          </div>
        )}

        {spec?.requiresWhoWith && (
          <div>
            <label
              htmlFor="permission-whowith"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-violet-300/70"
            >
              Who with? *
            </label>
            <input
              id="permission-whowith"
              name="whoWith"
              type="text"
              required
              maxLength={200}
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "placeholder:text-muted-foreground/40 outline-none",
                "focus:border-violet-500/40 transition-colors",
              )}
              placeholder="e.g. Sara, Ali, the office crew"
            />
          </div>
        )}

        {/* Protocol reference — optional dropdown of current ## headings */}
        {protocolHeadings.length > 0 && (
          <div>
            <label
              htmlFor="permission-protocolref"
              className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-primary/60"
            >
              Reference protocol section (optional)
            </label>
            <select
              id="permission-protocolref"
              name="protocolRef"
              defaultValue=""
              disabled={isPending || undefined}
              className={cn(
                "w-full rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
                "outline-none focus:border-primary/40 transition-colors",
              )}
            >
              <option value="">— None —</option>
              {protocolHeadings.map((h) => (
                <option key={h} value={h}>
                  § {h}
                </option>
              ))}
            </select>
          </div>
        )}
      </motion.div>

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
          disabled={isPending || undefined}
          className="rounded-full px-5"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
        </Button>
      </div>
    </form>
  );
}

function QuotaUsageBar({
  usage,
  maxPending,
  pendingCount,
}: {
  usage: CategoryUsage[];
  maxPending?: number;
  pendingCount: number;
}) {
  const capped = usage.filter((u) => u.limit !== undefined);
  const showPending = typeof maxPending === "number" && maxPending > 0;
  if (capped.length === 0 && !showPending) return null;
  const pendingAtCap = showPending && pendingCount >= (maxPending ?? 0);
  const pendingPct = showPending
    ? Math.min(100, (pendingCount / (maxPending ?? 1)) * 100)
    : 0;
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap gap-2 rounded-2xl border border-white/5 bg-card/30 p-3 backdrop-blur-xl"
    >
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
        This month
      </span>
      {capped.map((u) => {
        const pct =
          u.limit && u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 0;
        const atCap = u.limit !== undefined && u.used >= u.limit;
        return (
          <div
            key={u.category}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
              atCap
                ? "border-rose-500/30 bg-rose-500/10"
                : "border-white/10 bg-black/20",
            )}
          >
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-wider",
                atCap ? "text-rose-300" : "text-muted-foreground/70",
              )}
            >
              {CATEGORY_LABEL[u.category]}
            </span>
            <span
              className={cn(
                "text-[10px] tabular-nums",
                atCap ? "text-rose-300" : "text-foreground/60",
              )}
            >
              {u.used}/{u.limit}
            </span>
            <span
              className="ml-1 h-1 w-8 overflow-hidden rounded-full bg-white/10"
              aria-hidden
            >
              <span
                className={cn(
                  "block h-full",
                  atCap ? "bg-rose-400" : "bg-emerald-400/60",
                )}
                style={{ width: `${pct}%` }}
              />
            </span>
          </div>
        );
      })}
      {showPending && (
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1",
            pendingAtCap
              ? "border-rose-500/30 bg-rose-500/10"
              : "border-amber-500/20 bg-amber-500/5",
          )}
        >
          <span
            className={cn(
              "text-[10px] font-bold uppercase tracking-wider",
              pendingAtCap ? "text-rose-300" : "text-amber-300/80",
            )}
          >
            Pending
          </span>
          <span
            className={cn(
              "text-[10px] tabular-nums",
              pendingAtCap ? "text-rose-300" : "text-foreground/60",
            )}
          >
            {pendingCount}/{maxPending}
          </span>
          <span
            className="ml-1 h-1 w-8 overflow-hidden rounded-full bg-white/10"
            aria-hidden
          >
            <span
              className={cn(
                "block h-full",
                pendingAtCap ? "bg-rose-400" : "bg-amber-400/60",
              )}
              style={{ width: `${pendingPct}%` }}
            />
          </span>
        </div>
      )}
    </motion.div>
  );
}

function GrantedEmptyState({ hasFilter }: { hasFilter: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center gap-6 py-24 text-center"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/5 ring-1 ring-emerald-500/10">
        <Shield className="h-8 w-8 text-emerald-500/30" />
      </div>
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-foreground/50">
          {hasFilter
            ? "No granted permissions in this category"
            : "No granted permissions yet"}
        </h3>
        <p className="text-sm text-muted-foreground/50">
          Approved requests with terms appear here as your standing permissions
          reference.
        </p>
      </div>
    </motion.div>
  );
}

function QuotaModal({
  usage,
  quotas,
  onClose,
  onSaved,
}: {
  usage: CategoryUsage[];
  quotas: PermissionQuotas | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [state, dispatch, isPending] = useActionState(setQuotas, null);

  useEffect(() => {
    if (state?.success) {
      void onSaved();
      onClose();
    }
  }, [state, onSaved, onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", bounce: 0.1, duration: 0.4 }}
        className="w-full max-w-md rounded-3xl border border-white/10 bg-card p-6 shadow-2xl shadow-black/60"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-primary/80">
            Quotas &amp; Caps
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted-foreground/60 hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form action={dispatch} className="space-y-4">
          {/* Pending-queue cap — single global value */}
          <div className="space-y-2 border-b border-white/5 pb-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-amber-300/70">
              Pending Queue
            </p>
            <p className="text-xs text-muted-foreground/60">
              Maximum simultaneous pending requests. Auto-decided requests
              bypass. Empty / 0 = no cap.
            </p>
            <div className="flex items-center gap-3 pt-1">
              <label
                htmlFor="quota-max-pending"
                className="flex-1 text-xs font-bold uppercase tracking-wider text-muted-foreground/70"
              >
                Max Pending
              </label>
              <input
                id="quota-max-pending"
                name="maxPending"
                type="number"
                min={0}
                max={99}
                step={1}
                defaultValue={quotas?.maxPending ?? ""}
                placeholder="—"
                disabled={isPending || undefined}
                className={cn(
                  "w-20 rounded-xl border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-right tabular-nums",
                  "outline-none focus:border-amber-500/40 transition-colors",
                )}
              />
            </div>
          </div>

          {/* Per-category monthly limits */}
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-300/70">
              Monthly Approval Limits
            </p>
            <p className="text-xs text-muted-foreground/60">
              Per-category caps on approved requests per Cairo calendar month.
              Empty / 0 = no cap.
            </p>
            {PERMISSION_CATEGORIES.map((cat) => {
              const u = usage.find((x) => x.category === cat);
              return (
                <div key={cat} className="flex items-center gap-3">
                  <label
                    htmlFor={`limit-${cat}`}
                    className="flex-1 text-xs font-bold uppercase tracking-wider text-muted-foreground/70"
                  >
                    {CATEGORY_LABEL[cat]}
                  </label>
                  <span className="w-14 text-right text-[10px] tabular-nums text-muted-foreground/40">
                    used: {u?.used ?? 0}
                  </span>
                  <input
                    id={`limit-${cat}`}
                    name={`limit:${cat}`}
                    type="number"
                    min={0}
                    max={999}
                    step={1}
                    defaultValue={u?.limit ?? ""}
                    placeholder="—"
                    disabled={isPending || undefined}
                    className={cn(
                      "w-20 rounded-xl border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-right tabular-nums",
                      "outline-none focus:border-primary/40 transition-colors",
                    )}
                  />
                </div>
              );
            })}
          </div>

          {state?.error && (
            <p className="text-xs font-medium text-destructive">
              {state.error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending || undefined}
              className="rounded-full border border-border/40 px-4 py-2 text-xs font-semibold text-muted-foreground transition-all hover:text-foreground"
            >
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
                "Save"
              )}
            </Button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

function AuditLogView({ requestId, now }: { requestId: string; now: number }) {
  const [entries, setEntries] = useState<PermissionAuditEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    void getPermissionAudit(requestId).then((data) => {
      setTimeout(() => {
        setEntries(data);
        setIsLoading(false);
      }, 0);
    });
  }, [requestId]);

  if (isLoading) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/5 bg-black/20 p-3">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/40" />
        <span className="text-[10px] text-muted-foreground/40">
          Loading history…
        </span>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-white/5 bg-black/20 p-3">
      <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/40">
        Previous decisions ({entries.length})
      </p>
      <div className="space-y-2">
        {entries.map((entry, i) => (
          <div
            key={`${entry.decidedAt ?? i}-${i}`}
            className="rounded-lg border border-white/5 bg-black/30 p-2"
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest",
                  STATUS_BG[entry.status],
                )}
              >
                {STATUS_LABEL[entry.status]}
              </span>
              {entry.denialReason && (
                <span className="rounded-full border border-rose-500/20 bg-rose-500/5 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest text-rose-300/80">
                  {DENIAL_REASON_LABEL[entry.denialReason]}
                </span>
              )}
              <span className="ml-auto text-[9px] text-muted-foreground/40">
                {entry.decidedAt
                  ? formatRelative(entry.decidedAt, now)
                  : "earlier"}
              </span>
            </div>
            {entry.terms && (
              <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-emerald-200/80">
                <span className="font-bold uppercase tracking-wider text-emerald-400/60">
                  Terms:
                </span>{" "}
                {entry.terms}
              </p>
            )}
            {entry.reply && (
              <p className="mt-1.5 whitespace-pre-wrap text-[11px] text-foreground/70">
                {entry.reply}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Sir's auto-decide rule editor. Loads rules on mount, persists each
 * mutation immediately via saveAutoRules. Array order = priority
 * order; up/down buttons reorder.
 */
function AutoRulesModal({ onClose }: { onClose: () => void }) {
  const [rules, setRules] = useState<AutoDecideRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isPersisting, setIsPersisting] = useState(false);

  useEffect(() => {
    void getAutoRules().then((r) => {
      setTimeout(() => {
        setRules(r);
        setIsLoading(false);
      }, 0);
    });
  }, []);

  const persist = useCallback(async (next: AutoDecideRule[]) => {
    setIsPersisting(true);
    setError(null);
    try {
      const result = await saveAutoRules(next);
      if (result.error) {
        setError(result.error);
        return false;
      }
      setRules(next);
      return true;
    } finally {
      setTimeout(() => setIsPersisting(false), 0);
    }
  }, []);

  const handleAdd = () => {
    if (rules.length >= MAX_AUTO_RULES) {
      setError(`Maximum ${MAX_AUTO_RULES} rules.`);
      return;
    }
    void vibrate(20, "light");
    const draft: AutoDecideRule = {
      id: crypto.randomUUID(),
      enabled: true,
      decision: "approved",
      notifySir: true,
      createdAt: Date.now(),
    };
    void persist([...rules, draft]).then((ok) => {
      if (ok) setEditingId(draft.id);
    });
  };

  const handleToggle = (id: string) => {
    void vibrate(15, "light");
    void persist(
      rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    const idx = rules.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= rules.length) return;
    void vibrate(15, "light");
    const next = [...rules];
    [next[idx], next[target]] = [next[target], next[idx]];
    void persist(next);
  };

  const handleDelete = (id: string) => {
    void vibrate(30, "medium");
    void persist(rules.filter((r) => r.id !== id)).then((ok) => {
      if (ok) setConfirmDeleteId(null);
    });
  };

  const handleEditSave = (updated: AutoDecideRule) => {
    void persist(rules.map((r) => (r.id === updated.id ? updated : r))).then(
      (ok) => {
        if (ok) setEditingId(null);
      },
    );
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm md:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: "spring", bounce: 0.1, duration: 0.4 }}
        className="flex max-h-[90vh] w-full max-w-md flex-col rounded-3xl border border-white/10 bg-card shadow-2xl shadow-black/60"
      >
        <div className="flex items-center justify-between border-b border-white/5 p-6 pb-4">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-300" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-amber-300/80">
              Auto-decide Rules
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1.5 text-muted-foreground/60 hover:bg-white/5 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4">
          <p className="mb-4 text-xs text-muted-foreground/60">
            Rules evaluate top-to-bottom on every new request. First match wins;
            auto-decided requests skip the pending phase. Disabled rules are
            skipped.
          </p>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/40" />
            </div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Zap className="h-8 w-8 text-amber-500/20" />
              <p className="text-sm text-muted-foreground/60">
                No rules yet. Add one to start auto-deciding routine asks.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule, idx) => (
                <AutoRuleCard
                  key={rule.id}
                  rule={rule}
                  index={idx}
                  total={rules.length}
                  isEditing={editingId === rule.id}
                  isConfirmingDelete={confirmDeleteId === rule.id}
                  isBusy={isPersisting}
                  onEdit={() => {
                    void vibrate(15, "light");
                    setEditingId(rule.id);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onSaveEdit={handleEditSave}
                  onToggle={() => handleToggle(rule.id)}
                  onMoveUp={() => handleMove(rule.id, -1)}
                  onMoveDown={() => handleMove(rule.id, 1)}
                  onAskDelete={() => setConfirmDeleteId(rule.id)}
                  onCancelDelete={() => setConfirmDeleteId(null)}
                  onConfirmDelete={() => handleDelete(rule.id)}
                />
              ))}
            </div>
          )}

          {error && (
            <p className="mt-3 text-xs font-medium text-destructive">{error}</p>
          )}
        </div>

        <div className="border-t border-white/5 p-6 pt-4">
          <button
            type="button"
            onClick={handleAdd}
            disabled={isPersisting || rules.length >= MAX_AUTO_RULES}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-amber-500/30 px-4 py-3",
              "text-sm font-bold uppercase tracking-wider text-amber-300/80",
              "transition-all hover:bg-amber-500/5",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            <Plus className="h-4 w-4" />
            Add Rule
            <span className="ml-1 text-[10px] text-muted-foreground/40">
              {rules.length} / {MAX_AUTO_RULES}
            </span>
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AutoRuleCard({
  rule,
  index,
  total,
  isEditing,
  isConfirmingDelete,
  isBusy,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onToggle,
  onMoveUp,
  onMoveDown,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  rule: AutoDecideRule;
  index: number;
  total: number;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  isBusy: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (rule: AutoDecideRule) => void;
  onToggle: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const summary = summarizeRule(rule);
  const decisionTone =
    rule.decision === "approved"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
      : "bg-rose-500/10 text-rose-300 border-rose-500/20";

  if (isEditing) {
    return (
      <AutoRuleEditor
        rule={rule}
        isBusy={isBusy}
        onCancel={onCancelEdit}
        onSave={onSaveEdit}
      />
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-2xl border bg-black/20 p-3",
        rule.enabled ? "border-white/10" : "border-white/5 opacity-50",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Index + reorder */}
        <div className="flex flex-col items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0 || isBusy || undefined}
            aria-label="Move rule up"
            className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <span className="text-[9px] tabular-nums text-muted-foreground/40">
            {index + 1}
          </span>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === total - 1 || isBusy || undefined}
            aria-label="Move rule down"
            className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>

        {/* Decision + summary */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest",
                decisionTone,
              )}
            >
              {rule.decision === "approved" ? "Approve" : "Deny"}
            </span>
            {!rule.enabled && (
              <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
                Off
              </span>
            )}
            {rule.notifySir === false && rule.enabled && (
              <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
                Silent
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs text-foreground/80">{summary}</p>
        </div>

        {/* Toggle + edit + delete */}
        <div className="flex shrink-0 flex-col gap-1">
          <button
            type="button"
            onClick={onToggle}
            disabled={isBusy || undefined}
            aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors",
              rule.enabled
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-white/10 bg-black/20 text-muted-foreground/50",
            )}
          >
            {rule.enabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={isBusy || undefined}
            aria-label="Edit rule"
            className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground/70 transition-colors hover:border-white/20 hover:text-foreground"
          >
            Edit
          </button>
          {!isConfirmingDelete && (
            <button
              type="button"
              onClick={onAskDelete}
              disabled={isBusy || undefined}
              aria-label="Delete rule"
              className="rounded-full p-1 text-muted-foreground/60 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {isConfirmingDelete && (
        <div className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/5 p-2.5">
          <p className="text-[11px] text-rose-300/80">Delete this rule?</p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancelDelete}
              disabled={isBusy || undefined}
              className="rounded-full border border-border/40 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:text-foreground"
            >
              Keep
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={isBusy || undefined}
              className="rounded-full bg-destructive/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-destructive transition-all hover:bg-destructive/30 disabled:opacity-50"
            >
              {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
            </button>
          </div>
        </div>
      )}
    </motion.div>
  );
}

/**
 * Inline rule editor — single-rule scope. Doesn't talk to the server
 * directly; emits the updated rule via onSave and lets the parent
 * persist. Each input is local state to allow cancel-without-save.
 */
function AutoRuleEditor({
  rule,
  isBusy,
  onCancel,
  onSave,
}: {
  rule: AutoDecideRule;
  isBusy: boolean;
  onCancel: () => void;
  onSave: (rule: AutoDecideRule) => void;
}) {
  const [decision, setDecision] = useState<"approved" | "denied">(
    rule.decision,
  );
  const [category, setCategory] = useState<PermissionCategory | "">(
    rule.category ?? "",
  );
  const [priceMaxStr, setPriceMaxStr] = useState(
    rule.priceMax !== undefined ? String(rule.priceMax) : "",
  );
  const [keywordsStr, setKeywordsStr] = useState(
    rule.bodyContainsAny?.join(", ") ?? "",
  );
  const [noExpiry, setNoExpiry] = useState(rule.noExpiry === true);
  const [terms, setTerms] = useState(rule.terms ?? "");
  const [denialReason, setDenialReason] = useState<DenialReason | null>(
    rule.denialReason ?? null,
  );
  const [reply, setReply] = useState(rule.reply ?? "");
  const [notifySir, setNotifySir] = useState(rule.notifySir !== false);

  const handleSave = () => {
    const keywords = keywordsStr
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    if (keywords.length > MAX_RULE_KEYWORDS) {
      // saveAutoRules will reject this anyway — but a friendly clamp is
      // unfriendly here; let the server message surface.
    }

    const next: AutoDecideRule = {
      id: rule.id,
      enabled: rule.enabled,
      decision,
      createdAt: rule.createdAt,
      notifySir,
      ...(category && { category }),
      ...(priceMaxStr.length > 0 && { priceMax: Number(priceMaxStr) }),
      ...(keywords.length > 0 && { bodyContainsAny: keywords }),
      ...(noExpiry && { noExpiry: true }),
      ...(decision === "approved" &&
        terms.trim().length > 0 && {
          terms: terms.trim(),
        }),
      ...(decision === "denied" &&
        denialReason && {
          denialReason,
        }),
      ...(reply.trim().length > 0 && { reply: reply.trim() }),
    };

    onSave(next);
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      className="overflow-hidden rounded-2xl border border-amber-500/20 bg-amber-500/5 p-3"
    >
      <p className="mb-3 text-[10px] font-bold uppercase tracking-widest text-amber-300/70">
        Editing rule
      </p>

      {/* Decision */}
      <div className="mb-3">
        <p className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
          Decision
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setDecision("approved")}
            disabled={isBusy || undefined}
            className={cn(
              "flex-1 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors",
              decision === "approved"
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                : "border-white/10 bg-black/20 text-muted-foreground/60",
            )}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setDecision("denied")}
            disabled={isBusy || undefined}
            className={cn(
              "flex-1 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors",
              decision === "denied"
                ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                : "border-white/10 bg-black/20 text-muted-foreground/60",
            )}
          >
            Deny
          </button>
        </div>
      </div>

      {/* Conditions */}
      <p className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
        When all of these match
      </p>
      <div className="mb-3 space-y-2">
        <select
          value={category}
          onChange={(e) =>
            setCategory(e.target.value as PermissionCategory | "")
          }
          disabled={isBusy || undefined}
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-amber-500/40"
        >
          <option value="">Any category</option>
          {PERMISSION_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              Category = {CATEGORY_LABEL[cat]}
            </option>
          ))}
        </select>

        <input
          type="number"
          min={0}
          max={100_000}
          step="0.01"
          value={priceMaxStr}
          onChange={(e) => setPriceMaxStr(e.target.value)}
          disabled={isBusy || undefined}
          placeholder="Price ≤ … (purchase only)"
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-amber-500/40"
        />

        <input
          type="text"
          value={keywordsStr}
          onChange={(e) => setKeywordsStr(e.target.value)}
          disabled={isBusy || undefined}
          placeholder="Body contains any (comma-separated)"
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-amber-500/40"
        />

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
          <input
            type="checkbox"
            checked={noExpiry}
            onChange={(e) => setNoExpiry(e.target.checked)}
            disabled={isBusy || undefined}
            className="h-3 w-3 rounded border-white/20 bg-black/20 accent-amber-400"
          />
          Only when request has no expiry set
        </label>
      </div>

      {/* Decision-specific response */}
      {decision === "approved" && (
        <div className="mb-3">
          <p className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-emerald-400/70">
            Auto-applied terms (optional)
          </p>
          <input
            type="text"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            disabled={isBusy || undefined}
            placeholder="e.g. only this weekend, max $30"
            className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-emerald-500/40"
          />
        </div>
      )}

      {decision === "denied" && (
        <div className="mb-3">
          <p className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-rose-400/70">
            Denial reason (drives re-ask cooldown)
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setDenialReason(null)}
              disabled={isBusy || undefined}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                denialReason === null
                  ? "border-white/30 bg-white/10 text-foreground"
                  : "border-white/10 bg-black/20 text-muted-foreground/60",
              )}
            >
              None
            </button>
            {DENIAL_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDenialReason(r)}
                disabled={isBusy || undefined}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors",
                  denialReason === r
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                    : "border-white/10 bg-black/20 text-muted-foreground/60",
                )}
              >
                {DENIAL_REASON_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-3">
        <p className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
          Reply (optional)
        </p>
        <input
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          disabled={isBusy || undefined}
          placeholder="Auto-attached to every match"
          className="w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-xs outline-none focus:border-amber-500/40"
        />
      </div>

      <label className="mb-3 flex items-center gap-2 text-[11px] text-muted-foreground/80">
        <input
          type="checkbox"
          checked={notifySir}
          onChange={(e) => setNotifySir(e.target.checked)}
          disabled={isBusy || undefined}
          className="h-3 w-3 rounded border-white/20 bg-black/20 accent-amber-400"
        />
        Notify Sir on auto-decide (recommended for awareness)
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isBusy || undefined}
          className="rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-all hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isBusy || undefined}
          className="rounded-full bg-amber-500/20 px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-amber-200 transition-all hover:bg-amber-500/30 disabled:opacity-50"
        >
          {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
        </button>
      </div>
    </motion.div>
  );
}

/**
 * Plain-English one-liner for an AutoDecideRule. Used in the rule list
 * to give Sir a quick scan of what each rule does without expanding.
 */
function summarizeRule(rule: AutoDecideRule): string {
  const parts: string[] = [];
  if (rule.category) {
    parts.push(CATEGORY_LABEL[rule.category].toLowerCase());
  } else {
    parts.push("any request");
  }
  if (rule.priceMax !== undefined) {
    parts.push(`≤ $${rule.priceMax}`);
  }
  if (rule.bodyContainsAny && rule.bodyContainsAny.length > 0) {
    const preview = rule.bodyContainsAny
      .slice(0, 3)
      .map((k) => `"${k}"`)
      .join(", ");
    const more =
      rule.bodyContainsAny.length > 3
        ? ` +${rule.bodyContainsAny.length - 3}`
        : "";
    parts.push(`mentioning ${preview}${more}`);
  }
  if (rule.noExpiry) {
    parts.push("with no expiry");
  }
  let out = parts.join(", ");
  if (rule.terms) {
    out += ` → ${rule.decision === "approved" ? "approve with terms" : "deny"}`;
  }
  return out;
}

/**
 * Sir-only celebration affordance — renders between an empty pending
 * section and the decided list. Quiet by default; an animated sparkle
 * burst on first paint marks the transition without being obnoxious.
 * Only shows when there's at least some history (decided.length > 0)
 * so a brand-new install doesn't celebrate emptiness.
 */
function AllCaughtUp() {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", bounce: 0.3, duration: 0.6 }}
      className={cn(
        "flex items-center justify-center gap-2.5 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3",
        "backdrop-blur-xl",
      )}
    >
      <motion.span
        initial={{ rotate: -20, scale: 0 }}
        animate={{ rotate: 0, scale: 1 }}
        transition={{ delay: 0.15, type: "spring", bounce: 0.5 }}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15"
      >
        <Sparkles className="h-3.5 w-3.5 text-emerald-300" />
      </motion.span>
      <div className="flex flex-col">
        <p className="text-xs font-bold uppercase tracking-widest text-emerald-300">
          All caught up
        </p>
        <p className="text-[10px] text-muted-foreground/60">
          No pending requests waiting on you.
        </p>
      </div>
    </motion.div>
  );
}
