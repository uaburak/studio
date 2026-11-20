// "Ürünler" on the brand profile, like the iPhone app: the brand's products as an edge-to-edge
// grid of square tiles (the first photo; the name in small caps on a tone without one) with
// search and "Ürün ekle". A tile opens the product's page in place (zooming out of the tile):
// its photos full width (paged with dots; a click opens the image viewer), the name and
// category, the description written like a Postlar caption (cut to three lines, "… devamı"),
// the tags as hashtags, notes and "2 fotoğraf · 5 gün önce eklendi"; the pencil opens the
// editor sheet (name, category, description, tags, photos, notes; delete after a confirmation).
import type { Brand, BrandProduct } from "@studio/contract";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  SearchField,
  Spinner,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconEllipsis,
  IconImagePlus,
  IconPackage,
  IconPencil,
  IconPlus,
} from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { useImageZoom } from "../../components/ui/zoomable-image.tsx";
import { assetUrl, describeError } from "../../lib/api.ts";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useFocusRequests } from "../../state/focus-requests.ts";
import { useBrandProducts, useProductActions } from "./products-data.ts";
import {
  addTags,
  makeCover,
  PRODUCT_LIMITS,
  type ProductDraft,
  type ProductTone,
  productDraft,
  productHashtags,
  productInput,
  productMatches,
  productMetaLine,
  productPatch,
  productProblem,
  productTone,
} from "./products-model.ts";

const FIELD_AREA =
  "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3";

/** Postlar's tiles without a picture. */
const TONE_CLASS: Record<ProductTone, string> = {
  dark: "bg-[#1d1d1f] text-white",
  light: "bg-[#f2f2f4] text-black",
  muted: "bg-control text-fg",
};

/** Tiles are at least 180 px, and never fewer than three in a row. */
const GRID =
  "grid grid-cols-[repeat(auto-fill,minmax(min(180px,calc((100%-3px)/3)),1fr))] gap-[1.5px]";

