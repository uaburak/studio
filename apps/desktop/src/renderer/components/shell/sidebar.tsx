// Left sidebar (Wecra "Sidebar"): window controls row, navigation rows, conversations grouped
// by brand (collapsible), footer with avatar, name, brand menu and settings.
import type { Brand, Conversation } from "@studio/contract";
import { type ReactNode, useMemo } from "react";
import { useAppStore } from "../../state/app-store.ts";
import { useBrands, useConversations, useHost, useJobs, useSettings } from "../../state/studio.tsx";
import { cn, IconButton, WorkingDots } from "../ui/controls.tsx";
import {
  IconCalendar,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconEllipsis,
  IconGrid,
  IconImage,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconTag,
} from "../ui/icons.tsx";
import { MenuButton, type MenuEntry, useContextMenu } from "../ui/menu.tsx";
import { useConversationActions } from "./conversation-actions.ts";

export const SIDEBAR_WIDTH = 265;

/** Traffic lights (18 + 52) and the 24 pt gap Claude leaves before its buttons. */
export function WindowControls({ inset }: { inset: boolean }) {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const goBack = useAppStore((s) => s.goBack);
  const goForward = useAppStore((s) => s.goForward);
  const canBack = useAppStore((s) => s.back.length > 0);
  const canForward = useAppStore((s) => s.forward.length > 0);
  return (
    <div className="flex h-11 shrink-0 items-center" style={{ paddingLeft: inset ? 94 : 12 }}>
      <IconButton
        icon={<IconSidebar size={16} strokeWidth={1.5} />}
        label="Kenar çubuğu"
        shortcut="⌘\"
        onClick={toggleSidebar}
      />
      <IconButton
        icon={<IconChevronLeft size={16} strokeWidth={1.5} />}
        label="Geri"
        shortcut="⌘["
        disabled={!canBack}
        onClick={goBack}
      />
      <IconButton
        icon={<IconChevronRight size={16} strokeWidth={1.5} />}
        label="İleri"
        shortcut="⌘]"
        disabled={!canForward}
        onClick={goForward}
      />
    </div>
  );
}

export function SidebarRow({
  icon,
  label,
  selected,
  onClick,
  trailing,
  shortcut,
  onContextMenu,
  className,
}: {
  icon?: ReactNode;
  label: string;
  selected?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
  shortcut?: string;
  onContextMenu?: (event: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: the row holds its own "…" button; buttons cannot nest
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? "page" : undefined}
      data-selected={selected || undefined}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      }}
      title={shortcut ? `${label} (${shortcut})` : undefined}
      className={cn(
        "group no-drag relative mx-2 flex h-8 items-center gap-2.5 rounded-full px-2.5 text-body text-fg",
        "transition-colors duration-150 hover:bg-control data-[selected]:bg-selected",
        className,
      )}
    >
      {icon && (
        <span className="flex size-4 shrink-0 items-center justify-center text-icon">{icon}</span>
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </div>
  );
}

export function GroupHeader({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="no-drag mx-2 mt-2.5 flex h-7 items-center gap-1 rounded-full px-2.5 text-footnote text-fg-3 transition-colors hover:text-fg-2"
    >
      <span className="truncate">{label}</span>
      {expanded ? (
        <IconChevronDown size={12} strokeWidth={1.75} />
      ) : (
        <IconChevronRight size={12} strokeWidth={1.75} />
      )}
    </button>
  );
}

