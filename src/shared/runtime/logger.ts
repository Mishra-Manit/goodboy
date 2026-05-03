/**
 * Colored, timestamped console logger keyed by module context. Every backend
 * file uses `createLogger("<module>")` instead of `console.*`.
 */

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

function emit(level: LogLevel, context: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const color = LEVEL_COLORS[level];
  const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${context}]${RESET}`;
  const output = level === "error" || level === "warn" ? console.error : console.log;
  if (data !== undefined) {
    output(`${prefix} ${message}`, data);
  } else {
    output(`${prefix} ${message}`);
  }
}

/** Build a logger bound to a module name. The name is printed as `[context]` on every line. */
export function createLogger(context: string): Logger {
  return {
    debug: (msg, data) => emit("debug", context, msg, data),
    info: (msg, data) => emit("info", context, msg, data),
    warn: (msg, data) => emit("warn", context, msg, data),
    error: (msg, data) => emit("error", context, msg, data),
  };
}
