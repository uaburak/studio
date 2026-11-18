// What the main process hands to the window's page once it listens (A8, A11):
//
// - A notification click opens or focuses the window; its route is delivered only after the page
//   said it is ready (`IPC.rendererReady`), so a click that created the window is not lost.
// - The page crashed or hung: it is reloaded and, once ready again, told so in a short notice.
//
// Electron-free: the window's contents are an interface, timers are injected (tested on their own).
import { IPC } from "../shared/ipc.ts";

export type Send = (channel: string, ...args: unknown[]) => boolean;

export class RendererLink {
  private ready = false;
  private route: string | null = null;
  private notices: string[] = [];

  constructor(private readonly send: Send) {}

  get isReady(): boolean {
    return this.ready;
  }

  /** A page started loading (new window, reload, crash): it must say it is ready again. */
  reset(): void {
    this.ready = false;
  }

  /** The page's listeners are in place. */
  markReady(): void {
    this.ready = true;
    this.flush();
  }

  /** A notification was clicked: go to `route` (now, or as soon as the page listens). */
  openRoute(route: string): void {
    this.route = route;
    this.flush();
  }

  /** A short message for the page (a toast). */
  notice(message: string): void {
    if (!this.notices.includes(message)) this.notices.push(message);
    this.flush();
  }

  private flush(): void {
    if (!this.ready) return;
    if (this.route !== null && this.send(IPC.noticeClicked, this.route)) this.route = null;
    while (this.notices.length > 0) {
      if (!this.send(IPC.appNotice, this.notices[0])) return;
      this.notices.shift();
    }
  }
}

// --- crash / hang recovery -----------------------------------------------------------------------

export interface RecoverableContents {
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode: number }) => void,
  ): unknown;
  on(event: "unresponsive" | "responsive", listener: () => void): unknown;
  reload(): void;
  forcefullyCrashRenderer(): void;
  isDestroyed(): boolean;
}

export interface RecoveryOptions {
  link: RendererLink;
  log(message: string): void;
  /** A hung page is reloaded after this long without answering. */
  unresponsiveMs?: number;
  /** At most this many reloads in `windowMs` (a page that crashes on load is left alone). */
  maxReloads?: number;
  windowMs?: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const CRASH_NOTICE = "Pencere beklenmedik şekilde kapandı ve yeniden yüklendi.";
export const HANG_NOTICE = "Pencere yanıt vermiyordu; yeniden yüklendi.";

/** Reloads the page when its process is gone or it hangs, and says so once it is back. */
export function watchRenderer(contents: RecoverableContents, options: RecoveryOptions): void {
  const unresponsiveMs = options.unresponsiveMs ?? 10_000;
  const maxReloads = options.maxReloads ?? 3;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const reloads: number[] = [];
  let hangTimer: unknown;
  /** The page is being crashed on purpose (a hang): its "gone" event is ours. */
  let crashing = false;

  const reload = (notice: string): void => {
    if (contents.isDestroyed()) return;
    const at = now();
    while (reloads.length > 0 && at - (reloads[0] as number) > windowMs) reloads.shift();
    if (reloads.length >= maxReloads) {
      options.log(`renderer: not reloaded again (${reloads.length} reloads within a minute)`);
      return;
    }
    reloads.push(at);
    options.link.reset();
    options.link.notice(notice);
    contents.reload();
  };

  contents.on("render-process-gone", (_event, details) => {
    if (hangTimer !== undefined) clearTimer(hangTimer);
    hangTimer = undefined;
    if (crashing) {
      crashing = false;
      return;
    }
    options.log(`renderer gone: ${details.reason} (exit code ${details.exitCode})`);
    if (details.reason === "clean-exit") return;
    reload(CRASH_NOTICE);
  });
  contents.on("unresponsive", () => {
    if (hangTimer !== undefined) return;
    options.log("renderer unresponsive");
    hangTimer = setTimer(() => {
      hangTimer = undefined;
      if (contents.isDestroyed()) return;
      options.log(`renderer still unresponsive after ${unresponsiveMs} ms: reloading`);
      crashing = true;
      contents.forcefullyCrashRenderer();
      reload(HANG_NOTICE);
    }, unresponsiveMs);
  });
  contents.on("responsive", () => {
    if (hangTimer === undefined) return;
    clearTimer(hangTimer);
    hangTimer = undefined;
    options.log("renderer responsive again");
  });
}
