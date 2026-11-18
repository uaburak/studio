// The conversation as a list of display items (pure values, tested without views). Port of
// StudioMac/Chat/TranscriptModel.swift (TranscriptBuilder + StepSummary), with the Wecra
// design's grouping of progress steps into one "Plan" card.
import {
  type AgentRun,
  type AttachmentPart,
  type ConsentPart,
  type ConversationAlias,
  type ErrorPart,
  type Message,
  type MessageMention,
  type MessagePart,
  type Plan,
  type ProgressPart,
  type QuestionPart,
  resolveAliasMentions,
  scanAliasTokens,
  type ToolStepPart,
} from "@studio/contract";
import { capitalizeTr } from "./format.ts";

export interface ChatImage {
  assetId: string;
  width?: number | null;
  height?: number | null;
  /** `@alias` or the post title: tooltip and lightbox caption. */
  caption?: string | null;
  aliasId?: string | null;
  /** Explicit source (previews, the gallery); default: the asset's content URL. */
  url?: string;
  /** Backdrop behind a transparent picture in the viewer (a logo's light or dark tile). */
  background?: string;
}

export interface StepGroup {
  key: string;
  steps: ToolStepPart[];
  isExpanded: boolean;
  thumbnails: ChatImage[];
  /** The live group of a running reply: its running steps are on the working line. */
  isLive: boolean;
  summary: string;
  hasErrors: boolean;
}

export type AssistantBlock =
  | { kind: "text"; key: string; markdown: string }
  | { kind: "steps"; key: string; group: StepGroup }
  | { kind: "images"; key: string; images: ChatImage[] }
  | { kind: "consent"; key: string; consent: ConsentPart; busy: boolean }
  | { kind: "question"; key: string; question: QuestionPart; busy: boolean }
  | { kind: "plan"; key: string; planId: string; plan: Plan | null; busy: boolean }
  | { kind: "progress"; key: string; steps: ProgressPart[] }
  | { kind: "error"; key: string; error: ErrorPart }
  | { kind: "post"; key: string; contentId: string; version: number | null; note: string | null }
  | { kind: "notice"; key: string; text: string }
  | { kind: "unknown"; key: string; text: string };

export interface OutgoingAttachment {
  assetId: string;
  alias?: string;
}

export interface OutgoingMessage {
  clientMessageId: string;
  text: string;
  attachments: OutgoingAttachment[];
}

export type QueuedState =
  | { kind: "waiting" }
  | { kind: "sending" }
  | { kind: "failed"; error: string };

export interface QueuedMessage {
  message: OutgoingMessage;
  state: QueuedState;
  /** "Şimdi gönder": goes before the others once the running reply stops. */
  sendNow: boolean;
}

export type WorkingPhase =
  /** The run waits (for the Mac or in line): grey, static dots. */
  | { kind: "queued"; text: string }
  | { kind: "thinking" }
  | { kind: "step"; label: string }
  | { kind: "writing" };

export interface WorkingItem {
  phase: WorkingPhase;
  /** Elapsed time counts from here (epoch ms; null: no time shown). */
  since: number | null;
  cancellable: boolean;
  /** The step group the "›" opens. */
  groupKey: string | null;
}

export type TranscriptItem =
  | { kind: "loading"; key: string; trouble: boolean }
  | { kind: "empty"; key: string }
  | {
      kind: "user";
      key: string;
      id: string;
      text: string;
      mentions: MessageMention[];
      images: ChatImage[];
    }
  | {
      kind: "assistant";
      key: string;
      message: Message;
      blocks: AssistantBlock[];
      copyText: string;
      isStreaming: boolean;
    }
  | { kind: "event"; key: string; text: string }
  | {
      kind: "queued";
      key: string;
      id: string;
      text: string;
      images: ChatImage[];
      state: QueuedState;
      canEdit: boolean;
      sendNow: boolean;
    }
  | { kind: "working"; key: string; working: WorkingItem };

