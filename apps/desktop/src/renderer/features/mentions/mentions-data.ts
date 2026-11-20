// `@product` / `@post` names (docs/URETIM-RESIM.md §6): the brand's candidates the composer
// offers after `@`, and what a sent message's chip opens (a product: its page on the brand's
// Ürünler; a post: the post).
import type { MentionCandidate, MessageEntityMention } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../lib/api.ts";
import { focusProduct } from "../../state/focus-requests.ts";
import { isHostUp, useHost } from "../../state/studio.tsx";
import { openPostDetail } from "../posts/store.ts";

export const mentionKeys = {
  candidates: (brandId: string) => ["mention-candidates", brandId] as const,
};

const NONE: MentionCandidate[] = [];

/** Products (oldest first), then posts (newest first); empty without a brand. */
export function useMentionCandidates(brandId: string | null): MentionCandidate[] {
  const api = useApi();
  const up = isHostUp(useHost());
  const query = useQuery({
    queryKey: mentionKeys.candidates(brandId ?? ""),
    queryFn: async () => (await api.brands.mentionCandidates(brandId as string)).items,
    enabled: up && brandId !== null,
    staleTime: 60_000,
  });
  return query.data ?? NONE;
}

/** A sent message's `@product` / `@post` chip was clicked. */
export function openEntityMention(
  mention: Pick<MessageEntityMention, "kind" | "id">,
  brandId: string | null,
): void {
  if (mention.kind === "content") {
    openPostDetail(mention.id);
    return;
  }
  if (brandId) focusProduct(brandId, mention.id);
}
