// src/components/review/review-form.tsx
"use client";

import { useState, useTransition } from "react";
import { motion } from "motion/react";
import { Loader2, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { useNetwork } from "@/hooks/use-network";
import { submitReview } from "@/app/actions/reviews";
import {
  MAX_FIELD_LENGTH,
  REVIEW_FIELDS,
  type ReviewFieldKey,
  type ReviewRecord,
} from "@/lib/review-constants";
import { formatWeekLabel } from "@/lib/review-utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { RichTextEditor } from "@/components/ui/rich-text-editor";

interface ReviewFormProps {
  weekDate: string;
  existing: ReviewRecord | null;
  /**
   * Called after a successful submit, and when the user clicks Cancel
   * during an edit. Parent uses this to swap back to the waiting card
   * (or unmount the form if first-submit).
   */
  onDone?: () => void;
  /**
   * Defensive — parent should already be gating on this. If the
   * window closed mid-session, the server will reject; the form
   * surfaces the error.
   */
  withinWindow: boolean;
}

type FieldValues = Record<ReviewFieldKey, string>;

function initialValues(existing: ReviewRecord | null): FieldValues {
  return {
    whatWorked: existing?.whatWorked ?? "",
    whatDidnt: existing?.whatDidnt ?? "",
    friction: existing?.friction ?? "",
    goalsNext: existing?.goalsNext ?? "",
  };
}

/**
 * Composition surface for the weekly retrospective.
 *
 * Two rich fields (whatWorked, whatDidnt) and two plain fields
 * (friction, goalsNext). All four render through MarkdownRenderer at
 * reveal-time regardless of input mode — plain inputs still get GFM
 * if the writer used it.
 *
 * State machine is intentionally minimal: composing → submitting →
 * (success: parent unmounts via revalidatePath) | (error: surface and
 * stay composing). Char counters allow typing past the limit but
 * disable submit when over — matches the notes-page pattern.
 *
 * The server is the sole authority on the reveal lock and submission
 * window. This component does not race the clock.
 */
export function ReviewForm({
  weekDate,
  existing,
  onDone,
  withinWindow,
}: ReviewFormProps) {
  const [values, setValues] = useState<FieldValues>(() =>
    initialValues(existing),
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { connected } = useNetwork();
  const isOffline = !connected;

  const isEdit = !!existing;
  const overLimit = REVIEW_FIELDS.some(
    (m) => values[m.key].length > MAX_FIELD_LENGTH,
  );
  const hasContent = REVIEW_FIELDS.some((m) => values[m.key].trim().length > 0);
  const canSubmit =
    withinWindow && hasContent && !overLimit && !isPending && !isOffline;

  const setField = (key: ReviewFieldKey, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (error) setError(null);
  };

  const onSubmit = () => {
    if (!canSubmit) return;
    void vibrate(30, "light");
    startTransition(async () => {
      const fd = new FormData();
      for (const meta of REVIEW_FIELDS) {
        fd.set(meta.key, values[meta.key]);
      }
      const result = await submitReview(null, fd);
      if (result.error) {
        setError(result.error);
        return;
      }
      onDone?.();
    });
  };

  const onCancel = () => {
    if (isPending) return;
    void vibrate(20, "light");
    setValues(initialValues(existing));
    setError(null);
    onDone?.();
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        "rounded-3xl border border-white/5 bg-card/40 p-6 sm:p-8",
        "backdrop-blur-md shadow-xl shadow-black/20",
      )}
    >
      <header className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            {isEdit ? "Edit reflection" : "Weekly reflection"}
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground/50">
            Week of {formatWeekLabel(weekDate)}
          </p>
        </div>
        <p className="hidden text-[10px] uppercase tracking-wider text-muted-foreground/40 sm:block">
          Independent · revealed when both submit
        </p>
      </header>

      <div className="space-y-6">
        {REVIEW_FIELDS.map((meta) => {
          const value = values[meta.key];
          const len = value.length;
          const isOver = len > MAX_FIELD_LENGTH;
          const isWarn = !isOver && len > MAX_FIELD_LENGTH * 0.85;

          return (
            <div key={meta.key} className="space-y-2">
              <label
                htmlFor={`review-${meta.key}`}
                className="block cursor-pointer"
              >
                <span className="block text-xs font-bold uppercase tracking-[0.18em] text-foreground/80">
                  {meta.label}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground/50">
                  {meta.prompt}
                </span>
              </label>

              {meta.mode === "rich" ? (
                <RichTextEditor
                  id={`review-${meta.key}`}
                  name={meta.key}
                  value={value}
                  onChange={(e) => setField(meta.key, e.target.value)}
                  placeholder={meta.placeholder}
                  disabled={isPending || !withinWindow}
                  minHeight="min-h-[140px]"
                />
              ) : (
                <Textarea
                  id={`review-${meta.key}`}
                  name={meta.key}
                  value={value}
                  onChange={(e) => setField(meta.key, e.target.value)}
                  placeholder={meta.placeholder}
                  disabled={isPending || !withinWindow}
                  rows={5}
                  dir="auto"
                  className={cn(
                    "min-h-30 w-full resize-y whitespace-pre-wrap p-3",
                    "rounded-xl border border-white/10 bg-black/20",
                    "placeholder:text-muted-foreground/40 outline-none",
                    "transition-colors focus:border-primary/40",
                  )}
                />
              )}

              <div
                className={cn(
                  "text-end text-[10px] font-medium tabular-nums transition-colors",
                  isOver
                    ? "text-destructive"
                    : isWarn
                      ? "text-amber-400/80"
                      : "text-muted-foreground/40",
                )}
              >
                {len} / {MAX_FIELD_LENGTH}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-4 text-xs font-medium text-destructive">{error}</p>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        {isEdit && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending || undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border/40 px-3 py-1.5",
              "text-[10px] font-bold uppercase tracking-wider text-muted-foreground",
              "transition-all hover:text-foreground disabled:opacity-50",
            )}
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        )}
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || undefined}
          className="flex items-center gap-1.5 rounded-full px-4 text-[10px] uppercase tracking-wider"
        >
          {isPending ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              {isEdit ? "Updating" : "Submitting"}
            </>
          ) : (
            <>
              <Send className="h-3 w-3" />
              {isEdit ? "Update" : "Submit reflection"}
            </>
          )}
        </Button>
      </div>
    </motion.section>
  );
}