export interface TranscriptInput {
  hasState: boolean;
  connectionTrouble?: boolean;
  messages?: Message[];
  plans?: Plan[];
  aliases?: ConversationAlias[];
  activeRun?: AgentRun | null;
  runWaitingForMac?: boolean;
  isOnline?: boolean;
  expandedSteps?: ReadonlySet<string>;
  busyPlans?: ReadonlySet<string>;
  busyQuestions?: ReadonlySet<string>;
  busyConsents?: ReadonlySet<string>;
  queue?: QueuedMessage[];
  /** When each running step was first seen (the working line's elapsed time). */
  stepStarts?: Readonly<Record<string, number>>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function plainText(message: Message): string {
  return message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

/** The synthetic "Düşünüyor…" step is hidden once it is done. */
export function isHiddenInChat(part: MessagePart): boolean {
  return part.type === "progress" && part.stepId === "thinking" && part.state !== "running";
}

export function chatImage(part: AttachmentPart, aliases: ConversationAlias[]): ChatImage {
  const alias =
    aliases.find((a) => a.id === part.aliasId) ?? aliases.find((a) => a.assetId === part.assetId);
  const name = alias?.alias ?? part.alias;
  return {
    assetId: part.assetId,
    width: part.width,
    height: part.height,
    caption: name ? `@${name}` : part.filename,
    aliasId: alias?.id ?? part.aliasId ?? null,
  };
}

/** The reply being written by the active run. */
export function liveMessageId(input: TranscriptInput): string | null {
  const run = input.activeRun;
  if (run?.status !== "running") return null;
  const messages = input.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m &&
      m.role !== "user" &&
      m.status === "streaming" &&
      (m.runId === null || m.runId === run.id)
    ) {
      return m.id;
    }
  }
  return null;
}

/** Ids of running tool / progress steps in the live reply (their start times are remembered). */
export function runningStepKeys(input: TranscriptInput): string[] {
  const live = liveMessageId(input);
  const message = (input.messages ?? []).find((m) => m.id === live);
  if (!message) return [];
  const keys: string[] = [];
  for (const part of message.parts) {
    if (part.type === "tool_step" && part.state === "running") keys.push(part.id);
    if (part.type === "progress" && part.state === "running" && part.stepId !== "thinking") {
      keys.push(`progress-${part.stepId}`);
    }
  }
  return keys;
}

export function buildTranscript(input: TranscriptInput): TranscriptItem[] {
  if (!input.hasState)
    return [{ kind: "loading", key: "loading", trouble: input.connectionTrouble ?? false }];
  const messages = input.messages ?? [];
  const aliases = input.aliases ?? [];
  const queue = input.queue ?? [];
  const items: TranscriptItem[] = [];
  const live = liveMessageId(input);

  for (const message of messages) {
    if (message.role === "user") {
      const text = plainText(message);
      items.push({
        kind: "user",
        key: `m-${message.id}`,
        id: message.id,
        text,
        mentions: message.mentions ?? resolveAliasMentions(text, aliases),
        images: message.parts.flatMap((p) =>
          p.type === "attachment" ? [chatImage(p, aliases)] : [],
        ),
      });
    } else if (message.role === "system") {
      const text = plainText(message).trim();
      if (text) items.push({ kind: "event", key: `m-${message.id}`, text });
    } else {
      items.push(assistantItem(message, input, message.id === live));
    }
  }

  if (messages.length === 0 && queue.length === 0 && !input.activeRun) {
    items.push({ kind: "empty", key: "empty" });
  }
  const working = workingItem(input, live);
  if (working) items.push({ kind: "working", key: "working", working });
  for (const queued of queue) {
    items.push({
      kind: "queued",
      key: `q-${queued.message.clientMessageId}`,
      id: queued.message.clientMessageId,
      text: queued.message.text,
      images: queued.message.attachments.map((a) => ({
        assetId: a.assetId,
        caption: a.alias ? `@${a.alias}` : null,
      })),
      state: queued.state,
      canEdit: queued.message.attachments.length === 0 && queued.state.kind !== "sending",
      sendNow: queued.sendNow,
    });
  }
  return items;
}

