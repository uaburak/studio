// Model and effort of a chat turn: labels, menu order, provider groups, why a provider cannot be
// used right now, and the per-conversation memory (same rules as the AppKit app's
// AgentChoiceStore).
import type { AgentEffort, AgentModel, AiProviderStatus, WorkerPresence } from "@studio/contract";
import type { AgentChoiceValue, DesktopSettings } from "../../shared/ipc.ts";

export interface AgentChoice {
  model: AgentModel;
  effort: AgentEffort;
}

export const FALLBACK_CHOICE: AgentChoice = { model: "gemini-flash-lite", effort: "medium" };

export const CLAUDE_MODELS: { id: AgentModel; label: string }[] = [
  { id: "opus", label: "Opus 5.5" },
  { id: "sonnet", label: "Sonnet 5" },
  { id: "haiku", label: "Haiku 5" },
];

export const GEMINI_MODELS: { id: AgentModel; label: string }[] = [
  { id: "gemini-flash-lite", label: "Gemini Flash-Lite" },
  { id: "gemini-flash", label: "Gemini Flash" },
  { id: "gemini-pro", label: "Gemini Pro" },
];

export const OPENAI_MODELS: { id: AgentModel; label: string }[] = [
  { id: "codex", label: "Codex (ChatGPT)" },
  { id: "gpt", label: "GPT (OpenAI API)" },
];

export const ANTIGRAVITY_MODELS: { id: AgentModel; label: string }[] = [
  { id: "antigravity", label: "Antigravity" },
];

export type ModelProvider = "claude" | "gemini" | "openai" | "antigravity";

/** The model menu's groups, in order. */
export const MODEL_GROUPS: {
  provider: ModelProvider;
  title: string;
  models: { id: AgentModel; label: string }[];
}[] = [
  { provider: "claude", title: "Claude", models: CLAUDE_MODELS },
  { provider: "gemini", title: "Gemini", models: GEMINI_MODELS },
  { provider: "openai", title: "OpenAI", models: OPENAI_MODELS },
  { provider: "antigravity", title: "Google Antigravity", models: ANTIGRAVITY_MODELS },
];

export const EFFORTS: { id: AgentEffort; label: string }[] = [
  { id: "low", label: "Düşük" },
  { id: "medium", label: "Orta" },
  { id: "high", label: "Yüksek" },
  { id: "xhigh", label: "Çok yüksek" },
];

const ALL_MODELS = MODEL_GROUPS.flatMap((g) => g.models);
const MODEL_IDS = new Set<string>(ALL_MODELS.map((m) => m.id));
const EFFORT_IDS = new Set<string>(EFFORTS.map((e) => e.id));

export function modelLabel(model: string): string {
  return ALL_MODELS.find((m) => m.id === model)?.label ?? model;
}

export function effortLabel(effort: string): string {
  return EFFORTS.find((e) => e.id === effort)?.label ?? effort;
}

export function isGemini(model: string): boolean {
  return model.startsWith("gemini");
}

/** Short Turkish reason a provider row cannot run turns, or null when it can. */
function providerRowReason(row: AiProviderStatus | undefined): string | null {
  if (!row) return "durum bilinmiyor";
  switch (row.state) {
    case "ready":
      return null;
    case "not_installed":
      return "kurulu değil";
    case "signed_out":
      return "giriş yapılmadı";
    case "signing_in":
      return "giriş sürüyor";
    case "not_configured":
      return "anahtar yok";
    default:
      return "hata";
  }
}

/**
 * Why `model` cannot answer on this Mac right now (null = it can, or the Mac has not said yet).
 * Claude and Gemini read their own presence fields; the others read presence `providers`.
 */
export function modelUnavailableReason(
  model: AgentModel,
  presence: WorkerPresence | null | undefined,
): string | null {
  if (!presence) return null;
  if (!presence.online) return "Mac çevrimdışı";
  const row = (id: AiProviderStatus["provider"]) =>
    presence.providers?.find((p) => p.provider === id);
  switch (model) {
    case "opus":
    case "sonnet":
    case "haiku": {
      const status = presence.claude?.status;
      if (!status || status === "signed_in") return null;
      return status === "not_installed"
        ? "Claude Code gerekli · Kur"
        : status === "signing_in"
          ? "giriş sürüyor"
          : "giriş yapılmadı";
    }
    case "gemini-flash-lite":
    case "gemini-flash":
    case "gemini-pro":
      if (!presence.gemini) return null;
      return presence.gemini.status === "ready" ? null : "anahtar yok";
    case "codex":
      return presence.providers ? providerRowReason(row("codex")) : null;
    case "gpt":
      return presence.providers ? providerRowReason(row("openai")) : null;
    case "antigravity":
      return presence.providers ? providerRowReason(row("antigravity")) : null;
    default:
      return null;
  }
}

/** A note for a usable model ("araçsız": Antigravity answers without Studio's tools). */
export function modelNote(
  model: AgentModel,
  presence: WorkerPresence | null | undefined,
): string | null {
  if (model !== "antigravity") return null;
  const row = presence?.providers?.find((p) => p.provider === "antigravity");
  return row && !row.tools ? "araçsız" : null;
}

function known(value: AgentChoiceValue | null | undefined, fallback: AgentChoice): AgentChoice {
  return {
    model: value && MODEL_IDS.has(value.model) ? (value.model as AgentModel) : fallback.model,
    effort: value && EFFORT_IDS.has(value.effort) ? (value.effort as AgentEffort) : fallback.effort,
  };
}

/** The last choice the user made anywhere (default for new chats). */
export function lastChoice(settings: Pick<DesktopSettings, "agent">): AgentChoice {
  return known(settings.agent.last, FALLBACK_CHOICE);
}

/** The conversation's own choice, else the last one used. */
export function choiceFor(
  settings: Pick<DesktopSettings, "agent">,
  conversationId: string | null,
): AgentChoice {
  const fallback = lastChoice(settings);
  if (!conversationId) return fallback;
  const stored = settings.agent.conversations[conversationId];
  return stored ? known(stored, fallback) : fallback;
}

/** Settings patch that saves `choice` as the last one and for the conversation. */
export function saveChoicePatch(choice: AgentChoice, conversationId: string | null) {
  return {
    agent: {
      last: { ...choice },
      ...(conversationId ? { conversations: { [conversationId]: { ...choice } } } : {}),
    },
  };
}
