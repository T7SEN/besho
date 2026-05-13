// src/app/admin/games/page.tsx
//
// Admin landing for the /games subtree. Lists each registered game
// with a per-game admin link. Adding a new game adds an entry in the
// `GAMES` registry; new admin work is gated on creating
// /admin/games/{slug}/page.tsx alongside.

import Link from "next/link";
import { ArrowLeft, Gamepad2 } from "lucide-react";
import { GAMES, type GameDescriptor } from "@/lib/games/registry";
import { RefreshListenerForServerPage } from "@/components/refresh-listener";
import { cn } from "@/lib/utils";

export default function AdminGamesLandingPage() {
  return (
    <main className="mx-auto max-w-3xl p-4 pb-28 md:p-12 md:pb-32">
      <RefreshListenerForServerPage />
      <header className="mb-6">
        <Link
          href="/admin"
          className="group mb-4 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-1" />
          Admin
        </Link>
        <div className="flex items-center gap-3">
          <span className="rounded-2xl bg-primary/10 p-2.5 text-primary">
            <Gamepad2 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Games admin
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Per-game tooling — force-cancel, stat edits, history purge.
            </p>
          </div>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-2 md:gap-6">
        {GAMES.map((game) => (
          <GameAdminTile key={game.slug} game={game} />
        ))}
      </section>
    </main>
  );
}

function GameAdminTile({ game }: { game: GameDescriptor }) {
  const Icon = game.Icon;
  if (!game.available) {
    return (
      <div className="flex items-start gap-3 rounded-2xl border border-border/40 bg-card/40 p-4 opacity-60">
        <span className="rounded-lg bg-muted/30 p-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <span className="block font-semibold text-foreground">
            {game.title}
          </span>
          <span className="text-[10px] text-muted-foreground">
            Not yet available
          </span>
        </div>
      </div>
    );
  }
  return (
    <Link
      href={`/admin/games/${game.slug}`}
      className={cn(
        "group flex items-start gap-3 rounded-2xl border border-border/40 bg-card p-4",
        "transition-colors hover:border-primary/40 active:scale-[0.99]",
      )}
    >
      <span className="rounded-lg bg-primary/10 p-2 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1">
        <span className="block font-semibold text-foreground">
          {game.title}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {game.description}
        </span>
      </span>
    </Link>
  );
}
