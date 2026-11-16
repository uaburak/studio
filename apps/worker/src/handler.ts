import type { Job, ProtocolMessage, WorkerToHubMessage } from "@studio/contract";
import { type Logger, silentLogger } from "./log.ts";

export interface JobContext {
  workerId: string;
  /** Report progress 0..1 to the hub. */
  progress(value: number, message?: string): void;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<Record<string, unknown>>;

export interface MessageHandlerOptions {
  workerId: string;
  send: (message: WorkerToHubMessage) => void;
  handlers: Partial<Record<Job["type"], JobHandler>>;
  logger?: Logger;
}

/**
 * Reacts to decoded hub messages. Pure with respect to I/O: everything goes
 * through `send`, so it can be tested without a socket.
 * Returns a promise that settles when any work triggered by the message ends.
 */
export function createMessageHandler(options: MessageHandlerOptions) {
  const { workerId, send, handlers, logger = silentLogger } = options;

  async function runJob(job: Job): Promise<void> {
    const handler = handlers[job.type];
    if (!handler) {
      send({
        type: "job.result",
        jobId: job.id,
        status: "failed",
        error: `unsupported job type: ${job.type}`,
      });
      return;
    }
    logger.info(`job ${job.id} (${job.type}) started`);
    try {
      const output = await handler(job, {
        workerId,
        progress: (value, message) =>
          send({
            type: "job.progress",
            jobId: job.id,
            progress: Math.min(1, Math.max(0, value)),
            ...(message !== undefined ? { message } : {}),
          }),
      });
      send({ type: "job.result", jobId: job.id, status: "succeeded", output });
      logger.info(`job ${job.id} succeeded`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: "job.result", jobId: job.id, status: "failed", error: message });
      logger.warn(`job ${job.id} failed: ${message}`);
    }
  }

  return async function handle(message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case "ping":
        send({ type: "pong", ts: message.ts });
        return;
      case "pong":
        return;
      case "job.dispatch":
        await runJob(message.job);
        return;
      default:
        logger.debug(`ignoring unexpected message from hub: ${message.type}`);
    }
  };
}

export function capabilitiesOf(handlers: MessageHandlerOptions["handlers"]): string[] {
  return Object.keys(handlers);
}
