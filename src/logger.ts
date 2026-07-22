const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) || "info";

function fmt(level: Level, msg: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (LEVELS[level] >= LEVELS[MIN_LEVEL]) {
    console.log(prefix, msg, ...args);
  }
}

export const log = {
  debug: (msg: string, ...args: unknown[]) => fmt("debug", msg, ...args),
  info: (msg: string, ...args: unknown[]) => fmt("info", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => fmt("warn", msg, ...args),
  error: (msg: string, ...args: unknown[]) => fmt("error", msg, ...args),
};
