const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";

function log(level: LogLevel, context: string, message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  const color = LEVEL_COLORS[level];
  const prefix = `${color}[${timestamp}] [${level.toUpperCase()}] [${context}]${RESET}`;
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function createLogger(context: string) {
  return {
    debug: (msg: string, data?: unknown) => log("debug", context, msg, data),
    info: (msg: string, data?: unknown) => log("info", context, msg, data),
    warn: (msg: string, data?: unknown) => log("warn", context, msg, data),
    error: (msg: string, data?: unknown) => log("error", context, msg, data),
  };
}
