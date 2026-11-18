// Live parts of an assistant reply: step lines, the working line, the plan (progress) card,
// plan proposals, consent and question cards, errors and notices.
import type {
  ConsentPart,
  ErrorPart,
  Message,
  Plan,
  ProgressPart,
  QuestionPart,
  ToolStepPart,
} from "@studio/contract";
import { useEffect, useState } from "react";
import { CONTENT_TYPE_LABEL } from "../../features/posts/board.ts";
import { EstimateDialog, needsEstimate } from "../../features/posts/estimate.tsx";
import { imageSlotsOf } from "../../features/posts/plan-model.ts";
import { openPlanPage } from "../../features/posts/store.ts";
import { formatDuration, shortDate } from "../../lib/format.ts";
import { type StepGroup, type WorkingItem, workingLabel } from "../../lib/transcript.ts";
import type { ConversationController } from "../../state/conversation.ts";

/** What the cards need from a conversation (the gallery passes a stub). */
export type CardActions = Pick<
  ConversationController,
  "acceptAndGenerate" | "generatePlan" | "rejectPlan" | "decideConsent" | "answer"
>;

import { Button, cn, Spinner, TagPill, TextField, WorkingDots } from "../ui/controls.tsx";
import {
  IconCheck,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleEllipsis,
  IconCircleX,
  PlatformIcon,
} from "../ui/icons.tsx";
import { StepThumbnails } from "./images.tsx";