export function ConversationRow({
  conversation,
  selected,
  running,
  onOpen,
  menu,
}: {
  conversation: Conversation;
  selected: boolean;
  running: boolean;
  onOpen(): void;
  menu: MenuEntry[];
}) {
  const context = useContextMenu();
  return (
    <>
      <SidebarRow
        label={conversation.title || "Adsız sohbet"}
        selected={selected}
        onClick={onOpen}
        onContextMenu={(event) => context.open(event, menu)}
        trailing={
          <span className="flex shrink-0 items-center">
            {running && (
              <span className="group-hover:hidden group-data-[selected]:hidden" title="Çalışıyor">
                <WorkingDots size={14} />
              </span>
            )}
            <MenuButton entries={menu} placement="bottom-start" label="Sohbet">
              {({ ref, onClick, onKeyDown, open, ...aria }) => (
                <button
                  ref={ref}
                  type="button"
                  aria-label="Sohbet seçenekleri"
                  {...aria}
                  onKeyDown={onKeyDown}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClick();
                  }}
                  className={cn(
                    "-mr-1 size-5 items-center justify-center rounded-full text-fg-2 hover:bg-control-hover hover:text-fg",
                    open ? "flex" : "hidden group-hover:flex group-data-[selected]:flex",
                  )}
                >
                  <IconEllipsis size={14} />
                </button>
              )}
            </MenuButton>
          </span>
        }
      />
      {context.element}
    </>
  );
}

interface Group {
  id: string;
  label: string;
  conversations: Conversation[];
}

/** Brands with conversations (most recent activity first), then "Genel" for brand-less ones. */
export function groupConversations(
  conversations: Conversation[],
  brands: Brand[],
  currentBrandId: string | null,
): Group[] {
  const byBrand = new Map<string, Conversation[]>();
  const general: Conversation[] = [];
  for (const c of conversations) {
    if (!c.brandId) {
      general.push(c);
      continue;
    }
    byBrand.set(c.brandId, [...(byBrand.get(c.brandId) ?? []), c]);
  }
  const latest = (list: Conversation[]) =>
    Math.max(...list.map((c) => Date.parse(c.lastActivityAt)));
  const groups: Group[] = [];
  for (const brand of brands) {
    const list = byBrand.get(brand.id);
    if (list?.length || brand.id === currentBrandId) {
      groups.push({ id: brand.id, label: brand.name, conversations: list ?? [] });
    }
  }
  // Conversations of brands not in the list (archived brands) still show, under their id.
  for (const [brandId, list] of byBrand) {
    if (!groups.some((g) => g.id === brandId))
      groups.push({ id: brandId, label: "Arşivlenmiş marka", conversations: list });
  }
  groups.sort((a, b) => (latest(b.conversations) || 0) - (latest(a.conversations) || 0));
  groups.push({ id: "general", label: "Genel", conversations: general });
  return groups;
}

