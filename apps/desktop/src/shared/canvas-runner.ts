// The canvas runner (S1): a hidden page of the Mac app that runs Wecra's engine for the chat
// agent's canvas jobs (`canvas.read`, `canvas.apply`) while no post window has the post open.
// The main process holds the hub connection (the worker token never reaches a page) and hands
// each dispatched job to the page over these channels; only the runner window may answer.
import type { Job } from "@studio/contract";

/** The runner window's extra argument: its preload exposes `window.studio.canvasRunner`. */
export const CANVAS_RUNNER_ARG = "--studio-canvas-runner";

/** The page of the runner (next to index.html). */
export const CANVAS_RUNNER_PAGE = "canvas-runner.html";

export const CANVAS_RUNNER_IPC = {
  /** main → page: run a job. */
  job: "canvas-runner:job",
  /** main → page: stop a job. */
  cancel: "canvas-runner:cancel",
  /** page → main: the page is up (the job listener is installed). */
  ready: "canvas-runner:ready",
  /** page → main: a job's progress. */
  progress: "canvas-runner:progress",
  /** page → main: a job ended. */
  done: "canvas-runner:done",
} as const;

export interface CanvasRunnerRequest {
  id: number;
  job: Job;
}

export interface CanvasRunnerProgress {
  id: number;
  value: number;
  message?: string;
}

export type CanvasRunnerResult =
  | { id: number; ok: true; output: Record<string, unknown> }
  | { id: number; ok: false; error: string };

export interface CanvasRunnerBridge {
  onJob(listener: (request: CanvasRunnerRequest) => void): () => void;
  onCancel(listener: (id: number) => void): () => void;
  ready(): void;
  progress(update: CanvasRunnerProgress): void;
  done(result: CanvasRunnerResult): void;
}
