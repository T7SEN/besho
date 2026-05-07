"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { sendTestPushAction } from "@/app/actions/admin";
import { TITLE_BY_AUTHOR } from "@/lib/constants";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { useRefreshListener } from "@/hooks/use-refresh-listener";
import { useRouter } from "next/navigation";

export default function PushTestPage() {
  const [state, action, pending] = useActionState(sendTestPushAction, {
    success: undefined,
    error: undefined,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const router = useRouter();
  useRefreshListener(() => router.refresh());

  useEffect(() => {
    if (state.success) {
      setFlash("Sent.");
      void hideKeyboard();
      void vibrate(50, "medium");
      formRef.current?.reset();
      const id = setTimeout(() => setFlash(null), 2_500);
      return () => clearTimeout(id);
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

      <form ref={formRef} action={action} className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Recipient
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(["T7SEN", "Besho"] as const).map((author) => (
              <label
                key={author}
                className="flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-border/40 bg-card p-3 text-sm transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/10"
              >
                <input
                  type="radio"
                  name="to"
                  value={author}
                  required
                  className="sr-only"
                />
                <span className="font-semibold">
                  {TITLE_BY_AUTHOR[author]}
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
