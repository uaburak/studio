// The unified top bar (Wecra "Top bar"): window controls (sidebar, back, forward) when the
// sidebar is hidden, the title with its menu (double-click renames inline), the right panel's
// tool icons (they only switch the right panel) and the panel header above the panel. Chats
// and posts are switched from the sidebar. While a post is open on the canvas, its title area
// and its panel's header are slots the post workspace renders into (features/post-editor/slots).
import { useEffect, useRef, useState } from "react";
import { isPageRoute, PageTitle } from "../../features/page-title.tsx";
import { WorkspaceSlot } from "../../features/post-editor/slots.tsx";
import { useWorkspaceStore } from "../../features/post-editor/workspace-store.ts";
import { PostsTitleButton } from "../../features/posts/posts-title.tsx";
import {
  PANEL_WIDTH_EXPANDED,
  type PanelPane,
  panelTitle,
  panelWidthOf,
  useAppStore,
} from "../../state/app-store.ts";
import { useBrands, useConversations } from "../../state/studio.tsx";
import { cn, IconButton } from "../ui/controls.tsx";
import {
  IconCalendar,
  IconChevronDown,
  IconClock,
  IconClose,
  IconEllipsis,
  IconImage,
  IconList,
  IconMaximize,
  IconMinimize,
  IconPhone,
  IconSliders,
  IconTag,
} from "../ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../ui/menu.tsx";
import { useConversationActions } from "./conversation-actions.ts";
import { WindowControls } from "./sidebar.tsx";

export const TOP_BAR_HEIGHT = 44;

const TOOLS: { pane: PanelPane; icon: React.ReactNode; shortcut?: string }[] = [
  { pane: "details", icon: <IconList size={16} strokeWidth={1.5} />, shortcut: "⌥⌘I" },
  { pane: "jobs", icon: <IconClock size={16} strokeWidth={1.5} /> },
  { pane: "calendar", icon: <IconCalendar size={16} strokeWidth={1.5} /> },
  { pane: "media", icon: <IconImage size={16} strokeWidth={1.5} /> },
  { pane: "brand", icon: <IconTag size={16} strokeWidth={1.5} /> },
  { pane: "phone", icon: <IconPhone size={16} strokeWidth={1.5} /> },
];

/** The open post's panel (Düzenle / Sohbet): its icon comes first while a post is open. */
const POST_TOOL = { pane: "post" as const, icon: <IconSliders size={16} strokeWidth={1.5} /> };

export function PanelTools() {
  const panelPresented = useAppStore((s) => s.panelPresented);
  const panelPane = useAppStore((s) => s.panelPane);
  const postOpen = useWorkspaceStore((s) => s.active !== null);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const more: MenuEntry[] = [
    { id: "reload", label: "Yenile", shortcut: "Y", onSelect: () => window.location.reload() },
    { id: "search", label: "Ara", shortcut: "K", onSelect: () => setSearchOpen(true) },
    { type: "separator" },
    { id: "settings", label: "Ayarlar", shortcut: ",", onSelect: () => setSettingsOpen(true) },
  ];
  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Sağ panel">
      {(postOpen ? [POST_TOOL, ...TOOLS] : TOOLS).map((tool) => (
        <IconButton
          key={tool.pane}
          icon={tool.icon}
          label={panelTitle(tool.pane)}
          shortcut={"shortcut" in tool ? tool.shortcut : undefined}
          selected={panelPresented && panelPane === tool.pane}
          onClick={() => togglePanel(tool.pane)}
        />
      ))}
      <MenuButton entries={more} placement="bottom-end" label="Diğer">
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <IconButton
            ref={ref}
            icon={<IconEllipsis size={16} strokeWidth={1.5} />}
            label="Diğer"
            selected={open}
            onClick={onClick}
            onKeyDown={onKeyDown}
            {...aria}
          />
        )}
      </MenuButton>
    </div>
  );
}

export function PanelHeader() {
  const pane = useAppStore((s) => s.panelPane);
  const postOpen = useWorkspaceStore((s) => s.active !== null);
  const expanded = useAppStore((s) => panelWidthOf(s) >= PANEL_WIDTH_EXPANDED);
  const toggleExpanded = useAppStore((s) => s.togglePanelExpanded);
  const close = useAppStore((s) => s.closePanel);
  return (
    <div className="flex h-full items-center gap-0.5 pr-2 pl-4">
      {pane === "post" && postOpen ? (
        // The open post's panel brings its own title (Düzenle's tabs, Sohbet's actions).
        <WorkspaceSlot
          name="panel-header"
          className="flex h-full min-w-0 flex-1 items-center gap-1"
        />
      ) : (
        <h2 className="min-w-0 flex-1 truncate text-body font-medium text-fg">
          {panelTitle(pane)}
        </h2>
      )}
      <IconButton
        icon={
          expanded ? (
            <IconMinimize size={14} strokeWidth={1.5} />
          ) : (
            <IconMaximize size={14} strokeWidth={1.5} />
          )
        }
        label={expanded ? "Daralt" : "Genişlet"}
        onClick={toggleExpanded}
      />
      <IconButton
        icon={<IconClose size={16} strokeWidth={1.5} />}
        label="Paneli kapat"
        shortcut="⌥⌘I"
        onClick={close}
      />
    </div>
  );
}

