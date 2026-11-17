// Medya pane of the right panel (Wecra "Panel – Medya"): search, "MTM Agro · 128 görsel" with
// "Tümü" (the library page), a 3-column grid of the brand's pictures; click → lightbox, drag into
// the composer to attach, right-click for Önizle / Sohbete ekle / Farklı kaydet.
import { useMemo, useState } from "react";
import { SearchField } from "../../components/ui/controls.tsx";
import { IconImage } from "../../components/ui/icons.tsx";
import { useContextMenu } from "../../components/ui/menu.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { PaneMessage, TextLink } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import { useBrandAssets } from "./media-data.ts";
import { filterAssets, isImageAsset, mediaSummary } from "./media-model.ts";
import { MediaTile, mediaMenu, useMediaLightbox } from "./media-views.tsx";

/** Tiles shown in the pane; the rest is on the library page. */
export const PANE_LIMIT = 60;

export function MediaPane() {
  const { brandId, brand } = usePanelBrand();
  if (!brandId) {
    return (
      <PaneMessage
        icon={<IconImage size={18} />}
        text="Medya için başlıktaki menüden bir marka seç."
      />
    );
  }
  return <MediaPaneBody key={brandId} brandId={brandId} brandName={brand?.name ?? null} />;
}

function MediaPaneBody({ brandId, brandName }: { brandId: string; brandName: string | null }) {
  const navigate = useAppStore((s) => s.navigate);
  const assets = useBrandAssets(brandId);
  const [query, setQuery] = useState("");
  const menu = useContextMenu();
  const images = useMemo(() => (assets.data ?? []).filter(isImageAsset), [assets.data]);
  const shown = useMemo(() => filterAssets(images, query), [images, query]);
  const lightbox = useMediaLightbox(shown);
  return (
    <div className="flex flex-col gap-3">
      <SearchField
        className="w-full"
        placeholder="Medyada ara"
        aria-label="Medyada ara"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query) {
            event.stopPropagation();
            setQuery("");
          }
        }}
      />
      <div className="flex h-4 items-center">
        <span className="min-w-0 flex-1 truncate text-footnote text-fg-2">
          {mediaSummary(brandName, images.length)}
        </span>
        <TextLink className="text-footnote" onClick={() => navigate({ kind: "media" })}>
          Tümü
        </TextLink>
      </div>
      {assets.error ? (
        <p className="text-footnote text-danger">{describeError(assets.error)}</p>
      ) : assets.isLoading ? (
        <p className="text-footnote text-fg-3">Yükleniyor…</p>
      ) : images.length === 0 ? (
        <p className="text-footnote text-fg-3">
          Bu markanın görseli yok. Medya sayfasından yükleyebilir ya da AI ile üretebilirsin.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-footnote text-fg-3">“{query}” için görsel yok.</p>
      ) : (
        <section className="grid grid-cols-3 gap-2" aria-label="Görseller">
          {shown.slice(0, PANE_LIMIT).map((asset) => (
            <MediaTile
              key={asset.id}
              asset={asset}
              tileRef={lightbox.register(asset.id)}
              onOpen={() => lightbox.open(asset)}
              onContextMenu={(event) =>
                menu.open(
                  event,
                  mediaMenu(asset, () => lightbox.open(asset)),
                )
              }
            />
          ))}
        </section>
      )}
      {shown.length > PANE_LIMIT && (
        <TextLink className="text-footnote" onClick={() => navigate({ kind: "media" })}>
          {shown.length - PANE_LIMIT} görsel daha →
        </TextLink>
      )}
      {images.length > 0 && (
        <p className="text-footnote text-fg-3">
          Bir görseli yazı kutusuna sürükleyerek sohbete ekle.
        </p>
      )}
      {menu.element}
    </div>
  );
}