function assistantItem(message: Message, input: TranscriptInput, isLive: boolean): TranscriptItem {
  const blocks: AssistantBlock[] = [];
  const parts = message.parts;
  const aliases = input.aliases ?? [];
  const expanded = input.expandedSteps ?? EMPTY_SET;
  let index = 0;
  while (index < parts.length) {
    const part = parts[index] as MessagePart;
    if (part.type === "tool_step") {
      const start = index;
      const steps: ToolStepPart[] = [];
      while (index < parts.length && parts[index]?.type === "tool_step") {
        steps.push(parts[index] as ToolStepPart);
        index += 1;
      }
      const key = stepGroupKey(message.id, start);
      const isExpanded = expanded.has(key);
      const summarized = isLive ? steps.filter((s) => s.state !== "running") : steps;
      // A live group with only running steps lives on the working line.
      if (summarized.length === 0 && !isExpanded) continue;
      blocks.push({
        kind: "steps",
        key,
        group: {
          key,
          steps,
          isExpanded,
          thumbnails: stepThumbnails(steps, aliases),
          isLive,
          summary: stepSummary(summarized.length > 0 ? summarized : steps),
          hasErrors: steps.some((s) => s.state === "error"),
        },
      });
      continue;
    }
    if (part.type === "attachment") {
      const start = index;
      const images: ChatImage[] = [];
      while (index < parts.length && parts[index]?.type === "attachment") {
        images.push(chatImage(parts[index] as AttachmentPart, aliases));
        index += 1;
      }
      blocks.push({ kind: "images", key: `images-${start}`, images });
      continue;
    }
    if (part.type === "progress") {
      const start = index;
      const steps: ProgressPart[] = [];
      while (index < parts.length && parts[index]?.type === "progress") {
        const p = parts[index] as ProgressPart;
        if (p.stepId !== "thinking") steps.push(p);
        index += 1;
      }
      // One running step of a live reply is on the working line; two or more form the plan card.
      if (steps.length === 1 && isLive && steps[0]?.state === "running") continue;
      if (steps.length > 0) blocks.push({ kind: "progress", key: `progress-${start}`, steps });
      continue;
    }
    const at = index;
    index += 1;
    if (isHiddenInChat(part)) continue;
    switch (part.type) {
      case "text":
        if (part.text.trim()) blocks.push({ kind: "text", key: `text-${at}`, markdown: part.text });
        break;
      case "consent":
        blocks.push({
          kind: "consent",
          key: `consent-${part.consentId}`,
          consent: part,
          busy: (input.busyConsents ?? EMPTY_SET).has(message.id + part.consentId),
        });
        break;
      case "question":
        blocks.push({
          kind: "question",
          key: `question-${part.questionId}`,
          question: part,
          busy: (input.busyQuestions ?? EMPTY_SET).has(message.id + part.questionId),
        });
        break;
      case "plan_proposal":
        blocks.push({
          kind: "plan",
          key: `plan-${part.planId}`,
          planId: part.planId,
          plan: (input.plans ?? []).find((p) => p.id === part.planId) ?? null,
          busy: (input.busyPlans ?? EMPTY_SET).has(part.planId),
        });
        break;
      case "error":
        blocks.push({ kind: "error", key: `error-${at}`, error: part });
        break;
      case "content_ref":
        blocks.push({
          kind: "post",
          key: `post-${at}-${part.contentId}`,
          contentId: part.contentId,
          version: part.version,
          note: part.note,
        });
        break;
      default:
        blocks.push({
          kind: "unknown",
          key: `unknown-${at}`,
          text: `Bu sürümün gösteremediği bir içerik (${(part as { type: string }).type}).`,
        });
    }
  }
  if (message.status === "failed")
    blocks.push({ kind: "notice", key: "status", text: "Yanıt yarıda kaldı." });
  if (message.status === "cancelled")
    blocks.push({ kind: "notice", key: "status", text: "Yanıt durduruldu." });
  return {
    kind: "assistant",
    key: `m-${message.id}`,
    message,
    blocks,
    copyText: plainText(message).trim(),
    isStreaming: message.status === "streaming",
  };
}

/** Unique per message and position (tool call ids repeat across turns). */
export function stepGroupKey(messageId: string, startIndex: number): string {
  return `steps-${messageId}-${startIndex}`;
}

/** "Görsel üretiliyor…" reads badly before a timer: the time follows the label. */
export function stepLabel(label: string): string {
  if (label.endsWith("…")) return label.slice(0, -1);
  if (label.endsWith("...")) return label.slice(0, -3);
  return label;
}

/** What the agent does now: queued, thinking, a running step, or writing. */
export function workingItem(input: TranscriptInput, live: string | null): WorkingItem | null {
  const run = input.activeRun;
  if (!run) return null;
  if (run.status !== "running") {
    const text = input.runWaitingForMac
      ? input.isOnline === false
        ? "Mac sırada bekliyor: Mac çevrimdışı."
        : "Mac sırada bekliyor: sohbet ajanı henüz kurulu değil."
      : "Sırada";
    return { phase: { kind: "queued", text }, since: null, cancellable: true, groupKey: null };
  }
  const starts = input.stepStarts ?? {};
  const runStart = run.startedAt ? Date.parse(run.startedAt) : (starts[`run-${run.id}`] ?? null);
  const message = (input.messages ?? []).find((m) => m.id === live);
  if (!live || !message) {
    return { phase: { kind: "thinking" }, since: runStart, cancellable: false, groupKey: null };
  }
  let groupKey: string | null = null;
  let currentGroupKey: string | null = null;
  let phase: WorkingPhase | null = null;
  let since = runStart;
  let sawText = false;
  let previousWasStep = false;
  for (const [partIndex, part] of message.parts.entries()) {
    if (part.type === "tool_step") {
      if (!previousWasStep) currentGroupKey = stepGroupKey(message.id, partIndex);
      previousWasStep = true;
      if (part.state === "running") {
        phase = { kind: "step", label: stepLabel(part.label) };
        since = starts[part.id] ?? runStart;
        groupKey = currentGroupKey;
      }
      continue;
    }
    if (part.type === "progress" && part.state === "running") {
      if (part.stepId === "thinking") {
        if (!phase) phase = { kind: "thinking" };
      } else {
        let label = stepLabel(part.label);
        if (part.current !== null && part.total !== null) label += ` ${part.current}/${part.total}`;
        phase = { kind: "step", label };
        since = starts[`progress-${part.stepId}`] ?? runStart;
        groupKey = null;
      }
    } else if (part.type === "text" && part.text.trim()) {
      sawText = true;
    }
    previousWasStep = false;
  }
  if (phase) return { phase, since, cancellable: false, groupKey };
  return {
    phase: sawText ? { kind: "writing" } : { kind: "thinking" },
    since: runStart,
    cancellable: false,
    groupKey: null,
  };
}

