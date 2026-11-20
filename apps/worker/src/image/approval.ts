/**
 * A generated picture asks for the owner's word (docs/URETIM-RESIM.md §11–13): every picture
 * (every variant) becomes its own approval request with the AI check's report and the original
 * request (so "Yeniden üret" can run it again), and — when it came from a chat — a message with
 * the card in that chat. The worker never generates again on its own, whatever the check says.
 */
import type {
  ApprovalCheckReport,
  ApprovalCreate,
  ApprovalTarget,
  ImageGeneratePayload,
} from "@studio/contract";

export interface ApprovalMessageInput {
  kind: ApprovalTarget["kind"];
  report: ApprovalCheckReport | null;
  variant?: { index: number; count: number } | undefined;
  /** The picture replaces one the owner asked to generate again. */
  regenerated: boolean;
  /** The label was composited from the real photo (`preserveProductLabel`). */
  composite: boolean;
}

/** The chat message that carries the card ("Görsel geldi; kontrol: … Onaylıyor musun?"). */
export function approvalMessageText(input: ApprovalMessageInput): string {
  const which =
    input.variant && input.variant.count > 1
      ? ` (${input.variant.index}/${input.variant.count})`
      : "";
  const head =
    input.kind === "product_photo_upgrade"
      ? `Ürün fotoğrafının iyileştirilmiş hali geldi${which}`
      : input.regenerated
        ? `Yeniden üretilen görsel geldi${which}`
        : `Görsel geldi${which}`;
  const check = !input.report
    ? "kontrol yapılamadı, ürünü elle karşılaştır"
    : input.report.passed
      ? "kontrol: temiz, ürün referans fotoğraflarıyla birebir"
      : `kontrol: ${lowerFirst(input.report.summary || "bazı kısımlar hatalı geldi")}`;
  const ask =
    input.kind === "product_photo_upgrade"
      ? "Olmuş mu? Onaylarsan ürünün fotoğrafı bununla değişir, eskisi 30 gün çöpte durur."
      : "Onaylıyor musun, yeniden üreteyim mi?";
  const composite =
    input.report &&
    !input.report.passed &&
    !input.composite &&
    input.kind !== "product_photo_upgrade"
      ? " İstersen yeniden üretirken etiketi birebir koruyarak yerleştirebilirim (gerçek ürün fotoğrafı sahneye yapıştırılır)."
      : "";
  return `${head}; ${stripEndDot(check)}. ${ask}${composite}`;
}

function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLocaleLowerCase("tr-TR") + text.slice(1) : text;
}

function stripEndDot(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

/**
 * The approval request for one generated picture of an `image.generate` job whose payload
 * carries `approval`.
 */
export function buildApprovalCreate(input: {
  brandId: string;
  jobId: string;
  payload: ImageGeneratePayload;
  assetId: string;
  checkReport: ApprovalCheckReport | null;
}): ApprovalCreate {
  const { payload } = input;
  const target = payload.approval;
  if (!target) throw new Error("the payload asks for no approval");
  const contentId = target.contentId ?? payload.targetContentId;
  const slotId = target.slotId ?? payload.targetSlotId;
  const productId = target.productId ?? payload.productIds?.[0];
  // "Yeniden üret" runs the same request; the API adds the new `approval` (with supersedesId).
  const { approval: _approval, variant: _variant, ...request } = payload;
  const text = approvalMessageText({
    kind: target.kind,
    report: input.checkReport,
    variant: payload.variant,
    regenerated: Boolean(target.supersedesId),
    composite: payload.preserveProductLabel,
  });
  return {
    brandId: input.brandId,
    kind: target.kind,
    assetIds: [input.assetId],
    ...(contentId ? { contentId } : {}),
    ...(slotId ? { slotId } : {}),
    ...(productId ? { productId } : {}),
    ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    ...(target.messageId ? { messageId: target.messageId } : {}),
    ...(target.replacesAssetId ? { replacesAssetId: target.replacesAssetId } : {}),
    ...(input.checkReport ? { checkReport: input.checkReport } : {}),
    sourceJobId: input.jobId,
    request: { jobType: "image.generate", payload: request as Record<string, unknown> },
    ...(target.supersedesId ? { supersedesId: target.supersedesId } : {}),
    ...(target.conversationId && !target.messageId ? { chatMessage: { text } } : {}),
  };
}
