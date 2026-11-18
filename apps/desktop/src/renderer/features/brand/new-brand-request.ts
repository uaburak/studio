// Git → Yeni marka… (⇧⌘N): the Markalar page opens its "Yeni marka" sheet once it is on screen.
import { create } from "zustand";
import { useAppStore } from "../../state/app-store.ts";

export const useNewBrandRequest = create<{ pending: boolean }>(() => ({ pending: false }));

export function requestNewBrand(): void {
  useNewBrandRequest.setState({ pending: true });
  useAppStore.getState().navigate({ kind: "brands" });
}
