// "Ürünler" on the brand profile: the brand's products as cards (cover photo, name, category,
// short description, tags) with search, "Ürün ekle" and an editor sheet (name, category,
// description, tags, photos, notes; delete after a confirmation).
import type { Brand, BrandProduct } from "@studio/contract";
import { useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  SearchField,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import {
  IconClose,
  IconEllipsis,
  IconImagePlus,
  IconPackage,
  IconPlus,
} from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { assetUrl, describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useBrandProducts, useProductActions } from "./products-data.ts";
import {
  addTags,
  makeCover,
  PRODUCT_LIMITS,
  type ProductDraft,
  productDraft,
  productInput,
  productMatches,
  productPatch,
  productProblem,
} from "./products-model.ts";

const FIELD_AREA =
  "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3";

export function ProductsTab({ brand }: { brand: Brand }) {
  const products = useBrandProducts(brand.id);
  const actions = useProductActions(brand.id);
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<BrandProduct | "new" | null>(null);
  const [deleting, setDeleting] = useState<BrandProduct | null>(null);
  const [removing, setRemoving] = useState(false);
  const list = products.data ?? [];
  const shown = list.filter((p) => productMatches(p, query));

  const remove = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      await actions.remove(deleting.id);
      showToast({ message: `“${deleting.name}” silindi.` });
      if (editing !== "new" && editing?.id === deleting.id) setEditing(null);
      setDeleting(null);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 pt-1">
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
        <ul
          aria-label="Ürünler"
          className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"
        >
          {shown.map((product) => (
            <li key={product.id}>
              <ProductCard
                product={product}
                onEdit={() => setEditing(product)}
                onDelete={() => setDeleting(product)}
              />
            </li>
          ))}
        </ul>
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

function ProductCard({
  product,
  onEdit,
  onDelete,
}: {
  product: BrandProduct;
  onEdit(): void;
  onDelete(): void;
}) {
  const cover = product.imageAssetIds[0];
  const photos = product.imageAssetIds.length;
  const menu: MenuEntry[] = [
    { id: "edit", label: "Düzenle", onSelect: onEdit },
    { type: "separator" },
    { id: "delete", label: "Sil", danger: true, onSelect: onDelete },
  ];
  return (
    <article
      aria-label={product.name}
      className="group relative flex h-full flex-col overflow-hidden rounded-[12px] bg-field shadow-[inset_0_0_0_1px_var(--border-hairline)] transition-colors hover:bg-control"
    >
      <button
        type="button"
        aria-label={`${product.name}: düzenle`}
        onClick={onEdit}
        className="flex flex-1 flex-col text-left"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-control">
          {cover ? (
            <img
              src={assetUrl(cover)}
              alt=""
              loading="lazy"
              draggable={false}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-fg-3">
              <IconPackage size={28} strokeWidth={1.25} />
            </span>
          )}
          {photos > 1 && (
            <span className="absolute right-2 bottom-2 rounded-full bg-black/55 px-1.5 text-caption text-white">
              {photos} fotoğraf
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body-lg font-medium text-fg">{product.name}</span>
            {product.category && <TagPill>{product.category}</TagPill>}
          </div>
          {product.description && (
            <p className="line-clamp-2 text-body text-fg-2">{product.description}</p>
          )}
          {product.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {product.tags.map((tag) => (
                <TagPill key={tag} tone="accent">
                  {tag}
                </TagPill>
              ))}
            </div>
          )}
        </div>
      </button>
      <div className="absolute top-2 right-2">
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
