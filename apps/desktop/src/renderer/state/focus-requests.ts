// "Go there and show it" requests that outlive a navigation: a chat message to scroll to and
// highlight (an approval row of the details panel, a post's "Onaya git"), a product to open on
// its brand's Ürünler (an @product chip). The target view takes the request once it can show it.
import { create } from "zustand";
import { useAppStore } from "./app-store.ts";

export interface MessageFocus {
  conversationId: string;
  messageId: string;
  /** Changes with every request (the same message can be asked for twice). */
  nonce: number;
}

export interface ProductFocus {
  brandId: string;
  productId: string;
  nonce: number;
}

interface FocusState {
  message: MessageFocus | null;
  product: ProductFocus | null;
  takeMessage(nonce: number): void;
  takeProduct(nonce: number): void;
}

let nonce = 0;

export const useFocusRequests = create<FocusState>((set, get) => ({
  message: null,
  product: null,
  takeMessage(n) {
    if (get().message?.nonce === n) set({ message: null });
  },
  takeProduct(n) {
    if (get().product?.nonce === n) set({ product: null });
  },
}));

/** Open the conversation and scroll to (and highlight) one of its messages. */
export function focusMessage(conversationId: string, messageId: string | null): void {
  useFocusRequests.setState({
    message: messageId ? { conversationId, messageId, nonce: ++nonce } : null,
  });
  useAppStore.getState().navigate({ kind: "conversation", id: conversationId });
}

/** Open a brand's Ürünler on one product's page. */
export function focusProduct(brandId: string, productId: string): void {
  useFocusRequests.setState({ product: { brandId, productId, nonce: ++nonce } });
  useAppStore.getState().navigate({ kind: "brand", id: brandId, tab: "products" });
}
