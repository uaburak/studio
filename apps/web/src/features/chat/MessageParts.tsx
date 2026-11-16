import {
  type AgentEffort,
  type AgentModel,
  type ConsentPart,
  type ConversationAlias,
  checkQuestionAnswer,
  type Message,
  type MessagePart,
  type Plan,
  type QuestionPart,
  resolveAliasMentions,
  type ToolStepPart,
} from "@studio/contract";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../api.ts";
import { IconAlert, IconCheck, IconContents, IconShield } from "../../components/icons.tsx";
import { InlineError } from "../../components/states.tsx";
import { useToast } from "../../components/toast.tsx";
import {
  Badge,
  Button,
  Card,
  cx,
  Input,
  Mono,
  Progress,
  Spinner,
  Tag,
} from "../../components/ui.tsx";
import { PlanProposalCard } from "./PlanProposalCard.tsx";

export function MessageBubble({
  message,
  conversationId,
  aliases,
  plans,
  selectedModel,
  selectedEffort,
  onMessageUpdated,
  onPlanUpdated,
}: {
  message: Message;
  conversationId: string;
  aliases: readonly ConversationAlias[];
  plans: readonly Plan[];
  selectedModel?: AgentModel | undefined;
  selectedEffort?: AgentEffort | undefined;
  onMessageUpdated: (updated: Message) => void;
  onPlanUpdated: (updated: Plan) => void;
}) {
  const isUser = message.role === "user";
  return (
    <article
      aria-label={isUser ? "Kullanıcı mesajı" : "Asistan mesajı"}
      className={cx("flex flex-col gap-2", isUser ? "items-end" : "items-start")}
    >
      <div
        className={cx(
          "flex max-w-3xl min-w-0 flex-col gap-2.5",
          isUser
            ? "rounded-2xl bg-ink px-4 py-3 text-bg shadow-card"
            : "w-full rounded-2xl bg-surface p-4 text-ink shadow-card ring-1 ring-line/70",
        )}
      >
        {message.parts.map((part, idx) => (
          <MessagePartView
            key={`${message.id}-p-${idx}`}
            part={part}
            isUser={isUser}
            conversationId={conversationId}
            messageId={message.id}
            aliases={aliases}
            plans={plans}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
            onMessageUpdated={onMessageUpdated}
            onPlanUpdated={onPlanUpdated}
          />
        ))}
        {message.status === "streaming" && message.parts.length === 0 && (
          <span className="inline-flex items-center gap-2 text-sm text-ink-3">
            <Spinner size={14} /> Yanıt hazırlanıyor…
          </span>
        )}
        {message.status === "cancelled" && (
          <span className="text-xs text-ink-3">Yanıt durduruldu.</span>
        )}
      </div>
    </article>
  );
}

