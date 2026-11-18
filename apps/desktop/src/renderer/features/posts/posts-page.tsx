// The posts screen (Wecra "Postlar"): month with ‹ ›, post count, search, "+ Yeni post", the
// status filters with counts, and a responsive grid of 4:5 cards — the current brand's, or
// every brand's grouped by brand. Keys: arrows move the selection, ↩ opens, Space quick look,
// ⌫ moves to the trash (with "Geri al"), ⌘D duplicates, ⌘F searches, ⌘A picks the month's cards,
// Esc clears the picked cards, then the selection. ⌘-click / ⇧-click pick cards for the bulk bar
// (N1). "Planlar" shows the month plans (N2); "Silinenler" the trash (7).
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
import {
  IconChevronLeft,
  IconChevronRight,
  IconPlus,
  IconTrash,
} from "../../components/ui/icons.tsx";
import { type MenuEntry, useContextMenu } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { startChat } from "../../state/chat-draft.ts";
import { isHostUp, useBrands, useHost } from "../../state/studio.tsx";
import { usePostActions } from "./actions.ts";
import {
  boardMonths,
  deletionBlocker,
  generationFailure,
  groupByBrand,
  monthWithPosts,
  moveSelection,
  nearestMonth,
  POST_FILTERS,
  type PostCard,
  type PostFilter,
  rangeSelection,
  toggleSelection,
  visibleCards,
  visibleSelection,
} from "./board.ts";
import { BulkBar } from "./bulk-bar.tsx";
import { useBoard, useTrash } from "./data.ts";
import { addMonths, monthKeyOf, monthName, monthTitle } from "./dates.ts";
import { exportMenuEntries, usePostExport } from "./export.ts";
import { PlansView } from "./plans-view.tsx";
import type { PostCardActions } from "./post-card.tsx";
import { PostCardView } from "./post-card.tsx";
import { type PostsView, usePostsStore } from "./store.ts";
import { TrashView } from "./trash-view.tsx";

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
  const storedMonth = usePostsStore((s) => s.month);
  const view = usePostsStore((s) => s.view);
  const scope = allBrands ? null : currentBrandId;
  const enabled = allBrands || currentBrandId !== null;
  const board = useBoard(scope, enabled && view === "board", storedMonth);
  const brandList = brands.data ?? [];
  const brandName = useCallback(
    (id: string) => brandList.find((b) => b.id === id)?.name,
    [brandList],
  );

  if (!enabled) {
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
  if (view === "plans") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 px-8 pt-6 pb-5">
          <h1 className="text-title font-semibold text-fg">Postlar</h1>
          <ViewTabs value="plans" />
        </div>
        <PlansView brandId={scope} brandName={brandName} />
      </div>
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
      tabs
    />
  );
}

