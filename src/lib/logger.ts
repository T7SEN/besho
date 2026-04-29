type LogLevel =
  | "trace"
  | "debug"
  | "info"
  | "interaction"
  | "warn"
  | "error"
  | "fatal";

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
    const logEntry: Record<string, unknown> = {
      level,
      message,
      timestamp: new Date().toISOString(),
    };

    if (context && Object.keys(context).length > 0) logEntry.context = context;
    if (error) logEntry.error = this.formatError(error);

    // --- LOCAL DEVELOPMENT (Colorful Strings) ---
    if (process.env.NODE_ENV !== "production") {
      const colors = {
        trace: "\x1b[90m", // Gray
        debug: "\x1b[34m", // Blue
        info: "\x1b[36m", // Cyan
        interaction: "\x1b[35m", // Magenta
        warn: "\x1b[33m", // Yellow
        error: "\x1b[31m", // Red
        fatal: "\x1b[41m\x1b[37m", // White on Red Background
      };
      const reset = "\x1b[0m";
      const prefix = `${colors[level]}[${level.toUpperCase()}] ${message}${reset}`;

      const extras = [];
      if (logEntry.context) extras.push(logEntry.context);
      if (logEntry.error) extras.push(logEntry.error);

      if (level === "error" || level === "fatal")
        console.error(prefix, ...extras);
      else if (level === "warn") console.warn(prefix, ...extras);
      else if (level === "info" || level === "interaction")
        console.info(prefix, ...extras);
      else console.debug(prefix, ...extras);

      return;
    }

    // --- VERCEL PRODUCTION (Structured JSON) ---
    const jsonOutput = JSON.stringify(logEntry);
    if (level === "error" || level === "fatal") console.error(jsonOutput);
    else if (level === "warn") console.warn(jsonOutput);
    else if (level === "info" || level === "interaction")
      console.info(jsonOutput);
    else console.debug(jsonOutput);
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
