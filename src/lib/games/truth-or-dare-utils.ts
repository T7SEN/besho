// src/lib/games/truth-or-dare-utils.ts
//
// Pure rendering helpers for Truth or Dare. No Redis, no async, no
// React. Shared by both the user-facing game page and the admin
// surface so the relative-time + countdown formats stay in sync.

/** Format a past timestamp relative to `now`. Returns "just now",
 *  "Nm ago", "Nh ago", or a locale date for anything older than a day.
 *  Mirrors the formatter used on directive/punishment admin pages. */
export function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** Format remaining time on an active challenge as a compact countdown.
 *  Picks the two largest non-zero units (days+hours, hours+minutes,
 *  minutes+seconds, or just seconds). Clamps negative values to 0s.
 *  Drives the chip on the incoming/outgoing cards in the game page;
 *  the admin page uses a different inline shape (Mm Ss). */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
