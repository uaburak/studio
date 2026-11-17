// The brand the Takvim / Medya / Marka panes show: the open conversation's brand (its
// attachments must be of that brand), else the current brand (new chat, full pages).
import type { Brand, Conversation } from "@studio/contract";
import { type Route, useAppStore } from "../state/app-store.ts";
import { useBrands, useConversations } from "../state/studio.tsx";

export function panelBrandId(
  route: Route,
  conversations: readonly Conversation[] | undefined,
  currentBrandId: string | null,
): string | null {
  if (route.kind === "conversation") {
    const brandId = conversations?.find((c) => c.id === route.id)?.brandId;
    if (brandId) return brandId;
  }
  return currentBrandId;
}

export function usePanelBrandId(): string | null {
  const route = useAppStore((s) => s.route);
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const conversations = useConversations();
  return panelBrandId(route, conversations.data, currentBrandId);
}

/** The panel brand and its record (undefined while brands load or for an unknown id). */
export function usePanelBrand(): { brandId: string | null; brand: Brand | undefined } {
  const brandId = usePanelBrandId();
  const brands = useBrands();
  return { brandId, brand: (brands.data ?? []).find((b) => b.id === brandId) };
}
