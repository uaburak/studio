// The chat's approval card (`approval_request` part, docs/URETIM-RESIM.md §12): the candidate
// pictures large (a click opens the viewer; with several, the round mark picks the one to
// use), the AI check's report (each aspect with ✓ / ✕ and its note), the state, and Onayla /
// Reddet / Yeniden üret. "Yeniden üret" asks first (it is paid): an optional instruction and,
// as a separate choice, "Etiketi birebir koruyarak yerleştir". Decided cards say what happened;
// a regenerated one links to the card that replaced it. `approval.updated` keeps it live.
import type { ApprovalRequest } from "@studio/contract";
import { useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconExpand,
  IconRetry,
  IconWarning,
} from "../../components/ui/icons.tsx";
import { Card } from "../../components/ui/popover.tsx";
import { useImageZoom } from "../../components/ui/zoomable-image.tsx";
import { assetUrl } from "../../lib/api.ts";
import type { ChatImage } from "../../lib/transcript.ts";
import { useJobList } from "../../state/studio.tsx";
import { useContent } from "../posts/data.ts";
import { openPostDetail } from "../posts/store.ts";
import {
  goToApproval,
  useApproval,
  useApprovalActions,
  useConversationApprovals,
} from "./approvals-data.ts";
import {
  APPROVAL_KIND_LABEL,
  APPROVAL_STATUS,
  chosenAsset,
  outcomeText,
  successorOf,
} from "./approvals-model.ts";

export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const query = useApproval(approvalId);
  if (!query.data) {
    const gone = (query.error as { status?: unknown } | null)?.status === 404;
    return (
      <Card className="my-3.5 flex h-11 items-center gap-2 px-3.5 text-body text-fg-2">
        {query.isError ? (
          <>
            <IconWarning size={14} className="text-fg-3" />
            {gone ? "Onay kaydı bulunamadı" : "Onay kaydı şu an yüklenemedi"}
          </>
        ) : (
          <>
            <Spinner size={13} /> Onay kaydı yükleniyor…
          </>
        )}
      </Card>
    );
  }
  return <ApprovalCardBody approval={query.data} />;
}

