"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Send, Sparkles } from "lucide-react";
import { sendTestPushAction } from "@/app/actions/admin";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useRouter } from "next/navigation";

type Recipient = Author | "Both";

interface PushPreset {
  id: string;
  label: string;
  description: string;
  to: Recipient;
  title: string;
  body: string;
  url: string;
}

const PRESETS: PushPreset[] = [
  // ── To Sir: things kitten triggers ─────────────────────────────────────
  {
    id: "perm-request",
    label: "Permission request → Sir",
    description: "Mimics the new-request push from /permissions.",
    to: "T7SEN",
    title: "🙏 Permission Request: outfit",
    body: "kitten asked for: skirt approval",
    url: "/permissions",
  },
  {
    id: "reward-claim",
    label: "Reward claim → Sir",
    description: "Kitten just claimed a reward.",
    to: "T7SEN",
    title: "🎁 Reward claim",
    body: "kitten claimed Tier I: praise & affirmation",
    url: "/rewards",
  },
  {
    id: "reward-received",
    label: "Reward delivered ack → Sir",
    description: "Kitten confirmed receipt of a delivered reward.",
    to: "T7SEN",
    title: "✓ Reward received",
    body: "kitten — thank you Sir",
    url: "/rewards",
  },
  {
    id: "task-submitted",
    label: "Task submitted → Sir",
    description: "Kitten submitted a task for review.",
    to: "T7SEN",
    title: "👀 Task Ready for Review",
    body: "Besho submitted: clean room",
    url: "/tasks",
  },
  {
    id: "ritual-submitted",
    label: "Ritual submitted → Sir",
    description: "Kitten checked in on a ritual.",
    to: "T7SEN",
    title: "✓ Ritual Submitted",
    body: "Evening prayer — done at 9pm",
    url: "/rituals",
  },
  {
    id: "stale-claim",
    label: "Stale claim nudge → Sir",
    description: "Cron-fired nudge when a claim sits >24h.",
    to: "T7SEN",
    title: "🔔 Claim still waiting",
    body: "kitten's Tier I claim (praise) has been pending 26h.",
    url: "/rewards",
  },
  {
    id: "auto-decided",
    label: "Auto-rule fired → Sir",
    description: "Awareness ping when an auto-rule decided a request.",
    to: "T7SEN",
    title: "Auto-approved request",
    body: "water — approved by auto-rule",
    url: "/permissions",
  },
  {
    id: "rule-ack",
    label: "Rule acknowledged → Sir",
    description: "Kitten acknowledged a rule.",
    to: "T7SEN",
    title: "✓ Rule Acknowledged",
    body: "kitten acknowledged: morning check-in",
    url: "/rules",
  },
  // ── To Both: broadcast events ──────────────────────────────────────────
  {
    id: "review-window",
    label: "Review window open → both",
    description: "Saturday window-open cron fires to both.",
    to: "Both",
    title: "🪞 Review window open",
    body: "Reflect on this week. Window closes Sunday 23:59 Cairo.",
    url: "/review",
  },
  {
    id: "week-wrapped",
    label: "Week wrapped → both",
    description: "Monday recap — fires to Sir and to author who scored.",
    to: "Both",
    title: "📊 Week wrapped — Apr 27 – May 3",
    body: "18 pts. No tier reached this week.",
    url: "/rewards",
  },
  {
    id: "smoke-test",
    label: "Smoke test → both",
    description: "End-to-end FCM check on both devices.",
    to: "Both",
    title: "🛠️ Push smoke test",
    body: "If you got this on both devices, FCM is healthy.",
    url: "/",
  },
  // ── To kitten ──────────────────────────────────────────────────────────
  {
    id: "tier-unlock",
    label: "Tier unlock → kitten",
    description: "Mimics the rewards tier-unlock push.",
    to: "Besho",
    title: "🏆 Tier I unlocked",
    body: "20 pts this week. Reward unlocks at week close.",
    url: "/rewards",
  },
];

