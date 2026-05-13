// src/app/games/page.tsx
//
// Games launcher. Server Component — reads the games registry and
// renders tiles. Adding a new game later means registering it in
// `@/lib/games/registry.ts`; this page picks it up automatically.

import Link from "next/link";
import { ArrowLeft, Gamepad2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GAMES, type GameDescriptor } from "@/lib/games/registry";
import { RefreshListenerForServerPage } from "@/components/refresh-listener";

export default function GamesLauncherPage() {
  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <RefreshListenerForServerPage />
      <header className="mb-6">
        <Link
          href="/"
          className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
          Back
        </Link>
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <Gamepad2 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Games</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Take turns. Keep it light.
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 md:gap-6">
        {GAMES.map((game) => (
          <GameTile key={game.slug} game={game} />
        ))}
      </section>
    </main>
  );
}

function GameTile({ game }: { game: GameDescriptor }) {
  const Icon = game.Icon;
  if (!game.available) {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-2xl border border-border/40 bg-card/40 p-5",
          "opacity-60",
        )}
      >
        <span className="rounded-lg bg-muted/30 p-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{game.title}</span>
            <span className="rounded-full bg-muted/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
              Coming soon
            </span>
          </div>
          <p
            dir="auto"
            className="mt-0.5 text-xs text-muted-foreground"
          >
            {game.description}
          </p>
        </div>
      </div>
    );
  }
  return (
    <Link
      href={`/games/${game.slug}`}
      className={cn(
        "group flex items-start gap-3 rounded-2xl border border-border/40 bg-card p-5",
        "transition-colors hover:border-primary/40 active:scale-[0.98]",
      )}
    >
      <span className="rounded-lg bg-primary/10 p-2 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <div className="flex-1">
        <span className="block font-semibold text-foreground">
          {game.title}
        </span>
        <p
          dir="auto"
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {game.description}
        </p>
      </div>
    </Link>
  );
}
