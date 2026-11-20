/**
 * The Mac app's canvas runner as the Wecra engine uses it: `canvas.create` (a blank Wecra
 * document, designed at once) and `canvas.apply` (a fix pass) are jobs the hub hands to the runner
 * (a hidden Electron page with Wecra's engine); the worker queues them and waits.
 */
import {
  CanvasApplyOutput,
  type CanvasApplyPayloadInput,
  CanvasCreateOutput,
  type CanvasCreatePayloadInput,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";
import type { StudioApi } from "../../api.ts";
import { abortableSleep } from "../../claude/gate.ts";

export const RUNNER_MISSING =
  "Mac'teki Studio uygulaması açık değil (tuval çalıştırıcısı bağlı değil); Wecra motoru tasarlayamadı. Studio'yu Mac'te açıp yeniden deneyin.";

/** A canvas job that ended without a result (the runner's own Turkish reason). */
export class CanvasRunnerJobError extends Error {
  override name = "CanvasRunnerJobError";
  constructor(
    message: string,
    readonly jobId: string,
  ) {
    super(message);
  }
}

export interface CanvasRunnerOptions {
  api: StudioApi;
  signal: AbortSignal;
  /** Poll interval (tests shorten it). */
  pollMs?: number;
  /** How long one canvas job may take. */
  timeoutMs?: number;
}

/** The Mac app's canvas runner is connected and takes `canvas.create` (else the jobs would wait). */
export async function requireCanvasRunner(o: CanvasRunnerOptions): Promise<void> {
  let presence: Awaited<ReturnType<StudioApi["client"]["workers"]["presence"]>>;
  try {
    presence = await o.api.client.workers.presence({ signal: o.signal });
  } catch {
    return; // Unknown: the job is queued and waited for.
  }
  const runners = presence.workers.filter(
    (w) => !w.draining && w.capabilities.includes("canvas.apply"),
  );
  if (runners.length === 0) throw new Error(RUNNER_MISSING);
  if (!runners.some((w) => w.capabilities.includes("canvas.create")))
    throw new Error(
      "Mac'teki Studio uygulaması Wecra motorunu henüz bilmiyor (eski sürüm); uygulamayı güncelleyip yeniden deneyin.",
    );
}

async function waitFor(o: CanvasRunnerOptions, id: string): Promise<Job | null> {
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  for (;;) {
    o.signal.throwIfAborted();
    const job = await o.api.client.jobs.get(id, { signal: o.signal });
    if (isTerminalJobStatus(job.status)) return job;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await abortableSleep(Math.min(o.pollMs ?? 1_500, left), o.signal);
  }
}

async function runJob(
  o: CanvasRunnerOptions,
  type: "canvas.create" | "canvas.apply",
  content: { id: string; brandId: string },
  payload: Record<string, unknown>,
): Promise<Job> {
  const job = await o.api.client.jobs.create(
    { type, brandId: content.brandId, contentId: content.id, payload },
    { signal: o.signal },
  );
  const done = await waitFor(o, job.id);
  if (!done)
    throw new CanvasRunnerJobError(
      `Tuval işi (${job.id}) zamanında bitmedi; Mac'te sürüyor olabilir.`,
      job.id,
    );
  if (done.status !== "succeeded")
    throw new CanvasRunnerJobError(
      done.error ??
        (done.status === "cancelled" ? "Tuval işi iptal edildi." : "Tuval işi başarısız oldu."),
      job.id,
    );
  return done;
}

/** A blank Wecra document for the post, designed with `operations` (`"frame:N"`). */
export async function canvasCreate(
  o: CanvasRunnerOptions,
  content: { id: string; brandId: string },
  payload: CanvasCreatePayloadInput,
): Promise<{ jobId: string; output: CanvasCreateOutput }> {
  const job = await runJob(o, "canvas.create", content, payload as Record<string, unknown>);
  return { jobId: job.id, output: CanvasCreateOutput.parse(job.output ?? {}) };
}

/** Operations on the post's current canvas version (a new `ai_edit` version). */
export async function canvasApply(
  o: CanvasRunnerOptions,
  content: { id: string; brandId: string },
  payload: CanvasApplyPayloadInput,
): Promise<{ jobId: string; output: CanvasApplyOutput }> {
  const job = await runJob(o, "canvas.apply", content, payload as Record<string, unknown>);
  return { jobId: job.id, output: CanvasApplyOutput.parse(job.output ?? {}) };
}