export function Sidebar() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const collapsed = useAppStore((s) => s.collapsedGroups);
  const toggleGroup = useAppStore((s) => s.toggleGroup);
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const fullScreen = useAppStore((s) => s.window.fullScreen);
  const brands = useBrands();
  const conversations = useConversations();
  const actions = useConversationActions();
  const groups = useMemo(
    () =>
      groupConversations(
        conversations.data ?? [],
        (brands.data ?? []).filter((b) => b.status === "active"),
        currentBrandId,
      ),
    [conversations.data, brands.data, currentBrandId],
  );

  return (
    <aside
      aria-label="Kenar çubuğu"
      className="sidebar-surface flex h-full shrink-0 flex-col border-r border-hairline"
      style={{ width: SIDEBAR_WIDTH }}
    >
      <div className="drag">
        <WindowControls inset={!fullScreen} />
      </div>
      <nav className="flex shrink-0 flex-col gap-0 pt-0.5 pb-1">
        <SidebarRow
          icon={<IconPlus size={16} strokeWidth={1.5} />}
          label="Yeni sohbet"
          shortcut="⌘N"
          selected={route.kind === "new"}
          onClick={() => navigate({ kind: "new" })}
        />
        <SidebarRow
          icon={<IconSearch size={16} strokeWidth={1.5} />}
          label="Ara"
          shortcut="⌘K"
          onClick={() => setSearchOpen(true)}
        />
        <SidebarRow
          icon={<IconGrid size={16} strokeWidth={1.5} />}
          label="Postlar"
          selected={route.kind === "posts"}
          onClick={() => navigate({ kind: "posts" })}
        />
        <SidebarRow
          icon={<IconCalendar size={16} strokeWidth={1.5} />}
          label="Takvim"
          selected={route.kind === "calendar"}
          onClick={() => navigate({ kind: "calendar" })}
        />
        <SidebarRow
          icon={<IconImage size={16} strokeWidth={1.5} />}
          label="Medya"
          selected={route.kind === "media"}
          onClick={() => navigate({ kind: "media" })}
        />
        <SidebarRow
          icon={<IconTag size={16} strokeWidth={1.5} />}
          label="Markalar"
          selected={route.kind === "brand"}
          onClick={() =>
            currentBrandId ? navigate({ kind: "brand", id: currentBrandId }) : togglePanel("brand")
          }
        />
      </nav>
      <div className="scroll-area min-h-0 flex-1 pb-3">
        {conversations.isLoading && (
          <p className="px-5 pt-3 text-footnote text-fg-3">Sohbetler yükleniyor…</p>
        )}
        {groups.map((group) => {
          if (group.conversations.length === 0 && group.id === "general") return null;
          const expanded = !collapsed.includes(group.id);
          return (
            <section key={group.id} aria-label={group.label} className="flex flex-col">
              <GroupHeader
                label={group.label}
                expanded={expanded}
                onToggle={() => toggleGroup(group.id)}
              />
              {expanded &&
                group.conversations.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    selected={route.kind === "conversation" && route.id === c.id}
                    running={c.activeRunId !== null}
                    onOpen={() => navigate({ kind: "conversation", id: c.id })}
                    menu={actions.menu(c)}
                  />
                ))}
            </section>
          );
        })}
      </div>
      <SidebarFooter brands={brands.data ?? []} />
    </aside>
  );
}

function SidebarFooter({ brands }: { brands: Brand[] }) {
  const { settings } = useSettings();
  const { presence } = useJobs();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const setCurrentBrand = useAppStore((s) => s.setCurrentBrand);
  const host = useHost();
  const name = settings.ownerName.trim() || presence?.claude?.displayName || "Burak";
  const brand = brands.find((b) => b.id === currentBrandId);
  const active = brands.filter((b) => b.status === "active");
  const entries: MenuEntry[] = [
    { type: "label", label: "Marka" },
    ...active.map((b, i) => ({
      id: b.id,
      label: b.name,
      checked: b.id === currentBrandId,
      shortcut: i < 9 ? String(i + 1) : undefined,
      onSelect: () => setCurrentBrand(b.id),
    })),
  ];
  return (
    <footer className="flex h-[52px] shrink-0 items-center gap-2 border-t border-hairline pr-2.5 pl-4">
      <div className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-on-accent">
        {name.charAt(0).toLocaleUpperCase("tr-TR")}
      </div>
      <MenuButton entries={entries} placement="top-start" label="Marka" width={220}>
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            {...aria}
            onClick={onClick}
            onKeyDown={onKeyDown}
            className="no-drag flex min-w-0 flex-1 items-center gap-1 rounded-full py-1 text-left"
          >
            <span className="truncate text-body font-medium text-fg">{name}</span>
            <span className="truncate text-footnote text-fg-2">· {brand?.name ?? "Studio"}</span>
            <IconChevronDown size={12} className={cn("shrink-0 text-fg-3", open && "text-fg-2")} />
          </button>
        )}
      </MenuButton>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          host?.status.kind === "error" ? "bg-danger" : presence?.online ? "bg-success" : "bg-fg-3",
        )}
        title={presence?.online ? "Mac hazır" : "Mac çevrimdışı"}
      />
      <IconButton
        icon={<IconSettings size={16} strokeWidth={1.5} />}
        label="Ayarlar"
        shortcut="⌘,"
        onClick={() => useAppStore.getState().setSettingsOpen(true)}
      />
    </footer>
  );
}
