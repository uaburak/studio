// Messages of the transcript (Wecra "User bubble", markdown, image tiles): the user's bubble on
// the right, the assistant's reply without a bubble with an action row on hover, the queued
// bubble with "Şimdi gönder".
import type { ConversationAlias, MessageMention } from "@studio/contract";
import { type ReactNode, useState } from "react";
import type {
  AssistantBlock,
  ChatImage,
  QueuedState,
  TranscriptItem,
} from "../../lib/transcript.ts";
import type { ConversationController } from "../../state/conversation.ts";
import { cn, IconButton } from "../ui/controls.tsx";
import { IconCheck, IconClose, IconCopy, IconPencil, IconRetry } from "../ui/icons.tsx";
import {
  ConsentCard,
  ErrorBlock,
  NoticeLine,
  PlanProposalCard,
  ProgressCard,
  QuestionCard,
  StepLine,
} from "./blocks.tsx";
import { ImageGrid } from "./images.tsx";
import { Markdown, MentionPill } from "./markdown.tsx";

/** User text with the server's resolved mentions as pills. */
function MentionedText({
  text,
  mentions,
  aliases,
  onMention,
}: {
  text: string;
  mentions: MessageMention[];
  aliases: ConversationAlias[];
  onMention(aliasId: string): void;
}) {
  if (mentions.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < cursor) continue;
    if (m.start > cursor) parts.push(text.slice(cursor, m.start));
    const name = aliases.find((a) => a.id === m.aliasId)?.alias ?? m.alias;
    parts.push(
      <MentionPill key={`${m.start}`} alias={name} onClick={() => onMention(m.aliasId)} />,
    );
    cursor = m.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function UserBubble({
  text,
  mentions,
  images,
  aliases,
  onMention,
  muted = false,
}: {
  text: string;
  mentions: MessageMention[];
  images: ChatImage[];
  aliases: ConversationAlias[];
  onMention(aliasId: string): void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {images.length > 0 && <ImageGrid images={images} className="justify-end" />}
      {text && (
        <div
          className={cn(
            "selectable max-w-[78%] rounded-[14px] bg-bubble px-3.5 py-2.5 text-prose whitespace-pre-wrap [overflow-wrap:anywhere]",
            muted ? "text-fg-2" : "text-fg",
          )}
        >
          <MentionedText text={text} mentions={mentions} aliases={aliases} onMention={onMention} />
        </div>
      )}
    </div>
  );
}

export function QueuedBubble({
  item,
  controller,
  onEdit,
}: {
  item: Extract<TranscriptItem, { kind: "queued" }>;
  controller: ConversationController;
  onEdit(text: string): void;
}) {
  const label = queuedLabel(item.state);
  return (
    <div className="my-5 flex flex-col items-end gap-1">
      <UserBubble
        text={item.text}
        mentions={[]}
        images={item.images}
        aliases={[]}
        onMention={() => undefined}
        muted
      />
      <div className="flex items-center gap-0.5 text-footnote">
        <span className={cn("mr-1.5", item.state.kind === "failed" ? "text-danger" : "text-fg-3")}>
          {label}
        </span>
        {item.canEdit && (
          <IconButton
            icon={<IconPencil size={13} strokeWidth={1.75} />}
            label="Düzenle"
            size={24}
            onClick={() => {
              const text = controller.takeQueuedForEdit(item.id);
              if (text !== null) onEdit(text);
            }}
          />
        )}
        {item.state.kind === "failed" && (
          <IconButton
            icon={<IconRetry size={13} strokeWidth={1.75} />}
            label="Yeniden dene"
            size={24}
            onClick={() => controller.retryQueued(item.id)}
          />
        )}
        <IconButton
          icon={<IconCopy size={13} strokeWidth={1.75} />}
          label="Kopyala"
          size={24}
          onClick={() => void navigator.clipboard?.writeText(item.text)}
        />
        {item.state.kind !== "sending" && (
          <IconButton
            icon={<IconClose size={13} strokeWidth={1.75} />}
            label="Sıradan çıkar"
            size={24}
            onClick={() => controller.removeQueued(item.id)}
          />
        )}
        {item.state.kind !== "sending" && !item.sendNow && (
          <button
            type="button"
            onClick={() => void controller.sendQueuedNow(item.id)}
            className="ml-1 rounded-full px-1.5 py-1 font-medium text-accent-text hover:bg-control"
          >
            Şimdi gönder
          </button>
        )}
      </div>
    </div>
  );
}

function queuedLabel(state: QueuedState): string {
  switch (state.kind) {
    case "waiting":
      return "Sırada";
    case "sending":
      return "Gönderiliyor…";
    case "failed":
      return state.error;
  }
}

export function AssistantMessage({
  item,
  aliases,
  controller,
  onMention,
  onEditPlan,
}: {
  item: Extract<TranscriptItem, { kind: "assistant" }>;
  aliases: ConversationAlias[];
  controller: ConversationController;
  onMention(aliasId: string): void;
  onEditPlan(): void;
}) {
  const [copied, setCopied] = useState(false);
  const env = { aliases, onMention };
  return (
    <div className="group/msg relative">
      {item.blocks.map((block) => (
        <AssistantBlockView
          key={block.key}
          block={block}
          message={item.message}
          env={env}
          controller={controller}
          onEditPlan={onEditPlan}
        />
      ))}
      {!item.isStreaming && item.copyText && (
        <div className="-mt-1.5 flex h-7 items-center gap-0.5 opacity-0 transition-opacity duration-200 ease-snap group-hover/msg:opacity-100 focus-within:opacity-100">
          <IconButton
            icon={
              copied ? (
                <IconCheck size={14} strokeWidth={2} />
              ) : (
                <IconCopy size={14} strokeWidth={1.75} />
              )
            }
            label={copied ? "Kopyalandı" : "Kopyala"}
            size={24}
            onClick={() => {
              void navigator.clipboard?.writeText(item.copyText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            }}
          />
        </div>
      )}
    </div>
  );
}

function AssistantBlockView({
  block,
  message,
  env,
  controller,
  onEditPlan,
}: {
  block: AssistantBlock;
  message: Extract<TranscriptItem, { kind: "assistant" }>["message"];
  env: { aliases: ConversationAlias[]; onMention(aliasId: string): void };
  controller: ConversationController;
  onEditPlan(): void;
}) {
  switch (block.kind) {
    case "text":
      return (
        <div className="my-3.5">
          <Markdown source={block.markdown} env={env} />
        </div>
      );
    case "steps":
      return (
        <StepLine group={block.group} onToggle={() => controller.toggleSteps(block.group.key)} />
      );
    case "images":
      return <ImageGrid images={block.images} className="my-3.5" />;
    case "consent":
      return (
        <ConsentCard
          message={message}
          consent={block.consent}
          busy={block.busy}
          controller={controller}
        />
      );
    case "question":
      return (
        <QuestionCard
          message={message}
          question={block.question}
          busy={block.busy}
          controller={controller}
        />
      );
    case "plan":
      return (
        <PlanProposalCard
          plan={block.plan}
          busy={block.busy}
          controller={controller}
          onEdit={onEditPlan}
        />
      );
    case "progress":
      return <ProgressCard steps={block.steps} />;
    case "error":
      return <ErrorBlock error={block.error} />;
    case "post":
      return (
        <div className="my-3.5 rounded-[12px] border border-hairline px-4 py-2.5 text-body text-fg-2">
          Post{block.note ? ` · ${block.note}` : ""}{" "}
          <span className="text-fg-3">(post kartı bir sonraki sürümde)</span>
        </div>
      );
    case "notice":
    case "unknown":
      return <NoticeLine text={block.text} />;
  }
}