/** "Pano | Planlar" (N2). */
function ViewTabs({ value }: { value: PostsView }) {
  return (
    <SegmentedControl<PostsView>
      label="Görünüm"
      value={value}
      onChange={(v) => usePostsStore.getState().setView(v)}
      options={[
        { value: "board", label: "Pano" },
        { value: "plans", label: "Planlar" },
      ]}
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
  tabs = false,
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
  /** Show the Pano / Planlar switch. */
  tabs?: boolean;
  now?: Date;
}) {
  const storedMonth = usePostsStore((s) => s.month);
  const filter = usePostsStore((s) => s.filter);
  const query = usePostsStore((s) => s.query);
  const selectedId = usePostsStore((s) => s.selectedId);
  const picked = usePostsStore((s) => s.picked);
  const trashOpen = usePostsStore((s) => s.trash);
  const openedId = usePostsStore((s) => s.opened?.contentId ?? null);
  const store = usePostsStore.getState;
  const actions = usePostActions();
  const exporter = usePostExport();
  const context = useContextMenu();
  const trash = useTrash(grouped ? null : brandId);
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
  const orderedIds = useMemo(() => ordered.map((c) => c.id), [ordered]);
  const pickedVisible = useMemo(() => visibleSelection(orderedIds, picked), [orderedIds, picked]);
  const pickedCards = useMemo(
    () => ordered.filter((c) => pickedVisible.includes(c.id)),
    [ordered, pickedVisible],
  );
  const gridRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());
  // One ref callback per card, kept across renders (a new one would redraw a memoized card).
  const refCallbacks = useRef(new Map<string, (el: HTMLLIElement | null) => void>());
  const refFor = (id: string) => {
    let callback = refCallbacks.current.get(id);
    if (!callback) {
      callback = (el) => {
        if (el) itemRefs.current.set(id, el);
        else itemRefs.current.delete(id);
      };
      refCallbacks.current.set(id, callback);
    }
    return callback;
  };

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

  const media = (id: string) => itemRefs.current.get(id)?.querySelector("[data-media]") ?? null;
  const mediaRect = (id: string) => media(id)?.getBoundingClientRect() ?? null;

  // The cards' actions keep their identity (memoized cards); they read the latest values here.
  const latest = useRef({ orderedIds, actions, context });
  latest.current = { orderedIds, actions, context };
  const cardActions = useMemo<PostCardActions>(() => {
    const open: PostCardActions["open"] = (card, origin, event) => {
      const s = store();
      if (event && (event.metaKey || event.ctrlKey)) {
        s.setPicked(toggleSelection(s.picked, card.id), card.id);
        s.select(card.id);
        return;
      }
      if (event?.shiftKey) {
        s.setPicked(
          rangeSelection(latest.current.orderedIds, s.picked, s.anchorId ?? s.selectedId, card.id),
        );
        s.select(card.id);
        return;
      }
      if (s.picked.length > 0) s.clearPicked();
      s.select(card.id);
      s.open(card.id, {
        origin: origin
          ? { x: origin.left, y: origin.top, width: origin.width, height: origin.height }
          : null,
      });
    };
    return {
      open,
      quickLook: (card, source) =>
        latest.current.actions.quickLook(card.content, card.version, { source }),
      copyCaption: (card) => void latest.current.actions.copyCaption(card.content),
      duplicate: (card) => void latest.current.actions.duplicate(card.content),
      remove: (card) => latest.current.actions.askDelete(card.content),
      retry: (card, jobId) => void latest.current.actions.retry(jobId, card.content.title),
      contextMenu: (card, event) => {
        store().select(card.id);
        latest.current.context.open(event, menuRef.current(card));
      },
    };
  }, [store]);

  const menuFor = (card: PostCard): MenuEntry[] => {
    const blocker = deletionBlocker(card.content);
    const failure = generationFailure(card);
    return [
      { id: "open", label: "Aç", onSelect: () => cardActions.open(card, mediaRect(card.id)) },
      {
        id: "quicklook",
        label: "Hızlı bakış",
        shortcut: "␣",
        disabled: !card.version?.slides.some((s) => s.renderedAssetId),
        onSelect: () => cardActions.quickLook(card, media(card.id)),
      },
      ...(failure
        ? [
            {
              id: "retry",
              label: "Yeniden dene",
              onSelect: () => cardActions.retry?.(card, failure.jobId),
            },
          ]
        : []),
      { type: "separator" },
      {
        id: "caption",
        label: "Açıklamayı kopyala",
        disabled: !card.content.caption.trim(),
        onSelect: () => cardActions.copyCaption(card),
      },
      ...exportMenuEntries(exporter, card.content, card.version, null),
      {
        id: "duplicate",
        label: "Çoğalt",
        shortcut: "D",
        onSelect: () => cardActions.duplicate(card),
      },
      { type: "separator" },
      {
        id: "delete",
        label: "Sil",
        danger: true,
        disabled: !!blocker,
        ...(blocker ? { detail: blocker } : {}),
        onSelect: () => cardActions.remove(card),
      },
    ];
  };
  const menuRef = useRef(menuFor);
  menuRef.current = menuFor;

  const selected = ordered.find((c) => c.id === selectedId) ?? null;
  const selectAll = () => store().setPicked(orderedIds, orderedIds[0] ?? null);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    if (trashOpen) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const columns = gridColumns(gridRef.current?.querySelector("ul") ?? null);
    const ids = orderedIds;
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
          if (pickedVisible.length > 0) {
            event.preventDefault();
            store().clearPicked();
          } else if (selectedId) {
            event.preventDefault();
            store().select(null);
          }
          return;
      }
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      const key = event.key.toLowerCase();
      if (key === "d" && selected) {
        event.preventDefault();
        cardActions.duplicate(selected);
      } else if (key === "f") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (key === "a" && ids.length > 0) {
        event.preventDefault();
        selectAll();
      }
    }
  };

  const earlier = monthWithPosts(months, month, -1);
  const later = monthWithPosts(months, month, 1);
  const filterLabel = POST_FILTERS.find((f) => f.id === filter)?.label ?? "";
  const trashCount = trash.data?.length ?? 0;

  let body: React.ReactNode;
  if (trashOpen) {
    body = <TrashView brandId={grouped ? null : brandId} brandName={brandName} />;
  } else if (loading && cards.length === 0) {
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
                  ref={refFor(card.id)}
                  card={card}
                  brandName={brandName(card.content.brandId)}
                  selected={card.id === selectedId}
                  picked={pickedVisible.includes(card.id)}
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
          {tabs && <ViewTabs value="board" />}
          {!trashOpen && (
            <div className="flex items-center gap-0.5">
              <IconButton
                icon={<IconChevronLeft size={14} strokeWidth={1.75} />}
                label="Önceki ay"
                size={24}
                onClick={() => store().setMonth(addMonths(month, -1))}
              />
              <span className="min-w-[96px] text-center text-body text-fg">
                {monthTitle(month)}
              </span>
              <IconButton
                icon={<IconChevronRight size={14} strokeWidth={1.75} />}
                label="Sonraki ay"
                size={24}
                onClick={() => store().setMonth(addMonths(month, 1))}
              />
            </div>
          )}
          <span className="min-w-0 flex-1 truncate text-body text-fg-2">
            {trashOpen ? `${trashCount} silinen post` : `${view.monthTotal} post`}
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
        <div className="flex min-h-10 items-center gap-3">
          {pickedVisible.length > 0 && !trashOpen ? (
            <BulkBar picked={pickedCards} visibleCount={ordered.length} onSelectAll={selectAll} />
          ) : (
            <>
              {!trashOpen && (
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
              )}
              {!trashOpen && ordered.length > 1 && (
                <Button variant="ghost" onClick={selectAll}>
                  Tümünü seç
                </Button>
              )}
              <div className="flex-1" />
              <button
                type="button"
                aria-pressed={trashOpen}
                onClick={() => store().setTrash(!trashOpen)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-body",
                  trashOpen ? "bg-control text-fg" : "text-fg-2 hover:bg-control hover:text-fg",
                )}
              >
                <IconTrash size={13} strokeWidth={1.75} />
                Silinenler
                {trashCount > 0 && <span className="text-fg-3 tabular-nums">{trashCount}</span>}
              </button>
            </>
          )}
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