/** A ticking clock for elapsed labels (one timer per mounted line). */
export function useNow(intervalMs = 1_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/** "2 görsel üretti, 1 post oluşturdu ›" — click expands the steps. */
export function StepLine({ group, onToggle }: { group: StepGroup; onToggle(): void }) {
  return (
    <div className="my-3.5">
      <div className="flex w-full items-center">
        <button
          type="button"
          aria-expanded={group.isExpanded}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-1.5 text-left text-body-lg text-fg-2 hover:text-fg"
        >
          <span className="truncate">{group.summary}</span>
          <IconChevronRight
            size={14}
            strokeWidth={1.75}
            className={cn(
              "shrink-0 transition-transform duration-200 ease-snap",
              group.isExpanded && "rotate-90",
            )}
          />
        </button>
        <StepThumbnails images={group.thumbnails} />
      </div>
      {group.isExpanded && (
        <ul className="mt-2 flex animate-fade-in flex-col gap-1.5 border-l border-hairline pl-3.5">
          {group.steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StepRow({ step }: { step: ToolStepPart }) {
  return (
    <li className="flex items-start gap-2 text-body text-fg-2">
      <span className="mt-[2px] flex size-3.5 shrink-0 items-center justify-center">
        {step.state === "running" ? (
          <Spinner size={12} />
        ) : step.state === "error" ? (
          <IconCircleX size={13} className="text-danger" />
        ) : (
          <IconCheck size={13} strokeWidth={2} />
        )}
      </span>
      <span className="min-w-0">
        <span className={step.state === "error" ? "text-danger" : "text-fg"}>{step.label}</span>
        {step.summary && <span className="block text-footnote text-fg-3">{step.summary}</span>}
      </span>
    </li>
  );
}

/** The line at the bottom while the agent works: orange dots, label, elapsed time, "›". */
export function WorkingLine({
  working,
  onOpenGroup,
  onCancel,
}: {
  working: WorkingItem;
  onOpenGroup?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}) {
  const now = useNow(1_000, working.since !== null);
  const step = working.phase.kind === "step";
  const queued = working.phase.kind === "queued";
  return (
    <div className="my-3.5 flex items-center gap-2 text-body-lg" aria-live="polite">
      <WorkingDots animated={!queued} />
      <span className={cn("truncate", step ? "text-fg" : "text-fg-2")}>
        {workingLabel(working.phase)}
      </span>
      {working.since !== null && (
        <span className="shrink-0 text-fg-2 tabular-nums">
          {formatDuration(now - working.since)}
        </span>
      )}
      {working.groupKey && onOpenGroup && (
        <button
          type="button"
          aria-label="Adımları göster"
          onClick={onOpenGroup}
          className="text-fg-2 hover:text-fg"
        >
          <IconChevronRight size={14} strokeWidth={1.75} />
        </button>
      )}
      {working.cancellable && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="ml-1 text-body text-fg-2 underline-offset-2 hover:text-fg hover:underline"
        >
          Vazgeç
        </button>
      )}
    </div>
  );
}

function ProgressIcon({ state }: { state: ProgressPart["state"] }) {
  switch (state) {
    case "done":
      return <IconCircleCheck size={14} strokeWidth={1.75} className="text-fg-2" />;
    case "running":
      return <IconCircleEllipsis size={14} strokeWidth={1.75} className="text-fg" />;
    case "failed":
      return <IconCircleX size={14} strokeWidth={1.75} className="text-danger" />;
    default:
      return <IconCircleDashed size={14} strokeWidth={1.75} className="text-fg-2" />;
  }
}

/** Wecra "Plan" card: the agent's progress steps with circle states. */
export function ProgressCard({ steps }: { steps: ProgressPart[] }) {
  return (
    <div className="my-3.5 rounded-[12px] border border-hairline px-4 pt-2.5 pb-2">
      <div className="mb-1 text-footnote text-fg-2">Plan</div>
      <ul className="flex flex-col">
        {steps.map((step) => (
          <li key={step.stepId} className="flex min-h-7 items-center gap-2.5 text-body-lg">
            <ProgressIcon state={step.state} />
            <span
              className={cn(
                step.state === "done"
                  ? "text-fg-2"
                  : step.state === "skipped"
                    ? "text-fg-3 line-through"
                    : "text-fg",
                step.state === "failed" && "text-danger",
              )}
            >
              {step.label}
              {step.current !== null && step.total !== null && ` · ${step.current}/${step.total}`}
            </span>
            {step.detail && <span className="truncate text-footnote text-fg-3">{step.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PLAN_STATUS: Record<
  Plan["status"],
  { label: string; tone: "neutral" | "accent" | "success" | "danger" }
> = {
  draft: { label: "Taslak", tone: "neutral" },
  proposed: { label: "Onay bekliyor", tone: "accent" },
  accepted: { label: "Onaylandı", tone: "success" },
  rejected: { label: "Reddedildi", tone: "danger" },
  superseded: { label: "Yenisi var", tone: "neutral" },
};

/** A content plan the agent proposed: items, then "Onayla ve üret" / "Reddet". */
/**
 * An accepted plan whose accepted items never got a generation request (the generate step
 * failed after the accept, or the app closed in between).
 */
export function generationNotStarted(plan: Plan): boolean {
  const items = plan.items.filter((i) => i.status === "accepted");
  return plan.status === "accepted" && items.length > 0 && items.every((i) => !i.generation);
}

export function PlanProposalCard({
  plan,
  busy,
  controller,
  onEdit,
  generateError = null,
}: {
  plan: Plan | null;
  busy: boolean;
  controller: CardActions;
  onEdit(): void;
  /** The generation could not be started (accept succeeded): the reason. */
  generateError?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  // More than a few posts: the time and cost first (N4), then the generation.
  const [estimating, setEstimating] = useState(false);
  if (!plan) {
    return (
      <div className="my-3.5 rounded-[12px] border border-hairline px-4 py-3 text-body text-fg-2">
        Plan yükleniyor…
      </div>
    );
  }
  const items = plan.items.filter((i) => i.status !== "skipped");
  const shown = expanded ? items : items.slice(0, 6);
  const status = PLAN_STATUS[plan.status];
  const open = plan.status === "draft" || plan.status === "proposed";
  return (
    <div className="my-3.5 rounded-[12px] border border-hairline">
      <div className="flex items-start gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-heading font-semibold text-fg">{plan.title || "İçerik planı"}</div>
          <div className="text-footnote text-fg-2">
            {shortDate(plan.periodStart)} – {shortDate(plan.periodEnd)} · {items.length} post
          </div>
        </div>
        <TagPill tone={status.tone}>{status.label}</TagPill>
      </div>
      <ul className="border-t border-hairline">
        {shown.map((item) => (
          <li
            key={item.id}
            className="flex h-[34px] items-center gap-3 border-b border-hairline px-4 text-body last:border-b-0"
          >
            <span className="w-14 shrink-0 text-fg-2">
              {item.date ? shortDate(item.date) : "—"}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-icon">
              {item.platforms.map((p) => (
                <PlatformIcon key={p} platform={p} size={14} />
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
            <span className="shrink-0 text-footnote text-fg-3">
              {CONTENT_TYPE_LABEL[item.contentType]}
            </span>
          </li>
        ))}
      </ul>
      {items.length > 6 && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="w-full px-4 py-2 text-left text-footnote text-fg-2 hover:text-fg"
        >
          {expanded ? "Daha az göster" : `Tümünü göster (${items.length})`}
        </button>
      )}
      {(open || plan.status === "accepted") && (
        <div className="flex items-center gap-2 border-t border-hairline px-3 py-2.5">
          {open ? (
            <>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  needsEstimate(items.length)
                    ? setEstimating(true)
                    : void controller.acceptAndGenerate(plan)
                }
              >
                {busy ? "Gönderiliyor…" : "Onayla ve üret"}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  // The plan opens on the posts screen's Planlar view, item by item (N2).
                  onEdit();
                  openPlanPage(plan.id, plan.brandId);
                }}
              >
                Düzenle
              </Button>
              <div className="flex-1" />
              <Button
                variant="ghost"
                disabled={busy}
                className="text-fg-2"
                onClick={() => void controller.rejectPlan(plan)}
              >
                Reddet
              </Button>
            </>
          ) : generateError || (!busy && generationNotStarted(plan)) ? (
            <>
              <span className="min-w-0 flex-1 px-1 text-footnote text-danger" role="alert">
                {generateError
                  ? `Plan onaylandı ama üretim başlatılamadı: ${generateError}`
                  : "Plan onaylandı ama üretim başlamadı."}
              </span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void controller.generatePlan(plan)}
              >
                {busy ? "Gönderiliyor…" : "Yeniden dene"}
              </Button>
            </>
          ) : busy ? (
            <span className="px-1 text-footnote text-fg-2">Üretime gönderiliyor…</span>
          ) : (
            <span className="px-1 text-footnote text-fg-2">
              Postlar üretime alındı; ilerleme Arka plan işleri’nde.
            </span>
          )}
        </div>
      )}
      {/* Mounted only when asked: the card also renders without the API (tests, previews). */}
      {estimating && (
        <EstimateDialog
          query={{ count: items.length, brandId: plan.brandId, imageSlots: imageSlotsOf(items) }}
          title="Üretim başlasın mı?"
          what={`${items.length} post üretilecek.`}
          confirmLabel="Onayla ve üret"
          onClose={() => setEstimating(false)}
          onConfirm={async () => {
            setEstimating(false);
            await controller.acceptAndGenerate(plan);
          }}
        />
      )}
    </div>
  );
}

/** "May I do this?" — Allow once / Deny. */
export function ConsentCard({
  message,
  consent,
  busy,
  controller,
}: {
  message: Message;
  consent: ConsentPart;
  busy: boolean;
  controller: CardActions;
}) {
  const decided = consent.state !== "pending";
  const result = {
    pending: null,
    allowed: { label: "İzin verildi", tone: "success" as const },
    denied: { label: "Reddedildi", tone: "danger" as const },
    expired: { label: "Süresi doldu", tone: "neutral" as const },
  }[consent.state];
  return (
    <div
      className={cn(
        "my-3.5 rounded-[12px] border px-4 py-3",
        decided ? "border-hairline" : "border-accent/40 bg-accent-subtle/40",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-heading font-semibold text-fg">{consent.title}</div>
          {consent.detail && (
            <div className="selectable mt-0.5 text-body whitespace-pre-wrap text-fg-2">
              {consent.detail}
            </div>
          )}
        </div>
        {result && <TagPill tone={result.tone}>{result.label}</TagPill>}
      </div>
      {!decided && (
        <div className="mt-3 flex gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void controller.decideConsent(message, consent, true)}
          >
            Bir kez izin ver
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void controller.decideConsent(message, consent, false)}
          >
            Reddet
          </Button>
        </div>
      )}
    </div>
  );
}

/** A question of the agent: options (single / multiple) and / or free text. */
export function QuestionCard({
  message,
  question,
  busy,
  controller,
}: {
  message: Message;
  question: QuestionPart;
  busy: boolean;
  controller: CardActions;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const answered = question.answer !== null;
  const toggle = (id: string) =>
    setSelected((list) =>
      question.mode === "single"
        ? [id]
        : list.includes(id)
          ? list.filter((x) => x !== id)
          : [...list, id],
    );
  return (
    <div className="my-3.5 rounded-[12px] border border-hairline px-4 py-3">
      <div className="text-body-lg text-fg">{question.prompt}</div>
      {question.options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {question.options.map((option) => {
            const chosen = answered
              ? question.answer?.optionIds.includes(option.id)
              : selected.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                disabled={answered || busy}
                title={option.description ?? undefined}
                onClick={() => toggle(option.id)}
                className={cn(
                  "h-7 rounded-full px-3 text-body transition-colors",
                  chosen ? "bg-accent text-on-accent" : "bg-control text-fg hover:bg-control-hover",
                  answered && !chosen && "opacity-50",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      )}
      {answered ? (
        question.answer?.text && (
          <div className="mt-2 text-body text-fg-2">“{question.answer.text}”</div>
        )
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          {(question.mode === "text" || question.allowText) && (
            <TextField
              className="flex-1"
              placeholder={question.mode === "text" ? "Yanıtın" : "Başka bir şey…"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Once: not again while the answer is on its way, nor while an IME composes.
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (busy || (selected.length === 0 && !text.trim())) return;
                void controller.answer(message, question, selected, text);
              }}
            />
          )}
          <Button
            variant="primary"
            disabled={busy || (selected.length === 0 && !text.trim())}
            onClick={() => void controller.answer(message, question, selected, text)}
          >
            Yanıtla
          </Button>
        </div>
      )}
    </div>
  );
}

/** The agent's error; on the last reply "Yeniden dene" sends the last user message again. */
export function ErrorBlock({
  error,
  onRetry,
}: {
  error: ErrorPart;
  onRetry?: (() => Promise<unknown>) | undefined;
}) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="my-3.5 flex items-start gap-2 rounded-[12px] border border-danger/30 bg-danger/5 px-4 py-2.5 text-body text-fg">
      <IconCircleX size={15} className="mt-[1px] shrink-0 text-danger" />
      <span className="selectable min-w-0 flex-1">{error.message}</span>
      {onRetry && (
        <Button
          size="sm"
          variant="secondary"
          disabled={retrying}
          className="-my-0.5 shrink-0"
          onClick={() => {
            setRetrying(true);
            void onRetry().finally(() => setRetrying(false));
          }}
        >
          {retrying ? "Gönderiliyor…" : "Yeniden dene"}
        </Button>
      )}
    </div>
  );
}

export function NoticeLine({ text }: { text: string }) {
  return <div className="my-3 text-body text-fg-3">{text}</div>;
}

/** Small secondary system line ("Zamanlanmış post yayınlandı · Instagram"). */
export function EventLine({ text }: { text: string }) {
  return <div className="my-3.5 text-body text-fg-2">{text}</div>;
}
