"use client";

import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Heart, Loader2, SmilePlus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getTodayMoods,
  submitMood,
  sendHug,
  type MoodData,
} from "@/app/actions/mood";
import { vibrate } from "@/lib/haptic";

const MOOD_EMOJIS = [
  "😴",
  "😊",
  "😍",
  "🥺",
  "😤",
  "🥰",
  "😂",
  "🌟",
  "😌",
  "🤗",
] as const;

const UNLOCKED_QUOTES = [
  "Distance means so little when someone means so much.",
  "I carry your heart with me. I carry it in my heart.",
  "Every day I choose you, over and over, without pause.",
  "In a sea of people, my eyes will always search for you.",
  "You are my today and all of my tomorrows.",
];

function getDailyQuote(): string {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) /
      86_400_000,
  );
  return UNLOCKED_QUOTES[dayOfYear % UNLOCKED_QUOTES.length];
}

type CardState =
  | "loading"
  | "idle"
  | "mine-submitted"
  | "both-submitted"
  | "hug-sent";

export function MoodCard() {
  const [moodData, setMoodData] = useState<MoodData | null>(null);
  const [cardState, setCardState] = useState<CardState>("loading");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingHug, setIsSendingHug] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deriveCardState = useCallback((data: MoodData): CardState => {
    if (data.myMood && data.partnerMood) {
      return data.myHugSent ? "hug-sent" : "both-submitted";
    }
    if (data.myMood) return "mine-submitted";
    return "idle";
  }, []);

  // ── Initial load ──
  useEffect(() => {
    getTodayMoods().then((data) => {
      setMoodData(data);
      setCardState(deriveCardState(data));
    });
  }, [deriveCardState]);

  // ── Real-time polling — checks every 15s for partner mood updates ──
  // Stops polling once both moods are in (hug-sent is the terminal state).
  useEffect(() => {
    const poll = () => {
      // Don't poll if we already have both moods — nothing more to wait for
      if (cardState === "hug-sent") return;

      getTodayMoods()
        .then((data) => {
          setMoodData(data);
          setCardState(deriveCardState(data));
        })
        .catch(console.error);
    };

    const id = setInterval(poll, 15_000);
    return () => clearInterval(id);
  }, [cardState, deriveCardState]);

  const handleSelectEmoji = async (emoji: string) => {
    if (isSubmitting || cardState !== "idle") return;
    void vibrate(50, "medium");
    setIsSubmitting(true);
    setError(null);

    const result = await submitMood(emoji);
    if (result.error) {
      setError(result.error);
      setIsSubmitting(false);
      return;
    }

    const updated = await getTodayMoods();
    setMoodData(updated);
    setCardState(deriveCardState(updated));
    setIsSubmitting(false);
  };

  const handleSendHug = async () => {
    if (isSendingHug || cardState !== "both-submitted") return;
    void vibrate([50, 60, 50, 60, 100]);
    setIsSendingHug(true);
    setError(null);

    const result = await sendHug();
    if (result.error) {
      setError(result.error);
      setIsSendingHug(false);
      return;
    }

    const updated = await getTodayMoods();
    setMoodData(updated);
    setCardState("hug-sent");
    setIsSendingHug(false);
  };

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between overflow-hidden",
        "rounded-3xl border border-white/5 bg-card/40 p-8",
        "backdrop-blur-xl shadow-xl shadow-black/20 transition-colors",
        cardState === "both-submitted" || cardState === "hug-sent"
          ? "border-primary/20"
          : "hover:border-primary/20",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Today&apos;s Mood
        </h2>
        <div className="rounded-full bg-primary/10 p-2 text-primary">
          <SmilePlus className="h-4 w-4" />
        </div>
      </div>

      {/* Body */}
      <div className="mt-6">
        <AnimatePresence mode="wait">
          {/* ── Loading ── */}
          {cardState === "loading" && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex h-24 items-center justify-center"
            >
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/40" />
            </motion.div>
          )}

          {/* ── Idle — pick emoji ── */}
          {cardState === "idle" && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
            >
              <p className="mb-4 text-sm font-medium text-muted-foreground/60">
                How are you feeling today?
              </p>
              <div className="grid grid-cols-5 gap-2">
                {MOOD_EMOJIS.map((emoji) => (
                  <motion.button
                    key={emoji}
                    whileHover={{ scale: 1.15 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleSelectEmoji(emoji)}
                    disabled={isSubmitting || undefined}
                    className={cn(
                      "flex h-11 w-full items-center justify-center rounded-xl",
                      "bg-black/20 text-2xl transition-all hover:bg-primary/10",
                      "disabled:opacity-50",
                    )}
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/30" />
                    ) : (
                      emoji
                    )}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Mine submitted, waiting for partner ── */}
          {cardState === "mine-submitted" && (
            <motion.div
              key="mine-submitted"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center gap-4 py-4 text-center"
            >
              <motion.div
                animate={{ scale: [1, 1.1, 1] }}
                transition={{
                  duration: 2.5,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                className="text-6xl"
              >
                {moodData?.myMood}
              </motion.div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground/60">
                  Your mood is logged ✓
                </p>
                <p className="text-xs text-muted-foreground/40">
                  Waiting for your partner&apos;s mood…
                </p>
              </div>
              <div className="flex gap-2 opacity-30">
                {[0, 1, 2].map((i) => (
                  <motion.div
                    key={i}
                    animate={{ opacity: [0.3, 1, 0.3] }}
                    transition={{
                      duration: 1.5,
                      repeat: Infinity,
                      delay: i * 0.5,
                    }}
                    className="h-1.5 w-1.5 rounded-full bg-primary"
                  />
                ))}
              </div>
            </motion.div>
          )}

          {/* ── Both submitted ── */}
          {(cardState === "both-submitted" || cardState === "hug-sent") && (
            <motion.div
              key="both-submitted"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, type: "spring", bounce: 0.2 }}
              className="space-y-5"
            >
              {/* Mood pair */}
              <div className="flex items-center justify-center gap-6">
                <div className="flex flex-col items-center gap-1">
                  <span className="text-5xl">{moodData?.myMood}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-foreground/40">
                    You
                  </span>
                </div>
                <Heart
                  className="h-4 w-4 text-primary/60"
                  fill="currentColor"
                />
                <div className="flex flex-col items-center gap-1">
                  <span className="text-5xl">{moodData?.partnerMood}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary/60">
                    Them
                  </span>
                </div>
              </div>

              {/* Unlocked quote */}
              <p className="text-center font-serif text-sm italic leading-relaxed text-muted-foreground/60">
                &ldquo;{getDailyQuote()}&rdquo;
              </p>

              {/* Hug button */}
              <AnimatePresence mode="wait">
                {cardState === "hug-sent" ? (
                  <motion.div
                    key="hug-sent"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: "spring", bounce: 0.4 }}
                    className="flex items-center justify-center gap-2 rounded-full bg-primary/10 py-2.5 text-xs font-bold uppercase tracking-wider text-primary"
                  >
                    <Heart className="h-3.5 w-3.5" fill="currentColor" />
                    Hug sent 💝
                  </motion.div>
                ) : (
                  <motion.button
                    key="hug-button"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleSendHug}
                    disabled={isSendingHug || undefined}
                    className={cn(
                      "flex w-full items-center justify-center gap-2 rounded-full",
                      "bg-primary/80 py-2.5 text-xs font-bold uppercase tracking-wider",
                      "text-primary-foreground transition-all hover:bg-primary",
                      "disabled:opacity-60",
                    )}
                  >
                    {isSendingHug ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <Heart className="h-3.5 w-3.5" fill="currentColor" />
                        Send a virtual hug
                      </>
                    )}
                  </motion.button>
                )}
              </AnimatePresence>

              {/* Hug received indicator */}
              {moodData?.hugReceivedFrom && (
                <motion.p
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-center text-[10px] font-semibold uppercase tracking-wider text-primary/60"
                >
                  💝 {moodData.hugReceivedFrom} sent you a hug today
                </motion.p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <p className="mt-3 text-center text-xs font-medium text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
