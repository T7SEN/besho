// packages/cli/src/lib/format.ts
//
// ANSI color helpers + small formatters used across commands. No
// dependency on chalk — hand-rolled escape codes keep the CLI
// zero-dep beyond tsx.
//
// Colors are auto-disabled when output is piped (NO_COLOR / not a
// TTY) so `ourspace status | grep foo` doesn't pollute the pipe.

const isTTY = process.stdout.isTTY === true;
const noColor = process.env.NO_COLOR !== undefined;
const enabled = isTTY && !noColor;

function wrap(open: number, close: number): (s: string) => string {
  return (s: string) =>
    enabled ? `[${open}m${s}[${close}m` : s;
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return c.gray("never");
  if (ageMs < 0) return c.gray("future");
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

export function ok(msg: string): void {
  process.stdout.write(`${c.green("✓")} ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${c.cyan("ℹ")} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${c.yellow("⚠")} ${msg}\n`);
}

export function fail(msg: string): void {
  process.stderr.write(`${c.red("✗")} ${msg}\n`);
}
