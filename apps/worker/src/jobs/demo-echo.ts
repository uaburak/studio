import { type DemoEchoOutput, DemoEchoPayload } from "@studio/contract";
import { defineHandler } from "../registry.ts";

/**
 * demo.echo — proves the dispatch -> progress -> result round trip.
 * With `delayMs` it takes that long, reporting progress in `steps` and
 * stopping early when the job is cancelled (useful for manual tests).
 */
export const demoEcho = defineHandler({
  payload: DemoEchoPayload,
  async run(payload, ctx): Promise<DemoEchoOutput> {
    const delayMs = payload.delayMs ?? 0;
    if (delayMs > 0) {
      const steps = payload.steps ?? 4;
      for (let i = 1; i <= steps; i++) {
        await abortableSleep(delayMs / steps, ctx.signal);
        ctx.progress(i / steps, `adım ${i}/${steps}`);
      }
    } else {
      ctx.progress(0.5, "metin işleniyor");
    }
    return {
      text: payload.text,
      reversed: [...payload.text].reverse().join(""),
      workerId: ctx.workerId,
    };
  },
});

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
