"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCheck,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  adminSaveAutoRulesJson,
  adminSaveQuotasJson,
  bulkApprovePendingOlderThan,
  bulkDenyPendingByCategory,
  getPermissionsAdminBundle,
  simulateAutoRules,
  type PermissionsAdminBundle,
  type SimulateAutoRuleResult,
} from "@/app/actions/admin";
import {
  CATEGORY_LABEL,
  DENIAL_REASON_LABEL,
  DENIAL_REASONS,
  PERMISSION_CATEGORIES,
  type DenialReason,
  type PermissionCategory,
} from "@/lib/permissions-constants";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { vibrate } from "@/lib/haptic";
import { cn } from "@/lib/utils";
import { useRefreshListener } from "@/hooks/use-refresh-listener";

const CONFIRM_TIMEOUT_MS = 5_000;

export default function AdminPermissionsPage() {
  const [bundle, setBundle] = useState<PermissionsAdminBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBundle = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await getPermissionsAdminBundle();
      if (result.error) {
        setError(result.error);
      } else if (result.bundle) {
        setBundle(result.bundle);
        setError(null);
      }
    } catch {
      setError("Failed to load.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void fetchBundle();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchBundle]);

  useRefreshListener(fetchBundle);

  return (
    <main className="mx-auto max-w-4xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6 flex items-center justify-between gap-3">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <button
          type="button"
          onClick={() => {
            void vibrate(20, "light");
            void fetchBundle();
          }}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Permissions admin</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Power-user editing for auto-rules + quotas (JSON), plus bulk
        decide for stale pending requests. The /permissions modals stay
        — this is an additional path, not a replacement.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!bundle ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-48 animate-pulse rounded-2xl border border-border/40 bg-card"
            />
          ))}
        </div>
      ) : (
        <Tabs defaultValue="bulk">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="bulk">Bulk decide</TabsTrigger>
            <TabsTrigger value="rules">Auto-rules JSON</TabsTrigger>
            <TabsTrigger value="quotas">Quotas JSON</TabsTrigger>
            <TabsTrigger value="simulate">Simulate</TabsTrigger>
          </TabsList>
          <TabsContent value="bulk" className="space-y-6">
            <BulkDecideEditor bundle={bundle} onSaved={fetchBundle} />
          </TabsContent>
          <TabsContent value="rules" className="space-y-6">
            <AutoRulesEditor bundle={bundle} onSaved={fetchBundle} />
          </TabsContent>
          <TabsContent value="quotas" className="space-y-6">
            <QuotasEditor bundle={bundle} onSaved={fetchBundle} />
          </TabsContent>
          <TabsContent value="simulate" className="space-y-6">
            <AutoRuleSimulator bundle={bundle} />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

// ── Bulk decide ──────────────────────────────────────────────────────────

function BulkDecideEditor({
  bundle,
  onSaved,
}: {
  bundle: PermissionsAdminBundle;
  onSaved: () => Promise<void>;
}) {
  const [approveHours, setApproveHours] = useState("24");
  const [approveReply, setApproveReply] = useState("");
  const [denyCategory, setDenyCategory] =
    useState<PermissionCategory>("treat");
  const [denyReason, setDenyReason] = useState<DenialReason | "">("");
  const [denyReply, setDenyReply] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [confirming, setConfirming] = useState<"approve" | "deny" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [confirming]);

  const handleApprove = async () => {
    const hours = Number(approveHours);
    if (!Number.isFinite(hours) || hours < 1) {
      setErr("Hours must be ≥ 1.");
      return;
    }
    if (confirming !== "approve") {
      setConfirming("approve");
      setErr(null);
      setMsg(null);
      void vibrate(40, "medium");
      return;
    }
    setBusy("approve");
    setErr(null);
    setMsg(null);
    void vibrate([100, 40, 80], "heavy");
    const result = await bulkApprovePendingOlderThan({
      olderThanHours: Math.floor(hours),
      reply: approveReply.trim() || undefined,
    });
    setBusy(null);
    setConfirming(null);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg(
      `Approved ${result.approved ?? 0} pending request${result.approved === 1 ? "" : "s"}.`,
    );
    setApproveReply("");
    void onSaved();
  };

  const handleDeny = async () => {
    if (confirming !== "deny") {
      setConfirming("deny");
      setErr(null);
      setMsg(null);
      void vibrate(40, "medium");
      return;
    }
    setBusy("deny");
    setErr(null);
    setMsg(null);
    void vibrate([100, 40, 80], "heavy");
    const result = await bulkDenyPendingByCategory({
      category: denyCategory,
      reason: denyReason || undefined,
      reply: denyReply.trim() || undefined,
    });
    setBusy(null);
    setConfirming(null);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg(
      `Denied ${result.denied ?? 0} pending ${denyCategory} request${result.denied === 1 ? "" : "s"}.`,
    );
    setDenyReply("");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Bulk decide pending</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {bundle.pendingCount} pending request{bundle.pendingCount === 1 ? "" : "s"} total.
        {Object.keys(bundle.pendingByCategory).length > 0 && (
          <>
            {" "}
            By category:{" "}
            {Object.entries(bundle.pendingByCategory)
              .map(
                ([cat, n]) =>
                  `${CATEGORY_LABEL[cat as PermissionCategory] ?? cat}: ${n}`,
              )
              .join(" · ")}
            .
          </>
        )}{" "}
        One summary FCM per bulk action — not one per claim.
      </p>

      <div className="space-y-4">
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-400">
            <CheckCheck className="h-3.5 w-3.5" />
            Approve all pending older than N hours
          </p>
          <div className="mt-2 grid gap-2 md:grid-cols-[auto_1fr]">
            <Field label="Hours">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={approveHours}
                onChange={(e) => setApproveHours(e.target.value)}
                className="w-24 rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
              />
            </Field>
            <Field label="Reply (optional, applied to all)">
              <input
                type="text"
                value={approveReply}
                onChange={(e) => setApproveReply(e.target.value)}
                maxLength={1000}
                dir="auto"
                placeholder="e.g. Approved in bulk this morning"
                className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
          </div>
          <button
            type="button"
            onClick={() => void handleApprove()}
            disabled={busy !== null}
            className={cn(
              "mt-2 flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-opacity active:scale-95 disabled:opacity-60",
              confirming === "approve"
                ? "bg-rose-500/80 text-white"
                : "bg-emerald-500/80 text-white",
            )}
          >
            {busy === "approve" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {confirming === "approve"
              ? `Confirm approve all older than ${approveHours}h`
              : "Approve all stale pending"}
          </button>
        </div>

        <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-rose-400">
            <XCircle className="h-3.5 w-3.5" />
            Deny all pending by category
          </p>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            <Field label="Category">
              <select
                dir="auto"
                value={denyCategory}
                onChange={(e) =>
                  setDenyCategory(e.target.value as PermissionCategory)
                }
                className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
              >
                {PERMISSION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason (optional)">
              <select
                dir="auto"
                value={denyReason}
                onChange={(e) =>
                  setDenyReason(
                    (e.target.value as DenialReason | "") || "",
                  )
                }
                className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
              >
                <option value="">— default cooldown —</option>
                {DENIAL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {DENIAL_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reply (optional)">
              <input
                type="text"
                value={denyReply}
                onChange={(e) => setDenyReply(e.target.value)}
                maxLength={1000}
                dir="auto"
                placeholder="Why all of these"
                className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
          </div>
          <button
            type="button"
            onClick={() => void handleDeny()}
            disabled={busy !== null}
            className={cn(
              "mt-2 flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-opacity active:scale-95 disabled:opacity-60",
              confirming === "deny"
                ? "bg-rose-600 text-white"
                : "bg-rose-500/80 text-white",
            )}
          >
            {busy === "deny" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : null}
            {confirming === "deny"
              ? `Confirm deny all ${denyCategory}`
              : "Deny by category"}
          </button>
        </div>
      </div>

      {msg && <p className="mt-3 text-sm text-emerald-400">{msg}</p>}
      {err && <p className="mt-3 text-sm text-destructive">{err}</p>}
    </section>
  );
}

// ── Auto-rules JSON ──────────────────────────────────────────────────────

function AutoRulesEditor({
  bundle,
  onSaved,
}: {
  bundle: PermissionsAdminBundle;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(bundle.autoRules, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setText(JSON.stringify(bundle.autoRules, null, 2));
    }, 0);
    return () => clearTimeout(t);
  }, [bundle.autoRules]);

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await adminSaveAutoRulesJson(text);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg(`Saved ${result.count ?? 0} rule${result.count === 1 ? "" : "s"}.`);
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 text-primary/70" />
        Auto-decide rules ({bundle.autoRules.length})
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        First-match-wins. Conditions within a rule are AND-combined.
        Sir-private — Besho never sees these. Validation runs on save;
        a parse or schema error aborts the whole write.
      </p>
      <textarea
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        rows={20}
        className="w-full rounded border border-border/60 bg-input/40 px-3 py-2 font-mono text-xs leading-relaxed focus:border-primary focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save rules
        </button>
        <button
          type="button"
          onClick={() => {
            setText(JSON.stringify(bundle.autoRules, null, 2));
            setErr(null);
            setMsg(null);
          }}
          disabled={busy}
          className="rounded-full border border-border/40 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          Reset
        </button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </section>
  );
}

// ── Quotas JSON ──────────────────────────────────────────────────────────

function QuotasEditor({
  bundle,
  onSaved,
}: {
  bundle: PermissionsAdminBundle;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(bundle.quotas, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setText(JSON.stringify(bundle.quotas, null, 2));
    }, 0);
    return () => clearTimeout(t);
  }, [bundle.quotas]);

  const handleSave = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    void vibrate(40, "medium");
    const result = await adminSaveQuotasJson(text);
    setBusy(false);
    if (result.error) {
      setErr(result.error);
      return;
    }
    setMsg("Saved.");
    void onSaved();
  };

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Quotas</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Per-category monthly limits + max simultaneous pending. Empty
        <code className="mx-1">monthlyLimits</code> object clears every
        cap. <code>maxPending</code> is optional; omit for no cap.
      </p>
      <textarea
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        rows={10}
        className="w-full rounded border border-border/60 bg-input/40 px-3 py-2 font-mono text-xs leading-relaxed focus:border-primary focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save quotas
        </button>
        <button
          type="button"
          onClick={() => {
            setText(JSON.stringify(bundle.quotas, null, 2));
            setErr(null);
            setMsg(null);
          }}
          disabled={busy}
          className="rounded-full border border-border/40 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground active:scale-95 disabled:opacity-50"
        >
          Reset
        </button>
        {msg && <span className="text-xs text-emerald-400">{msg}</span>}
        {err && <span className="text-xs text-destructive">{err}</span>}
      </div>
    </section>
  );
}

