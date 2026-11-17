// UI state of the posts screen and the opened post: month, filter, search, keyboard
// selection, brand scope, and which post the detail overlay shows.
import type { Content } from "@studio/contract";
import { create } from "zustand";
import type { PostFilter } from "./board.ts";
import type { MonthKey } from "./dates.ts";

export type DetailTab = "post" | "edit" | "versions";

export interface OpenedPost {
  contentId: string;
  tab: DetailTab;
  /** Frame the detail zooms from (the clicked card). */
  origin: { x: number; y: number; width: number; height: number } | null;
}

interface PostsState {
  /** Every brand's posts (grouped by brand) instead of the current brand's. */
  allBrands: boolean;
  /** null: the month with the nearest posts, picked on load. */
  month: MonthKey | null;
  filter: PostFilter;
  query: string;
  selectedId: string | null;
  opened: OpenedPost | null;
  /** A post waiting for the delete confirmation. */
  deleting: Content | null;

  setAllBrands(all: boolean): void;
  askDelete(content: Content | null): void;
  setMonth(month: MonthKey | null): void;
  setFilter(filter: PostFilter): void;
  setQuery(query: string): void;
  select(id: string | null): void;
  open(contentId: string, options?: Partial<Omit<OpenedPost, "contentId">>): void;
  setTab(tab: DetailTab): void;
  close(): void;
}

export const usePostsStore = create<PostsState>((set, get) => ({
  allBrands: false,
  month: null,
  filter: "all",
  query: "",
  selectedId: null,
  opened: null,
  deleting: null,

  setAllBrands(allBrands) {
    set({ allBrands, selectedId: null });
  },
  askDelete(deleting) {
    set({ deleting });
  },
  setMonth(month) {
    set({ month, selectedId: null });
  },
  setFilter(filter) {
    set({ filter, selectedId: null });
  },
  setQuery(query) {
    set({ query });
  },
  select(selectedId) {
    set({ selectedId });
  },
  open(contentId, options = {}) {
    set({
      opened: { contentId, tab: options.tab ?? "post", origin: options.origin ?? null },
      selectedId: get().selectedId ?? contentId,
    });
  },
  setTab(tab) {
    const opened = get().opened;
    if (opened) set({ opened: { ...opened, tab } });
  },
  close() {
    set({ opened: null });
  },
}));

/** Open the post detail over the centre (chat cards, the board, other screens). */
export function openPostDetail(
  contentId: string,
  options?: Partial<Omit<OpenedPost, "contentId">>,
): void {
  usePostsStore.getState().open(contentId, options);
}
