// "Onay bekleyenler" in the details panel (docs/URETIM-RESIM.md §12): the brand's pending
// approval requests, newest first — the picture, what it is, the post / product it is for, the
// check's short line and Onayla / Reddet / Yeniden üret. A click on a row opens the chat message
// that shows the request (scrolled to and highlighted).
import type { ApprovalRequest } from "@studio/contract";
import { cn, Spinner, TagPill } from "../../components/ui/controls.tsx";
import { IconChevronRight } from "../../components/ui/icons.tsx";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { useBrandProducts } from "../brand/products-data.ts";
import { useContent } from "../posts/data.ts";
import { ApprovalActions } from "./approval-card.tsx";
import { goToApproval, useContentApprovals, usePendingApprovals } from "./approvals-data.ts";
import { APPROVAL_KIND_LABEL, badgeText, checkSummaryLine, checkTone } from "./approvals-model.ts";

/** The brand's pending count (the panel tool's badge); 0 while unknown. */
export function usePendingApprovalCount(brandId: string | null): number {
  return usePendingApprovals(brandId).data?.length ?? 0;
}

/** A small accent count ("3"), like the sidebar's unread comments; nothing at 0. */
export function CountBadge({
  count,
  label,
  className,
}: {
  count: number;
  /** Read after the number: "3 onay bekliyor". */
  label: string;
  className?: string;
}) {
  const text = badgeText(count);
  if (!text) return null;
  return (
    <span
      role="status"
      aria-label={`${count} ${label}`}
      className={cn(
        "flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-on-accent tabular-nums",
        className,
      )}
    >
      {text}
    </span>
  );
}

export function PendingApprovals({ brandId }: { brandId: string }) {
  const query = usePendingApprovals(brandId);
  if (query.isLoading) {
    return (
      <p className="flex items-center gap-2 text-footnote text-fg-3">
        <Spinner size={11} /> Yükleniyor…
      </p>
    );
  }
  if (query.isError) {
    return <p className="text-footnote text-danger">Onay bekleyenler yüklenemedi.</p>;
  }
  const list = query.data ?? [];
  if (list.length === 0) {
    return <p className="text-footnote text-fg-3">Onay bekleyen görsel yok.</p>;
  }
  return (
    <ul aria-label="Onay bekleyenler" className="flex flex-col gap-2">
      {list.map((approval) => (
        <PendingRow key={approval.id} approval={approval} brandId={brandId} />
      ))}
    </ul>
  );
}

function PendingRow({ approval, brandId }: { approval: ApprovalRequest; brandId: string }) {
  const content = useContent(approval.contentId);
  const products = useBrandProducts(approval.productId ? brandId : null);
  const product = approval.productId
    ? (products.data ?? []).find((p) => p.id === approval.productId)
    : undefined;
  const subject = content.data?.title ?? product?.name ?? null;
  const cover = approval.assetIds[0];
  const tone = checkTone(approval.checkReport);
  const many = approval.assetIds.length;
  return (
    <li className="rounded-[10px] bg-control px-2.5 py-2">
      <button
        type="button"
        onClick={() => goToApproval(approval)}
        aria-label={`Onay kaydını aç: ${APPROVAL_KIND_LABEL[approval.kind]}${subject ? `, ${subject}` : ""}`}
        className="group flex w-full items-start gap-2.5 text-left"
      >
        <span className="relative h-[55px] w-11 shrink-0 overflow-hidden rounded-[6px] bg-field">
          {cover && (
            <img
              src={thumbUrl(cover, 44)}
              alt=""
              draggable={false}
              loading="lazy"
              className="size-full object-cover"
            />
          )}
          {many > 1 && (
            <span className="absolute right-0.5 bottom-0.5 rounded-full bg-black/60 px-1 text-[10px] leading-[14px] font-semibold text-white">
              {many}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body-lg text-fg group-hover:underline">
            {subject ?? APPROVAL_KIND_LABEL[approval.kind]}
          </span>
          <span className="truncate text-footnote text-fg-2">
            {APPROVAL_KIND_LABEL[approval.kind]}
            {many > 1 ? ` · ${many} seçenek` : ""}
          </span>
          <span
            title={approval.checkReport?.summary || undefined}
            className={cn(
              "truncate text-footnote",
              tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-fg-3",
            )}
          >
            {checkSummaryLine(approval.checkReport)}
          </span>
        </span>
      </button>
      <div className="mt-2">
        {many > 1 ? (
          // Several candidates: the choice is made on the chat card, where they are large.
          <MultiCandidateActions approval={approval} />
        ) : (
          <ApprovalActions approval={approval} assetId={cover ?? null} layout="row" />
        )}
      </div>
    </li>
  );
}

/**
 * The post detail's "Onay bekliyor" (next to its status) with "Onaya git": the newest pending
 * request's chat message. Nothing while the post has none.
 */
export function PostApprovalTag({ contentId, count }: { contentId: string; count: number }) {
  const approvals = useContentApprovals(contentId, count > 0);
  if (count <= 0) return null;
  const first = approvals.data?.[0];
  return (
    <span className="inline-flex items-center gap-1">
      <TagPill tone="warning">{count > 1 ? `${count} onay bekliyor` : "Onay bekliyor"}</TagPill>
      {first && (
        <button
          type="button"
          onClick={() => goToApproval(first)}
          className="no-drag flex h-[18px] items-center gap-0.5 rounded-full px-1 text-caption font-medium text-accent-text hover:underline"
        >
          Onaya git
          <IconChevronRight size={10} strokeWidth={2} />
        </button>
      )}
    </span>
  );
}

function MultiCandidateActions({ approval }: { approval: ApprovalRequest }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-footnote text-fg-3">Hangisinin kullanılacağını sohbetteki kartta seç.</p>
      <ApprovalActions approval={approval} assetId={null} layout="row" chooseInChat />
    </div>
  );
}
