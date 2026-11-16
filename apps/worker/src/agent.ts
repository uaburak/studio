/**
 * Settings and shared dependencies of the Claude-backed job handlers.
 */
import path from "node:path";
import { z } from "zod";
import type { StudioApi } from "./api.ts";
import type { ClaudeGate } from "./claude/gate.ts";
import type { ClaudeHealth } from "./claude/health.ts";
import type { Logger } from "./log.ts";

const AgentEnv = z.object({
  /** `0` runs the worker without the Claude-backed job types (demo/smoke only). */
  STUDIO_CLAUDE_ENABLED: z.enum(["0", "1"]).default("1"),
  /** API origin; default derived from STUDIO_HUB_URL. */
  STUDIO_API_URL: z.url({ protocol: /^https?$/ }).optional(),
  STUDIO_CLAUDE_BIN: z.string().min(1).default("claude"),
  STUDIO_CLAUDE_MODEL: z.string().min(1).default("opus"),
  STUDIO_CLAUDE_EFFORT_CHAT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  STUDIO_CLAUDE_EFFORT_DESIGN: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Claude calls at the same time across all jobs (default 1). */
  STUDIO_CLAUDE_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
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
}

export function loadAgentSettings(env: NodeJS.ProcessEnv = process.env): AgentSettings {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = AgentEnv.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
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
  };
}

export function claudeLogDir(stateDir: string): string {
  return path.join(stateDir, "claude-logs");
}

export interface AgentDeps {
  api: StudioApi;
  gate: ClaudeGate;
  settings: AgentSettings;
  logger: Logger;
  /** Latest self-test result. */
  health: () => ClaudeHealth;
  /** Where caches (brand files) live. */
  stateDir: string;
  now?: () => Date;
}
