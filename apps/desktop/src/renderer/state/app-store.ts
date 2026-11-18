// Window state of the renderer (zustand): the location (route + opened post) with a back /
// forward history, sidebar and right panel (open state and widths), current brand, overlays.
// The session part is saved through the preload bridge.
import { create } from "zustand";
import type { SessionState, WindowState } from "../../shared/ipc.ts";
import type { ChatImage } from "../lib/transcript.ts";

/** Sections of a brand's profile page (each one is a step of the history). */
export type BrandTab = "general" | "kit" | "profile" | "accounts" | "products";

export const BRAND_TABS: readonly BrandTab[] = [
  "general",
  "kit",
  "profile",
  "accounts",
  "products",
];

/** The section a brand page opens on when the route names none. */
export const DEFAULT_BRAND_TAB: BrandTab = "kit";

export type Route =
  | { kind: "new" }
  | { kind: "conversation"; id: string }
  | { kind: "gallery" }
  /** Full pages of the right panel's Takvim / Medya (wave 2B). */
  | { kind: "calendar" }
  | { kind: "media" }
  /** Markalar: the list of brands. */
  | { kind: "brands" }
  /** A brand's profile page, on one of its sections. */
  | { kind: "brand"; id: string; tab?: BrandTab }
  /** The posts board (wave 2A). */
  | { kind: "posts" }
  /** Archived conversations: browse, open, take back. */
  | { kind: "archive" };

/** A place in the history: a route and the post opened over it (if any). */
export interface Location {
  route: Route;
  /** Content id of the post detail open over the route. */
  post: string | null;
}

const HISTORY_LIMIT = 50;

// --- side panels' widths ------------------------------------------------------------------

export const SIDEBAR_WIDTH = 265;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;
export const PANEL_WIDTH = 357;
export const PANEL_WIDTH_EXPANDED = 520;
export const PANEL_MIN_WIDTH = 300;
export const PANEL_MAX_WIDTH = 720;

export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The right panel's panes. `post` is the open post's own panel (Düzenle / Sohbet): it exists
 * while a post is open on the canvas and is never saved as the session's pane.
 */
export type PanelPane = "details" | "jobs" | "calendar" | "media" | "brand" | "phone" | "post";

/** The panes the top bar's tool icons switch to (the post pane comes with the open post). */
export const PANEL_PANES: { id: Exclude<PanelPane, "post">; title: string }[] = [
  { id: "details", title: "Ayrıntılar" },
  { id: "jobs", title: "Arka plan işleri" },
  { id: "calendar", title: "Takvim" },
  { id: "media", title: "Medya" },
  { id: "brand", title: "Marka" },
  { id: "phone", title: "iPhone" },
];

export function panelTitle(pane: PanelPane): string {
  if (pane === "post") return "Post paneli";
  return PANEL_PANES.find((p) => p.id === pane)?.title ?? "";
}

export function routeKey(route: Route): string {
  switch (route.kind) {
    case "new":
      return "new";
    case "conversation":
      return `c:${route.id}`;
    case "gallery":
      return "gallery";
    case "calendar":
      return "calendar";
    case "media":
      return "media";
    case "brands":
      return "brands";
    case "brand":
      return `brand:${route.id}/${route.tab ?? DEFAULT_BRAND_TAB}`;
    case "posts":
      return "posts";
    case "archive":
      return "archive";
  }
}

export function parseRoute(key: string | null | undefined): Route {
  if (key?.startsWith("c:") && key.length > 2) return { kind: "conversation", id: key.slice(2) };
  if (key === "gallery") return { kind: "gallery" };
  if (key === "calendar") return { kind: "calendar" };
  if (key === "media") return { kind: "media" };
  if (key === "brands") return { kind: "brands" };
  if (key?.startsWith("brand:") && key.length > 6) {
    // `brand:<id>/<tab>`; older sessions saved `brand:<id>`.
    const rest = key.slice(6);
    const slash = rest.lastIndexOf("/");
    const tab = slash > 0 ? rest.slice(slash + 1) : "";
    if (BRAND_TABS.includes(tab as BrandTab)) {
      return { kind: "brand", id: rest.slice(0, slash), tab: tab as BrandTab };
    }
    return { kind: "brand", id: rest };
  }
  if (key === "posts") return { kind: "posts" };
  if (key === "archive") return { kind: "archive" };
  return { kind: "new" };
}

/** A width from the saved session (missing in older files → the default). */
function savedWidth(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clampWidth(value, min, max)
    : fallback;
}

const sameLocation = (a: Location, b: Location) =>
  routeKey(a.route) === routeKey(b.route) && a.post === b.post;

export interface LightboxRequest {
  images: ChatImage[];
  index: number;
  /** The thumbnail (its `<img>` or tile) of an image: the picture zooms out of it and back into
   *  it. None, gone or scrolled away: the viewer fades. */
  sourceOf?: ((index: number) => Element | null) | undefined;
}

export interface Toast {
  id: number;
  message: string;
  tone: "default" | "danger";
  action?: { label: string; run: () => void };
  /** How long it stays (default 5 s); "Geri al" toasts stay 10 s. */
  durationMs?: number;
}

