// Tool-call log: `<state>/logs/mcp.log`, one line per call with the tool name, the outcome and
// the duration. Never arguments, bodies or responses (they may hold private content).
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type CallStatus = "ok" | "error" | "refused" | "needs_confirm";

export interface CallLog {
  call(tool: string, status: CallStatus, durationMs: number, httpStatus?: number): void;
  event(text: string): void;
}

export function fileLog(stateDir: string): CallLog {
  const dir = join(stateDir, "logs");
  const file = join(dir, "mcp.log");
  const write = (line: string) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never break a tool call.
    }
  };
  return {
    call(tool, status, durationMs, httpStatus) {
      const safeTool = tool.replace(/[^A-Za-z0-9_]/g, "?").slice(0, 80);
      write(
        `tool=${safeTool} status=${status}${httpStatus ? ` http=${httpStatus}` : ""} ms=${Math.round(durationMs)}`,
      );
    },
    event(text) {
      write(text.replace(/[\r\n]+/g, " ").slice(0, 300));
    },
  };
}

export const silentLog: CallLog = { call() {}, event() {} };