function MessagePartView({
  part,
  isUser,
  conversationId,
  messageId,
  aliases,
  plans,
  selectedModel,
  selectedEffort,
  onMessageUpdated,
  onPlanUpdated,
}: {
  part: MessagePart;
  isUser: boolean;
  conversationId: string;
  messageId: string;
  aliases: readonly ConversationAlias[];
  plans: readonly Plan[];
  selectedModel?: AgentModel | undefined;
  selectedEffort?: AgentEffort | undefined;
  onMessageUpdated: (updated: Message) => void;
  onPlanUpdated: (updated: Plan) => void;
}) {
  const api = useApi();

  switch (part.type) {
    case "text":
      return (
        <div className="text-[15px] leading-relaxed break-words whitespace-pre-wrap">
          {renderTextWithAliases(part.text, aliases, isUser)}
        </div>
      );

    case "attachment": {
      const currentAlias =
        (part.aliasId
          ? aliases.find((a) => a.id === part.aliasId)?.alias
          : aliases.find((a) => a.assetId === part.assetId)?.alias) ?? part.alias;
      const url = api.assets.contentUrl(part.assetId);
      return (
        <div
          className={cx(
            "inline-flex max-w-xs flex-col overflow-hidden rounded-xl ring-1",
            isUser ? "bg-bg/10 ring-bg/20" : "bg-surface-2 ring-line",
          )}
        >
          {part.mimeType.startsWith("image/") ? (
            <img
              src={url}
              alt={part.filename ?? currentAlias ?? "Ek"}
              className="max-h-48 w-auto object-cover"
              loading="lazy"
            />
          ) : (
            <div className="px-3 py-2 text-xs">{part.filename ?? part.assetId}</div>
          )}
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
            {currentAlias ? (
              <span className="font-mono font-medium">@{currentAlias}</span>
            ) : (
              <span className="truncate">{part.filename ?? "Ek"}</span>
            )}
          </div>
        </div>
      );
    }

    case "tool_step":
      return <ToolStepRow part={part} />;

    case "progress": {
      const ratio =
        part.current !== null && part.total && part.total > 0 ? part.current / part.total : null;
      return (
        <div className="flex flex-col gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 font-medium text-ink">
              {part.state === "running" && <Spinner size={12} />}
              {part.state === "done" && <IconCheck size={14} className="text-good" />}
              {part.state === "failed" && <IconAlert size={14} className="text-bad" />}
              {part.label}
            </span>
            {part.current !== null && part.total !== null && (
              <Mono className="text-ink-3">
                {part.current}/{part.total}
              </Mono>
            )}
          </div>
          {ratio !== null && <Progress value={ratio} label={part.label} />}
          {part.detail && <p className="text-ink-3">{part.detail}</p>}
        </div>
      );
    }

    case "consent":
      return (
        <ConsentCard
          part={part}
          conversationId={conversationId}
          messageId={messageId}
          onMessageUpdated={onMessageUpdated}
        />
      );

    case "question":
      return (
        <QuestionCard
          part={part}
          conversationId={conversationId}
          messageId={messageId}
          onMessageUpdated={onMessageUpdated}
        />
      );

    case "plan_proposal": {
      const cached = plans.find((p) => p.id === part.planId);
      return (
        <PlanProposalCard
          planId={part.planId}
          cachedPlan={cached}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          onPlanUpdated={onPlanUpdated}
        />
      );
    }

    case "content_ref":
      return (
        <Link
          to={`/icerikler/${part.contentId}`}
          className="flex items-center gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-sm ring-1 ring-line transition-colors hover:bg-surface-3"
        >
          <IconContents size={18} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-ink">
              İçerik {part.version ? `· v${part.version}` : ""}
            </span>
            {part.note && <p className="truncate text-xs text-ink-2">{part.note}</p>}
          </div>
          <span className="text-xs font-medium text-accent">Aç →</span>
        </Link>
      );

    case "error":
      return (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl p-3 text-sm tint-bad">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{part.message}</p>
            {part.code && <Mono className="opacity-75">{part.code}</Mono>}
          </div>
        </div>
      );
  }
}