export function ApprovalCardBody({ approval }: { approval: ApprovalRequest }) {
  const [picked, setPicked] = useState<string | null>(null);
  const pending = approval.status === "pending";
  const status = APPROVAL_STATUS[approval.status];
  const chosen = pending ? chosenAsset(approval, picked) : approval.approvedAssetId;
  const multiple = approval.assetIds.length > 1;
  return (
    <Card
      className={cn(
        "my-3.5 flex flex-col gap-3 p-3.5",
        pending &&
          "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-default)_35%,transparent)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-heading font-semibold text-fg">
          {APPROVAL_KIND_LABEL[approval.kind]}
        </span>
        <TagPill tone={status.tone}>{status.label}</TagPill>
        <PostLink contentId={approval.contentId} />
      </div>
      <Candidates
        approval={approval}
        chosen={chosen}
        onPick={pending && multiple ? setPicked : null}
      />
      <CheckReport approval={approval} />
      {pending ? (
        <ApprovalActions approval={approval} assetId={chosen} layout="card" />
      ) : (
        <Outcome approval={approval} />
      )}
    </Card>
  );
}

/** "· Hasat Bayramı ›" after the title: opens the post the picture is for. */
function PostLink({ contentId }: { contentId: string | null }) {
  const content = useContent(contentId);
  if (!contentId || !content.data) return null;
  return (
    <button
      type="button"
      onClick={() => openPostDetail(contentId)}
      className="group ml-auto flex min-w-0 items-center gap-1 text-footnote text-fg-2 hover:text-fg"
    >
      <span className="min-w-0 truncate group-hover:underline">{content.data.title}</span>
      <IconChevronRight size={11} strokeWidth={1.75} className="shrink-0" />
    </button>
  );
}

function Candidates({
  approval,
  chosen,
  onPick,
}: {
  approval: ApprovalRequest;
  chosen: string | null;
  /** Picking is possible (several candidates, still pending). */
  onPick: ((assetId: string) => void) | null;
}) {
  const multiple = approval.assetIds.length > 1;
  const images: ChatImage[] = approval.assetIds.map((assetId, index) => ({
    assetId,
    caption: multiple ? `Seçenek ${index + 1}` : APPROVAL_KIND_LABEL[approval.kind],
  }));
  const zoom = useImageZoom(images);
  return (
    <div className={cn("grid gap-2", multiple ? "grid-cols-2" : "grid-cols-1")}>
      {images.map((image, index) => {
        const isChosen = multiple && chosen === image.assetId;
        const decidedOther = approval.status === "approved" && multiple && chosen !== image.assetId;
        return (
          <div
            key={image.assetId}
            className={cn(
              "group relative overflow-hidden rounded-[10px] bg-control",
              multiple ? "w-full" : "w-[min(100%,380px)]",
              decidedOther && "opacity-45",
            )}
            style={{ aspectRatio: "4 / 5" }}
          >
            <button
              type="button"
              aria-label={`Görseli aç: ${image.caption}`}
              onClick={() => zoom.open(index)}
              className="absolute inset-0"
            >
              <img
                ref={zoom.ref(index)}
                src={assetUrl(image.assetId)}
                alt=""
                draggable={false}
                loading="lazy"
                className="size-full object-contain"
              />
              <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/15" />
              <span className="pointer-events-none absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <IconExpand size={12} strokeWidth={2} />
              </span>
            </button>
            {isChosen && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[10px] shadow-[inset_0_0_0_3px_var(--accent-default)]"
              />
            )}
            {multiple && (
              // biome-ignore lint/a11y/useSemanticElements: a badge on the picture that picks it, read as a radio
              <button
                type="button"
                role="radio"
                aria-checked={isChosen}
                aria-label={`${image.caption} seç`}
                disabled={!onPick}
                onClick={() => onPick?.(image.assetId)}
                className={cn(
                  "absolute top-2 left-2 flex h-6 items-center gap-1 rounded-full px-2 text-caption font-semibold",
                  isChosen ? "bg-accent text-on-accent" : "bg-black/55 text-white",
                  onPick ? "hover:bg-accent-hover hover:text-on-accent" : "cursor-default",
                )}
              >
                {isChosen && <IconCheck size={11} strokeWidth={2.5} />}
                {index + 1}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CheckReport({ approval }: { approval: ApprovalRequest }) {
  const report = approval.checkReport;
  if (!report) {
    return <p className="text-footnote text-fg-3">Yapay zekâ kontrolü çalışmadı.</p>;
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2 text-body">
        <span
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full text-white",
            report.passed ? "bg-success" : "bg-danger",
          )}
        >
          {report.passed ? (
            <IconCheck size={10} strokeWidth={3} />
          ) : (
            <IconClose size={10} strokeWidth={3} />
          )}
        </span>
        <span className="selectable min-w-0 flex-1 text-fg">
          <span className="font-medium">
            {report.passed ? "Kontrol geçti" : "Kontrolde sorun var"}
          </span>
          {report.summary && <span className="text-fg-2"> · {report.summary}</span>}
        </span>
      </div>
      {report.items.length > 0 && (
        <ul aria-label="Kontrol raporu" className="flex flex-col gap-1 pl-6">
          {report.items.map((item, index) => (
            <li key={`${index}-${item.aspect}`} className="flex items-start gap-2 text-footnote">
              {item.ok ? (
                <IconCheck size={12} strokeWidth={2.25} className="mt-0.5 shrink-0 text-success" />
              ) : (
                <IconClose size={12} strokeWidth={2.25} className="mt-0.5 shrink-0 text-danger" />
              )}
              <span className="selectable min-w-0 flex-1">
                <span className={item.ok ? "text-fg-2" : "font-medium text-fg"}>{item.aspect}</span>
                {item.note && <span className="text-fg-2"> — {item.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What happened to a decided request; a regenerated one links to its successor. */
function Outcome({ approval }: { approval: ApprovalRequest }) {
  const superseded = approval.status === "superseded";
  const others = useConversationApprovals(approval.conversationId, superseded);
  const jobs = useJobList();
  const successor = successorOf(approval, others.data ?? []);
  const job = approval.regenerateJobId
    ? jobs.find((j) => j.id === approval.regenerateJobId)
    : undefined;
  const making =
    superseded && !successor && (job?.status === "queued" || job?.status === "running");
  const failed =
    superseded && !successor && (job?.status === "failed" || job?.status === "cancelled");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg-2">
      <span className="selectable">{outcomeText(approval)}</span>
      {making && (
        <span className="flex items-center gap-1.5 text-fg-3">
          <Spinner size={11} /> Yeni görsel üretiliyor…
        </span>
      )}
      {failed && <span className="text-danger">Yeniden üretim başarısız oldu.</span>}
      {successor && (
        <button
          type="button"
          onClick={() => goToApproval(successor)}
          className="flex items-center gap-1 font-medium text-accent-text hover:underline"
        >
          Yeni karta git
          <IconChevronRight size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/**
 * Onayla / Reddet / Yeniden üret. `card`: full-size buttons, the regenerate choices open under
 * them; `row`: small buttons for the details panel's list.
 */
export function ApprovalActions({
  approval,
  assetId,
  layout,
  chooseInChat = false,
}: {
  approval: ApprovalRequest;
  /** The candidate "Onayla" uses. */
  assetId: string | null;
  layout: "card" | "row";
  /** Several candidates outside the card: "Seç ve onayla" opens the card to pick one. */
  chooseInChat?: boolean;
}) {
  const actions = useApprovalActions(approval);
  const [regenerating, setRegenerating] = useState(false);
  const size = layout === "row" ? "sm" : "md";
  const multiple = approval.assetIds.length > 1;
  const regenerateReason = approval.canRegenerate
    ? null
    : "Bu görselin üretim isteği bilinmiyor; yeniden üretilemez.";
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="primary"
          size={size}
          disabled={actions.busy !== null}
          onClick={() => (chooseInChat ? goToApproval(approval) : void actions.approve(assetId))}
        >
          {actions.busy === "approve" ? (
            <Spinner size={11} />
          ) : (
            <IconCheck size={13} strokeWidth={2.25} />
          )}
          {chooseInChat
            ? "Seç ve onayla"
            : multiple && layout === "card" && assetId
              ? `${approval.assetIds.indexOf(assetId) + 1}. seçeneği onayla`
              : "Onayla"}
        </Button>
        <Button
          variant="secondary"
          size={size}
          disabled={actions.busy !== null}
          onClick={() => void actions.reject()}
        >
          {actions.busy === "reject" && <Spinner size={11} />}
          Reddet
        </Button>
        <span title={regenerateReason ?? undefined} className="inline-flex">
          <Button
            variant="secondary"
            size={size}
            aria-expanded={regenerating}
            disabled={actions.busy !== null || regenerateReason !== null}
            onClick={() => setRegenerating((open) => !open)}
          >
            <IconRetry size={12} strokeWidth={1.75} />
            Yeniden üret
          </Button>
        </span>
      </div>
      {regenerating && (
        <RegenerateForm
          busy={actions.busy === "regenerate"}
          compact={layout === "row"}
          onCancel={() => setRegenerating(false)}
          onSubmit={async (input) => {
            if (await actions.regenerate(input)) setRegenerating(false);
          }}
        />
      )}
    </div>
  );
}

/** The owner's consent to a new (paid) round, with its two optional choices. */
export function RegenerateForm({
  busy,
  compact = false,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  compact?: boolean;
  onSubmit(input: { preserveLabelComposite: boolean; instructions?: string }): void;
  onCancel(): void;
}) {
  const [preserve, setPreserve] = useState(false);
  const [instructions, setInstructions] = useState("");
  const submit = () =>
    onSubmit({
      preserveLabelComposite: preserve,
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    });
  return (
    <form
      aria-label="Yeniden üret"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="flex flex-col gap-2.5 rounded-[10px] bg-control/60 p-3"
    >
      <TextField
        aria-label="Ek talimat"
        placeholder="Ek talimat (isteğe bağlı): daha sıcak ışık, ahşap masa…"
        value={instructions}
        maxLength={2000}
        onChange={(event) => setInstructions(event.target.value)}
        className="w-full"
      />
      <Checkbox checked={preserve} onChange={setPreserve}>
        Etiketi birebir koruyarak yerleştir
      </Checkbox>
      {!compact && (
        <p className="-mt-1 pl-6 text-footnote text-fg-3">
          Ürünün gerçek fotoğrafı kesilip yeni sahneye yerleştirilir; etiket yeniden çizilmez.
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button type="submit" variant="primary" size={compact ? "sm" : "md"} disabled={busy}>
          {busy && <Spinner size={11} />}
          Yeniden üret
        </Button>
        <Button variant="ghost" size={compact ? "sm" : "md"} disabled={busy} onClick={onCancel}>
          Vazgeç
        </Button>
        <span className="ml-auto text-footnote text-fg-3">Yeni üretim ücretlidir.</span>
      </div>
    </form>
  );
}
