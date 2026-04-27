"use client";

import { useState, useEffect, useRef } from "react";
import { Quote as QuoteIcon, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/lib/utils";
import { fetchRandomQuote, type QuoteData } from "@/app/actions/quote";

export function QuoteCard() {
  const [quoteData, setQuoteData] = useState<QuoteData | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasFetched = useRef(false);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    fetchRandomQuote().then(setQuoteData);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    const data = await fetchRandomQuote(true);
    setQuoteData(data);
    setIsRefreshing(false);
  };

  return (
    <div
      className={cn(
        "relative flex h-full flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
        "hover:border-primary/20",
      )}
    >
      <div className="relative z-10 flex-1 flex flex-col">
        <div className="mb-4 flex items-center justify-between">
          <QuoteIcon className="h-6 w-6 text-primary/40" />
          <button
            onClick={handleRefresh}
            disabled={isRefreshing || !quoteData}
            aria-label="Get a different quote"
            className="rounded-full p-1.5 text-muted-foreground/30 transition-all hover:bg-primary/10 hover:text-primary disabled:opacity-30"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
            />
          </button>
        </div>

        <AnimatePresence mode="wait">
          {quoteData ? (
            <motion.div
              key={quoteData.text}
              initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="flex flex-col gap-3"
            >
              <p
                className={cn(
                  "text-lg font-medium leading-relaxed italic",
                  "text-foreground/90 whitespace-pre-wrap",
                )}
              >
                &quot;{quoteData.text}&quot;
              </p>
              <p className="text-sm font-semibold text-primary/80">
                — {quoteData.author}
              </p>
            </motion.div>
          ) : (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="space-y-3 py-2"
            >
              <div className="h-4 w-full animate-pulse rounded bg-muted/50" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-muted/50" />
              <div className="h-4 w-4/6 animate-pulse rounded bg-muted/50" />
              <div className="mt-4 h-3 w-1/3 animate-pulse rounded bg-primary/20" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="relative z-10 mt-6 flex items-center gap-3">
        <div className="h-px flex-1 bg-border/50" />
        <span
          className={cn(
            "text-xs font-medium uppercase tracking-widest",
            "text-muted-foreground",
          )}
        >
          Daily Quote
        </span>
      </div>
    </div>
  );
}