function renderTextWithAliases(
  text: string,
  aliases: readonly ConversationAlias[],
  isUser: boolean,
): ReactNode {
  const mentions = resolveAliasMentions(text, aliases);
  if (mentions.length === 0) return text;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  mentions.forEach((m, i) => {
    if (m.start > cursor) {
      nodes.push(text.slice(cursor, m.start));
    }
    const latestName = aliases.find((a) => a.id === m.aliasId)?.alias ?? m.alias;
    nodes.push(
      <span
        key={`${m.aliasId}-${m.start}-${i}`}
        className={cx(
          "inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[13px] font-medium",
          isUser ? "bg-accent text-accent-ink" : "tint-accent",
        )}
      >
        @{latestName}
      </span>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

/** Wecra-style compact secondary row for tool execution steps. */
export function ToolStepRow({ part }: { part: ToolStepPart }) {
  return (
    <div
      data-testid={`tool-step-${part.id}`}
      className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/80 px-3 py-1.5 text-xs text-ink-2 ring-1 ring-line/60"
    >
      {part.state === "running" && <Spinner size={13} className="text-info" />}
      {part.state === "done" && <IconCheck size={14} className="text-good" />}
      {part.state === "error" && <IconAlert size={14} className="text-bad" />}
      <span className="font-medium text-ink">{part.label}</span>
      <Mono className="text-[11px] text-ink-3">{part.name}</Mono>
      {part.summary && <span className="text-ink-3">· {part.summary}</span>}
    </div>
  );
}

/** Interactive Consent card: Allow once / Deny while run waits for owner permission. */
export function ConsentCard({
  part,
  conversationId,
  messageId,
  onMessageUpdated,
}: {
  part: ConsentPart;
  conversationId: string;
  messageId: string;
  onMessageUpdated: (updated: Message) => void;
}) {
  const api = useApi();
  const toast = useToast();

  const decide = useMutation({
    mutationFn: (allow: boolean) =>
      api.conversations.messages.consent(conversationId, messageId, {
        consentId: part.consentId,
        allow,
      }),
    onSuccess: (res, allow) => {
      onMessageUpdated(res.message);
      toast.success(allow ? "İşleme izin verildi" : "İşlem reddedildi");
    },
    onError: (e) => toast.error(e, "Onay yanıtı gönderilemedi"),
  });

  const stateBadge = {
    pending: { label: "Onay bekliyor", tone: "warn" as const },
    allowed: { label: "İzin verildi", tone: "good" as const },
    denied: { label: "Reddedildi", tone: "bad" as const },
    expired: { label: "Süresi doldu", tone: "neutral" as const },
  }[part.state];

  return (
    <Card className="my-1 border border-line-strong bg-surface-2/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <IconShield size={18} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{part.title}</span>
          <Tag>
            <Mono>{part.tool}</Mono>
          </Tag>
        </div>
        <Badge tone={stateBadge.tone}>{stateBadge.label}</Badge>
      </div>
      {part.detail && <p className="mt-2 text-sm whitespace-pre-wrap text-ink-2">{part.detail}</p>}
      {part.state === "pending" && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="danger"
            loading={decide.isPending && decide.variables === false}
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            Reddet
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<IconCheck size={15} />}
            loading={decide.isPending && decide.variables === true}
            disabled={decide.isPending}
            onClick={() => decide.mutate(true)}
          >
            Bir kez izin ver
          </Button>
        </div>
      )}
      <InlineError error={decide.error} />
    </Card>
  );
}

/** Interactive Question card for single, multiple, or free-text agent questions. */
export function QuestionCard({
  part,
  conversationId,
  messageId,
  onMessageUpdated,
}: {
  part: QuestionPart;
  conversationId: string;
  messageId: string;
  onMessageUpdated: (updated: Message) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");

  const answerMutation = useMutation({
    mutationFn: () =>
      api.conversations.messages.answer(conversationId, messageId, {
        questionId: part.questionId,
        optionIds: selectedIds,
        ...(freeText.trim() ? { text: freeText.trim() } : {}),
      }),
    onSuccess: (res) => {
      onMessageUpdated(res.message);
      toast.success("Yanıt gönderildi");
    },
    onError: (e) => toast.error(e, "Yanıt gönderilemedi"),
  });

  if (part.answer) {
    const chosenLabels = part.answer.optionIds.map(
      (id) => part.options.find((o) => o.id === id)?.label ?? id,
    );
    return (
      <Card className="my-1 bg-surface-2/60 p-4">
        <p className="text-sm font-medium text-ink">{part.prompt}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chosenLabels.map((lbl) => (
            <Badge key={lbl} tone="good">
              {lbl}
            </Badge>
          ))}
          {part.answer.text && <span className="text-sm text-ink-2">“{part.answer.text}”</span>}
        </div>
      </Card>
    );
  }

  const toggleOption = (id: string) => {
    if (part.mode === "single") {
      setSelectedIds([id]);
    } else {
      setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    }
  };

  const validationError = checkQuestionAnswer(part, {
    optionIds: selectedIds,
    text: freeText,
  });

  return (
    <Card className="my-1 border border-line-strong bg-surface p-4">
      <p className="text-sm font-semibold text-ink">{part.prompt}</p>
      {part.mode !== "text" && (
        <div className="mt-3 flex flex-col gap-2">
          {part.options.map((opt) => {
            const checked = selectedIds.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={checked}
                onClick={() => toggleOption(opt.id)}
                className={cx(
                  "flex flex-col items-start rounded-xl px-3.5 py-2.5 text-left ring-1 ring-inset transition-colors",
                  checked
                    ? "bg-ink text-bg ring-ink"
                    : "bg-surface-2 text-ink ring-line hover:ring-line-strong",
                )}
              >
                <span className="text-sm font-medium">{opt.label}</span>
                {opt.description && (
                  <span className={cx("text-xs", checked ? "opacity-80" : "text-ink-2")}>
                    {opt.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {(part.mode === "text" || part.allowText) && (
        <div className="mt-3">
          <Input
            aria-label="Serbest yanıt"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder={part.mode === "text" ? "Yanıtınızı yazın…" : "Başka bir şey ekleyin…"}
          />
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="primary"
          disabled={validationError !== null}
          loading={answerMutation.isPending}
          onClick={() => answerMutation.mutate()}
        >
          Yanıtla
        </Button>
      </div>
      <InlineError error={answerMutation.error} />
    </Card>
  );
}