export function workingLabel(phase: WorkingPhase): string {
  switch (phase.kind) {
    case "queued":
      return phase.text;
    case "thinking":
      return "Düşünüyor…";
    case "step":
      return phase.label;
    case "writing":
      return "Yazıyor…";
  }
}

// --- step summaries ---------------------------------------------------------------------------

type Phrase = { counted: boolean; text: string };

const PHRASES: Record<string, Phrase> = {
  list_brands: { counted: false, text: "markaları okudu" },
  get_brand_profile: { counted: false, text: "marka profilini okudu" },
  set_conversation_brand: { counted: false, text: "markayı seçti" },
  propose_plan: { counted: false, text: "plan önerdi" },
  ask_user: { counted: true, text: "soru sordu" },
  list_aliases: { counted: false, text: "görselleri listeledi" },
  view_alias: { counted: true, text: "görsele baktı" },
  list_contents: { counted: false, text: "postları listeledi" },
  get_content: { counted: true, text: "posta baktı" },
  view_post: { counted: true, text: "posta baktı" },
  generate_post: { counted: true, text: "post oluşturdu" },
  wait_jobs: { counted: false, text: "üretimi bekledi" },
  generate_reel: { counted: true, text: "Reels oluşturdu" },
  revise_post: { counted: true, text: "post düzeltti" },
  list_skills: { counted: false, text: "becerileri okudu" },
  get_skill: { counted: false, text: "becerileri okudu" },
  list_social_accounts: { counted: false, text: "hesapları okudu" },
  accept_and_generate_plan: { counted: false, text: "planı üretime aldı" },
  approve_content: { counted: true, text: "post onayladı" },
  schedule_content: { counted: true, text: "post zamanladı" },
  create_brand: { counted: false, text: "marka oluşturdu" },
  analyze_brand: { counted: false, text: "markayı analiz etti" },
  generate_ai_image: { counted: true, text: "görsel üretti" },
  fill_post_slot: { counted: true, text: "görsel yerleştirdi" },
  export_content_pdf: { counted: false, text: "PDF hazırladı" },
  publish_now: { counted: true, text: "post yayınladı" },
};

/**
 * "2 görsel üretti, 1 post oluşturdu" (Claude Code's "Ran 3 commands, read 2 files").
 * One step: its own label. Several: grouped phrases in order of first appearance, then
 * the failed count.
 */
export function stepSummary(steps: ToolStepPart[]): string {
  if (steps.length === 0) return "";
  if (steps.length === 1) {
    const step = steps[0] as ToolStepPart;
    const label = step.label.replace(/^[…. ]+|[…. ]+$/g, "");
    return step.state === "error" ? `${label} · başarısız` : step.label;
  }
  const order: string[] = [];
  const counts = new Map<string, number>();
  const counted = new Map<string, boolean>();
  for (const step of steps) {
    const phrase = PHRASES[step.name] ?? { counted: true, text: "adım tamamladı" };
    if (!counts.has(phrase.text)) order.push(phrase.text);
    counts.set(phrase.text, (counts.get(phrase.text) ?? 0) + 1);
    counted.set(phrase.text, phrase.counted);
  }
  const pieces = order.map((key) => (counted.get(key) ? `${counts.get(key) ?? 1} ${key}` : key));
  const failed = steps.filter((s) => s.state === "error").length;
  if (failed > 0) pieces.push(`${failed} başarısız`);
  return capitalizeTr(pieces.join(", "));
}

/** Images behind finished steps: `@alias` tokens in their summaries (unique, in order). */
export function stepThumbnails(steps: ToolStepPart[], aliases: ConversationAlias[]): ChatImage[] {
  const seen = new Set<string>();
  const result: ChatImage[] = [];
  for (const step of steps) {
    if (step.state !== "done" || !step.summary) continue;
    for (const token of scanAliasTokens(step.summary)) {
      const alias = aliases.find(
        (a) => a.alias === token.alias || a.previousAliases.includes(token.alias),
      );
      if (!alias || seen.has(alias.assetId)) continue;
      seen.add(alias.assetId);
      result.push({
        assetId: alias.assetId,
        width: alias.width,
        height: alias.height,
        caption: `@${alias.alias}`,
        aliasId: alias.id,
      });
    }
  }
  return result;
}