// ── Auto-rule simulator ──────────────────────────────────────────────────

function AutoRuleSimulator({ bundle }: { bundle: PermissionsAdminBundle }) {
  const [body, setBody] = useState("");
  const [category, setCategory] = useState<PermissionCategory | "">("");
  const [price, setPrice] = useState("");
  const [hasExpiry, setHasExpiry] = useState(false);
  const [expiresInHours, setExpiresInHours] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulateAutoRuleResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handleSimulate = async () => {
    setErr(null);
    setBusy(true);
    void vibrate(30, "light");
    try {
      const args: {
        body: string;
        category?: PermissionCategory;
        price?: number;
        expiresAt?: number;
      } = { body };
      if (category) args.category = category;
      if (price.trim() !== "") {
        const n = Number(price);
        if (!Number.isFinite(n) || n < 0) {
          setErr("Price must be a non-negative number.");
          setBusy(false);
          return;
        }
        args.price = n;
      }
      if (hasExpiry && expiresInHours.trim() !== "") {
        const n = Number(expiresInHours);
        if (!Number.isFinite(n) || n <= 0) {
          setErr("Expiry hours must be > 0.");
          setBusy(false);
          return;
        }
        args.expiresAt = Date.now() + n * 60 * 60 * 1000;
      }
      const r = await simulateAutoRules(args);
      if (r.error) setErr(r.error);
      else setResult(r);
    } finally {
      setBusy(false);
    }
  };

  const enabledCount = bundle.autoRules.filter((r) => r.enabled).length;
  const totalCount = bundle.autoRules.length;

  return (
    <section className="rounded-2xl border border-border/40 bg-card p-5">
      <h2 className="mb-3 text-sm font-semibold">Auto-rule simulator</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Paste a fake permission request shape. Server applies the same
        first-match-wins logic as <code>createPermission</code>; no Redis
        writes, no FCM. {enabledCount} of {totalCount} rules enabled.
      </p>

      <div className="space-y-3">
        <Field label="Body (required)">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            dir="auto"
            placeholder="e.g. Can I have a small treat?"
            className="w-full rounded border border-border/60 bg-input/40 px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
          />
        </Field>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Category">
            <select
              dir="auto"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as PermissionCategory | "")
              }
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm focus:border-primary focus:outline-none"
            >
              <option value="">— none —</option>
              {PERMISSION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Price (purchase only)">
            <input
              type="number"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="e.g. 25"
              min={0}
              className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none"
            />
          </Field>
          <Field label="Expiry">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={hasExpiry}
                onChange={(e) => setHasExpiry(e.target.checked)}
                className="rounded border-border/60"
              />
              <input
                type="number"
                inputMode="numeric"
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(e.target.value)}
                placeholder="hours"
                disabled={!hasExpiry}
                min={1}
                className="w-full rounded border border-border/60 bg-input/40 px-2 py-1 text-sm tabular-nums focus:border-primary focus:outline-none disabled:opacity-40"
              />
            </div>
          </Field>
        </div>
      </div>

      <button
        type="button"
        onClick={() => void handleSimulate()}
        disabled={busy || body.trim().length === 0}
        className="mt-4 flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-opacity active:scale-95 disabled:opacity-60"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Save className="h-3.5 w-3.5" />
        )}
        Simulate
      </button>

      {err && (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {err}
        </p>
      )}

      {result && (
        <div
          className={cn(
            "mt-5 rounded-2xl border p-4",
            result.matched
              ? result.decision === "approved"
                ? "border-emerald-400/40 bg-emerald-400/5"
                : "border-rose-500/40 bg-rose-500/5"
              : "border-border/40 bg-card/40",
          )}
        >
          {result.matched && result.rule ? (
            <>
              <p className="text-sm font-bold">
                Matched rule:{" "}
                <span className="font-mono text-xs">{result.rule.id}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Would{" "}
                <span
                  className={cn(
                    "font-bold",
                    result.decision === "approved"
                      ? "text-emerald-400"
                      : "text-rose-400",
                  )}
                >
                  {result.decision}
                </span>{" "}
                this request.
              </p>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                {result.reply && (
                  <>
                    <dt className="font-bold uppercase tracking-wider text-muted-foreground/70">
                      Reply
                    </dt>
                    <dd dir="auto">{result.reply}</dd>
                  </>
                )}
                {result.terms && (
                  <>
                    <dt className="font-bold uppercase tracking-wider text-muted-foreground/70">
                      Terms
                    </dt>
                    <dd dir="auto">{result.terms}</dd>
                  </>
                )}
                {result.denialReason && (
                  <>
                    <dt className="font-bold uppercase tracking-wider text-muted-foreground/70">
                      Reason
                    </dt>
                    <dd className="font-mono">
                      {DENIAL_REASON_LABEL[result.denialReason]}
                    </dd>
                  </>
                )}
                <dt className="font-bold uppercase tracking-wider text-muted-foreground/70">
                  Considered
                </dt>
                <dd className="font-mono tabular-nums">
                  {result.rulesConsidered ?? 0} enabled rules
                </dd>
              </dl>
            </>
          ) : (
            <>
              <p className="text-sm font-bold">No rule matched.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Considered {result.rulesConsidered ?? 0} enabled rules.
                The request would land in the pending queue (or be
                quota-rejected) per the canonical{" "}
                <code>createPermission</code> flow.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
