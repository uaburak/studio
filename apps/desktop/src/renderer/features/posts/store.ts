// UI state of the posts screen and the opened post: month, filter, search, keyboard
// selection, brand scope, and which post the detail overlay shows. Opening and closing a post
// are steps of the window's history (app store `post`): back closes it, forward reopens it.
import type { Content } from "@studio/contract";
import { create } from "zustand";
import { useAppStore } from "../../state/app-store.ts";
import type { PostFilter } from "./board.ts";
import type { MonthKey } from "./dates.ts";

export type DetailTab = "post" | "edit" | "versions";

/** The posts screen's two views: the board and the month plans (N2). */
export type PostsView = "board" | "plans";

export interface OpenedPost {
  contentId: string;
  tab: DetailTab;
  /** Frame the detail zooms from (the clicked card). */
  origin: { x: number; y: number; width: number; height: number } | null;
}

interface PostsState {
  /** Every brand's posts (grouped by brand) instead of the current brand's. */
  allBrands: boolean;
  /** Board or month plans. */
  view: PostsView;
  /** The plan open on the plans view (null: the list's first one). */
  planId: string | null;
  /** The board shows the trash ("Silinenler") instead of the month. */
  trash: boolean;
  /** Cards picked with ⌘-click / ⇧-click / "Tümünü seç" (N1). */
  picked: string[];
  /** Where a ⇧-click range starts. */
  anchorId: string | null;
  /** null: the month with the nearest posts, picked on load. */
  month: MonthKey | null;
  filter: PostFilter;
  query: string;
  selectedId: string | null;
  opened: OpenedPost | null;
  /** A trashed post waiting for the "Kalıcı olarak sil" confirmation. */
  deleting: Content | null;

  setAllBrands(all: boolean): void;
  askDelete(content: Content | null): void;
  setView(view: PostsView): void;
  /** Open the plans view on a plan (the chat plan card's "Düzenle"). */
  showPlan(planId: string | null): void;
  setTrash(trash: boolean): void;
  setPicked(ids: string[], anchorId?: string | null): void;
  clearPicked(): void;
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
  view: "board",
  planId: null,
  trash: false,
  picked: [],
  anchorId: null,
  month: null,
  filter: "all",
  query: "",
  selectedId: null,
  opened: null,
  deleting: null,

  setAllBrands(allBrands) {
    set({ allBrands, month: null, selectedId: null, picked: [], anchorId: null, planId: null });
  },
  askDelete(deleting) {
    set({ deleting });
  },
  setView(view) {
    set({ view, picked: [], anchorId: null });
  },
  showPlan(planId) {
    set({ view: "plans", planId, picked: [], anchorId: null });
  },
  setTrash(trash) {
    set({ trash, selectedId: null, picked: [], anchorId: null });
  },
  setPicked(picked, anchorId) {
    set(anchorId === undefined ? { picked } : { picked, anchorId });
  },
  clearPicked() {
    set({ picked: [], anchorId: null });
  },
  setMonth(month) {
    set({ month, selectedId: null, picked: [], anchorId: null });
  },
  setFilter(filter) {
    set({ filter, selectedId: null, picked: [], anchorId: null });
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

// Another brand: its own month with posts (A4 — the old brand's month showed "post yok"), no
// picked cards, the plans view on its first plan.
useAppStore.subscribe((state, previous) => {
  if (state.currentBrandId === previous.currentBrandId) return;
  usePostsStore.setState({
    month: null,
    selectedId: null,
    picked: [],
    anchorId: null,
    planId: null,
  });
});

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

/**
 * The posts screen on a plan (the chat plan card's "Düzenle"): its brand becomes the current one
 * and the plans view opens on it.
 */
export function openPlanPage(planId: string, brandId: string | null): void {
  const app = useAppStore.getState();
  if (brandId && app.currentBrandId !== brandId) app.setCurrentBrand(brandId);
  usePostsStore.setState({ allBrands: false });
  usePostsStore.getState().showPlan(planId);
  app.navigate({ kind: "posts" });
}

/** Open the post detail over the centre (chat cards, the board, other screens). */
export function openPostDetail(
  contentId: string,
  options?: Partial<Omit<OpenedPost, "contentId">>,
): void {
  usePostsStore.getState().open(contentId, options);
}