/** "Kasım kampanya postları ⌄": menu on click, inline rename on double-click (or ⌘R menu). */
function TitleButton() {
  const route = useAppStore((s) => s.route);
  const renameRequest = useAppStore((s) => s.renameRequest);
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const conversations = useConversations();
  const brands = useBrands();
  const actions = useConversationActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement | null>(null);
  const lastRename = useRef(renameRequest);
  const conversation =
    route.kind === "conversation"
      ? (conversations.data ?? []).find((c) => c.id === route.id)
      : undefined;

  useEffect(() => {
    if (renameRequest === lastRename.current) return;
    lastRename.current = renameRequest;
    if (conversation) {
      setDraft(conversation.title);
      setEditing(true);
    }
  }, [renameRequest, conversation]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (route.kind === "gallery") {
    return <span className="px-2.5 text-body-lg text-fg">Bileşen galerisi</span>;
  }
  if (route.kind === "posts") return <PostsTitleButton />;
  if (isPageRoute(route)) return <PageTitle route={route} />;

  if (editing && conversation) {
    const commit = async () => {
      setEditing(false);
      if (draft.trim() && draft.trim() !== conversation.title) {
        await actions.rename(conversation.id, draft);
      }
    };
    return (
      <input
        ref={input}
        aria-label="Sohbet adı"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="no-drag selectable h-7 w-[320px] rounded-full bg-field px-2.5 text-body-lg text-fg shadow-[inset_0_0_0_1px_var(--border-default)] outline-none"
      />
    );
  }

  const isNew = route.kind === "new";
  const activeBrands = (brands.data ?? []).filter((b) => b.status === "active");
  const title = isNew ? "Yeni sohbet" : conversation?.title || "Adsız sohbet";
  const entries = (): MenuEntry[] =>
    isNew
      ? [
          { type: "label", label: "Marka" },
          ...activeBrands.map((b, i) => ({
            id: b.id,
            label: b.name,
            checked: b.id === currentBrandId,
            shortcut: i < 9 ? String(i + 1) : undefined,
            onSelect: () => setCurrentBrand(b.id),
          })),
          { type: "separator" },
          {
            id: "none",
            label: "Markasız",
            checked: currentBrandId === null,
            onSelect: () => setCurrentBrand(null),
          },
        ]
      : conversation
        ? actions.menu(conversation)
        : [];
  const brandName = isNew ? activeBrands.find((b) => b.id === currentBrandId)?.name : undefined;
  return (
    <MenuButton entries={entries} placement="bottom-start" label="Sohbet menüsü" width={248}>
      {({ ref, onClick, onKeyDown, open, ...aria }) => (
        <button
          ref={ref}
          type="button"
          {...aria}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onDoubleClick={() => {
            if (!conversation) return;
            setDraft(conversation.title);
            setEditing(true);
          }}
          className={cn(
            "no-drag flex h-7 max-w-[420px] min-w-0 items-center gap-1.5 rounded-full px-2.5 text-body-lg text-fg transition-colors hover:bg-control",
            open && "bg-control",
          )}
        >
          <span className="truncate">{title}</span>
          {brandName && <span className="truncate text-fg-2">· {brandName}</span>}
          <IconChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-fg-2" />
        </button>
      )}
    </MenuButton>
  );
}

export function TopBar({ panelWidth }: { panelWidth: number | null }) {
  const sidebarPresented = useAppStore((s) => s.sidebarPresented);
  const fullScreen = useAppStore((s) => s.window.fullScreen);
  const postOpen = useWorkspaceStore((s) => s.active !== null);
  return (
    <header
      className="drag flex shrink-0 border-b border-hairline"
      style={{ height: TOP_BAR_HEIGHT }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 pr-2">
        {!sidebarPresented ? <WindowControls inset={!fullScreen} /> : <span className="w-1" />}
        {postOpen ? (
          // The open post's title, state, versions and its approve / schedule actions.
          <WorkspaceSlot
            name="title"
            className="@container flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden"
          />
        ) : (
          <>
            <TitleButton />
            <div className="flex-1" />
          </>
        )}
        <PanelTools />
      </div>
      {panelWidth !== null && (
        <div className="h-full shrink-0 border-l border-hairline" style={{ width: panelWidth }}>
          <PanelHeader />
        </div>
      )}
    </header>
  );
}
