// The posts screen (Wecra "Postlar"): month with ‹ ›, post count, search, "+ Yeni post", the
// status filters with counts, and a responsive grid of 4:5 cards — the current brand's, or
// every brand's grouped by brand. Keys: arrows move the selection, ↩ opens, Space quick look,
// ⌫ deletes (after confirming), ⌘D duplicates, ⌘F searches, Esc clears the selection.
import type { Brand } from "@studio/contract";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  Button,
  cn,
  IconButton,
  SearchField,
  SegmentedControl,
  Spinner,
} from "../../components/ui/controls.tsx";
import { IconChevronLeft, IconChevronRight, IconPlus } from "../../components/ui/icons.tsx";
import { type MenuEntry, useContextMenu } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { startChat } from "../../state/chat-draft.ts";
import { isHostUp, useBrands, useHost } from "../../state/studio.tsx";
import { usePostActions } from "./actions.ts";
import {
  boardMonths,
  deletionBlocker,
  groupByBrand,
  monthWithPosts,
  moveSelection,
  nearestMonth,
  POST_FILTERS,
  type PostCard,
  type PostFilter,
  visibleCards,
} from "./board.ts";
import { useBoard } from "./data.ts";
import { addMonths, monthKeyOf, monthName, monthTitle } from "./dates.ts";
import { PostCardView } from "./post-card.tsx";
import { usePostsStore } from "./store.ts";

/** Columns of a CSS grid as laid out now (arrow keys move by rows). */
export function gridColumns(el: Element | null): number {
  if (!el) return 1;
  const template = getComputedStyle(el).gridTemplateColumns;
  const count = template.split(" ").filter((t) => t && t !== "none").length;
  return Math.max(1, count);
}

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(212px,1fr))] gap-x-7 gap-y-6";

