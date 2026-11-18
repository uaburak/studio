// UI state of the posts screen and the opened post: month, filter, search, keyboard
// selection, brand scope, and which post the detail overlay shows. Opening and closing a post
// are steps of the window's history (app store `post`): back closes it, forward reopens it.
import type { Content } from "@studio/contract";
import { create } from "zustand";
import { useAppStore } from "../../state/app-store.ts";
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
    useAppStore.getState().openPost(contentId);
  },
  setTab(tab) {
    const opened = get().opened;
    if (opened) set({ opened: { ...opened, tab } });
  },
  close() {
    if (get().opened) set({ opened: null });
    useAppStore.getState().closePost();
  },
}));

// Back / forward (and navigating elsewhere) change the window's post: follow it.
useAppStore.subscribe((state, previous) => {
  if (state.post === previous.post) return;
  const opened = usePostsStore.getState().opened;
  if (state.post === null) {
    if (opened) usePostsStore.setState({ opened: null });
  } else if (opened?.contentId !== state.post) {
    usePostsStore.setState({ opened: { contentId: state.post, tab: "post", origin: null } });
  }
});

/** Open the post detail over the centre (chat cards, the board, other screens). */
export function openPostDetail(
  contentId: string,
  options?: Partial<Omit<OpenedPost, "contentId">>,
): void {
  usePostsStore.getState().open(contentId, options);
}
