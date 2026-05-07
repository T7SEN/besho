import Link from "next/link";
import {
  Activity,
  ArrowLeft,
  Award,
  BarChart3,
  Bell,
  CalendarHeart,
  Database,
  Download,
  HeartPulse,
  KeyRound,
  Lock,
  Send,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Smile,
  Trash2,
} from "lucide-react";
import { SummonButton } from "@/components/admin/summon-button";
import { RestraintToggle } from "@/components/admin/restraint-toggle";
import { CrossFeatureSearch } from "@/components/admin/cross-feature-search";
import { RefreshListenerForServerPage } from "@/components/refresh-listener";
import { getDeployInfo, type DeployInfo } from "@/app/actions/admin";

const TOOLS = [
  {
    href: "/admin/stats",
    title: "Stats",
    description: "Counts, ratios, heatmap.",
    Icon: BarChart3,
  },
  {
    href: "/admin/health",
    title: "Diagnostics",
    description: "Health, cooldowns, and live system time.",
    Icon: HeartPulse,
  },
  {
    href: "/admin/trash",
    title: "Trash & restore",
    description: "Soft-deleted records. Restore within 7 days.",
    Icon: Trash2,
  },
  {
    href: "/admin/export",
    title: "Export",
    description: "Download a JSON snapshot of every feature.",
    Icon: Download,
  },
  {
    href: "/admin/devices",
    title: "Devices & sessions",
    description: "Live presence + FCM tokens + per-install device records.",
    Icon: Smartphone,
  },
  {
    href: "/admin/push-test",
    title: "Send test push",
    description: "Fire a custom FCM to either author.",
    Icon: Send,
  },
  {
    href: "/admin/activity",
    title: "Activity feed",
    description: "Last 500 logged interactions.",
    Icon: Activity,
  },
  {
    href: "/admin/sessions",
    title: "Sessions",
    description: "Force-logout an author's devices.",
    Icon: KeyRound,
  },
  {
    href: "/admin/auth-log",
    title: "Auth log",
    description: "Failed login attempts (last 100).",
    Icon: ShieldAlert,
  },
  {
    href: "/admin/mood",
    title: "Mood override",
    description: "Set or clear today's mood for either author.",
    Icon: Smile,
  },
  {
    href: "/admin/dates",
    title: "Anniversary & birthdays",
    description: "Edit relationship start + per-author birthdays.",
    Icon: CalendarHeart,
  },
  {
    href: "/admin/rewards",
    title: "Rewards & obedience",
    description: "Tier catalog, weights, streak threshold, multipliers.",
    Icon: Award,
  },
  {
    href: "/admin/permissions",
    title: "Permissions admin",
    description: "Auto-rules + quotas (JSON), bulk decide pending.",
    Icon: ShieldCheck,
  },
  {
    href: "/admin/notifications",
    title: "Notification audit",
    description: "Both drawers side-by-side; re-send any prior push.",
    Icon: Bell,
  },
  {
    href: "/admin/restraint-history",
    title: "Restraint history",
    description: "Engage / lift transitions with timestamps + reasons.",
    Icon: Lock,
  },
  {
    href: "/admin/redis",
    title: "Redis inspector",
    description: "Read-only probe by exact key. Type, TTL, capped preview.",
    Icon: Database,
  },
] as const;

function DeployFooter({ info }: { info: DeployInfo | null }) {
  if (!info) return null;
  const parts: string[] = [];
  parts.push(`v${info.version}`);
  if (info.commitShaShort) parts.push(`commit ${info.commitShaShort}`);
  if (info.branch) parts.push(`branch ${info.branch}`);
  parts.push(`env ${info.env}`);
  const serverTime = new Date(info.serverTime).toISOString().replace("T", " ").slice(0, 19);
  parts.push(`server ${serverTime}`);
  return (
    <p className="mt-8 text-center text-[10px] text-muted-foreground/60">
      {parts.join(" · ")}
    </p>
  );
}

export default async function AdminLandingPage() {
  const deploy = await getDeployInfo();
  const info = deploy.info ?? null;
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
        <h1 className="text-2xl font-bold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Sir-only tooling. Server-side enforced; the routes redirect anyone else.
        </p>
      </header>

      <RestraintToggle />
      <SummonButton />

      <CrossFeatureSearch />

      <div className="grid gap-4 md:grid-cols-2 md:gap-6">
        {TOOLS.map(({ href, title, description, Icon }) => (
          <Link
            key={href}
            href={href}
            className="group flex items-start gap-3 rounded-2xl border border-border/40 bg-card p-4 transition-colors hover:border-primary/40 active:scale-[0.99]"
          >
            <span className="rounded-lg bg-primary/10 p-2 text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block font-semibold text-foreground">
                {title}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {description}
              </span>
            </span>
          </Link>
        ))}
      </div>

      <DeployFooter info={info} />
    </main>
  );
}