export function PostsPage() {
  const brands = useBrands();
  const host = useHost();
  const currentBrandId = useAppStore((s) => s.currentBrandId);
  const allBrands = usePostsStore((s) => s.allBrands);
  const scope = allBrands ? null : currentBrandId;
  const board = useBoard(scope, allBrands || currentBrandId !== null);
  const brandList = brands.data ?? [];
  const brandName = useCallback(
    (id: string) => brandList.find((b) => b.id === id)?.name,
    [brandList],
  );

  if (!allBrands && !currentBrandId) {
    return (
      <PageShell>
        <EmptyState
          title="Marka seçilmedi"
          detail="Postlarını görmek için başlıktaki menüden bir marka seç."
          actions={
            <Button variant="secondary" onClick={() => usePostsStore.getState().setAllBrands(true)}>
              Tüm markaları göster
            </Button>
          }
        />
      </PageShell>
    );
  }
  return (
    <Board
      cards={board.cards}
      loading={board.isLoading || !isHostUp(host)}
      error={board.error ? describeError(board.error) : null}
      onRetry={board.refetch}
      brands={brandList}
      brandName={brandName}
      grouped={allBrands}
      brandId={currentBrandId}
    />
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export function Board({
  cards,
  loading,
  error,
  onRetry,
  brands,
  brandName,
  grouped,
  brandId,
  now = new Date(),
}: {
  cards: PostCard[];
  loading: boolean;
  error: string | null;
  onRetry(): void;
  brands: Brand[];
  brandName(id: string): string | undefined;
  grouped: boolean;
  brandId: string | null;
  now?: Date;
}) {
  const storedMonth = usePostsStore((s) => s.month);
  const filter = usePostsStore((s) => s.filter);
  const query = usePostsStore((s) => s.query);
  const selectedId = usePostsStore((s) => s.selectedId);
  const openedId = usePostsStore((s) => s.opened?.contentId ?? null);
  const store = usePostsStore.getState;
  const actions = usePostActions();
  const context = useContextMenu();
  const months = useMemo(() => boardMonths(cards), [cards]);
  const thisMonth = monthKeyOf(now);
  const month = storedMonth ?? nearestMonth(months, thisMonth);
  const view = useMemo(
    () => visibleCards(cards, { month, filter, query, brandName }),
    [cards, month, filter, query, brandName],
  );
  const groups = useMemo(
    () =>
      grouped
        ? groupByBrand(
            view.cards,
            brands.map((b) => b.id),
          )
        : [{ brandId: brandId ?? "", cards: view.cards }],
    [grouped, view.cards, brands, brandId],
  );
  const ordered = useMemo(() => groups.flatMap((g) => g.cards), [groups]);
  const gridRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  // The first load picks the month with the nearest posts; keep it once the owner moves.
  useEffect(() => {
    if (storedMonth === null && !loading && cards.length > 0) store().setMonth(month);
  }, [storedMonth, loading, cards.length, month, store]);

  useLayoutEffect(() => {
    if (selectedId) itemRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  useEffect(() => {
    if (!openedId && document.activeElement === document.body) gridRef.current?.focus();
  }, [openedId]);

  const cardActions = {
    open: (card: PostCard, origin: DOMRect | null) => {
      store().select(card.id);
      store().open(card.id, {
        origin: origin
          ? { x: origin.left, y: origin.top, width: origin.width, height: origin.height }
          : null,
      });
    },
    quickLook: (card: PostCard, source: Element | null) =>
      actions.quickLook(card.content, card.version, { source }),
    copyCaption: (card: PostCard) => void actions.copyCaption(card.content),
    duplicate: (card: PostCard) => void actions.duplicate(card.content),
    remove: (card: PostCard) => actions.askDelete(card.content),
    contextMenu: (card: PostCard, event: React.MouseEvent) => {
      store().select(card.id);
      context.open(event, menuFor(card));
    },
  };

  const media = (id: string) => itemRefs.current.get(id)?.querySelector("[data-media]") ?? null;
  const mediaRect = (id: string) => media(id)?.getBoundingClientRect() ?? null;

  const menuFor = (card: PostCard): MenuEntry[] => {
    const blocker = deletionBlocker(card.content);
    return [
      { id: "open", label: "Aç", onSelect: () => cardActions.open(card, mediaRect(card.id)) },
      {
        id: "quicklook",
        label: "Hızlı bakış",
        shortcut: "␣",
        disabled: !card.version?.slides.some((s) => s.renderedAssetId),
        onSelect: () => cardActions.quickLook(card, media(card.id)),
      },
      { type: "separator" },
      {
        id: "caption",
        label: "Açıklamayı kopyala",
        disabled: !card.content.caption.trim(),
        onSelect: () => cardActions.copyCaption(card),
      },
      {
        id: "duplicate",
        label: "Çoğalt",
        shortcut: "D",
        onSelect: () => cardActions.duplicate(card),
      },
      { type: "separator" },
      {
        id: "delete",
        label: "Sil…",
        danger: true,
        disabled: !!blocker,
        ...(blocker ? { detail: blocker } : {}),
        onSelect: () => cardActions.remove(card),
      },
    ];
  };

  const selected = ordered.find((c) => c.id === selectedId) ?? null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const columns = gridColumns(gridRef.current?.querySelector("ul") ?? null);
    const ids = ordered.map((c) => c.id);
    const move = (offset: number) => {
      event.preventDefault();
      store().select(moveSelection(ids, selectedId, offset));
    };
    if (plain) {
      switch (event.key) {
        case "ArrowLeft":
          return move(-1);
        case "ArrowRight":
          return move(1);
        case "ArrowUp":
          return move(-columns);
        case "ArrowDown":
          return move(columns);
        case "Enter":
          if (selected) {
            event.preventDefault();
            cardActions.open(selected, mediaRect(selected.id));
          }
          return;
        case " ":
          event.preventDefault();
          if (selected) cardActions.quickLook(selected, media(selected.id));
          return;
        case "Backspace":
        case "Delete":
          if (selected) {
            event.preventDefault();
            cardActions.remove(selected);
          }
          return;
        case "Escape":
          if (selectedId) {
            event.preventDefault();
            store().select(null);
          }
          return;
      }
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      if (event.key.toLowerCase() === "d" && selected) {
        event.preventDefault();
        cardActions.duplicate(selected);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
  };

  const earlier = monthWithPosts(months, month, -1);
  const later = monthWithPosts(months, month, 1);
  const filterLabel = POST_FILTERS.find((f) => f.id === filter)?.label ?? "";

  let body: React.ReactNode;
  if (loading && cards.length === 0) {
    body = (
      <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
        <Spinner /> Postlar yükleniyor…
      </div>
    );
  } else if (error && cards.length === 0) {
    body = (
      <EmptyState
        title="Postlar yüklenemedi"
        detail={error}
        actions={
          <Button variant="secondary" onClick={onRetry}>
            Yeniden dene
          </Button>
        }
      />
    );
  } else if (ordered.length === 0) {
    body =
      view.monthTotal > 0 ? (
        <EmptyState
          title={
            query.trim() ? "Sonuç yok" : `${monthName(month)} ayında “${filterLabel}” post yok`
          }
          detail={query.trim() ? `“${query.trim()}” ile eşleşen post yok.` : "Başka bir durum seç."}
          actions={
            <Button
              variant="secondary"
              onClick={() => {
                store().setFilter("all");
                store().setQuery("");
              }}
            >
              Tümünü göster
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={`${monthTitle(month)} için post yok`}
          detail="Sohbette bir plan iste ya da başka bir aya geç."
          actions={
            <>
              {earlier && (
                <Button variant="secondary" onClick={() => store().setMonth(earlier)}>
                  ‹ {monthName(earlier)}
                </Button>
              )}
              {later && (
                <Button variant="secondary" onClick={() => store().setMonth(later)}>
                  {monthName(later)} ›
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() =>
                  startChat(
                    `${monthName(month)} ayı için post planı hazırla.`,
                    brandId ?? undefined,
                  )
                }
              >
                Sohbette plan iste
              </Button>
            </>
          }
        />
      );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <section key={group.brandId} aria-label={brandName(group.brandId) ?? "Postlar"}>
            {grouped && (
              <h2 className="mb-3 flex items-baseline gap-2 text-heading font-semibold text-fg">
                {brandName(group.brandId) ?? "Arşivlenmiş marka"}
                <span className="text-body font-normal text-fg-3">{group.cards.length}</span>
              </h2>
            )}
            <ul className={GRID} aria-label="Post kartları">
              {group.cards.map((card) => (
                <PostCardView
                  key={card.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(card.id, el);
                    else itemRefs.current.delete(card.id);
                  }}
                  card={card}
                  brandName={brandName(card.content.brandId)}
                  selected={card.id === selectedId}
                  actions={cardActions}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 px-8 pt-6 pb-5">
        <div className="flex h-7 items-center gap-3">
          <h1 className="text-title font-semibold text-fg">Postlar</h1>
          <div className="flex items-center gap-0.5">
            <IconButton
              icon={<IconChevronLeft size={14} strokeWidth={1.75} />}
              label="Önceki ay"
              size={24}
              onClick={() => store().setMonth(addMonths(month, -1))}
            />
            <span className="min-w-[96px] text-center text-body text-fg">{monthTitle(month)}</span>
            <IconButton
              icon={<IconChevronRight size={14} strokeWidth={1.75} />}
              label="Sonraki ay"
              size={24}
              onClick={() => store().setMonth(addMonths(month, 1))}
            />
          </div>
          <span className="min-w-0 flex-1 truncate text-body text-fg-2">
            {view.monthTotal} post
            {loading && cards.length > 0 && <span className="ml-2 text-fg-3">yenileniyor…</span>}
          </span>
          <SearchField
            ref={searchRef}
            className="w-[200px]"
            placeholder="Postlarda ara"
            aria-label="Postlarda ara"
            value={query}
            onChange={(e) => store().setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                store().setQuery("");
                gridRef.current?.focus();
              }
              if (e.key === "ArrowDown" || e.key === "Enter") {
                e.preventDefault();
                gridRef.current?.focus();
                if (!selectedId) store().select(ordered[0]?.id ?? null);
              }
            }}
          />
          <Button
            variant="primary"
            icon={<IconPlus size={14} strokeWidth={2} />}
            onClick={() => startChat("Yeni bir post hazırla: ", brandId ?? undefined)}
          >
            Yeni post
          </Button>
        </div>
        <div className="flex items-center">
          <SegmentedControl<PostFilter>
            label="Durum"
            value={filter}
            onChange={(f) => store().setFilter(f)}
            options={POST_FILTERS.map((f) => ({
              value: f.id,
              label: f.label,
              count: view.counts[f.id],
            }))}
          />
        </div>
      </div>
      <section
        ref={gridRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the board takes the arrow keys (selection)
        tabIndex={0}
        aria-label="Postlar"
        onKeyDown={onKeyDown}
        className="scroll-area min-h-0 flex-1 px-8 pt-1 pb-8 outline-none focus-visible:shadow-none"
      >
        {body}
      </section>
      {context.element}
    </div>
  );
}

function EmptyState({
  title,
  detail,
  actions,
}: {
  title: string;
  detail: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-24 text-center">
      <p className="text-heading font-semibold text-fg">{title}</p>
      <p className="selectable max-w-[420px] text-body text-fg-2">{detail}</p>
      {actions && <div className={cn("mt-3 flex flex-wrap justify-center gap-2")}>{actions}</div>}
    </div>
  );
}
