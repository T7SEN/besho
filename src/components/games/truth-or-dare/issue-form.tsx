// src/components/games/truth-or-dare/issue-form.tsx
"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import {
  BookmarkPlus,
  HelpCircle,
  Library,
  Loader2,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { vibrate } from "@/lib/haptic";
import { hideKeyboard } from "@/lib/keyboard";
import { TITLE_BY_AUTHOR, type Author } from "@/lib/constants";
import {
  MAX_PROMPT_LEN,
  MAX_PROMPTS_PER_LIBRARY,
  type TodPrompt,
} from "@/lib/games/truth-or-dare-constants";
import {
  deleteTodPrompt,
  getTodPromptLibrary,
  issueChallenge,
  saveTodPrompt,
} from "@/app/actions/games/truth-or-dare";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

interface IssueFormProps {
  /** True when the caller's outgoing slot is occupied — renders a
   *  disabled placeholder instead of the form so the issuer can't
   *  attempt a second issuance that the server would reject anyway. */
  disabled: boolean;
  /** Used in the copy ("{partner} picks which") — drives the label,
   *  not the action target (the action infers from session). */
  partner: Author;
  /** Called after a successful issuance so the parent can re-fetch the
   *  bundle and surface the new outgoing card. */
  onSuccess: () => void;
}

/** Two-textarea form: one truth prompt + one dare prompt. Bound via
 *  `useActionState` to the `issueChallenge` server action. Both fields
 *  are controlled state so the prompt library can pre-fill them. On
 *  success, clears the state, fires a medium haptic, hides the soft
 *  keyboard, and calls `onSuccess`. Error path renders the action's
 *  error message inline above the submit button.
 *
 *  Library affordance: a Sheet-based picker pulls from
 *  `tod:prompts:{author}` (private to the caller). Saving a current
 *  draft appends to the library; saved entries can be deleted from
 *  inside the picker. */
