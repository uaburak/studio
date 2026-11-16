import { type DemoEchoOutput, DemoEchoPayload } from "@studio/contract";
import type { JobHandler } from "../handler.ts";

/** demo.echo — proves the dispatch -> progress -> result round trip. */
export const demoEcho: JobHandler = async (job, ctx) => {
  const payload = DemoEchoPayload.parse(job.payload);
  ctx.progress(0.5, "metin işleniyor");
  const output: DemoEchoOutput = {
    text: payload.text,
    reversed: [...payload.text].reverse().join(""),
    workerId: ctx.workerId,
  };
  return output;
};
