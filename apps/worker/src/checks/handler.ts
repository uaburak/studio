/**
 * `content.check`: run the generation checks on a version on demand ("Kontrolleri çalıştır",
 * "Yeniden çalıştır") and, with `fix`, apply the automatic fixes ("Düzelt"). The deterministic
 * checks need no AI; the model pass is skipped when neither Gemini nor Claude is available, so
 * the job type is always announced.
 */
import { ApiError, ContentCheckPayload } from "@studio/contract";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { type ChecksDeps, runContentChecks } from "./pipeline.ts";

export function createContentCheckHandler(deps: ChecksDeps) {
  return defineHandler({
    payload: ContentCheckPayload,
    run: async (payload, ctx: JobContext) => {
      const contentId = ctx.job.contentId;
      if (!contentId) throw new Error("content.check işi için contentId gerekli.");
      try {
        ctx.progress(0.02, "Kontroller hazırlanıyor");
        const fix = payload.fix ?? false;
        const model = payload.model ?? true;
        // Without the model pass ("Düzelt"), the version's language results stay while the
        // text is unchanged.
        const previous =
          !model && payload.version !== undefined
            ? (
                await deps.api.client.contents.checks.list(
                  contentId,
                  { version: payload.version, limit: 1 },
                  { signal: ctx.signal },
                )
              ).items[0]
            : undefined;
        const res = await runContentChecks({
          deps,
          jobId: ctx.jobId,
          trigger: fix ? "fix" : "manual",
          contentId,
          ...(payload.version !== undefined ? { version: payload.version } : {}),
          model,
          ...(previous ? { carryOver: { run: previous, unchangedSlides: new Set<number>() } } : {}),
          fix,
          signal: ctx.signal,
          progress: (v, m) => ctx.progress(v, m),
        });
        ctx.progress(1, "Tamamlandı");
        return {
          contentId,
          version: res.brief.version,
          runId: res.run?.id ?? null,
          ...(res.fixedVersion
            ? {
                fixedVersion: res.fixedVersion.version,
                versionId: res.fixedVersion.id,
                contentHash: res.fixedVersion.contentHash,
              }
            : {}),
          captionFixed: res.captionFixed,
          checks: res.brief,
        };
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      }
    },
  });
}
