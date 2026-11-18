// Window overlays: ⌘K search palette and the host status banner (Ayarlar lives in
// features/settings).
//
// The palette searches conversation titles, posts (title and caption), brands and media (file
// name, and the open conversation's @aliases); results come in groups. The field is a combobox
// over one listbox (aria-activedescendant), and the palette is modal (focus trap, Esc).
import type { Asset, Brand, Content, Conversation, ConversationAlias } from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { openPostDetail } from "../../features/posts/store.ts";
import { useApi } from "../../lib/api.ts";
import { formatAgo } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  isHostUp,
  useBrands,
  useConversationCache,
  useConversations,
  useHost,
} from "../../state/studio.tsx";
import { Button, cn, SearchField } from "../ui/controls.tsx";
import { IconChat, IconGrid, IconImage, IconPlus, IconTag, IconWarning } from "../ui/icons.tsx";
import { useModal } from "../ui/modal.ts";

/** Turkish-insensitive match ("İ" / "i", "ş" / "s" …). */
export function fold(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function searchConversations(list: Conversation[], query: string): Conversation[] {
  const q = fold(query.trim());
  if (!q) return list.slice(0, 12);
  return list.filter((c) => fold(c.title).includes(q)).slice(0, 30);
}

export type SearchKind = "conversation" | "post" | "brand" | "media" | "new";

export interface SearchItem {
  /** Unique in the list (also the option's DOM id suffix). */
  key: string;
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  asset?: Pick<Asset, "id" | "width" | "height"> | undefined;
}

export interface SearchGroup {
  id: Exclude<SearchKind, "new">;
  label: string;
  items: SearchItem[];
}

export interface SearchSources {
  conversations: Conversation[];
  contents: Content[];
  brands: Brand[];
  assets: Asset[];
  /** The open conversation's image names. */
  aliases: ConversationAlias[];
}

/** A short piece of `text` around the match (captions are long). */
export function snippet(text: string, query: string, width = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = fold(flat).indexOf(fold(query));
  if (at === -1 || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${piece}${start + width < flat.length ? "…" : ""}`;
}

const GROUP_LIMIT = 6;

/** Grouped results: conversations, posts, brands, media (empty query: recent conversations). */
export function searchAll(sources: SearchSources, query: string): SearchGroup[] {
  const q = fold(query.trim());
  const brandName = (id: string | null) =>
    sources.brands.find((b) => b.id === id)?.name ?? (id ? "Arşivlenmiş marka" : "Genel");
  const conversations = searchConversations(sources.conversations, query)
    .slice(0, q ? GROUP_LIMIT : 8)
    .map<SearchItem>((c) => ({
      key: `conversation-${c.id}`,
      kind: "conversation",
      id: c.id,
      title: c.title || "Adsız sohbet",
      subtitle: `${brandName(c.brandId)} · ${formatAgo(c.lastActivityAt)}`,
    }));
  if (!q) return [{ id: "conversation", label: "Sohbetler", items: conversations }];
  const posts = sources.contents
    .filter((c) => !c.deletedAt && (fold(c.title).includes(q) || fold(c.caption).includes(q)))
    .slice(0, GROUP_LIMIT)
    .map<SearchItem>((c) => ({
      key: `post-${c.id}`,
      kind: "post",
      id: c.id,
      title: c.title || "Adsız post",
      subtitle: fold(c.title).includes(q)
        ? brandName(c.brandId)
        : `${brandName(c.brandId)} · ${snippet(c.caption, query)}`,
    }));
  const brands = sources.brands
    .filter((b) => b.status === "active" && fold(b.name).includes(q))
    .slice(0, GROUP_LIMIT)
    .map<SearchItem>((b) => ({
      key: `brand-${b.id}`,
      kind: "brand",
      id: b.id,
      title: b.name,
      subtitle: "Marka profili",
    }));
  const media: SearchItem[] = [];
  for (const a of sources.aliases) {
    if (![a.alias, ...a.previousAliases].some((name) => fold(name).includes(q))) continue;
    media.push({
      key: `alias-${a.id}`,
      kind: "media",
      id: a.assetId,
      title: `@${a.alias}`,
      subtitle: "Bu sohbetteki görsel",
      asset: { id: a.assetId, width: a.width, height: a.height },
    });
  }
  for (const a of sources.assets) {
    if (media.length >= GROUP_LIMIT) break;
    if (a.deletedAt || !a.originalFilename || !fold(a.originalFilename).includes(q)) continue;
    if (media.some((m) => m.id === a.id)) continue;
    media.push({
      key: `asset-${a.id}`,
      kind: "media",
      id: a.id,
      title: a.originalFilename,
      subtitle: `${brandName(a.brandId)} · Medya`,
      asset: { id: a.id, width: a.width, height: a.height },
    });
  }
  return [
    { id: "conversation" as const, label: "Sohbetler", items: conversations },
    { id: "post" as const, label: "Postlar", items: posts },
    { id: "brand" as const, label: "Markalar", items: brands },
    { id: "media" as const, label: "Medya", items: media.slice(0, GROUP_LIMIT) },
  ].filter((g) => g.items.length > 0);
}

const NEW_CHAT: SearchItem = {
  key: "new-chat",
  kind: "new",
  id: "new",
  title: "Yeni sohbet",
  subtitle: "⌘N",
};

const KIND_ICON = {
  conversation: IconChat,
  post: IconGrid,
  brand: IconTag,
  media: IconImage,
  new: IconPlus,
} as const;

/** Posts and media for the palette (fetched while it is open; one page of the newest each). */
function useSearchSources(open: boolean, query: string) {
  const api = useApi();
  const up = isHostUp(useHost());
  const typed = query.trim().length > 0;
  const contents = useQuery({
    queryKey: ["search", "contents"],
    queryFn: async () => (await api.contents.list({ limit: 100 })).items,
    enabled: open && up && typed,
    staleTime: 30_000,
  });
  const assets = useQuery({
    queryKey: ["search", "assets"],
    queryFn: async () => (await api.assets.list({ limit: 100, kind: "image" })).items,
    enabled: open && up && typed,
    staleTime: 30_000,
  });
  return { contents, assets };
}

export function SearchPalette() {
  const open = useAppStore((s) => s.searchOpen);
  if (!open) return null;
  return <SearchPanel />;
}

function SearchPanel() {
  const setOpen = useAppStore((s) => s.setSearchOpen);
  const navigate = useAppStore((s) => s.navigate);
  const route = useAppStore((s) => s.route);
  const conversations = useConversations();
  const brands = useBrands();
  const cache = useConversationCache();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const close = () => setOpen(false);
  useModal(panel, { open: true, onClose: close, initialFocus: "input" });
  const { contents, assets } = useSearchSources(true, query);
  const aliases =
    route.kind === "conversation" ? (cache?.peek(route.id)?.state?.aliases ?? []) : [];
  const groups = useMemo(
    () =>
      searchAll(
        {
          conversations: conversations.data ?? [],
          contents: contents.data ?? [],
          brands: brands.data ?? [],
          assets: assets.data ?? [],
          aliases,
        },
        query,
      ),
    [conversations.data, contents.data, brands.data, assets.data, aliases, query],
  );
  const options = useMemo(() => [...groups.flatMap((g) => g.items), NEW_CHAT], [groups]);
  useEffect(() => setActive(0), [query]);
  const current = Math.min(active, options.length - 1);
  const optionId = (item: SearchItem) => `${listId}-${item.key}`;
  const activeItem = options[current];

  // The active option stays in view.
  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(optionId(activeItem))?.scrollIntoView({ block: "nearest" });
  });

  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    close();
    switch (item.kind) {
      case "new":
        navigate({ kind: "new" });
        useAppStore.getState().requestComposerFocus();
        return;
      case "conversation":
        navigate({ kind: "conversation", id: item.id });
        return;
      case "post":
        openPostDetail(item.id);
        return;
      case "brand":
        navigate({ kind: "brand", id: item.id });
        return;
      case "media":
        useAppStore.getState().openLightbox({
          images: [
            {
              assetId: item.id,
              width: item.asset?.width ?? null,
              height: item.asset?.height ?? null,
              caption: item.title,
            },
          ],
          index: 0,
        });
        return;
    }
  };

  const loading = query.trim() !== "" && (contents.isFetching || assets.isFetching);
  const failed = contents.isError || assets.isError;
  const empty = groups.length === 0 && !loading;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes (Esc does too)
    <div
      className="fixed inset-0 z-[96] flex justify-center bg-black/20 pt-[14vh] animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Ara"
        tabIndex={-1}
        className="glass h-fit w-[560px] animate-pop-in overflow-hidden rounded-[14px] outline-none"
      >
        <div className="p-2.5">
          <SearchField
            className="w-full"
            placeholder="Sohbet, post, marka ya da görsel ara"
            aria-label="Ara"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive(Math.min(current + 1, options.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(current - 1, 0));
              } else if (e.key === "Home" && e.metaKey) {
                setActive(0);
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(activeItem);
              }
            }}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Sonuçlar"
          className="scroll-area max-h-[400px] border-t border-hairline p-1"
        >
          {failed && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-footnote text-fg-3">
              <IconWarning size={12} /> Postlar ya da medya şu an aranamıyor.
            </p>
          )}
          {groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
            <div key={group.id} role="group" aria-labelledby={`${listId}-${group.id}`}>
              <div
                id={`${listId}-${group.id}`}
                className="px-2.5 pt-2 pb-1 text-caption font-medium text-fg-3"
              >
                {group.label}
              </div>
              {group.items.map((item) => (
                <Option
                  key={item.key}
                  id={optionId(item)}
                  item={item}
                  selected={item === activeItem}
                  onHover={() => setActive(options.indexOf(item))}
                  onChoose={() => choose(item)}
                />
              ))}
            </div>
          ))}
          {empty && <p className="px-3 py-3 text-body text-fg-3">Sonuç yok.</p>}
          {loading && <p className="px-3 py-2 text-footnote text-fg-3">Aranıyor…</p>}
          <div className="mt-1 border-t border-hairline pt-1">
            <Option
              id={optionId(NEW_CHAT)}
              item={NEW_CHAT}
              selected={activeItem === NEW_CHAT}
              onHover={() => setActive(options.length - 1)}
              onChoose={() => choose(NEW_CHAT)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Option({
  id,
  item,
  selected,
  onHover,
  onChoose,
}: {
  id: string;
  item: SearchItem;
  selected: boolean;
  onHover(): void;
  onChoose(): void;
}) {
  const Icon = KIND_ICON[item.kind];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the field's arrows and ↩ choose (activedescendant)
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex h-9 w-full cursor-default items-center gap-2.5 rounded-[8px] px-2.5 text-left",
        selected && "bg-control",
      )}
    >
      <Icon size={14} className="shrink-0 text-icon" />
      <span className="min-w-0 flex-1 truncate text-body text-fg">{item.title}</span>
      <span className="max-w-[55%] shrink-0 truncate text-caption text-fg-3">{item.subtitle}</span>
    </div>
  );
}

/** A thin line under the top bar while the host starts or after it failed. */
export function HostBanner() {
  const host = useHost();
  const status = host?.status;
  if (!status || status.kind === "running" || status.kind === "attached") return null;
  if (status.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 border-b border-hairline bg-danger/8 px-4 py-2 text-body text-fg"
      >
        <IconWarning size={15} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="selectable">{status.message}</div>
          {status.log && (
            <pre className="selectable mt-1 max-h-24 overflow-auto font-mono text-caption text-fg-2">
              {status.log}
            </pre>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={() => void window.studio?.host.restart()}>
          Yeniden dene
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-4 py-1.5 text-footnote text-fg-2">
      <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      {status.kind === "starting" ? status.message : "Studio sunucusu kapalı"}
    </div>
  );
}
