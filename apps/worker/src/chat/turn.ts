/**
 * `chat.turn`: one agent turn of a conversation.
 *
 * start run (context) -> pick images of the latest user message -> one Claude call
 * (reply streamed into the assistant message while it is written) -> plan (PUT plan)
 * or question part -> complete. Usage limits park the call (the message shows a
 * progress step with the reset time); cancellation stops everything.
 */
import { ApiError, type Brand, ChatTurnPayload, type RunUsage } from "@studio/contract";
import type { AgentDeps } from "../agent.ts";
import { ClaudeError, describeClaudeError, formatClock, isClaudeError } from "../claude/errors.ts";
import type { ParkInfo } from "../claude/gate.ts";
import { aliasOf, chooseModel, type ModelChoice, readChoice } from "../claude/models.ts";
import type { ClaudeCallResult, ClaudeContentBlock } from "../claude/runner.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { loadTurnImages, selectTurnImages } from "./images.ts";
import { buildChatContext, CHAT_SYSTEM_PROMPT } from "./prompt.ts";
import { CHAT_TURN_JSON_SCHEMA, ChatTurnOutput, convertPlan, toQuestionPart } from "./schema.ts";
import { RunClosedError, TurnWriter } from "./writer.ts";

export interface ChatTurnOutputSummary extends Record<string, unknown> {
  runId: string;
  action: "none" | "plan" | "question";
  planId?: string;
  planItems?: number;
  planNotes?: string[];
  images: string[];
  model?: string;
  usage?: RunUsage;
}

/** Contract `RunUsage` from the CLI's numbers. */
export function toRunUsage(
  result: Pick<ClaudeCallResult, "usage" | "model">,
  choice?: ModelChoice,
  calls = 1,
): RunUsage {
  const u = result.usage;
  return {
    // The model actually used (full id from the CLI), the requested family and effort.
    ...(result.model ? { model: result.model } : {}),
    ...(choice ? { requestedModel: choice.model, effort: choice.effort } : {}),
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    costUsd: u.costUsd,
    durationMs: Math.round(u.wallMs),
    calls,
    apiMs: Math.round(u.durationApiMs),
  };
}

export function createChatTurnHandler(deps: AgentDeps) {
  return defineHandler({
    payload: ChatTurnPayload,
    run: (payload, ctx) => runChatTurn(payload, ctx, deps),
  });
}

