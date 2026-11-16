import { type Asset, type AssetKind, AssetKind as AssetKindEnum } from "@studio/contract";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { useApi } from "../../api.ts";
import { Dialog } from "../../components/dialog.tsx";
import { IconFile, IconMedia, IconUpload } from "../../components/icons.tsx";
import { BrandMark, PageHeader } from "../../components/page.tsx";
import { EmptyState, ErrorState, SkeletonGrid } from "../../components/states.tsx";
import {
  Badge,
  Button,
  cx,
  FilterSelect,
  KeyValue,
  Mono,
  Segmented,
  Spinner,
} from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import { formatDateTime } from "../../lib/datetime.ts";
import { describeError } from "../../lib/errors.ts";
import { formatBytes, formatDuration } from "../../lib/format.ts";
import { ASSET_KIND_LABELS, ASSET_SOURCE_LABELS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { checkFile, readMediaMetadata, withMimeType } from "./upload.ts";

interface UploadItem {
  key: string;
  name: string;
  size: number;
  state: "queued" | "uploading" | "done" | "error";
  error?: string;
}

const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,audio/mpeg,audio/mp4,audio/wav,.woff2,.woff,.ttf,.otf,application/pdf";

export function MediaPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { brandId, setBrandId, activeBrands } = useBrands();
  const brandName = useBrandName();
  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [uploadBrand, setUploadBrand] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Asset | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const targetBrand = brandId ?? uploadBrand;

  const filters = { brandId: brandId ?? undefined, kind: kind === "all" ? undefined : kind };
  const query = useInfiniteQuery({
    queryKey: queryKeys.assets.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.assets.list(
        { ...filters, limit: 48, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const patch = (key: string, change: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));

  async function uploadFiles(files: File[]) {
    if (!targetBrand || files.length === 0) return;
    const batch = files.map((file, i) => ({ file, key: `${Date.now()}-${i}-${file.name}` }));
    setUploads((list) => [
      ...batch.map(({ file, key }) => ({
        key,
        name: file.name,
        size: file.size,
        state: "queued" as const,
      })),
      ...list,
    ]);
    // Sequential: keeps memory flat on phones and the order predictable.
    for (const { file, key } of batch) {
      const check = checkFile(file);
      if (!check.ok) {
        patch(key, { state: "error", error: check.error });
        continue;
      }
      patch(key, { state: "uploading" });
      try {
        const meta = await readMediaMetadata(file, check.mimeType);
        await api.assets.upload({
          brandId: targetBrand,
          file: withMimeType(file, check.mimeType),
          ...meta,
        });
        patch(key, { state: "done" });
        void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
      } catch (error) {
        const view = describeError(error);
        patch(key, { state: "error", error: view.title });
      }
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles(Array.from(e.dataTransfer.files));
  };

  const busy = uploads.some((u) => u.state === "uploading" || u.state === "queued");

  return (
    <>
      <PageHeader
        title="Medya"
        description="Fotoğraflar, logolar, fontlar ve çekimler. Tasarımlarda kullanılmak üzere markaya bağlı tutulur."
      />

      {/* Drop zone */}
      <section
        aria-label="Dosya yükle"
        onDragOver={(e) => {
          e.preventDefault();
          if (targetBrand) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cx(
          "mb-8 flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-accent bg-accent/5" : "border-line-strong bg-surface/50",
        )}
      >
        <span
          className={cx(
            "flex size-12 items-center justify-center rounded-2xl",
            dragging ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
          )}
        >
          <IconUpload />
        </span>
        <div>
          <p className="font-display text-[26px] leading-tight text-ink">
            {dragging ? "Bırakın, yükleyelim" : "Dosyaları buraya sürükleyin"}
          </p>
          <p className="mt-1 text-sm text-ink-2">
            Görsel 20 MB, video ve ses 50 MB, font 5 MB'a kadar. Birden çok dosya seçebilirsiniz.
          </p>
        </div>
        {brandId ? (
          <p className="text-[13px] text-ink-3">
            Hedef marka: <strong className="font-medium text-ink">{brandName(brandId)}</strong>
          </p>
        ) : (
          <FilterSelect
            label="Yükleme için marka"
            value={uploadBrand}
            onChange={(e) => setUploadBrand(e.target.value)}
          >
            <option value="">Yükleme için marka seçin</option>
            {activeBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </FilterSelect>
        )}
        <Button
          variant="primary"
          onClick={() => inputRef.current?.click()}
          disabled={!targetBrand}
          loading={busy}
        >
          Dosya seç
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            void uploadFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      </section>

      {uploads.length > 0 && (
        <section aria-label="Yüklemeler" className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-wide text-ink-2 uppercase">
              Yüklemeler
            </h2>
            {!busy && (
              <Button size="sm" variant="ghost" onClick={() => setUploads([])}>
                Listeyi temizle
              </Button>
            )}
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-2xl bg-surface ring-1 ring-line">
            {uploads.map((u) => (
              <li key={u.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
                <span className="hidden text-[12px] text-ink-3 sm:inline">
                  {formatBytes(u.size)}
                </span>
                {u.state === "uploading" && <Spinner />}
                {u.state === "queued" && <Badge tone="neutral">Sırada</Badge>}
                {u.state === "done" && <Badge tone="good">Yüklendi</Badge>}
                {u.state === "error" && (
                  <Badge tone="bad" title={u.error}>
                    {u.error ?? "Hata"}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented
          name="asset-kind"
          label="Tür"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "Tümü" },
            ...AssetKindEnum.options.map((k) => ({ value: k, label: ASSET_KIND_LABELS[k] })),
          ]}
        />
        {!brandId && activeBrands.length > 0 && (
          <FilterSelect label="Marka" value="" onChange={(e) => setBrandId(e.target.value || null)}>
            <option value="">Tüm markalar</option>
            {activeBrands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </FilterSelect>
        )}
      </div>

      {query.isPending ? (
        <SkeletonGrid count={8} aspect="aspect-square" />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Medya yok" glyph={<IconMedia size={24} />}>
          {kind === "all"
            ? "Yukarıdaki alana dosya sürükleyerek başlayın."
            : `Bu türde (${ASSET_KIND_LABELS[kind]}) dosya yok.`}
        </EmptyState>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {items.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => setOpen(asset)}
                  className="group flex w-full flex-col overflow-hidden rounded-2xl bg-surface text-left shadow-card ring-1 ring-line/70 hover:ring-line-strong"
                >
                  <div className="checker relative aspect-square w-full overflow-hidden">
                    <AssetPreview
                      asset={asset}
                      url={api.assets.contentUrl(asset.id)}
                      variant="tile"
                    />
                    <span className="absolute top-2 left-2">
                      <Badge tone="neutral" dot={false} className="bg-surface/90 backdrop-blur">
                        {ASSET_KIND_LABELS[asset.kind]}
                      </Badge>
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 p-3">
                    <span className="truncate text-[13px] font-medium text-ink">
                      {asset.originalFilename ?? asset.id}
                    </span>
                    <span className="flex items-center gap-1.5 truncate text-[12px] text-ink-3">
                      {!brandId && (
                        <BrandMark id={asset.brandId} name={brandName(asset.brandId)} size={14} />
                      )}
                      {formatBytes(asset.bytes)}
                      {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Daha fazla yükle
              </Button>
            </div>
          )}
        </>
      )}

      <AssetDialog asset={open} onClose={() => setOpen(null)} />
    </>
  );
}

function useAssetFont(asset: Asset, url: string): string | null {
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (asset.kind !== "font" || typeof FontFace === "undefined") return;
    const name = `asset-${asset.id}`;
    const face = new FontFace(name, `url(${url})`);
    let alive = true;
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        if (alive) setFamily(name);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [asset.id, asset.kind, url]);
  return family;
}

function AssetPreview({
  asset,
  url,
  variant,
}: {
  asset: Asset;
  url: string;
  variant: "tile" | "full";
}) {
  const font = useAssetFont(asset, url);
  const alt = asset.originalFilename ?? ASSET_KIND_LABELS[asset.kind];
  const fit =
    variant === "tile"
      ? "absolute inset-0 size-full object-contain p-2"
      : "max-h-[60dvh] w-full object-contain";

  if (asset.mimeType.startsWith("image/")) {
    return <img src={url} alt={alt} loading="lazy" decoding="async" className={fit} />;
  }
  if (asset.mimeType.startsWith("video/")) {
    return (
      <video
        src={url}
        className={fit}
        controls={variant === "full"}
        muted
        preload="metadata"
        playsInline
      />
    );
  }
  if (asset.kind === "font") {
    return (
      <div
        className={cx(
          "flex flex-col items-center justify-center bg-surface text-ink",
          variant === "tile" ? "absolute inset-0" : "min-h-64 rounded-xl p-8",
        )}
      >
        <span
          style={font ? { fontFamily: font } : undefined}
          className={variant === "tile" ? "text-6xl" : "text-8xl"}
        >
          Aa
        </span>
        {variant === "full" && (
          <span
            style={font ? { fontFamily: font } : undefined}
            className="mt-4 text-center text-2xl"
          >
            Çok güzel şeyler yapıyoruz — ĞÜŞİÖÇ ğüşıöç 0123456789
          </span>
        )}
      </div>
    );
  }
  if (asset.mimeType.startsWith("audio/")) {
    return variant === "full" ? (
      // biome-ignore lint/a11y/useMediaCaption: audio asset preview
      <audio src={url} controls className="w-full" />
    ) : (
      <div className="absolute inset-0 flex items-center justify-center bg-surface text-ink-3">
        <span className="font-display text-4xl italic">ses</span>
      </div>
    );
  }
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-2 bg-surface text-ink-3",
        variant === "tile" ? "absolute inset-0" : "min-h-48 rounded-xl",
      )}
    >
      <IconFile size={32} />
      <span className="font-mono text-[12px] uppercase">{asset.mimeType.split("/").pop()}</span>
    </div>
  );
}

function AssetDialog({ asset, onClose }: { asset: Asset | null; onClose: () => void }) {
  const api = useApi();
  const brandName = useBrandName();
  return (
    <Dialog
      open={asset !== null}
      onClose={onClose}
      title={asset?.originalFilename ?? "Dosya"}
      size="xl"
    >
      {asset && (
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="checker flex items-center justify-center overflow-hidden rounded-2xl p-3">
            <AssetPreview asset={asset} url={api.assets.contentUrl(asset.id)} variant="full" />
          </div>
          <div className="flex flex-col gap-4">
            <KeyValue
              items={[
                { label: "Tür", value: ASSET_KIND_LABELS[asset.kind] },
                { label: "Kaynak", value: ASSET_SOURCE_LABELS[asset.source] },
                { label: "Marka", value: brandName(asset.brandId) },
                { label: "Biçim", value: <Mono>{asset.mimeType}</Mono> },
                { label: "Boyut", value: formatBytes(asset.bytes) },
                ...(asset.width && asset.height
                  ? [{ label: "Ölçü", value: `${asset.width} × ${asset.height} px` }]
                  : []),
                ...(asset.durationMs
                  ? [{ label: "Süre", value: formatDuration(asset.durationMs) }]
                  : []),
                { label: "Eklendi", value: formatDateTime(asset.createdAt) },
                {
                  label: "SHA-256",
                  value: <Mono className="break-all text-ink-3">{asset.sha256}</Mono>,
                },
                {
                  label: "Kimlik",
                  value: <Mono className="break-all text-ink-3">{asset.id}</Mono>,
                },
              ]}
            />
            <a
              href={api.assets.contentUrl(asset.id)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-surface px-4 text-sm font-medium text-ink ring-1 ring-line-strong ring-inset hover:bg-surface-2"
            >
              Dosyayı yeni sekmede aç
            </a>
          </div>
        </div>
      )}
    </Dialog>
  );
}