interface AppState {
  route: Route;
  /** The post detail open over the route (part of the history). */
  post: string | null;
  back: Location[];
  forward: Location[];
  sidebarPresented: boolean;
  sidebarWidth: number;
  panelPresented: boolean;
  panelPane: PanelPane;
  panelExpanded: boolean;
  /** The panel's own width (the expanded panel is at least PANEL_WIDTH_EXPANDED). */
  panelWidth: number;
  /** What the panel showed before the open post took it over (back to it when the post closes). */
  panelReturn: { presented: boolean; pane: Exclude<PanelPane, "post"> } | null;
  currentBrandId: string | null;
  collapsedGroups: string[];
  searchOpen: boolean;
  settingsOpen: boolean;
  /** Bumped to start the title's inline rename (menu "Yeniden adlandır"). */
  renameRequest: number;
  lightbox: LightboxRequest | null;
  toasts: Toast[];
  window: WindowState;
  /** Bumped to focus the composer. */
  focusComposer: number;

  /** Go to `route` (a new history step; `replace` swaps the current one). Closes the post. */
  navigate(route: Route, options?: { replace?: boolean }): void;
  /** Open a post over the current route (a history step). */
  openPost(contentId: string): void;
  /** Close the open post: steps back when opening it was the last step, else a new step. */
  closePost(): void;
  /** Drop a deleted post from the history. */
  forgetPost(contentId: string): void;
  /** Drop a route from the history (an archived conversation: back / forward skip it). */
  forgetRoute(route: Route): void;
  goBack(): void;
  goForward(): void;
  toggleSidebar(): void;
  setSidebarWidth(width: number): void;
  setPanelWidth(width: number): void;
  togglePanel(pane?: PanelPane): void;
  closePanel(): void;
  togglePanelExpanded(): void;
  /** The open post takes the panel over (its Düzenle / Sohbet panel), remembering what it showed. */
  showPostPanel(): void;
  /** The post closed: the panel shows what it showed before (unless another pane was picked). */
  releasePostPanel(): void;
  setCurrentBrand(id: string | null): void;
  toggleGroup(id: string): void;
  setSearchOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  requestRename(): void;
  openLightbox(request: LightboxRequest): void;
  closeLightbox(): void;
  showToast(toast: Omit<Toast, "id" | "tone"> & { tone?: Toast["tone"] }): void;
  dismissToast(id: number): void;
  setWindowState(state: WindowState): void;
  requestComposerFocus(): void;
  restore(session: SessionState): void;
}

let toastId = 0;

