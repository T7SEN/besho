import { MY_TZ } from "@/lib/constants";
import { LogoutButton } from "@/components/dashboard/logout-button";
import { NotificationButton } from "@/components/dashboard/notification-button";

interface HeaderProps {
  now: Date;
  author: string | null;
}

export function Header({ now, author }: HeaderProps) {
  const hour = parseInt(
    now.toLocaleString("en-US", {
      timeZone: MY_TZ,
      hour: "numeric",
      hour12: false,
    }),
  );

  let greeting = "Good evening";
  if (hour >= 5 && hour < 12) greeting = "Good morning";
  else if (hour >= 12 && hour < 18) greeting = "Good afternoon";

  const personalGreeting = author ? `${greeting}, ${author}` : greeting;

  return (
    <header className="flex items-start justify-between pb-2">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-extrabold tracking-tight text-foreground">
          {personalGreeting}.
        </h1>
        <p className="text-lg font-medium text-muted-foreground">
          Welcome back to your private space.
        </p>
      </div>
      <div className="flex items-center gap-1 pt-1">
        <NotificationButton />
        <LogoutButton />
      </div>
    </header>
  );
}
