/**
 * Settings and shared dependencies of the Claude- and Gemini-backed job handlers.
 */
import type { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type { AiProviderStatus, ClaudeAccount, GeminiAccount } from "@studio/contract";
import { z } from "zod";
import type { AiPolicy } from "./ai/policy.ts";
import type { AiUsageRecorder } from "./ai/usage-recorder.ts";
import type { StudioApi } from "./api.ts";
import type { Skill } from "./chat/skills.ts";
import type { ClaudeGate } from "./claude/gate.ts";
import type { ClaudeHealth } from "./claude/health.ts";
import type { UsageTracker } from "./claude/usage.ts";
import { type GeminiModelAlias, liveGeminiModels } from "./gemini/models.ts";
import type { Logger } from "./log.ts";
import type { StudioMcpServer } from "./mcp/server.ts";
import type { VisionHelper } from "./vision/helper.ts";

const AgentEnv = z.object({
  /** `0` runs the worker without the AI-backed job types (demo/smoke only). */
  STUDIO_CLAUDE_ENABLED: z.enum(["0", "1"]).default("1"),
  /** API origin; default derived from STUDIO_HUB_URL. */
  STUDIO_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  STUDIO_CLAUDE_BIN: z.string().min(1).default("claude"),
  STUDIO_CLAUDE_MODEL: z.string().min(1).default("opus"),
  STUDIO_CLAUDE_EFFORT_CHAT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  STUDIO_CLAUDE_EFFORT_DESIGN: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Claude calls at the same time across all jobs (default 2: a chat turn plus the generation it starts). */
  STUDIO_CLAUDE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  STUDIO_CLAUDE_TIMEOUT_S: z.coerce.number().int().min(30).max(3600).default(900),
  /** Separate Claude login for the worker (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). */
  STUDIO_CLAUDE_CONFIG_DIR: z.string().min(1).optional(),
  /** `auto`: tiny self-test call at most every 6 h; `always`; `never` (auth status only). */
  STUDIO_CLAUDE_SELFTEST: z.enum(["auto", "always", "never"]).default("auto"),
  /** Write every call's raw stream-json to <state>/claude-logs (debugging). */
  STUDIO_CLAUDE_LOG_STREAMS: z.enum(["0", "1"]).default("0"),
  /** Minutes to wait when a usage limit names no reset time. */
  STUDIO_USAGE_LIMIT_FALLBACK_MIN: z.coerce.number().int().min(1).max(600).default(30),
  STUDIO_CHAT_MAX_IMAGES: z.coerce.number().int().min(0).max(10).default(4),
  STUDIO_IMAGE_MAX_EDGE: z.coerce.number().int().min(256).max(4096).default(1568),
  /** Extra fix passes after critique-and-revise when lint errors remain (default 1). */
  STUDIO_DESIGN_FIX_PASSES: z.coerce.number().int().min(0).max(3).default(1),

  // --- Gemini chat & image provider (.env GEMINI_API_KEY and/or `gemini` CLI) ---
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  STUDIO_GEMINI_BIN: z.string().min(1).default("gemini"),
  STUDIO_GEMINI_MODE: z.enum(["auto", "api", "cli"]).default("auto"),
  /**
   * Explicit model per alias (always wins); unset = the newest priced model of that tier the
   * key lists, else DEFAULT_GEMINI_MODELS (`gemini/models.ts`).
   */
  STUDIO_GEMINI_MODEL_FLASH_LITE: z.string().trim().min(1).optional(),
  STUDIO_GEMINI_MODEL_FLASH: z.string().trim().min(1).optional(),
  STUDIO_GEMINI_MODEL_PRO: z.string().trim().min(1).optional(),
  STUDIO_GEMINI_IMAGE_MODEL: z.string().min(1).default("gemini-nano-banana-2.1"),

  // --- Other providers (roadmap 7): Codex CLI, OpenAI API (key in the vault), Antigravity CLI ---
  STUDIO_CODEX_BIN: z.string().min(1).default("codex"),
  /** Model for `codex exec -m`; unset = the Codex CLI's own default. */
  STUDIO_CODEX_MODEL: z.string().trim().min(1).optional(),
  /** OpenAI API model; unset = the best chat model the key lists (`pickOpenAiModel`). */
  STUDIO_OPENAI_MODEL: z.string().trim().min(1).optional(),
  STUDIO_ANTIGRAVITY_BIN: z.string().min(1).default("agy"),
  /** Model slug for `agy --model` (see `agy models`); unset = the CLI's default. */
  STUDIO_ANTIGRAVITY_MODEL: z.string().trim().min(1).optional(),

  // --- Reels Video / TTS / Transcription ---
  ELEVENLABS_API_KEY: z.string().trim().min(1).optional(),
  /** ElevenLabs voice; unset = a voice of the text's language from the account (`video/tts.ts`). */
  STUDIO_ELEVENLABS_VOICE_ID: z.string().trim().min(1).optional(),
  STUDIO_FFMPEG_BIN: z.string().trim().min(1).optional(),
  STUDIO_WHISPER_BIN: z.string().trim().min(1).optional(),

  // --- Cloud Publisher & Background Schedule Sync ---
  STUDIO_CLOUD_PUBLISHER_URL: z.url({ protocol: /^https?$/ }).optional(),
  STUDIO_CLOUD_PUBLISHER_TOKEN: z.string().trim().min(1).optional(),
  STUDIO_SCHEDULE_POLL_INTERVAL_S: z.coerce.number().min(0).max(3600).default(30),
  /** Runtime skills of the chat agent (default: the repo's `agent/skills`). */
  STUDIO_SKILLS_DIR: z.string().min(1).optional(),
});

export interface AgentSettings {
  enabled: boolean;
  apiUrl: string | undefined;
  claudeBin: string;
  model: string;
  effortChat: string | undefined;
  effortDesign: string | undefined;
  claudeConcurrency: number;
  claudeTimeoutMs: number;
  claudeConfigDir: string | undefined;
  selfTest: "auto" | "always" | "never";
  logStreams: boolean;
  usageLimitFallbackMs: number;
  chatMaxImages: number;
  imageMaxEdge: number;
  designFixPasses: number;
  /** Max bytes downloaded per image. */
  imageMaxBytes: number;
  /** Direct Gemini API key from `.env` (never logged). */
  geminiApiKey: string | undefined;
  geminiBin: string;
  geminiMode: "auto" | "api" | "cli";
  /** Explicit `STUDIO_GEMINI_MODEL_*` values only (they always win). */
  geminiModelOverrides: Partial<Record<GeminiModelAlias, string>>;
  /**
   * Model id per alias, resolved on every read (`liveGeminiModels`): override → newest priced
   * model of the tier in the vault key's model list → static fallback.
   */
  geminiModels: Record<GeminiModelAlias, string>;
  geminiImageModel: string;
  codexBin: string;
  codexModel: string | undefined;
  openaiModel: string | undefined;
  antigravityBin: string;
  antigravityModel: string | undefined;
  /**
   * API keys from the vault (Ayarlar → Yapay zekâ), filled by the runtime from the API and
   * preferred over `.env`. Mutable; never logged.
   */
  vault?: AiVault;
  /** ElevenLabs API key from `.env` (never logged). */
  elevenLabsApiKey: string | undefined;
  /** `STUDIO_ELEVENLABS_VOICE_ID`; undefined = a voice of the text's language from the account. */
  elevenLabsVoiceId: string | undefined;
  ffmpegBin: string | undefined;
  whisperBin: string | undefined;
  /** Cloud Publisher URL & bearer token (never logged). */
  cloudPublisherUrl: string | undefined;
  cloudPublisherToken: string | undefined;
  schedulePollIntervalMs: number;
  /** `STUDIO_SKILLS_DIR`; undefined = the repo's `agent/skills`. */
  skillsDir: string | undefined;
  /** Source environment passed to `loadAgentSettings` (keeps unit tests hermetic). */
  parentEnv: NodeJS.ProcessEnv;
}

export function loadAgentSettings(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const parsed = AgentEnv.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const geminiModelOverrides: Partial<Record<GeminiModelAlias, string>> = {
    ...(e.STUDIO_GEMINI_MODEL_FLASH_LITE
      ? { "gemini-flash-lite": e.STUDIO_GEMINI_MODEL_FLASH_LITE }
      : {}),
    ...(e.STUDIO_GEMINI_MODEL_FLASH ? { "gemini-flash": e.STUDIO_GEMINI_MODEL_FLASH } : {}),
    ...(e.STUDIO_GEMINI_MODEL_PRO ? { "gemini-pro": e.STUDIO_GEMINI_MODEL_PRO } : {}),
  };
  const settings: AgentSettings = {
    enabled: e.STUDIO_CLAUDE_ENABLED === "1",
    apiUrl: e.STUDIO_API_URL,
    claudeBin: e.STUDIO_CLAUDE_BIN,
    model: e.STUDIO_CLAUDE_MODEL,
    effortChat: e.STUDIO_CLAUDE_EFFORT_CHAT,
    effortDesign: e.STUDIO_CLAUDE_EFFORT_DESIGN,
    claudeConcurrency: e.STUDIO_CLAUDE_CONCURRENCY,
    claudeTimeoutMs: e.STUDIO_CLAUDE_TIMEOUT_S * 1000,
    claudeConfigDir: e.STUDIO_CLAUDE_CONFIG_DIR,
    selfTest: e.STUDIO_CLAUDE_SELFTEST,
    logStreams: e.STUDIO_CLAUDE_LOG_STREAMS === "1",
    usageLimitFallbackMs: e.STUDIO_USAGE_LIMIT_FALLBACK_MIN * 60_000,
    chatMaxImages: e.STUDIO_CHAT_MAX_IMAGES,
    imageMaxEdge: e.STUDIO_IMAGE_MAX_EDGE,
    designFixPasses: e.STUDIO_DESIGN_FIX_PASSES,
    imageMaxBytes: 25 * 1024 * 1024,
    geminiApiKey: e.GEMINI_API_KEY,
    geminiBin: e.STUDIO_GEMINI_BIN,
    geminiMode: e.STUDIO_GEMINI_MODE,
    geminiModelOverrides,
    // The vault is filled (and replaced) by the runtime later: read it on every lookup.
    geminiModels: liveGeminiModels(geminiModelOverrides, () => settings.vault?.gemini?.models),
    geminiImageModel: e.STUDIO_GEMINI_IMAGE_MODEL,
    codexBin: e.STUDIO_CODEX_BIN,
    codexModel: e.STUDIO_CODEX_MODEL,
    openaiModel: e.STUDIO_OPENAI_MODEL,
    antigravityBin: e.STUDIO_ANTIGRAVITY_BIN,
    antigravityModel: e.STUDIO_ANTIGRAVITY_MODEL,
    vault: {},
    elevenLabsApiKey: e.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: e.STUDIO_ELEVENLABS_VOICE_ID,
    ffmpegBin: e.STUDIO_FFMPEG_BIN,
    whisperBin: e.STUDIO_WHISPER_BIN,
    cloudPublisherUrl: e.STUDIO_CLOUD_PUBLISHER_URL,
    cloudPublisherToken: e.STUDIO_CLOUD_PUBLISHER_TOKEN,
    schedulePollIntervalMs: e.STUDIO_SCHEDULE_POLL_INTERVAL_S * 1000,
    skillsDir: e.STUDIO_SKILLS_DIR,
    parentEnv: env,
  };
  return settings;
}

/** Keys the owner stored in the vault, as the worker last read them (`GET /api/worker/ai/credentials`). */
export interface AiVault {
  gemini?: { apiKey: string; models: string[] } | undefined;
  openai?: { apiKey: string; models: string[] } | undefined;
}

export function claudeLogDir(stateDir: string): string {
  return path.join(stateDir, "claude-logs");
}

export interface AgentDeps {
  api: StudioApi;
  gate: ClaudeGate;
  settings: AgentSettings;
  logger: Logger;
  /** Latest Claude self-test result. */
  health: () => ClaudeHealth;
  /** Latest Claude sign-in status (`worker.claude`). */
  claudeAccount?: () => ClaudeAccount;
  /** Latest Gemini readiness (`worker.gemini`). */
  geminiAccount?: () => GeminiAccount;
  /** Latest Claude subscription usage windows (`worker.usage`). */
  usage?: UsageTracker;
  /** Read `claude -p /usage` again (no model call; at most once a minute). */
  refreshUsage?: () => void;
  /** Studio's MCP server (one per worker); a turn without it starts its own. */
  mcpServer?: StudioMcpServer;
  /** Runtime skills (`agent/skills`). */
  skills?: () => Promise<Skill[]>;
  /** Where caches and MCP work dirs live. */
  stateDir: string;
  now?: () => Date;
  /** Records paid AI calls (Gemini, OpenAI, ElevenLabs spend) and checks the budget; absent in tests that do not care. */
  aiUsage?: AiUsageRecorder;
  /** The owner's Claude-limit choice and budget (S7); absent: switch to Gemini at the limit, no budget. */
  aiPolicy?: AiPolicy;
  /** Codex CLI / OpenAI API / Antigravity CLI readiness (`worker.providers`). */
  providers?: () => AiProviderStatus[];
  /**
   * Apple Vision on this Mac (`studio-vision`, N12 / U9): tagging, OCR, cutouts. Absent (tests):
   * treated as not installed.
   */
  vision?: VisionHelper;
  /** Test seams for Gemini, publishers & consent polling. */
  geminiFetch?: typeof globalThis.fetch;
  geminiCliSpawn?: typeof nodeSpawn;
  codexSpawn?: typeof nodeSpawn;
  antigravitySpawn?: typeof nodeSpawn;
  openaiFetch?: typeof globalThis.fetch;
  publisherFetch?: typeof globalThis.fetch;
  consentPollIntervalMs?: number;
  consentTimeoutMs?: number;
  /** `ask_user` wait (default 10 min) and `wait_jobs` poll interval (default 3 s). */
  askTimeoutMs?: number;
  jobPollIntervalMs?: number;
}
