// The window: sidebar | (top bar / content + right panel), overlays, shortcuts and menu
// commands (Claude Code's: ⌘N new chat, ⌘K search, ⌘, settings, ⌘\ sidebar, ⌥⌘I panel,
// ⌘[ ⌘] back / forward; also the mouse's back / forward buttons and a two-finger swipe).
// The sidebar's and the panel's inner edges resize them.
import { lazy, Suspense, useEffect } from "react";
import type { MenuCommand } from "../../../shared/ipc.ts";
import { OnboardingSheet } from "../../features/onboarding/onboarding-sheet.tsx";
import { PostDetailLayer } from "../../features/post-detail/post-detail.tsx";
import { PostsPage } from "../../features/posts/posts-page.tsx";
import { SettingsSheet } from "../../features/settings/settings-sheet.tsx";
import { installAppFlush } from "../../lib/app-flush.ts";
import { bridge, isElectron } from "../../lib/bridge.ts";
import {
  mouseButtonDirection,
  type NavDirection,
  navKeyTakenByCanvas,
  noSwipeAt,
  SwipeDetector,
  swipeBlockedAt,
} from "../../lib/nav-gestures.ts";
import {
  DEFAULT_BRAND_TAB,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH,
  panelWidthOf,
  parseRoute,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH,
  useAppStore,
} from "../../state/app-store.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { Lightbox } from "../chat/lightbox.tsx";
import { NewChatView } from "../chat/new-chat-view.tsx";
import { RightPanel } from "../panels/right-panel.tsx";
import { ToastHost } from "../ui/popover.tsx";
import { ArchivePage } from "./archive-page.tsx";
import { HostBanner, SearchPalette } from "./overlays.tsx";
import { ResizeHandle } from "./resize-handle.tsx";
import { Sidebar } from "./sidebar.tsx";
import { TopBar } from "./top-bar.tsx";

const Gallery = lazy(() => import("../../routes/gallery.tsx"));
// Full pages of the Takvim / Medya / Marka panes (wave 2B).
const CalendarPage = lazy(() => import("../../features/calendar/calendar-page.tsx"));
const MediaPage = lazy(() => import("../../features/media/media-page.tsx"));
const BrandPage = lazy(() => import("../../features/brand/brand-page.tsx"));
const BrandsPage = lazy(() => import("../../features/brand/brands-page.tsx"));

/** The centre keeps at least this much room when a side panel is dragged wider. */
export const MIN_CENTER_WIDTH = 420;

// One history step per gesture, whichever way it arrives (a trackpad swipe can come both as
// wheel events and as the window's "swipe" event).
let lastGestureAt = Number.NEGATIVE_INFINITY;
const GESTURE_DEDUPE_MS = 700;
/** Where the pointer last was: the window's three-finger swipe has no target of its own. */
let pointerTarget: EventTarget | null = null;

/** Back / forward from a gesture (mouse button, swipe); repeated within 0.7 s → ignored. */
export function navigateByGesture(direction: NavDirection, now = performance.now()): boolean {
  if (now - lastGestureAt < GESTURE_DEDUPE_MS) return false;
  lastGestureAt = now;
  const s = useAppStore.getState();
  if (direction === "back") s.goBack();
  else s.goForward();
  return true;
}

export function runMenuCommand(command: MenuCommand): void {
  const s = useAppStore.getState();
  switch (command) {
    case "new-chat":
      s.navigate({ kind: "new" });
      s.requestComposerFocus();
      break;
    case "search":
      s.setSearchOpen(true);
      break;
    case "settings":
      s.setSettingsOpen(true);
      break;
    case "toggle-sidebar":
      s.toggleSidebar();
      break;
    case "toggle-panel":
      s.togglePanel();
      break;
    case "back":
      // ⌘[ on the post canvas is Wecra's send backward (the menu may still see the key).
      if (!navKeyTakenByCanvas()) s.goBack();
      break;
    case "forward":
      if (!navKeyTakenByCanvas()) s.goForward();
      break;
    case "rename":
      s.requestRename();
      break;
    case "gallery":
      s.navigate({ kind: "gallery" });
      break;
    // The window's (three-finger) swipe: over the post canvas it pans there, never navigates.
    case "swipe-back":
      if (!noSwipeAt(pointerTarget)) navigateByGesture("back");
      break;
    case "swipe-forward":
      if (!noSwipeAt(pointerTarget)) navigateByGesture("forward");
      break;
  }
}

/** Keyboard shortcuts → menu commands (outside Electron; there the menu owns them). */
export function shortcutCommand(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "altKey" | "ctrlKey" | "shiftKey">,
): MenuCommand | null {
  if (!event.metaKey || event.ctrlKey) return null;
  if (event.altKey)
    return event.key.toLowerCase() === "i" || event.key === "ˆ" ? "toggle-panel" : null;
  switch (event.key) {
    case "n":
      return "new-chat";
    case "k":
      return "search";
    case ",":
      return "settings";
    case "\\":
      return "toggle-sidebar";
    case "[":
      return "back";
    case "]":
      return "forward";
    default:
      return null;
  }
}

