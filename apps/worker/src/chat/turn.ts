/**
 * `chat.turn`: one Wecra-style tool-using agent turn of a conversation.
 *
 * Supports:
 * - `/usage` & `/kullanım` slash command (instant Turkish status & usage report),
 * - Direct Gemini SSE API (`GEMINI_API_KEY`) and `gemini` CLI fallback,
 * - Headless Claude Code CLI with local MCP bridge (`studio-mcp.mjs`) and
 *   `--resume` session continuation (with automatic full-context fallback on stale sessions),
 * - Multi-part interleaved streaming (`text` -> `tool_step` -> `consent` -> `text`).
 */
import path from "node:path";
import {
  type AgentEffort,
  ApiError,
  type Brand,
  ChatTurnPayload,
  type ClaudeAccount,
  type GeminiAccount,
  type RunUsage,
  type TurnContext,
} from "@studio/contract";
import type { AgentDeps, AgentSettings } from "../agent.ts";
import { ClaudeError, describeClaudeError, formatClock, isClaudeError } from "../claude/errors.ts";
import type { ParkInfo } from "../claude/gate.ts";
import type { ClaudeHealth } from "../claude/health.ts";
import {
  aliasOf,
  chooseModel,
  DEFAULT_EFFORT,
  type Effort,
  MODEL_ALIASES,
  type ModelAlias,
  type ModelChoice,
  readChoice,
} from "../claude/models.ts";
import type { ClaudeCallResult, ClaudeContentBlock } from "../claude/runner.ts";
import type { UsageReport } from "../claude/usage.ts";
import { buildGeminiContents, runGeminiApiTurn } from "../gemini/api-runner.ts";
import { runGeminiCliTurn } from "../gemini/cli-runner.ts";
import { describeGeminiError, GeminiError, isGeminiError } from "../gemini/errors.ts";
import {
  type GeminiModelAlias,
  isGeminiModelAlias,
  resolveGeminiModelId,
} from "../gemini/models.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { loadTurnImages, selectTurnImages } from "./images.ts";
import { startMcpBridge } from "./mcp-bridge.ts";
import { buildChatContext, buildIncrementalChatPrompt, CHAT_SYSTEM_PROMPT } from "./prompt.ts";
import { StudioToolExecutor } from "./tools.ts";
import { RunClosedError, TurnWriter } from "./writer.ts";

