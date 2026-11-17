// Model and effort of a chat turn: labels, menu order, and the per-conversation memory
// (same rules as the AppKit app's AgentChoiceStore).
import type { AgentEffort, AgentModel } from "@studio/contract";
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

export const EFFORTS: { id: AgentEffort; label: string }[] = [
  { id: "low", label: "Düşük" },
  { id: "medium", label: "Orta" },
  { id: "high", label: "Yüksek" },
  { id: "xhigh", label: "Çok yüksek" },
];

const MODEL_IDS = new Set<string>([...CLAUDE_MODELS, ...GEMINI_MODELS].map((m) => m.id));
const EFFORT_IDS = new Set<string>(EFFORTS.map((e) => e.id));

export function modelLabel(model: string): string {
  return [...CLAUDE_MODELS, ...GEMINI_MODELS].find((m) => m.id === model)?.label ?? model;
}

export function effortLabel(effort: string): string {
  return EFFORTS.find((e) => e.id === effort)?.label ?? effort;
}

export function isGemini(model: string): boolean {
  return model.startsWith("gemini");
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
