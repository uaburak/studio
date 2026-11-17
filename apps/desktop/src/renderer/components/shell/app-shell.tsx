// The window: sidebar | (top bar / content + right panel), overlays, shortcuts and menu
// commands (Claude Code's: ⌘N new chat, ⌘K search, ⌘, settings, ⌘\ sidebar, ⌥⌘I panel,
// ⌘[ ⌘] back / forward).
import { lazy, Suspense, useEffect } from "react";
import type { MenuCommand } from "../../../shared/ipc.ts";
import { bridge, isElectron } from "../../lib/bridge.ts";
import { parseRoute, useAppStore } from "../../state/app-store.ts";
import { ChatView } from "../chat/chat-view.tsx";
import { Lightbox } from "../chat/lightbox.tsx";
import { NewChatView } from "../chat/new-chat-view.tsx";
import { PANEL_WIDTH, PANEL_WIDTH_EXPANDED, RightPanel } from "../panels/right-panel.tsx";
import { ToastHost } from "../ui/popover.tsx";
import { HostBanner, SearchPalette, SettingsSheet } from "./overlays.tsx";
import { Sidebar } from "./sidebar.tsx";
import { TopBar } from "./top-bar.tsx";

const Gallery = lazy(() => import("../../routes/gallery.tsx"));

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
      s.goBack();
      break;
    case "forward":
      s.goForward();
      break;
    case "rename":
      s.requestRename();
      break;
    case "gallery":
      s.navigate({ kind: "gallery" });
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
    const onKey = (event: KeyboardEvent) => {
      if (isElectron()) return;
      const command = shortcutCommand(event);
      if (command) {
        event.preventDefault();
        runMenuCommand(command);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      offMenu();
      offNotice();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}

export function AppShell() {
  useCommands();
  const route = useAppStore((s) => s.route);
  const sidebarPresented = useAppStore((s) => s.sidebarPresented);
  const panelPresented = useAppStore((s) => s.panelPresented);
  const panelExpanded = useAppStore((s) => s.panelExpanded);
  const panelWidth =
    panelPresented && route.kind !== "gallery"
      ? panelExpanded
        ? PANEL_WIDTH_EXPANDED
        : PANEL_WIDTH
      : null;

  return (
    <div className="flex h-full w-full overflow-hidden">
      {sidebarPresented && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col bg-page">
        <TopBar panelWidth={panelWidth} />
        <HostBanner />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {route.kind === "new" && <NewChatView />}
            {route.kind === "conversation" && <ChatView key={route.id} id={route.id} />}
            {route.kind === "gallery" && (
              <Suspense fallback={null}>
                <Gallery />
              </Suspense>
            )}
          </div>
          {panelWidth !== null && <RightPanel width={panelWidth} />}
        </div>
      </main>
      <SearchPalette />
      <SettingsSheet />
      <Lightbox />
      <ToastHost />
    </div>
  );
}
