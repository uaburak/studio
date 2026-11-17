// Native macOS notifications. Each notice has a stable id; the last 500 posted ids are kept in
// the state directory, so a restart or a second report never posts the same event twice.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NoticeInput } from "../shared/ipc.ts";

export interface NoticePoster {
  isSupported(): boolean;
  show(notice: NoticeInput, onClick: () => void): void;
}

export class NoticeLog {
  private ids: string[];

  constructor(
    private readonly file: string,
    private readonly limit = 500,
  ) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      this.ids = Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      this.ids = [];
    }
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  add(id: string): void {
    this.ids = [...this.ids.filter((x) => x !== id), id].slice(-this.limit);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.ids));
    } catch {
      // keep it in memory
    }
  }
}

export class Notifier {
  constructor(
    private readonly poster: NoticePoster,
    private readonly log: NoticeLog,
    private readonly enabled: () => boolean,
    private readonly onOpen: (route: string | undefined) => void,
  ) {}

  /** Returns whether the notice was shown. */
  post(notice: NoticeInput): boolean {
    if (!this.enabled() || !this.poster.isSupported() || this.log.has(notice.id)) return false;
    this.log.add(notice.id);
    this.poster.show(notice, () => this.onOpen(notice.route));
    return true;
  }
}
