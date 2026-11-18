// The main process's own log (`logs/desktop.log`, A11): warnings and errors of the app itself,
// unhandled rejections and exceptions, renderer crashes. Kept under a size limit (one older
// generation); secrets are masked like the host's logs.
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import { redactSecrets } from "./host/redact.ts";

export type LogLevel = "info" | "warn" | "error";

export class MainLog {
  private writes = 0;

  constructor(
    readonly file: string,
    private readonly limit = 2_000_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  write(level: LogLevel, message: string): void {
    try {
      // The size is checked now and then, not on every line.
      if (this.writes++ % 50 === 0) this.rotate();
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${this.now().toISOString()} ${level} ${redactSecrets(message)}\n`);
    } catch {
      // logging never breaks the app
    }
  }

  private rotate(): void {
    try {
      if (statSync(this.file).size <= this.limit) return;
      rmSync(`${this.file}.1`, { force: true });
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // no file yet
    }
  }
}

/** An error (or anything thrown) as one log text, with its stack when there is one. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return typeof error === "string" ? error : format("%o", error);
}

interface ProcessEvents {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  on(event: "uncaughtException", listener: (error: Error) => void): unknown;
}

/**
 * Unhandled rejections and exceptions go to the log (and do not end the app with Electron's
 * error dialog); `console.warn` / `console.error` are copied into it as well.
 */
export function installMainLog(
  log: MainLog,
  proc: ProcessEvents = process,
  target: Pick<Console, "warn" | "error"> = console,
): void {
  proc.on("unhandledRejection", (reason) =>
    log.write("error", `unhandledRejection: ${errorText(reason)}`),
  );
  proc.on("uncaughtException", (error) =>
    log.write("error", `uncaughtException: ${errorText(error)}`),
  );
  for (const level of ["warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      log.write(level, format(...args));
      original(...args);
    };
  }
}
