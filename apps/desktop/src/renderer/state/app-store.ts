// Window state of the renderer (zustand): route with back/forward history, sidebar and right
// panel, current brand, overlays. The session part is saved through the preload bridge.
import { create } from "zustand";
import type { SessionState, WindowState } from "../../shared/ipc.ts";
import type { ChatImage } from "../lib/transcript.ts";

export type Route =
  | { kind: "new" }
  | { kind: "conversation"; id: string }
  | { kind: "gallery" }
  /** Full pages of the right panel's Takvim / Medya / Marka (wave 2B). */
  | { kind: "calendar" }
  | { kind: "media" }
  | { kind: "brand"; id: string }
  /** The posts board (wave 2A). */
  | { kind: "posts" };

export type PanelPane = "details" | "jobs" | "calendar" | "media" | "brand" | "phone";

export const PANEL_PANES: { id: PanelPane; title: string }[] = [
  { id: "details", title: "Ayrıntılar" },
  { id: "jobs", title: "Arka plan işleri" },
  { id: "calendar", title: "Takvim" },
  { id: "media", title: "Medya" },
  { id: "brand", title: "Marka" },
  { id: "phone", title: "iPhone" },
];

export function panelTitle(pane: PanelPane): string {
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
    case "brand":
      return `brand:${route.id}`;
    case "posts":
      return "posts";
  }
}

export function parseRoute(key: string | null | undefined): Route {
  if (key?.startsWith("c:") && key.length > 2) return { kind: "conversation", id: key.slice(2) };
  if (key === "gallery") return { kind: "gallery" };
  if (key === "calendar") return { kind: "calendar" };
  if (key === "media") return { kind: "media" };
  if (key?.startsWith("brand:") && key.length > 6) return { kind: "brand", id: key.slice(6) };
  if (key === "posts") return { kind: "posts" };
  return { kind: "new" };
}

export interface LightboxRequest {
  images: ChatImage[];
  index: number;
  /** Thumbnail frame the image zooms from (and back to). */
  origin: { x: number; y: number; width: number; height: number } | null;
  /** Finds the current thumbnail frame of an image (for closing on another page). */
  originOf?: (index: number) => { x: number; y: number; width: number; height: number } | null;
}

export interface Toast {
  id: number;
  message: string;
  tone: "default" | "danger";
  action?: { label: string; run: () => void };
}

interface AppState {
  route: Route;
  back: Route[];
  forward: Route[];
  sidebarPresented: boolean;
  panelPresented: boolean;
  panelPane: PanelPane;
  panelExpanded: boolean;
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

  navigate(route: Route): void;
  goBack(): void;
  goForward(): void;
  toggleSidebar(): void;
  togglePanel(pane?: PanelPane): void;
  closePanel(): void;
  togglePanelExpanded(): void;
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
  back: [],
  forward: [],
  sidebarPresented: true,
  panelPresented: false,
  panelPane: "details",
  panelExpanded: false,
  currentBrandId: null,
  collapsedGroups: [],
  searchOpen: false,
  settingsOpen: false,
  renameRequest: 0,
  lightbox: null,
  toasts: [],
  window: { fullScreen: false, focused: true },
  focusComposer: 0,

  navigate(route) {
    const current = get().route;
    if (routeKey(current) === routeKey(route)) return;
    set({ route, back: [...get().back, current].slice(-50), forward: [] });
  },
  goBack() {
    const { back, route, forward } = get();
    const previous = back.at(-1);
    if (!previous) return;
    set({ route: previous, back: back.slice(0, -1), forward: [route, ...forward] });
  },
  goForward() {
    const { back, route, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({ route: next, back: [...back, route], forward: forward.slice(1) });
  },
  toggleSidebar() {
    set({ sidebarPresented: !get().sidebarPresented });
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
    set({ panelExpanded: !get().panelExpanded });
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
    setTimeout(() => get().dismissToast(id), 5_000);
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
      panelPresented: session.panelPresented,
      panelPane: pane,
      panelExpanded: session.panelExpanded,
      currentBrandId: session.currentBrandId,
      collapsedGroups: session.collapsedGroups,
    });
  },
}));

export function sessionOf(state: AppState): SessionState {
  return {
    sidebarPresented: state.sidebarPresented,
    panelPresented: state.panelPresented,
    panelPane: state.panelPane,
    panelExpanded: state.panelExpanded,
    route: state.route.kind === "gallery" ? "new" : routeKey(state.route),
    currentBrandId: state.currentBrandId,
    collapsedGroups: state.collapsedGroups,
  };
}