type Rect = { x: number; y: number; width: number; height: number };

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ProductsTab({ brand }: { brand: Brand }) {
  const products = useBrandProducts(brand.id);
  const actions = useProductActions(brand.id);
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<BrandProduct | "new" | null>(null);
  const [deleting, setDeleting] = useState<BrandProduct | null>(null);
  const [removing, setRemoving] = useState(false);
  const [opened, setOpened] = useState<{ id: string; origin: Rect | null } | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  /** The page's scroll position under the grid, put back when the product closes. */
  const gridScroll = useRef<number | null>(null);
  const list = products.data ?? [];
  const shown = list.filter((p) => productMatches(p, query));
  const openProduct = opened ? list.find((p) => p.id === opened.id) : undefined;

  // An @product chip of a chat asked for one product: open its page once the list has it.
  const focus = useFocusRequests((s) => s.product);
  useEffect(() => {
    if (!focus || focus.brandId !== brand.id || !products.data) return;
    useFocusRequests.getState().takeProduct(focus.nonce);
    if (products.data.some((p) => p.id === focus.productId)) {
      setOpened({ id: focus.productId, origin: null });
    } else {
      showToast({ message: "Ürün bulunamadı; silinmiş olabilir." });
    }
  }, [focus, brand.id, products.data, showToast]);

  const scroller = () => root.current?.closest<HTMLElement>(".scroll-area") ?? null;

  const open = (product: BrandProduct, tile: HTMLElement | null) => {
    const box = tile?.getBoundingClientRect();
    gridScroll.current = scroller()?.scrollTop ?? null;
    setOpened({
      id: product.id,
      origin:
        box && box.width > 0
          ? { x: box.left, y: box.top, width: box.width, height: box.height }
          : null,
    });
  };
  const [returned, setReturned] = useState(false);
  const close = () => {
    setOpened(null);
    setReturned(true);
  };

  // Back on the grid: where it was scrolled to.
  const showingGrid = !openProduct;
  useLayoutEffect(() => {
    if (!showingGrid || gridScroll.current === null) return;
    const el = scroller();
    if (el) el.scrollTop = gridScroll.current;
    gridScroll.current = null;
  }, [showingGrid]);

  const remove = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      await actions.remove(deleting.id);
      showToast({ message: `“${deleting.name}” silindi.` });
      if (editing !== "new" && editing?.id === deleting.id) setEditing(null);
      if (opened?.id === deleting.id) setOpened(null);
      setDeleting(null);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div ref={root} className="pt-1">
      {openProduct ? (
        <ProductDetail
          key={openProduct.id}
          product={openProduct}
          origin={opened?.origin ?? null}
          scroller={scroller}
          busy={editing !== null || deleting !== null}
          onBack={close}
          onEdit={() => setEditing(openProduct)}
        />
      ) : (
        <div className={cn("flex flex-col gap-5", returned && "animate-fade-in")}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-heading font-semibold text-fg">
                Ürünler{list.length > 0 && <span className="text-fg-3"> · {list.length}</span>}
              </h2>
              <p className="text-body text-fg-2">
                Postlarda doğru ad ve görselle gösterilsin diye markanın ürünleri.
              </p>
            </div>
            {list.length > 0 && (
              <SearchField
                aria-label="Ürünlerde ara"
                placeholder="Ürünlerde ara"
                className="w-[240px]"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <Button
              variant="primary"
              icon={<IconPlus size={14} strokeWidth={2} />}
              onClick={() => setEditing("new")}
            >
              Ürün ekle
            </Button>
          </div>

          {products.isPending && !products.error ? (
            <p className="text-body text-fg-3">Yükleniyor…</p>
          ) : products.error ? (
            <p className="text-body text-danger" role="alert">
              Ürünler yüklenemedi: {describeError(products.error)}
            </p>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-[12px] bg-field p-5 text-body text-fg-2">
              <span className="text-icon">
                <IconPackage size={20} strokeWidth={1.5} />
              </span>
              <p>Henüz ürün yok.</p>
              <p className="text-footnote text-fg-3">
                Ürün adı, fotoğrafları, kısa açıklaması ve etiketleriyle eklenince postlarda
                kullanılabilir.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-body text-fg-3">“{query.trim()}” için ürün yok.</p>
          ) : (
            <ul aria-label="Ürünler" className={GRID}>
              {shown.map((product) => (
                <li key={product.id}>
                  <ProductTile
                    product={product}
                    onOpen={(tile) => open(product, tile)}
                    onEdit={() => setEditing(product)}
                    onDelete={() => setDeleting(product)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {editing !== null && (
        <ProductSheet
          key={editing === "new" ? "new" : editing.id}
          brandId={brand.id}
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDelete={(product) => setDeleting(product)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `“${deleting.name}” silinsin mi?` : ""}
        message="Ürün listeden kalkar. Fotoğrafları markanın medyasında kalır."
        confirmLabel="Sil"
        destructive
        busy={removing}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

/** The name in small capitals on the product's tone (a product without a photo). */
function ToneName({ product, large = false }: { product: BrandProduct; large?: boolean }) {
  return (
    <span
      lang="tr"
      className={cn(
        "flex size-full items-end",
        TONE_CLASS[productTone(product.id)],
        large ? "p-6" : "p-2",
      )}
    >
      <span
        className={cn(
          "line-clamp-3 font-bold tracking-[0.04em] uppercase",
          large ? "text-title" : "text-[11px] leading-[14px]",
        )}
      >
        {product.name}
      </span>
    </span>
  );
}

function ProductTile({
  product,
  onOpen,
  onEdit,
  onDelete,
}: {
  product: BrandProduct;
  onOpen(tile: HTMLElement | null): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const cover = product.imageAssetIds[0];
  const menu: MenuEntry[] = [
    { id: "edit", label: "Düzenle", onSelect: onEdit },
    { type: "separator" },
    { id: "delete", label: "Sil", danger: true, onSelect: onDelete },
  ];
  return (
    <article aria-label={product.name} className="group relative aspect-square overflow-hidden">
      <button
        type="button"
        aria-label={[product.name, product.category].filter(Boolean).join(", ")}
        title={product.name}
        onClick={(event) => onOpen(event.currentTarget)}
        className="block size-full bg-control text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {cover ? (
          <img
            src={thumbUrl(cover, 360)}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover transition-opacity group-hover:opacity-90"
          />
        ) : (
          <ToneName product={product} />
        )}
      </button>
      <div className="absolute top-1.5 right-1.5">
        <MenuButton entries={menu} width={180} placement="bottom-end" label={product.name}>
          {({ ref, onClick, onKeyDown, open, ...aria }) => (
            <IconButton
              ref={ref}
              {...aria}
              size={24}
              tooltip={false}
              selected={open}
              label={`${product.name}: seçenekler`}
              icon={<IconEllipsis size={14} />}
              onClick={onClick}
              onKeyDown={onKeyDown}
              className={cn(
                "bg-popover/90 text-fg shadow-sm hover:bg-popover",
                !open && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              )}
            />
          )}
        </MenuButton>
      </div>
    </article>
  );
}

// --- the product's page ----------------------------------------------------------------------

function ProductDetail({
  product,
  origin,
  scroller,
  busy,
  onBack,
  onEdit,
}: {
  product: BrandProduct;
  /** The tile it opened from (on screen), to zoom out of; null: a fade. */
  origin: Rect | null;
  scroller(): HTMLElement | null;
  /** The editor or a confirmation is open: Esc is theirs. */
  busy: boolean;
  onBack(): void;
  onEdit(): void;
}) {
  const page = useRef<HTMLElement | null>(null);

  // Opens at the top, growing out of the tile it was opened from.
  useLayoutEffect(() => {
    const el = page.current;
    const scroll = scroller();
    if (scroll) scroll.scrollTop = 0;
    if (!el || typeof el.animate !== "function" || reducedMotion()) return;
    const box = el.getBoundingClientRect();
    const frames: Keyframe[] =
      origin && box.width > 0
        ? [
            {
              transform: `translate(${origin.x - box.left}px, ${origin.y - box.top}px) scale(${origin.width / box.width})`,
              opacity: 0.6,
            },
            { transform: "none", opacity: 1 },
          ]
        : [
            { transform: "scale(0.97)", opacity: 0 },
            { transform: "none", opacity: 1 },
          ];
    el.animate(frames, {
      duration: 320,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      fill: "backwards",
    });
  }, []);

  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true], [role=dialog], [role=menu]"))
        return;
      event.preventDefault();
      backRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  const hashtags = productHashtags(product.tags);
  return (
    <article
      ref={page}
      aria-label={product.name}
      className="mx-auto flex w-full max-w-[680px] origin-top-left flex-col"
    >
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex h-7 items-center gap-0.5 rounded-full pr-2.5 pl-1 text-body text-fg-2 hover:bg-control hover:text-fg"
        >
          <IconChevronLeft size={16} strokeWidth={1.75} />
          Ürünler
        </button>
        <IconButton
          label="Düzenle"
          icon={<IconPencil size={16} strokeWidth={1.75} />}
          onClick={onEdit}
        />
      </div>

      <ProductPhotos product={product} />

      <div className="flex flex-col gap-3 pt-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="selectable text-title font-bold text-fg">{product.name}</h2>
          {product.category && <p className="selectable text-body text-fg-2">{product.category}</p>}
        </div>
        {product.description.trim() && (
          <ProductCaption name={product.name} text={product.description.trim()} />
        )}
        {hashtags && <p className="selectable text-body text-accent">{hashtags}</p>}
        {product.notes.trim() && (
          <p className="selectable text-body whitespace-pre-line text-fg-2">
            {product.notes.trim()}
          </p>
        )}
        <p className="text-footnote text-fg-3">{productMetaLine(product)}</p>
      </div>
    </article>
  );
}

/** The photos full width, paged sideways with dots; a click opens the viewer at full size. */
function ProductPhotos({ product }: { product: BrandProduct }) {
  const ids = product.imageAssetIds;
  const images = useMemo(
    () =>
      ids.map((assetId, i) => ({
        assetId,
        caption: ids.length > 1 ? `${product.name} · ${i + 1}` : product.name,
      })),
    [ids, product.name],
  );
  const zoom = useImageZoom(images);
  const track = useRef<HTMLElement | null>(null);
  const [page, setPage] = useState(0);

  if (ids.length === 0) {
    return (
      <div className="aspect-square w-full overflow-hidden">
        <ToneName product={product} large />
      </div>
    );
  }

  const go = (index: number) => {
    const el = track.current;
    if (!el) return;
    const next = Math.min(Math.max(index, 0), ids.length - 1);
    el.scrollTo({ left: next * el.clientWidth, behavior: reducedMotion() ? "auto" : "smooth" });
    setPage(next);
  };

  return (
    <div className="group relative aspect-square w-full overflow-hidden bg-control">
      <section
        ref={track}
        aria-label="Fotoğraflar"
        className="flex size-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.clientWidth > 0) setPage(Math.round(el.scrollLeft / el.clientWidth));
        }}
      >
        {ids.map((id, index) => (
          <button
            key={id}
            type="button"
            aria-label={
              ids.length > 1 ? `Fotoğrafı aç (${index + 1} / ${ids.length})` : "Fotoğrafı aç"
            }
            onClick={() => zoom.open(index)}
            className="size-full shrink-0 snap-center cursor-zoom-in"
          >
            <img
              ref={zoom.ref(index)}
              src={thumbUrl(id, 680)}
              alt=""
              draggable={false}
              loading={index === 0 ? "eager" : "lazy"}
              className="size-full object-cover"
            />
          </button>
        ))}
      </section>
      {ids.length > 1 && (
        <>
          {page > 0 && (
            <IconButton
              label="Önceki fotoğraf"
              tooltip={false}
              icon={<IconChevronLeft size={16} strokeWidth={2} />}
              onClick={() => go(page - 1)}
              className="absolute top-1/2 left-2 -translate-y-1/2 bg-black/40 text-white opacity-0 group-hover:opacity-100 hover:bg-black/60 focus-visible:opacity-100"
            />
          )}
          {page < ids.length - 1 && (
            <IconButton
              label="Sonraki fotoğraf"
              tooltip={false}
              icon={<IconChevronRight size={16} strokeWidth={2} />}
              onClick={() => go(page + 1)}
              className="absolute top-1/2 right-2 -translate-y-1/2 bg-black/40 text-white opacity-0 group-hover:opacity-100 hover:bg-black/60 focus-visible:opacity-100"
            />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-2.5 flex justify-center gap-1.5">
            {ids.map((id, index) => (
              <span
                key={id}
                aria-hidden
                className={cn(
                  "size-1.5 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.5)] transition-colors",
                  index === page ? "bg-white" : "bg-white/45",
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** "**Name** description…" like a Postlar caption: three lines, then "… devamı" opens it in place. */
function ProductCaption({ name, text }: { name: string; text: string }) {
  const body = useRef<HTMLParagraphElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || expanded) return;
    const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className="relative">
      <p
        ref={body}
        className={cn(
          "selectable text-body whitespace-pre-line text-fg",
          !expanded && "line-clamp-3",
        )}
      >
        <span className="font-semibold">{name}</span> {text}
      </p>
      {cut && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute right-0 bottom-0 bg-page pl-1 text-body text-fg-3 hover:text-fg-2"
        >
          … devamı
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-footnote text-fg-2">{label}</span>
        {hint && <span className="ml-auto text-caption text-fg-3 tabular-nums">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function ProductSheet({
  brandId,
  product,
  onClose,
  onDelete,
}: {
  brandId: string;
  /** null: a new product. */
  product: BrandProduct | null;
  onClose(): void;
  onDelete(product: BrandProduct): void;
}) {
  const actions = useProductActions(brandId);
  const showToast = useAppStore((s) => s.showToast);
  const [draft, setDraft] = useState<ProductDraft>(() => productDraft(product));
  const [tagText, setTagText] = useState("");
  const [uploads, setUploads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const change = (update: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...update }));
  const problem = productProblem(draft);

  const upload = async (files: File[]) => {
    const room = PRODUCT_LIMITS.images - draft.imageAssetIds.length;
    const accepted = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
    if (accepted.length < files.length) {
      setError(`En fazla ${PRODUCT_LIMITS.images} fotoğraf eklenebilir (yalnızca görseller).`);
    }
    setUploads((n) => n + accepted.length);
    for (const file of accepted) {
      try {
        const asset = await actions.uploadPhoto(file);
        setDraft((d) =>
          d.imageAssetIds.includes(asset.id)
            ? d
            : { ...d, imageAssetIds: [...d.imageAssetIds, asset.id] },
        );
      } catch (e) {
        setError(`${file.name}: ${describeError(e)}`);
      } finally {
        setUploads((n) => n - 1);
      }
    }
  };

  const save = async () => {
    const final = tagText.trim() ? { ...draft, tags: addTags(draft.tags, tagText) } : draft;
    const reason = productProblem(final);
    if (reason) {
      setError(reason);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (product) {
        const patch = productPatch(product, final);
        if (patch) await actions.update(product.id, patch);
        showToast({ message: `“${final.name.trim()}” kaydedildi.` });
      } else {
        await actions.create(productInput(final));
        showToast({ message: `“${final.name.trim()}” eklendi.` });
      }
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const commitTags = () => {
    if (!tagText.trim()) return;
    change({ tags: addTags(draft.tags, tagText) });
    setTagText("");
  };

  return (
    <Sheet
      open
      title={product ? product.name : "Yeni ürün"}
      onClose={onClose}
      width={600}
      footer={
        <>
          {product && (
            <Button variant="ghost" className="text-danger" onClick={() => onDelete(product)}>
              Sil
            </Button>
          )}
          <span className="min-w-0 flex-1 truncate text-footnote text-danger" role="alert">
            {error ?? (draft.name.trim() ? (problem ?? "") : "")}
          </span>
          <Button onClick={onClose}>Vazgeç</Button>
          <Button
            variant="primary"
            disabled={saving || uploads > 0 || problem !== null}
            icon={saving ? <Spinner size={12} /> : undefined}
            onClick={() => void save()}
          >
            {product ? "Kaydet" : "Ekle"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-[2fr_1fr] gap-3">
          <Field label="Ürün adı">
            <TextField
              aria-label="Ürün adı"
              placeholder="Örn. Yaprak gübresi 1 L"
              maxLength={PRODUCT_LIMITS.name}
              value={draft.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </Field>
          <Field label="Kategori">
            <TextField
              aria-label="Kategori"
              placeholder="Örn. Gübre"
              maxLength={PRODUCT_LIMITS.category}
              value={draft.category}
              onChange={(e) => change({ category: e.target.value })}
            />
          </Field>
        </div>

        <Field
          label="Kısa açıklama"
          hint={`${draft.description.length}/${PRODUCT_LIMITS.description}`}
        >
          <textarea
            aria-label="Kısa açıklama"
            rows={3}
            maxLength={PRODUCT_LIMITS.description}
            placeholder="Ne olduğu, kime ve ne için."
            value={draft.description}
            onChange={(e) => change({ description: e.target.value })}
            className={FIELD_AREA}
          />
        </Field>

        <Field label="Etiketler" hint={`${draft.tags.length}/${PRODUCT_LIMITS.tags}`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {draft.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex h-6 items-center gap-1 rounded-full bg-control pr-1 pl-2.5 text-footnote text-fg"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`${tag} etiketini kaldır`}
                  onClick={() => change({ tags: draft.tags.filter((t) => t !== tag) })}
                  className="flex size-4 items-center justify-center rounded-full text-fg-2 hover:bg-control-hover hover:text-fg"
                >
                  <IconClose size={10} strokeWidth={2} />
                </button>
              </span>
            ))}
            <TextField
              aria-label="Etiket ekle"
              className="min-w-[160px] flex-1"
              placeholder={draft.tags.length ? "Etiket ekle" : "organik, yaprak, sıvı"}
              value={tagText}
              disabled={draft.tags.length >= PRODUCT_LIMITS.tags}
              onChange={(e) => {
                const value = e.target.value;
                if (value.includes(",")) {
                  change({ tags: addTags(draft.tags, value) });
                  setTagText("");
                } else setTagText(value);
              }}
              onBlur={commitTags}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTags();
                } else if (e.key === "Backspace" && !tagText && draft.tags.length > 0) {
                  change({ tags: draft.tags.slice(0, -1) });
                }
              }}
            />
          </div>
        </Field>

        <Field
          label="Fotoğraflar"
          hint={`${draft.imageAssetIds.length}/${PRODUCT_LIMITS.images} · ilki kapak`}
        >
          <div className="grid grid-cols-4 gap-2">
            {draft.imageAssetIds.map((id, index) => (
              <div
                key={id}
                className="group relative aspect-square overflow-hidden rounded-[10px] bg-control"
              >
                <img
                  src={assetUrl(id)}
                  alt=""
                  draggable={false}
                  className="size-full object-cover"
                />
                {index === 0 ? (
                  <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/55 px-1.5 text-caption text-white">
                    Kapak
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => change({ imageAssetIds: makeCover(draft.imageAssetIds, id) })}
                    className="absolute bottom-1.5 left-1.5 rounded-full bg-black/55 px-1.5 text-caption text-white opacity-0 group-hover:opacity-100 hover:bg-black/70 focus-visible:opacity-100"
                  >
                    Kapak yap
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Fotoğrafı kaldır"
                  title="Fotoğrafı kaldır"
                  onClick={() =>
                    change({ imageAssetIds: draft.imageAssetIds.filter((x) => x !== id) })
                  }
                  className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/70"
                >
                  <IconClose size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
            {Array.from({ length: uploads }, (_, i) => (
              <div
                key={`uploading-${i}`}
                className="flex aspect-square items-center justify-center rounded-[10px] bg-control text-fg-2"
              >
                <Spinner size={16} />
              </div>
            ))}
            {draft.imageAssetIds.length + uploads < PRODUCT_LIMITS.images && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void upload([...e.dataTransfer.files]);
                }}
                className="flex aspect-square flex-col items-center justify-center gap-1 rounded-[10px] text-footnote text-fg-2 shadow-[inset_0_0_0_1px_var(--border-default)] hover:bg-control hover:text-fg"
              >
                <IconImagePlus size={18} strokeWidth={1.5} />
                Fotoğraf ekle
              </button>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              void upload([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
        </Field>

        <Field label="Notlar" hint="Vurgulanacaklar, kaçınılacaklar">
          <textarea
            aria-label="Notlar"
            rows={4}
            maxLength={PRODUCT_LIMITS.notes}
            value={draft.notes}
            onChange={(e) => change({ notes: e.target.value })}
            className={FIELD_AREA}
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