async function runChatTurn(
  payload: ChatTurnPayload,
  ctx: JobContext,
  deps: AgentDeps,
): Promise<ChatTurnOutputSummary> {
  const { api, gate, settings, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const attempt = ctx.attempt ?? 1;
  const signal = ctx.signal;

  ctx.progress(0.02, "Tur başlatılıyor");
  let context: Awaited<ReturnType<typeof api.client.workerTurns.start>>;
  try {
    context = await api.client.workerTurns.start(payload.runId, attempt, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof ApiError && error.status === 409) {
      // Run cancelled/finished, or a newer attempt owns it: nothing to do.
      throw new Error(`run ${payload.runId} cannot be started: ${error.message}`);
    }
    throw new RetryableError(`could not start run ${payload.runId}: ${(error as Error).message}`);
  }

  const writer = new TurnWriter({
    api,
    runId: payload.runId,
    attempt,
    initialParts: context.assistantMessage?.parts.length ?? 0,
    signal,
    logger,
  });

  // Model and effort the user picked for this turn (run.model / run.effort), else env, else opus/medium.
  const choice = chooseModel(readChoice(context.run), {
    model: settings.model,
    effort: settings.effortChat,
  });
  const health = deps.health();
  if (health.state === "unauthenticated" || health.state === "error") {
    const message = health.message;
    await writer.fail(message).catch(() => undefined);
    throw new Error(message);
  }

  try {
    // Brand list only when the conversation has no brand (the model may pick one).
    let brands: Brand[] = [];
    if (!context.brand) {
      brands = (await api.client.brands.list({ status: "active", limit: 100 }, { signal })).items;
    }

    ctx.progress(0.08, "Görseller hazırlanıyor");
    const selected = selectTurnImages(context, settings.chatMaxImages);
    const loaded = await loadTurnImages(api, selected, {
      maxEdge: settings.imageMaxEdge,
      maxBytes: settings.imageMaxBytes,
      signal,
      logger,
    });

    const contextText = buildChatContext({
      context,
      now: now(),
      brands,
      images: loaded.notes,
    });
    const content: ClaudeContentBlock[] = [{ type: "text", text: contextText }, ...loaded.blocks];

    // Usage-limit park: show it in the message and the job, resume later.
    let parkIndex: number | null = null;
    const onPark = async (info: ParkInfo) => {
      const label = "Claude kullanım sınırı doldu";
      const detail = `Sınır ${formatClock(info.until)} civarında sıfırlanıyor; tur bekletiliyor ve o saatte kendiliğinden devam edecek.`;
      ctx.progress(0.1, `${label}: ${formatClock(info.until)} civarında devam edecek`);
      try {
        parkIndex = await writer.setPart(
          { type: "progress", stepId: "usage-limit", label, state: "pending", detail },
          parkIndex ?? undefined,
        );
      } catch (error) {
        logger.warn(`could not show the park state: ${(error as Error).message}`);
      }
    };
    const onResume = async () => {
      ctx.progress(0.12, "Claude'a yeniden bağlanılıyor");
      if (parkIndex === null) return;
      await writer
        .setPart(
          {
            type: "progress",
            stepId: "usage-limit",
            label: "Claude kullanım sınırı doldu",
            state: "done",
            detail: "Sınır sıfırlandı, devam edildi.",
          },
          parkIndex,
        )
        .catch(() => undefined);
    };

    ctx.progress(0.15, "Claude yanıtlıyor");
    const result = await gate.call(
      {
        label: `chat-${payload.runId}`,
        system: CHAT_SYSTEM_PROMPT,
        content,
        schema: CHAT_TURN_JSON_SCHEMA,
        model: choice.model,
        effort: choice.effort,
        timeoutMs: settings.claudeTimeoutMs,
        signal,
        streamField: "reply",
        onFieldDelta: (text) => writer.appendText(text),
      },
      { onPark, onResume },
    );
    await writer.flush();
    ctx.progress(0.85, "Yanıt kaydediliyor");

    const parsed = ChatTurnOutput.safeParse(result.output);
    if (!parsed.success) {
      throw new ClaudeError(
        "output",
        `chat output does not match the schema: ${parsed.error.message.slice(0, 500)}`,
      );
    }
    const out = parsed.data;
    // If the reply did not stream (or arrived only at the end), make sure it is there.
    if (!writer.written.trim() && out.reply.trim()) {
      writer.appendText(out.reply);
      await writer.flush();
    }

    const usage = toRunUsage(result, choice);
    const summary: ChatTurnOutputSummary = {
      runId: payload.runId,
      action: out.action,
      images: loaded.notes.filter((n) => n.attached).map((n) => n.alias),
      ...(result.model ? { model: result.model } : {}),
      effort: choice.effort,
      usage,
    };

    if (out.action === "plan" && out.plan) {
      const brandId = context.conversation.brandId ?? pickBrand(out.plan.brandId, brands);
      if (!brandId) {
        await writer.setPart({
          type: "question",
          questionId: "brand",
          prompt: "Bu plan hangi marka için?",
          mode: brands.length >= 2 ? "single" : "text",
          options:
            brands.length >= 2
              ? brands
                  .slice(0, 12)
                  .map((b) => ({ id: slugId(b.slug), label: b.name, description: null }))
              : [],
          allowText: brands.length >= 2,
        });
        summary.action = "question";
      } else {
        const { plan, notes } = convertPlan(out.plan, {
          aliases: context.aliases ?? [],
          ...(context.conversation.brandId ? {} : { brandId }),
        });
        if (notes.length) logger.info(`[job ${ctx.jobId}] plan fixes: ${notes.join("; ")}`);
        const saved = await writer.putPlan(plan);
        summary.planId = saved.plan.id;
        summary.planItems = saved.plan.items.length;
        if (notes.length) summary.planNotes = notes;
      }
    } else if (out.action === "question" && out.question) {
      const question = toQuestionPart(out.question, `q-${payload.runId.slice(-8)}`);
      if (question) await writer.setPart(question);
    }

    // The run's `model` becomes the model id actually used (the contract's convention).
    await writer.complete(result.model ?? aliasOf(choice.model), usage);
    ctx.progress(1, "Tamamlandı");
    return summary;
  } catch (error) {
    writer.dispose();
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof RunClosedError) {
      // Cancelled or closed by the API meanwhile; the hub settles the job.
      throw new Error(`run closed while writing: ${error.message}`);
    }
    if (isClaudeError(error) && (error.code === "transient" || error.code === "timeout")) {
      // Leave the run open: the hub re-queues the job (run -> queued) while attempts remain.
      throw new RetryableError(describeClaudeError(error));
    }
    const message = isClaudeError(error)
      ? describeClaudeError(error)
      : `Tur tamamlanamadı: ${(error as Error).message.slice(0, 500)}`;
    logger.warn(`[job ${ctx.jobId}] chat turn failed: ${(error as Error).message}`);
    await writer
      .fail(message)
      .catch((e: unknown) =>
        logger.warn(`could not mark run ${payload.runId} failed: ${(e as Error).message}`),
      );
    throw error instanceof Error ? error : new Error(String(error));
  }
}

function pickBrand(id: string | undefined, brands: readonly Brand[]): string | undefined {
  if (!id) return brands.length === 1 ? brands[0]?.id : undefined;
  return brands.find((b) => b.id === id || b.slug === id)?.id;
}

function slugId(slug: string): string {
  return slug.slice(0, 64);
}
