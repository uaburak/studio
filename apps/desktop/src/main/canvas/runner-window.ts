// The hidden canvas runner page (shared/canvas-runner.ts): a window that is never shown, opened
// when the first canvas job comes and closed after a while without one. It loads the app's own
// `canvas-runner.html` with the app's preload (Studio's font list, the runner's channels) and the
// app's session (its API requests carry the owner secret like the app's pages). Only that window
// may answer a job; a page that crashes fails its job and the next job opens a new one.

import type { Job } from "@studio/contract";
import { BrowserWindow, type IpcMainEvent, ipcMain } from "electron";
import {
  CANVAS_RUNNER_ARG,
  CANVAS_RUNNER_IPC,
  type CanvasRunnerProgress,
  type CanvasRunnerResult,
} from "../../shared/canvas-runner.ts";
import type { CanvasJobContext, CanvasJobRunner } from "./executor.ts";

interface Pending {
  resolve(output: Record<string, unknown>): void;
  reject(error: Error): void;
  progress(value: number, message?: string): void;
}

export interface RunnerWindowOptions {
  /** The page's URL (the app's origin, or the dev server's). */
  url: () => string;
  preload: string;
  /** How long the page may take to come up. */
  readyTimeoutMs?: number;
  /** How long one job may take. */
  jobTimeoutMs?: number;
  /** The page closes after this long without a job. */
  idleMs?: number;
  log?: (message: string) => void;
}

export class CanvasRunnerWindow implements CanvasJobRunner {
  private window: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly off: (() => void)[] = [];

  constructor(private readonly o: RunnerWindowOptions) {
    const own = (event: IpcMainEvent) =>
      !!this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
    const onReady = (event: IpcMainEvent) => {
      if (own(event)) this.markReady?.();
    };
    const onProgress = (event: IpcMainEvent, update: CanvasRunnerProgress) => {
      if (!own(event) || typeof update?.id !== "number") return;
      this.pending.get(update.id)?.progress(Number(update.value) || 0, update.message);
    };
    const onDone = (event: IpcMainEvent, result: CanvasRunnerResult) => {
      if (!own(event) || typeof result?.id !== "number") return;
      const p = this.pending.get(result.id);
      if (!p) return;
      this.pending.delete(result.id);
      if (result.ok) p.resolve(result.output ?? {});
      else p.reject(new Error(String(result.error || "Tuval işi başarısız oldu.")));
      this.scheduleIdle();
    };
    ipcMain.on(CANVAS_RUNNER_IPC.ready, onReady);
    ipcMain.on(CANVAS_RUNNER_IPC.progress, onProgress);
    ipcMain.on(CANVAS_RUNNER_IPC.done, onDone);
    this.off.push(
      () => ipcMain.removeListener(CANVAS_RUNNER_IPC.ready, onReady),
      () => ipcMain.removeListener(CANVAS_RUNNER_IPC.progress, onProgress),
      () => ipcMain.removeListener(CANVAS_RUNNER_IPC.done, onDone),
    );
  }

  private log(message: string): void {
    this.o.log?.(`canvas runner page: ${message}`);
  }

  private open(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.ready) return this.ready;
    const window = new BrowserWindow({
      show: false,
      width: 1080,
      height: 1350,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: this.o.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // Never shown: timers and frames must not be throttled while a job runs.
        backgroundThrottling: false,
        additionalArguments: [CANVAS_RUNNER_ARG],
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    const gone = (why: string) => {
      if (this.window !== window) return;
      this.log(why);
      this.window = null;
      this.ready = null;
      this.fail(new Error(`Tuval çalıştırıcısı kapandı (${why}).`));
      if (!window.isDestroyed()) window.destroy();
    };
    window.webContents.on("render-process-gone", (_e, details) => gone(details.reason));
    window.on("closed", () => gone("closed"));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Tuval çalıştırıcısı açılamadı (zaman aşımı)."));
        gone("not ready");
      }, this.o.readyTimeoutMs ?? 30_000);
      this.markReady = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    window.loadURL(this.o.url()).catch((e: unknown) => {
      gone(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    return this.ready;
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.pending.size) return;
    this.idleTimer = setTimeout(
      () => {
        if (this.pending.size) return;
        const window = this.window;
        this.window = null;
        this.ready = null;
        if (window && !window.isDestroyed()) window.destroy();
      },
      this.o.idleMs ?? 10 * 60_000,
    );
  }

  /** Opens the (hidden) page and waits until it is ready (the self-test's check). */
  async warmUp(): Promise<void> {
    clearTimeout(this.idleTimer);
    await this.open();
    this.scheduleIdle();
  }

  async run(job: Job, ctx: CanvasJobContext): Promise<Record<string, unknown>> {
    clearTimeout(this.idleTimer);
    await this.open();
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("Tuval çalıştırıcısı açık değil.");
    const id = ++this.seq;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          if (!window.isDestroyed()) window.webContents.send(CANVAS_RUNNER_IPC.cancel, id);
          reject(new Error("Tuval işi zamanında bitmedi."));
        },
        this.o.jobTimeoutMs ?? 5 * 60_000,
      );
      const settle = () => clearTimeout(timer);
      this.pending.set(id, {
        resolve: (output) => {
          settle();
          resolve(output);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        progress: ctx.progress,
      });
      ctx.signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(id)) return;
          if (!window.isDestroyed()) window.webContents.send(CANVAS_RUNNER_IPC.cancel, id);
        },
        { once: true },
      );
      window.webContents.send(CANVAS_RUNNER_IPC.job, { id, job });
    });
  }

  close(): void {
    clearTimeout(this.idleTimer);
    for (const off of this.off.splice(0)) off();
    this.fail(new Error("Uygulama kapanıyor."));
    const window = this.window;
    this.window = null;
    this.ready = null;
    if (window && !window.isDestroyed()) window.destroy();
  }
}
