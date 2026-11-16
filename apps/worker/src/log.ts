export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(level: LogLevel = "info"): Logger {
  const make =
    (l: LogLevel) =>
    (msg: string, extra?: unknown): void => {
      if (order[l] < order[level]) return;
      const line = `${new Date().toISOString()} ${l.toUpperCase().padEnd(5)} ${msg}`;
      const out = l === "error" || l === "warn" ? console.error : console.log;
      if (extra === undefined) out(line);
      else out(line, extra);
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
