// The media library ("Tümü"): the brand's files with kind filters and counts, search, upload
// (button or drop files on the page), "AI ile görsel üret", click → lightbox, right-click menu,
// drag pictures into a chat's composer.
import { useMemo, useRef, useState } from "react";
import { Button, cn, SearchField, SegmentedControl } from "../../components/ui/controls.tsx";
import { IconImage, IconSparkles, IconUpload } from "../../components/ui/icons.tsx";
import { useContextMenu } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { PageHeader, PaneMessage } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import { ImageGeneratorSheet } from "./image-generator.tsx";
import { useBrandAssets, useUploadAssets } from "./media-data.ts";
import {
  assetMeta,
  filterAssets,
  MEDIA_FILTERS,
  type MediaFilter,
  mediaCounts,
  UPLOAD_ACCEPT,
} from "./media-model.ts";
import { MediaTile, mediaMenu, useMediaLightbox } from "./media-views.tsx";

export default function MediaPage() {
  const { brandId, brand } = usePanelBrand();
  if (!brandId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Medya" />
        <div className="px-8">
          <PaneMessage
            icon={<IconImage size={18} />}
            text="Medya için kenar çubuğunun altındaki menüden bir marka seç."
          />
        </div>
      </div>
    );
  }
  return <MediaPageBody key={brandId} brandId={brandId} brandName={brand?.name ?? ""} />;
}

function MediaPageBody({ brandId, brandName }: { brandId: string; brandName: string }) {
  const assets = useBrandAssets(brandId);
  const { upload, uploading } = useUploadAssets(brandId);
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [generator, setGenerator] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const menu = useContextMenu();
  const all = assets.data ?? [];
  const counts = useMemo(() => mediaCounts(all), [all]);
  const shown = useMemo(() => filterAssets(all, query, filter), [all, query, filter]);
  const lightbox = useMediaLightbox(shown);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop files anywhere on the page to upload
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col",
        dropping && "shadow-[inset_0_0_0_2px_var(--accent-default)]",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropping(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(false);
        void upload([...event.dataTransfer.files]);
      }}
    >
      <PageHeader
        title="Medya"
        subtitle={
          brandName
            ? `${brandName} · ${counts.all} dosya${uploading ? ` · ${uploading} yükleniyor…` : ""}`
            : undefined
        }
        actions={
          <>
            <Button
              icon={<IconUpload size={14} strokeWidth={1.75} />}
              onClick={() => fileInput.current?.click()}
            >
              Yükle
            </Button>
            <Button
              variant="primary"
              icon={<IconSparkles size={14} strokeWidth={1.75} />}
              onClick={() => setGenerator(true)}
            >
              AI ile görsel üret
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept={UPLOAD_ACCEPT}
              onChange={(event) => {
                void upload([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SegmentedControl<MediaFilter>
            label="Tür"
            value={filter}
            onChange={setFilter}
            options={MEDIA_FILTERS.map((f) => ({
              value: f.id,
              label: `${f.label} ${counts[f.id]}`,
            }))}
          />
          <SearchField
            className="w-[260px]"
            placeholder="Medyada ara"
            aria-label="Medyada ara"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </PageHeader>
      <div className="scroll-area min-h-0 flex-1 px-8 pb-10">
        {assets.error ? (
          <p className="text-body text-danger">{describeError(assets.error)}</p>
        ) : assets.isLoading ? (
          <p className="text-body text-fg-3">Yükleniyor…</p>
        ) : shown.length === 0 ? (
          <p className="text-body text-fg-3">
            {all.length === 0
              ? "Henüz dosya yok. Yükle ya da dosyaları buraya bırak."
              : "Bu filtreyle eşleşen dosya yok."}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-4">
            {shown.map((asset) => (
              <figure key={asset.id} className="m-0 flex min-w-0 flex-col gap-1.5">
                <MediaTile
                  asset={asset}
                  radius={10}
                  tileRef={lightbox.register(asset.id)}
                  onOpen={() => lightbox.open(asset)}
                  onContextMenu={(event) =>
                    menu.open(
                      event,
                      mediaMenu(asset, () => lightbox.open(asset)),
                    )
                  }
                />
                <figcaption className="min-w-0 px-0.5">
                  <div
                    className="truncate text-footnote text-fg"
                    title={asset.originalFilename ?? undefined}
                  >
                    {asset.originalFilename ?? "Adsız"}
                  </div>
                  <div className="truncate text-caption text-fg-3">{assetMeta(asset)}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
      <ImageGeneratorSheet
        open={generator}
        onClose={() => setGenerator(false)}
        brandId={brandId}
        assets={all}
      />
      {menu.element}
    </div>
  );
}
