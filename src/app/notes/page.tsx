"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { getNotes, saveNote, type Note } from "@/app/actions/notes";
import { Button } from "@/components/ui/button";

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [state, action, isPending] = useActionState(saveNote, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    async function loadNotes() {
      const fetchedNotes = await getNotes();
      setNotes(fetchedNotes);
      setIsLoading(false);
    }
    loadNotes();
  }, []);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
      getNotes().then(setNotes);
    }
  }, [state]);

  const formatDate = (timestamp: number) => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timestamp));
  };

  return (
    <div className="relative min-h-screen bg-background p-6 md:p-12">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute left-[-10%] top-[-10%] h-[500px] w-[500px] rounded-full bg-primary/5 blur-[150px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[500px] w-[500px] rounded-full bg-blue-500/5 blur-[150px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-3xl space-y-12 pt-4">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="group flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
            Back to Dashboard
          </Link>
          <h1 className="text-xl font-bold tracking-widest uppercase text-primary/80">
            Our Notebook
          </h1>
        </div>

        <form
          ref={formRef}
          action={action}
          className="overflow-hidden rounded-3xl border border-white/5 bg-card/40 p-2 backdrop-blur-xl shadow-2xl shadow-black/40 transition-all focus-within:border-primary/30 focus-within:bg-card/60"
        >
          <textarea
            name="content"
            placeholder="Write a poem, a thought, or a letter..."
            required
            disabled={isPending}
            className={cn(
              "min-h-[150px] w-full resize-none bg-transparent p-6 text-lg outline-none",
              "font-serif leading-relaxed placeholder:text-muted-foreground/50",
            )}
          />
          <div className="flex items-center justify-between border-t border-border/40 p-4">
            <p className="ml-2 text-xs font-medium text-destructive">
              {state?.error}
            </p>
            <Button
              type="submit"
              disabled={isPending}
              className="rounded-full px-6 transition-all hover:scale-105"
            >
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  Save Note <Send className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        </form>

        <div className="space-y-8 pb-20">
          {isLoading ? (
            <div className="flex justify-center p-10">
              <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            </div>
          ) : notes.length === 0 ? (
            <div className="p-10 text-center text-muted-foreground">
              The notebook is empty. Be the first to write something.
            </div>
          ) : (
            notes.map((note, index) => (
              <motion.div
                key={note.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1, duration: 0.5 }}
                className="relative pl-8 before:absolute before:left-[11px] before:top-2 before:h-full before:w-[2px] before:bg-border/50 last:before:hidden"
              >
                <div className="absolute left-0 top-1.5 h-6 w-6 rounded-full border-4 border-background bg-primary shadow-sm" />

                <div className="flex flex-col gap-3 rounded-2xl border border-white/5 bg-card/20 p-6 backdrop-blur-sm">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    {formatDate(note.createdAt)}
                  </span>
                  <p className="whitespace-pre-wrap font-serif text-lg leading-relaxed text-foreground/90">
                    {note.content}
                  </p>
                </div>
              </motion.div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
