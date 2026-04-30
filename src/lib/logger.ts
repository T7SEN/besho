// src/lib/logger.ts
import * as Sentry from "@sentry/nextjs";

type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "interaction"
  | "warn"
  | "error"
  | "fatal";

/**
 * Maps custom log levels to Sentry logger methods.
 * 'interaction' has no Sentry equivalent — mapped to 'info'.
 */
const SENTRY_LEVEL_MAP = {
  trace: "trace",
  debug: "debug",
  info: "info",
  interaction: "info",
  warn: "warn",
  error: "error",
  fatal: "fatal",
} as const satisfies Record<LogLevel, keyof typeof Sentry.logger>;

class Logger {
  private formatError(error: unknown) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack };
    }
    return String(error || "Unknown error");
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: unknown,
  ) {
    // --- LOCAL DEVELOPMENT (Colorful Strings) ---
    if (process.env.NODE_ENV !== "production") {
      const colors: Record<LogLevel, string> = {
        trace: "\x1b[90m",
        debug: "\x1b[34m",
        info: "\x1b[36m",
        interaction: "\x1b[35m",
        warn: "\x1b[33m",
        error: "\x1b[31m",
        fatal: "\x1b[41m\x1b[37m",
      };
      const reset = "\x1b[0m";
      const prefix = `${colors[level]}[${level.toUpperCase()}] ${message}${reset}`;
      const extras: unknown[] = [];
      if (context && Object.keys(context).length > 0) extras.push(context);
      if (error) extras.push(this.formatError(error));

      if (level === "error" || level === "fatal")
        console.error(prefix, ...extras);
      else if (level === "warn") console.warn(prefix, ...extras);
      else if (level === "info" || level === "interaction")
        console.info(prefix, ...extras);
      else console.debug(prefix, ...extras);

      return;
    }

    // --- PRODUCTION (Sentry Logs + Exception Capture) ---
    const sentryLevel = SENTRY_LEVEL_MAP[level];
    const attributes: Record<string, string | number | boolean> = {};

    // Flatten context into Sentry log attributes (must be primitives)
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          attributes[key] = value;
        } else {
          attributes[key] = JSON.stringify(value);
        }
      }
    }

    // Forward to Sentry Logs — preserves structured output in Vercel logs too
    Sentry.logger[sentryLevel](message, attributes);

    // Errors and fatals also create a full Sentry Issue with stack trace
    if ((level === "error" || level === "fatal") && error) {
      Sentry.captureException(error, {
        extra: { message, ...context },
        level: level === "fatal" ? "fatal" : "error",
      });
    }
  }

  trace(message: string, context?: Record<string, unknown>) {
    this.log("trace", message, context);
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, unknown>) {
    this.log("info", message, context);
  }

  interaction(message: string, context?: Record<string, unknown>) {
    this.log("interaction", message, context);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.log("warn", message, context);
  }

  error(message: string, error?: unknown, context?: Record<string, unknown>) {
    this.log("error", message, context, error);
  }

  fatal(message: string, error?: unknown, context?: Record<string, unknown>) {
    this.log("fatal", message, context, error);
  }
}

export const logger = new Logger();