export interface ChatTurnOutputSummary extends Record<string, unknown> {
  runId: string;
  action: "none" | "plan" | "question";
  planId?: string;
  planItems?: number;
  planNotes?: string[];
  toolCalls?: string[];
  images: string[];
  provider?: "claude" | "gemini" | "system";
  model?: string;
  effort?: string;
  resumedSession?: boolean;
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

type ResolvedRoute =
  | {
      provider: "claude";
      choice: ModelChoice;
      explicitClaude: boolean;
    }
  | {
      provider: "gemini";
      alias: GeminiModelAlias;
      modelId: string;
      effort: Effort;
      execution: "api" | "cli";
    };

function defaultGeminiAccount(settings: AgentSettings): GeminiAccount {
  const apiKeyConfigured = Boolean(settings.geminiApiKey?.trim());
  return {
    status: apiKeyConfigured && settings.geminiMode !== "cli" ? "ready" : "not_configured",
    mode: apiKeyConfigured ? "api" : "none",
    apiKeyConfigured,
    cliVersion: null,
    defaultModel: settings.geminiModels["gemini-flash-lite"],
    detail: apiKeyConfigured
      ? `GEMINI_API_KEY hazır · doğrudan API (${settings.geminiModels["gemini-flash-lite"]})`
      : ".env dosyasında GEMINI_API_KEY tanımlı değil",
    checkedAt: new Date().toISOString(),
  };
}

function resolveGeminiExecution(
  alias: GeminiModelAlias,
  effort: Effort,
  settings: AgentSettings,
  gemini: GeminiAccount,
): ResolvedRoute {
  const modelId = resolveGeminiModelId(alias, settings.geminiModels);
  const apiKey = settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey;
  const hasKey = Boolean(apiKey && apiKey.trim().length > 0);
  const hasCli = gemini.cliVersion !== null || gemini.mode === "cli" || gemini.mode === "both";

  if (settings.geminiMode === "api") {
    if (!hasKey) {
      throw new GeminiError(
        "auth",
        "Gemini API seçildi ancak .env dosyasında GEMINI_API_KEY tanımlı değil.",
      );
    }
    return { provider: "gemini", alias, modelId, effort, execution: "api" };
  }

  if (settings.geminiMode === "cli") {
    if (!hasCli) {
      throw new GeminiError(
        "spawn",
        `STUDIO_GEMINI_MODE=cli seçili ancak Mac'te \`${settings.geminiBin}\` CLI bulunamadı.`,
      );
    }
    return { provider: "gemini", alias, modelId, effort, execution: "cli" };
  }

  // `auto`: prefer direct API whenever GEMINI_API_KEY is configured, else CLI.
  if (hasKey) {
    return { provider: "gemini", alias, modelId, effort, execution: "api" };
  }
  if (hasCli) {
    return { provider: "gemini", alias, modelId, effort, execution: "cli" };
  }
  throw new GeminiError(
    "auth",
    "Gemini kullanıma hazır değil: .env dosyasına GEMINI_API_KEY ekleyin veya Mac'e `gemini` CLI kurun.",
  );
}

export function resolveChatRoute(input: {
  runModel: string | null | undefined;
  runEffort: AgentEffort | null | undefined;
  settings: AgentSettings;
  claudeHealth: ClaudeHealth;
  geminiAccount: GeminiAccount;
}): ResolvedRoute {
  const { runModel, runEffort, settings, claudeHealth, geminiAccount } = input;
  const effort: Effort = runEffort ?? (settings.effortChat as Effort | undefined) ?? DEFAULT_EFFORT;
  const geminiReady = geminiAccount.status === "ready";

  if (isGeminiModelAlias(runModel)) {
    return resolveGeminiExecution(runModel, effort, settings, geminiAccount);
  }

  const isExplicitClaude =
    typeof runModel === "string" && (MODEL_ALIASES as readonly string[]).includes(runModel);

  if (isExplicitClaude) {
    if (claudeHealth.state === "unauthenticated" || claudeHealth.state === "error") {
      const hint = geminiReady
        ? "Model seçiciden Gemini Flash-Lite veya Gemini Flash seçebilir ya da Ayarlar'dan Claude hesabınıza giriş yapabilirsiniz."
        : "Ayarlar'dan Claude hesabınıza giriş yapın ya da Mac'te `claude auth login` çalıştırın.";
      throw new Error(`${claudeHealth.message} ${hint}`);
    }
    const choice = chooseModel(readChoice({ model: runModel, effort: runEffort }), {
      model: settings.model,
      effort: settings.effortChat,
    });
    return { provider: "claude", choice, explicitClaude: true };
  }

  // `run.model` is null / unset -> worker default with automatic Gemini fallback!
  if (isGeminiModelAlias(settings.model)) {
    return resolveGeminiExecution(settings.model, effort, settings, geminiAccount);
  }

  if (claudeHealth.state === "ok") {
    const choice = chooseModel(readChoice({ effort: runEffort }), {
      model: settings.model,
      effort: settings.effortChat,
    });
    return { provider: "claude", choice, explicitClaude: false };
  }

  if (geminiReady) {
    return resolveGeminiExecution("gemini-flash-lite", effort, settings, geminiAccount);
  }

  if (claudeHealth.state === "limited") {
    const choice = chooseModel(readChoice({ effort: runEffort }), {
      model: settings.model,
      effort: settings.effortChat,
    });
    return { provider: "claude", choice, explicitClaude: false };
  }

  throw new Error(claudeHealth.message);
}

function isUsageSlashCommand(context: TurnContext): boolean {
  const trigger = context.messages.find((m) => m.id === context.run.triggerMessageId);
  if (trigger?.role !== "user") return false;
  const hasAttachments = trigger.parts.some((p) => p.type === "attachment");
  if (hasAttachments) return false;
  const text = trigger.parts
    .filter(
      (p): p is Extract<(typeof trigger.parts)[number], { type: "text" }> => p.type === "text",
    )
    .map((p) => p.text)
    .join(" ")
    .trim()
    .toLowerCase();
  return text === "/usage" || text === "/kullanım" || text === "/kullanim";
}

export function formatUsageSlashReport(input: {
  claudeHealth: ClaudeHealth;
  claudeAccount?: ClaudeAccount;
  usageReport?: UsageReport | null;
  geminiAccount: GeminiAccount;
  settings: AgentSettings;
  now: Date;
}): string {
  const { claudeHealth, claudeAccount, usageReport, geminiAccount, settings, now } = input;
  const lines: string[] = ["### AI Durumu ve Kullanım Özeti", ""];

  // Claude section
  const claudeStatusMap: Record<ClaudeHealth["state"], string> = {
    ok: "Hazır",
    limited: `Kullanım sınırında${claudeHealth.resetsAt ? ` (${formatClock(new Date(claudeHealth.resetsAt), now)} civarında sıfırlanır)` : ""}`,
    unauthenticated: "Oturum kapalı",
    error: "Kullanılamıyor",
  };
  const accountSummary = claudeAccount
    ? [
        claudeAccount.plan,
        claudeAccount.email,
        claudeAccount.cliVersion ? `CLI ${claudeAccount.cliVersion}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : claudeHealth.cliVersion
      ? `CLI ${claudeHealth.cliVersion}`
      : "";

  lines.push(
    `**Claude Code**: ${claudeStatusMap[claudeHealth.state]}${accountSummary ? ` (${accountSummary})` : ""}`,
  );
  if (claudeHealth.state !== "ok" && claudeHealth.message) {
    lines.push(`- Durum notu: ${claudeHealth.message}`);
  }

  if (usageReport && usageReport.windows.length > 0) {
    for (const w of usageReport.windows) {
      const label =
        w.kind === "five_hour"
          ? "5 saatlik pencere"
          : w.kind === "weekly"
            ? "Haftalık pencere"
            : (w.name ?? "Diğer pencere");
      const pct = w.usedPercent !== undefined ? `%${w.usedPercent} kullanıldı` : "oran bilinmiyor";
      const reset = w.resetsAt ? `, sıfırlanma: ${formatClock(new Date(w.resetsAt), now)}` : "";
      const limitTag = w.limited ? " — **SINIR DOLU**" : "";
      lines.push(`- ${label}: ${pct}${reset}${limitTag}`);
    }
  } else {
    lines.push("- Kullanım penceresi: Henüz kayıtlı Claude pencere verisi yok.");
  }

  lines.push("");

  // Gemini section
  const geminiStatusLabel =
    geminiAccount.status === "ready"
      ? "Hazır"
      : geminiAccount.status === "not_configured"
        ? "Yapılandırılmadı"
        : "Hata";
  const geminiModeLabel =
    geminiAccount.mode === "both"
      ? `Doğrudan API + Gemini CLI (${geminiAccount.cliVersion ?? "?"})`
      : geminiAccount.mode === "api"
        ? "Doğrudan API (.env GEMINI_API_KEY)"
        : geminiAccount.mode === "cli"
          ? `Gemini CLI (${geminiAccount.cliVersion ?? "?"})`
          : "Yok";
  lines.push(`**Gemini**: ${geminiStatusLabel} · Mod: ${geminiModeLabel}`);
  lines.push(
    `- Modeller: Flash-Lite (\`${settings.geminiModels["gemini-flash-lite"]}\`), Flash (\`${settings.geminiModels["gemini-flash"]}\`), Pro (\`${settings.geminiModels["gemini-pro"]}\`)`,
  );
  if (geminiAccount.detail) {
    lines.push(`- Detay: ${geminiAccount.detail}`);
  }

  return lines.join("\n");
}

function canResumeClaudeSession(context: TurnContext): string | undefined {
  const session = context.conversation.agentSession;
  if (!session?.id || session.id.startsWith("gemini:")) return undefined;
  if (context.assistantMessage && context.assistantMessage.parts.length > 0) return undefined;
  const totalMessages = context.messageCount ?? context.messages.length;
  if (totalMessages !== session.messageCount + 1) return undefined;
  const trigger = context.messages.find((m) => m.id === context.run.triggerMessageId);
  if (trigger?.role !== "user") return undefined;
  return session.id;
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

  const claudeHealth = deps.health();
  const geminiAccount = deps.geminiAccount?.() ?? defaultGeminiAccount(settings);

  // Instant `/usage` (`/kullanım`) slash command — works even when providers are limited or signed out.
  if (isUsageSlashCommand(context)) {
    try {
      const startedMs = Date.now();
      const reportText = formatUsageSlashReport({
        claudeHealth,
        ...(deps.claudeAccount ? { claudeAccount: deps.claudeAccount() } : {}),
        usageReport: deps.usage?.latest() ?? null,
        geminiAccount,
        settings,
        now: now(),
      });
      writer.appendText(reportText);
      await writer.complete("system/usage", {
        durationMs: Math.max(0, Date.now() - startedMs),
        calls: 0,
      });
      ctx.progress(1, "Tamamlandı");
      return {
        runId: payload.runId,
        action: "none",
        images: [],
        provider: "system",
        model: "system/usage",
      };
    } catch (error) {
      writer.dispose();
      throw error;
    }
  }

  let route: ResolvedRoute;
  try {
    route = resolveChatRoute({
      runModel: context.run.model,
      runEffort: context.run.effort ?? null,
      settings,
      claudeHealth,
      geminiAccount,
    });
  } catch (error) {
    writer.dispose();
    const message = isGeminiError(error) ? describeGeminiError(error) : (error as Error).message;
    await writer.fail(message).catch(() => undefined);
    throw error instanceof Error ? error : new Error(message);
  }

  try {
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

    const claudeGenModel: ModelAlias | undefined =
      route.provider === "claude" &&
      (MODEL_ALIASES as readonly string[]).includes(route.choice.model)
        ? (route.choice.model as ModelAlias)
        : undefined;
    const rawEffort = route.provider === "claude" ? route.choice.effort : route.effort;
    const genEffort: AgentEffort | undefined = rawEffort !== "max" ? rawEffort : "xhigh";

    const executor = new StudioToolExecutor({
      api,
      writer,
      runId: payload.runId,
      conversationId: context.conversation.id,
      initialBrandId: context.conversation.brandId,
      initialOpenPlan: context.openPlan,
      aliases: context.aliases ?? [],
      signal,
      logger,
      generationChoice: {
        ...(claudeGenModel ? { model: claudeGenModel } : {}),
        ...(genEffort ? { effort: genEffort } : {}),
      },
      ...(deps.consentPollIntervalMs !== undefined
        ? { consentPollIntervalMs: deps.consentPollIntervalMs }
        : {}),
      ...(deps.consentTimeoutMs !== undefined ? { consentTimeoutMs: deps.consentTimeoutMs } : {}),
      now,
    });

    if (route.provider === "gemini") {
      ctx.progress(0.15, "Gemini yanıtlıyor");
      let usedModel: string;
      let usage: RunUsage;

      if (route.execution === "api") {
        const apiKey = (settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey ?? "").trim();
        const contents = buildGeminiContents({
          context,
          now: now(),
          brands,
          imageNotes: loaded.notes,
          imageBlocks: loaded.blocks,
        });
        const gemRes = await runGeminiApiTurn({
          apiKey,
          modelId: route.modelId,
          requestedModel: route.alias,
          effort: route.effort,
          system: CHAT_SYSTEM_PROMPT,
          contents,
          executor,
          onTextDelta: (text) => writer.appendText(text),
          signal,
          timeoutMs: settings.claudeTimeoutMs,
          ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
        });
        usedModel = gemRes.model;
        usage = gemRes.usage;
      } else {
        const bridge = await startMcpBridge(executor, {
          workRoot: path.join(deps.stateDir, "mcp-work"),
          signal,
        });
        try {
          const promptText = buildChatContext({
            context,
            now: now(),
            brands,
            images: loaded.notes,
          });
          const cliRes = await runGeminiCliTurn({
            bin: settings.geminiBin,
            apiKey: settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey,
            parentEnv: settings.parentEnv,
            modelId: route.modelId,
            requestedModel: route.alias,
            effort: route.effort,
            system: CHAT_SYSTEM_PROMPT,
            prompt: promptText,
            bridge,
            onTextDelta: (text) => writer.appendText(text),
            timeoutMs: settings.claudeTimeoutMs,
            signal,
            ...(deps.geminiCliSpawn ? { spawn: deps.geminiCliSpawn } : {}),
          });
          usedModel = cliRes.model;
          usage = cliRes.usage;
        } finally {
          await bridge.close();
        }
      }

      await writer.flush();
      ctx.progress(0.9, "Yanıt kaydediliyor");
      await writer.complete(usedModel, usage);
      ctx.progress(1, "Tamamlandı");

      return {
        runId: payload.runId,
        action: executor.outcome.action,
        ...(executor.outcome.planId ? { planId: executor.outcome.planId } : {}),
        ...(executor.outcome.planItems !== undefined
          ? { planItems: executor.outcome.planItems }
          : {}),
        ...(executor.outcome.planNotes ? { planNotes: executor.outcome.planNotes } : {}),
        ...(executor.outcome.toolCalls.length > 0 ? { toolCalls: executor.outcome.toolCalls } : {}),
        images: loaded.notes.filter((n) => n.attached).map((n) => n.alias),
        provider: "gemini",
        model: usedModel,
        effort: route.effort,
        usage,
      };
    }

    // --- Claude Wecra-style chat with MCP bridge & session persistence -------------------
    const choice = route.choice;
    const bridge = await startMcpBridge(executor, {
      workRoot: path.join(deps.stateDir, "mcp-work"),
      signal,
    });

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

    try {
      ctx.progress(0.15, "Claude yanıtlıyor");
      const resumeSessionId = canResumeClaudeSession(context);
      let resumedSession = Boolean(resumeSessionId);
      let result: ClaudeCallResult;

      const buildFullBlocks = (): ClaudeContentBlock[] => [
        {
          type: "text",
          text: buildChatContext({
            context,
            now: now(),
            brands,
            images: loaded.notes,
          }),
        },
        ...loaded.blocks,
      ];

      const callClaude = (sessionIdToResume: string | undefined) => {
        const content: ClaudeContentBlock[] = sessionIdToResume
          ? [
              {
                type: "text",
                text: buildIncrementalChatPrompt({
                  context,
                  now: now(),
                  images: loaded.notes,
                }),
              },
              ...loaded.blocks,
            ]
          : buildFullBlocks();

        return gate.call(
          {
            label: `chat-${payload.runId}`,
            system: CHAT_SYSTEM_PROMPT,
            content,
            model: choice.model,
            effort: choice.effort,
            timeoutMs: settings.claudeTimeoutMs,
            signal,
            persistSession: true,
            ...(sessionIdToResume ? { resumeSessionId: sessionIdToResume } : {}),
            mcpConfigFile: bridge.claudeMcpConfigPath,
            allowedTools: bridge.allowedTools,
            onTextDelta: (text) => writer.appendText(text),
          },
          { onPark, onResume },
        );
      };

      try {
        result = await callClaude(resumeSessionId);
      } catch (error) {
        if (
          resumeSessionId &&
          !signal.aborted &&
          !writer.written &&
          executor.outcome.toolCalls.length === 0 &&
          error instanceof ClaudeError &&
          error.code === "process"
        ) {
          logger.warn(
            `[job ${ctx.jobId}] claude session ${resumeSessionId} could not be resumed (${error.message}); retrying with full context`,
          );
          resumedSession = false;
          result = await callClaude(undefined);
        } else {
          throw error;
        }
      }

      await writer.flush();
      ctx.progress(0.9, "Yanıt kaydediliyor");

      const usage = toRunUsage(result, choice);
      const usedModel = result.model ?? aliasOf(choice.model) ?? choice.model;
      const finalSessionId = result.sessionId ?? resumeSessionId;

      await writer.complete(usedModel, usage, finalSessionId ? { id: finalSessionId } : undefined);
      ctx.progress(1, "Tamamlandı");

      return {
        runId: payload.runId,
        action: executor.outcome.action,
        ...(executor.outcome.planId ? { planId: executor.outcome.planId } : {}),
        ...(executor.outcome.planItems !== undefined
          ? { planItems: executor.outcome.planItems }
          : {}),
        ...(executor.outcome.planNotes ? { planNotes: executor.outcome.planNotes } : {}),
        ...(executor.outcome.toolCalls.length > 0 ? { toolCalls: executor.outcome.toolCalls } : {}),
        images: loaded.notes.filter((n) => n.attached).map((n) => n.alias),
        provider: "claude",
        ...(result.model ? { model: result.model } : {}),
        effort: choice.effort,
        ...(resumedSession ? { resumedSession: true } : {}),
        usage,
      };
    } finally {
      await bridge.close();
    }
  } catch (error) {
    writer.dispose();
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof RunClosedError) {
      throw new Error(`run closed while writing: ${error.message}`);
    }
    if (isClaudeError(error) && (error.code === "transient" || error.code === "timeout")) {
      throw new RetryableError(describeClaudeError(error));
    }
    if (isGeminiError(error) && (error.code === "transient" || error.code === "timeout")) {
      throw new RetryableError(describeGeminiError(error));
    }
    const message = isClaudeError(error)
      ? describeClaudeError(error)
      : isGeminiError(error)
        ? describeGeminiError(error)
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