export function IssueForm({ disabled, partner, onSuccess }: IssueFormProps) {
  const [state, action, isPending] = useActionState(issueChallenge, null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [truthPrompt, setTruthPrompt] = useState("");
  const [darePrompt, setDarePrompt] = useState("");

  // Library state — owned locally; fetched on mount and after writes.
  const [library, setLibrary] = useState<TodPrompt[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busyPromptId, setBusyPromptId] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    const r = await getTodPromptLibrary();
    setTimeout(() => {
      if (r.error) setLibraryError(r.error);
      else setLibraryError(null);
      setLibrary(r.prompts);
    }, 0);
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    if (!state?.success) return;
    setTimeout(() => {
      setTruthPrompt("");
      setDarePrompt("");
      void vibrate(60, "medium");
      void hideKeyboard();
      onSuccess();
    }, 0);
  }, [state, onSuccess]);

  const handleApplyPrompt = (prompt: TodPrompt) => {
    void vibrate(40, "light");
    setTimeout(() => {
      setTruthPrompt(prompt.truthPrompt);
      setDarePrompt(prompt.darePrompt);
      setLibraryOpen(false);
    }, 0);
  };

  const handleSave = async () => {
    if (saving) return;
    if (!truthPrompt.trim() || !darePrompt.trim()) return;
    setSaving(true);
    setSaveError(null);
    void vibrate(50, "medium");
    const r = await saveTodPrompt({
      truthPrompt,
      darePrompt,
    });
    if (r.error) {
      setSaveError(r.error);
    } else {
      void refreshLibrary();
    }
    setSaving(false);
  };

  const handleDeletePrompt = async (promptId: string) => {
    if (busyPromptId) return;
    setBusyPromptId(promptId);
    void vibrate(50, "heavy");
    await deleteTodPrompt(promptId);
    await refreshLibrary();
    setBusyPromptId(null);
  };

  if (disabled) {
    return (
      <div className="rounded-2xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/60">
        You already have a challenge in flight. Withdraw it to issue a new one.
      </div>
    );
  }

  const librarySize = library?.length ?? 0;
  const canSave = truthPrompt.trim().length > 0 && darePrompt.trim().length > 0;

  return (
    <form
      ref={formRef}
      action={action}
      className="space-y-4 rounded-3xl border border-white/5 bg-card/40 p-6 backdrop-blur-md shadow-xl shadow-black/30"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Issue a challenge
          </h2>
          <p className="text-[11px] text-muted-foreground/60">
            Write one truth and one dare. {TITLE_BY_AUTHOR[partner]} picks which.
          </p>
        </div>
        <Sheet open={libraryOpen} onOpenChange={setLibraryOpen}>
          <SheetTrigger asChild>
            <button
              type="button"
              onClick={() => void vibrate(30, "light")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-card px-3 py-1.5",
                "text-[10px] font-bold uppercase tracking-wider text-muted-foreground",
                "transition-colors hover:border-primary/40 hover:text-foreground active:scale-[0.97]",
              )}
            >
              <Library className="h-3 w-3" />
              Library
              {librarySize > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[9px] font-bold text-primary">
                  {librarySize}
                </span>
              )}
            </button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            className="max-h-[80vh] overflow-y-auto rounded-t-3xl border-t border-white/10 bg-neutral-950 p-0"
          >
            <SheetHeader className="px-6 pt-6">
              <SheetTitle className="text-base font-bold tracking-tight">
                Your prompt library
              </SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground/70">
                Saved truth + dare pairs — yours only. Tap one to fill the
                form.
              </SheetDescription>
            </SheetHeader>

            <div className="px-6 py-4">
              {libraryError && (
                <p className="mb-3 text-[11px] font-medium text-destructive">
                  {libraryError}
                </p>
              )}
              {library === null ? (
                <div className="flex h-24 items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : library.length === 0 ? (
                <p className="rounded-xl border border-white/5 bg-card/20 p-5 text-center text-xs text-muted-foreground/50">
                  Nothing saved yet. Write a truth + dare below, then tap
                  &ldquo;Save to library&rdquo;.
                </p>
              ) : (
                <ul className="space-y-2">
                  {library.map((p) => (
                    <li
                      key={p.id}
                      className="group rounded-xl border border-white/5 bg-card/20 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => handleApplyPrompt(p)}
                          className="min-w-0 flex-1 text-left active:scale-[0.98]"
                        >
                          {p.label && (
                            <p
                              dir="auto"
                              className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-primary/80"
                            >
                              {p.label}
                            </p>
                          )}
                          <p
                            dir="auto"
                            className="text-xs leading-relaxed text-foreground/90"
                          >
                            <span className="mr-1 inline-flex items-center gap-1 font-bold uppercase tracking-wider text-muted-foreground/60">
                              <HelpCircle className="h-2.5 w-2.5" />T
                            </span>
                            {p.truthPrompt}
                          </p>
                          <p
                            dir="auto"
                            className="mt-1 text-xs leading-relaxed text-foreground/90"
                          >
                            <span className="mr-1 inline-flex items-center gap-1 font-bold uppercase tracking-wider text-muted-foreground/60">
                              <Zap className="h-2.5 w-2.5" />D
                            </span>
                            {p.darePrompt}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePrompt(p.id)}
                          disabled={busyPromptId === p.id || undefined}
                          aria-label="Delete prompt"
                          className={cn(
                            "shrink-0 rounded-full p-2 text-muted-foreground/40 transition-all",
                            "hover:bg-destructive/10 hover:text-destructive active:scale-95",
                            "md:opacity-0 md:group-hover:opacity-100",
                            "disabled:opacity-50",
                          )}
                        >
                          {busyPromptId === p.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-[10px] text-muted-foreground/40">
                {librarySize} of {MAX_PROMPTS_PER_LIBRARY} max.
              </p>
            </div>
          </SheetContent>
        </Sheet>
      </header>

      <div>
        <label
          htmlFor="tod-truth"
          className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60"
        >
          <HelpCircle className="h-3 w-3" />
          Truth prompt *
        </label>
        <textarea
          dir="auto"
          id="tod-truth"
          name="truthPrompt"
          required
          rows={2}
          maxLength={MAX_PROMPT_LEN}
          value={truthPrompt}
          onChange={(e) => setTruthPrompt(e.target.value)}
          placeholder="Ask them something honest…"
          disabled={isPending || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-amber-500/40 transition-colors",
          )}
        />
      </div>

      <div>
        <label
          htmlFor="tod-dare"
          className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60"
        >
          <Zap className="h-3 w-3" />
          Dare prompt *
        </label>
        <textarea
          dir="auto"
          id="tod-dare"
          name="darePrompt"
          required
          rows={2}
          maxLength={MAX_PROMPT_LEN}
          value={darePrompt}
          onChange={(e) => setDarePrompt(e.target.value)}
          placeholder="Dare them to do something…"
          disabled={isPending || undefined}
          className={cn(
            "w-full resize-none rounded-xl border border-white/10 bg-black/20 px-4 py-2.5 text-sm",
            "placeholder:text-muted-foreground/40 outline-none",
            "focus:border-amber-500/40 transition-colors",
          )}
        />
      </div>

      {state?.error && (
        <p className="text-xs font-medium text-destructive">{state.error}</p>
      )}
      {saveError && (
        <p className="text-xs font-medium text-destructive">{saveError}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={isPending || undefined}
          className="flex-1 rounded-full"
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Issue
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleSave}
          disabled={!canSave || saving || isPending || undefined}
          className="rounded-full"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <BookmarkPlus className="mr-1.5 h-3.5 w-3.5" />
              Save to library
            </>
          )}
        </Button>
      </div>
    </form>
  );
}