export const useAppStore = create<AppState>((set, get) => ({
  route: { kind: "new" },
  post: null,
  back: [],
  forward: [],
  sidebarPresented: true,
  sidebarWidth: SIDEBAR_WIDTH,
  panelPresented: false,
  panelPane: "details",
  panelExpanded: false,
  panelWidth: PANEL_WIDTH,
  panelReturn: null,
  currentBrandId: null,
  collapsedGroups: [],
  searchOpen: false,
  settingsOpen: false,
  renameRequest: 0,
  lightbox: null,
  toasts: [],
  window: { fullScreen: false, focused: true },
  focusComposer: 0,

  navigate(route, options) {
    const { route: current, post, back } = get();
    const next: Location = { route, post: null };
    if (sameLocation({ route: current, post }, next)) return;
    if (options?.replace) {
      set({ route, post: null });
      return;
    }
    set({
      route,
      post: null,
      back: [...back, { route: current, post }].slice(-HISTORY_LIMIT),
      forward: [],
    });
  },
  openPost(contentId) {
    const { route, post, back } = get();
    if (post === contentId) return;
    set({
      post: contentId,
      back: [...back, { route, post }].slice(-HISTORY_LIMIT),
      forward: [],
    });
  },
  closePost() {
    const { route, post, back } = get();
    if (post === null) return;
    const previous = back.at(-1);
    if (previous && sameLocation(previous, { route, post: null })) {
      get().goBack();
      return;
    }
    set({ post: null, back: [...back, { route, post }].slice(-HISTORY_LIMIT), forward: [] });
  },
  forgetPost(contentId) {
    const keep = (list: Location[]) => {
      const out: Location[] = [];
      for (const location of list) {
        if (location.post === contentId) continue;
        const last = out.at(-1);
        if (!last || !sameLocation(last, location)) out.push(location);
      }
      return out;
    };
    const { back, forward, post } = get();
    set({
      back: keep(back),
      forward: keep(forward),
      ...(post === contentId ? { post: null } : {}),
    });
  },
  forgetRoute(route) {
    const key = routeKey(route);
    const keep = (list: Location[]) => {
      const out: Location[] = [];
      for (const location of list) {
        if (routeKey(location.route) === key) continue;
        const last = out.at(-1);
        if (!last || !sameLocation(last, location)) out.push(location);
      }
      return out;
    };
    const { back, forward } = get();
    set({ back: keep(back), forward: keep(forward) });
  },
  goBack() {
    const { back, route, post, forward } = get();
    const previous = back.at(-1);
    if (!previous) return;
    set({
      route: previous.route,
      post: previous.post,
      back: back.slice(0, -1),
      forward: [{ route, post }, ...forward].slice(0, HISTORY_LIMIT),
    });
  },
  goForward() {
    const { back, route, post, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({
      route: next.route,
      post: next.post,
      back: [...back, { route, post }].slice(-HISTORY_LIMIT),
      forward: forward.slice(1),
    });
  },
  toggleSidebar() {
    set({ sidebarPresented: !get().sidebarPresented });
  },
  setSidebarWidth(width) {
    set({ sidebarWidth: clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) });
  },
  setPanelWidth(width) {
    // A width picked by hand replaces the expanded size.
    set({ panelWidth: clampWidth(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH), panelExpanded: false });
  },
  togglePanel(pane) {
    const { panelPresented, panelPane } = get();
    if (!pane) {
      set({ panelPresented: !panelPresented });
      return;
    }
    // The selected icon closes the panel; another icon switches it (never the centre).
    if (panelPresented && panelPane === pane) set({ panelPresented: false });
    else set({ panelPresented: true, panelPane: pane });
  },
  closePanel() {
    set({ panelPresented: false, panelExpanded: false });
  },
  togglePanelExpanded() {
    const state = get();
    if (panelWidthOf(state) < PANEL_WIDTH_EXPANDED) {
      set({ panelExpanded: true });
      return;
    }
    // Back to the default width when the panel was dragged this wide by hand.
    set({
      panelExpanded: false,
      ...(state.panelWidth >= PANEL_WIDTH_EXPANDED ? { panelWidth: PANEL_WIDTH } : {}),
    });
  },
  showPostPanel() {
    const s = get();
    if (s.panelPresented && s.panelPane === "post") return;
    set({
      panelReturn: s.panelReturn ?? {
        presented: s.panelPresented,
        pane: s.panelPane === "post" ? "details" : s.panelPane,
      },
      panelPresented: true,
      panelPane: "post",
    });
  },
  releasePostPanel() {
    const s = get();
    const back = s.panelReturn;
    if (s.panelPane !== "post") {
      if (back) set({ panelReturn: null });
      return;
    }
    set({
      panelReturn: null,
      panelPresented: back?.presented ?? false,
      panelPane: back?.pane ?? "details",
    });
  },
  setCurrentBrand(id) {
    set({ currentBrandId: id });
  },
  toggleGroup(id) {
    const groups = get().collapsedGroups;
    set({
      collapsedGroups: groups.includes(id) ? groups.filter((g) => g !== id) : [...groups, id],
    });
  },
  setSearchOpen(open) {
    set({ searchOpen: open });
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  requestRename() {
    set({ renameRequest: get().renameRequest + 1 });
  },
  openLightbox(request) {
    set({ lightbox: request });
  },
  closeLightbox() {
    set({ lightbox: null });
  },
  showToast(toast) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { tone: "default" as const, ...toast, id }].slice(-3) });
    setTimeout(() => get().dismissToast(id), toast.durationMs ?? 5_000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setWindowState(state) {
    set({ window: state });
  },
  requestComposerFocus() {
    set({ focusComposer: get().focusComposer + 1 });
  },
  restore(session) {
    const pane = PANEL_PANES.some((p) => p.id === session.panelPane)
      ? (session.panelPane as PanelPane)
      : "details";
    set({
      route: get().route.kind === "gallery" ? get().route : parseRoute(session.route),
      sidebarPresented: session.sidebarPresented,
      sidebarWidth: savedWidth(
        session.sidebarWidth,
        SIDEBAR_WIDTH,
        SIDEBAR_MIN_WIDTH,
        SIDEBAR_MAX_WIDTH,
      ),
      panelPresented: session.panelPresented,
      panelPane: pane,
      panelExpanded: session.panelExpanded,
      panelWidth: savedWidth(session.panelWidth, PANEL_WIDTH, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
      currentBrandId: session.currentBrandId,
      collapsedGroups: session.collapsedGroups,
    });
  },
}));

export function sessionOf(state: AppState): SessionState {
  // The post's panel is not a place to come back to: save what it took over.
  const post = state.panelPane === "post";
  return {
    sidebarPresented: state.sidebarPresented,
    sidebarWidth: state.sidebarWidth,
    panelPresented: post ? (state.panelReturn?.presented ?? false) : state.panelPresented,
    panelPane: post ? (state.panelReturn?.pane ?? "details") : state.panelPane,
    panelExpanded: state.panelExpanded,
    panelWidth: state.panelWidth,
    route: state.route.kind === "gallery" ? "new" : routeKey(state.route),
    currentBrandId: state.currentBrandId,
    collapsedGroups: state.collapsedGroups,
  };
}

/** The right panel's width on screen (expanded: at least PANEL_WIDTH_EXPANDED). */
export function panelWidthOf(state: Pick<AppState, "panelWidth" | "panelExpanded">): number {
  return state.panelExpanded ? Math.max(PANEL_WIDTH_EXPANDED, state.panelWidth) : state.panelWidth;
}