export default function PushTestPage() {
  const [state, action, pending] = useActionState(sendTestPushAction, {
    success: undefined,
    error: undefined,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const router = useRouter();
  useRefreshListener(() => router.refresh());

  const applyPreset = (preset: PushPreset) => {
    void vibrate(20, "light");
    const form = formRef.current;
    if (!form) return;
    const toRadio = form.querySelector<HTMLInputElement>(
      `input[name="to"][value="${preset.to}"]`,
    );
    if (toRadio) toRadio.checked = true;
    const titleEl = form.querySelector<HTMLInputElement>('input[name="title"]');
    if (titleEl) titleEl.value = preset.title;
    const bodyEl = form.querySelector<HTMLTextAreaElement>(
      'textarea[name="body"]',
    );
    if (bodyEl) bodyEl.value = preset.body;
    const urlEl = form.querySelector<HTMLInputElement>('input[name="url"]');
    if (urlEl) urlEl.value = preset.url;
  };

  useEffect(() => {
    if (state.success) {
      // Deferred setState per AGENTS.md § 4 — synchronous setState in
      // an effect body trips react-hooks/set-state-in-effect.
      const setT = setTimeout(() => {
        setFlash("Sent.");
        void hideKeyboard();
        void vibrate(50, "medium");
        formRef.current?.reset();
      }, 0);
      const clearT = setTimeout(() => setFlash(null), 2_500);
      return () => {
        clearTimeout(setT);
        clearTimeout(clearT);
      };
    }
    if (state.error) {
      void vibrate(80, "medium");
    }
  }, [state]);

  return (
    <main className="mx-auto max-w-xl p-4 pb-28 md:p-12 md:pb-32">
      <header className="mb-6">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
      </header>

      <h1 className="text-2xl font-bold tracking-tight">Send test push</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        Bypasses presence so the FCM fires regardless of the recipient&apos;s
        current page.
      </p>

      <section className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
        <header className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary/70" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Presets
          </h2>
          <span className="ml-auto text-[10px] text-muted-foreground/70">
            tap to fill the form
          </span>
        </header>
        <div className="grid gap-2 md:grid-cols-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="group rounded-lg border border-border/30 bg-card/40 p-2.5 text-left transition-colors hover:border-primary/40 active:scale-[0.99]"
            >
              <p className="truncate text-sm font-semibold">{preset.label}</p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {preset.description}
              </p>
            </button>
          ))}
        </div>
      </section>

      <form ref={formRef} action={action} className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Recipient
          </legend>
          <div className="grid grid-cols-3 gap-2">
            {(["T7SEN", "Besho", "Both"] as const).map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-border/40 bg-card p-3 text-sm transition-colors has-checked:border-primary has-checked:bg-primary/10"
              >
                <input
                  type="radio"
                  name="to"
                  value={value}
                  required
                  className="sr-only"
                />
                <span className="font-semibold">
                  {value === "Both" ? "Both" : TITLE_BY_AUTHOR[value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Title
          </span>
          <input
            type="text"
            name="title"
            required
            maxLength={80}
            inputMode="text"
            enterKeyHint="next"
            autoComplete="off"
            className="w-full rounded-xl border border-border/40 bg-background px-3 py-2.5 text-sm focus-visible:border-primary focus-visible:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Body
          </span>
          <textarea
            name="body"
            required
            maxLength={240}
            rows={3}
            enterKeyHint="next"
            autoComplete="off"
            className="w-full resize-none rounded-xl border border-border/40 bg-background px-3 py-2.5 text-sm focus-visible:border-primary focus-visible:outline-none"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-bold uppercase tracking-wider text-muted-foreground">
            URL <span className="font-normal normal-case">(optional)</span>
          </span>
          <input
            type="text"
            name="url"
            placeholder="/notes"
            maxLength={200}
            inputMode="url"
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-full rounded-xl border border-border/40 bg-background px-3 py-2.5 text-sm focus-visible:border-primary focus-visible:outline-none"
          />
        </label>

        {state.error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive"
          >
            {state.error}
          </p>
        )}
        {flash && (
          <p className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 p-2.5 text-xs text-emerald-400">
            {flash}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/90 active:scale-[0.99] disabled:opacity-60"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Send push
        </button>
      </form>
    </main>
  );
}