function useCommands() {
  useEffect(() => {
    const b = bridge();
    const offMenu = b.onMenuCommand(runMenuCommand);
    const offNotice = b.onNoticeClicked((route) =>
      useAppStore.getState().navigate(parseRoute(route)),
    );
    const offAppNotice =
      b.onAppNotice?.((message) => useAppStore.getState().showToast({ message })) ?? (() => {});
    const onKey = (event: KeyboardEvent) => {
      // A key the page used (the post canvas's ⌘[ / ⌘]) is not a shortcut of the app's.
      if (isElectron() || event.defaultPrevented) return;
      const command = shortcutCommand(event);
      if (command) {
        event.preventDefault();
        runMenuCommand(command);
      }
    };
    // Mouse buttons 4 / 5. Chromium may also treat them as history navigation; there is no
    // page history to go to, but the default is stopped anyway.
    const onMouseUp = (event: MouseEvent) => {
      const direction = mouseButtonDirection(event);
      if (!direction) return;
      event.preventDefault();
      navigateByGesture(direction, event.timeStamp);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (mouseButtonDirection(event)) event.preventDefault();
    };
    // Two-finger sideways swipe (not over things that scroll sideways or the lightbox).
    const swipe = new SwipeDetector();
    const onWheel = (event: WheelEvent) => {
      pointerTarget = event.target;
      // Not over the lightbox, a sideways scroller, the post canvas (`data-no-swipe`), nor a
      // wheel something already used (Wecra's canvas pans with it).
      const blocked =
        event.defaultPrevented ||
        useAppStore.getState().lightbox !== null ||
        swipeBlockedAt(event.target as Element);
      const direction = swipe.wheel(event, blocked);
      if (direction) navigateByGesture(direction, event.timeStamp);
    };
    const onPointer = (event: PointerEvent) => {
      pointerTarget = event.target;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("pointermove", onPointer, { passive: true, capture: true });
    // Close / quit / reload: the open post's draft is written first (E14).
    const offFlush = installAppFlush(b.lifecycle ?? null);
    // Everything listens now: a notification click that opened the window comes after this.
    b.rendererReady?.();
    return () => {
      offMenu();
      offNotice();
      offAppNotice();
      offFlush();
      window.removeEventListener("pointermove", onPointer, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);
}

export function AppShell() {
  useCommands();
  const route = useAppStore((s) => s.route);
  const sidebarPresented = useAppStore((s) => s.sidebarPresented);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const panelPresented = useAppStore((s) => s.panelPresented);
  const panelOwnWidth = useAppStore(panelWidthOf);
  const panelWidth = panelPresented && route.kind !== "gallery" ? panelOwnWidth : null;
  // The other side and the centre's minimum bound how wide a panel may be dragged.
  const room = (other: number | null) =>
    Math.max(0, window.innerWidth - (other ?? 0) - MIN_CENTER_WIDTH);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {sidebarPresented && (
        <div className="relative flex h-full shrink-0">
          <Sidebar width={sidebarWidth} />
          <ResizeHandle
            edge="right"
            label="Kenar çubuğunu boyutlandır"
            width={sidebarWidth}
            min={SIDEBAR_MIN_WIDTH}
            max={SIDEBAR_MAX_WIDTH}
            onResize={(width) =>
              useAppStore
                .getState()
                .setSidebarWidth(Math.min(width, Math.max(SIDEBAR_MIN_WIDTH, room(panelWidth))))
            }
            onReset={() => useAppStore.getState().setSidebarWidth(SIDEBAR_WIDTH)}
          />
        </div>
      )}
      <main className="relative flex min-w-0 flex-1 flex-col bg-page">
        {panelWidth !== null && (
          <ResizeHandle
            edge="left"
            label="Sağ paneli boyutlandır"
            width={panelWidth}
            min={PANEL_MIN_WIDTH}
            max={PANEL_MAX_WIDTH}
            style={{ right: panelWidth - 4, left: "auto" }}
            onResize={(width) =>
              useAppStore
                .getState()
                .setPanelWidth(
                  Math.min(
                    width,
                    Math.max(PANEL_MIN_WIDTH, room(sidebarPresented ? sidebarWidth : null)),
                  ),
                )
            }
            onReset={() => useAppStore.getState().setPanelWidth(PANEL_WIDTH)}
          />
        )}
        <TopBar panelWidth={panelWidth} />
        <HostBanner />
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
            {route.kind === "new" && <NewChatView />}
            {route.kind === "posts" && <PostsPage />}
            {route.kind === "conversation" && <ChatView key={route.id} id={route.id} />}
            {route.kind === "archive" && <ArchivePage />}
            {route.kind === "gallery" && (
              <Suspense fallback={null}>
                <Gallery />
              </Suspense>
            )}
            {(route.kind === "calendar" ||
              route.kind === "media" ||
              route.kind === "brands" ||
              route.kind === "brand") && (
              <Suspense fallback={null}>
                {route.kind === "calendar" && <CalendarPage />}
                {route.kind === "media" && <MediaPage />}
                {route.kind === "brands" && <BrandsPage />}
                {route.kind === "brand" && (
                  <BrandPage
                    key={route.id}
                    brandId={route.id}
                    tab={route.tab ?? DEFAULT_BRAND_TAB}
                  />
                )}
              </Suspense>
            )}
            <PostDetailLayer />
          </div>
          {panelWidth !== null && <RightPanel width={panelWidth} />}
        </div>
      </main>
      <SearchPalette />
      <SettingsSheet />
      <OnboardingSheet />
      <Lightbox />
      <ToastHost />
    </div>
  );
}
