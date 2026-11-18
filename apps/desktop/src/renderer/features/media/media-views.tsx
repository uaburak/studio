// Media building blocks shared by the Medya pane and the library page: square thumbnails
// (hover dim, AI badge), click → the image viewer, drag into the composer, right-click menu
// (Önizle, Sohbete ekle, Farklı kaydet…).
import type { Asset } from "@studio/contract";
import { cn } from "../../components/ui/controls.tsx";
import {
  IconAddToChat,
  IconAudio,
  IconDocument,
  IconDownload,
  IconExpand,
  IconImage,
  IconType,
  IconVideo,
} from "../../components/ui/icons.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { useImageZoom } from "../../components/ui/zoomable-image.tsx";
import { assetUrl } from "../../lib/api.ts";
import { assetDragPayload, requestComposerAttach, writeAssetDrag } from "../../lib/asset-drag.ts";
import { useAppStore } from "../../state/app-store.ts";
import { downloadName, isImageAsset, lightboxImages } from "./media-model.ts";

/** Save an asset's bytes through the browser download (Electron asks where). */
export function saveAsset(asset: Asset): void {
  const a = document.createElement("a");
  a.href = assetUrl(asset.id);
  a.download = downloadName(asset);
  document.body.append(a);
  a.click();
  a.remove();
}

export function addToChat(asset: Asset): void {
  const { showToast } = useAppStore.getState();
  if (!requestComposerAttach([assetDragPayload(asset)])) {
    showToast({ message: "Sohbete eklemek için bir sohbet aç." });
  }
}

/** Opens the viewer on `asset` among `assets` (images only), zooming out of its tile. */
export function useMediaLightbox(assets: readonly Asset[]) {
  const images = lightboxImages(assets);
  const zoom = useImageZoom(images);
  const indexOf = new Map(images.map((image, index) => [image.assetId, index]));
  const open = (asset: Asset) => {
    const index = indexOf.get(asset.id);
    if (index !== undefined) zoom.open(index);
  };
  const register = (id: string) => {
    const index = indexOf.get(id);
    return index === undefined ? undefined : zoom.ref(index);
  };
  return { open, register };
}

export function mediaMenu(asset: Asset, preview: () => void): MenuEntry[] {
  const image = isImageAsset(asset);
  return [
    {
      id: "preview",
      label: "Önizle",
      icon: <IconExpand size={14} strokeWidth={1.5} />,
      disabled: !image,
      onSelect: preview,
    },
    {
      id: "chat",
      label: "Sohbete ekle",
      icon: <IconAddToChat size={14} strokeWidth={1.5} />,
      disabled: !image,
      onSelect: () => addToChat(asset),
    },
    { type: "separator" },
    {
      id: "save",
      label: "Farklı kaydet…",
      icon: <IconDownload size={14} strokeWidth={1.5} />,
      onSelect: () => saveAsset(asset),
    },
  ];
}

function KindGlyph({ asset }: { asset: Asset }) {
  const size = 20;
  if (asset.kind === "video") return <IconVideo size={size} strokeWidth={1.4} />;
  if (asset.kind === "audio") return <IconAudio size={size} strokeWidth={1.4} />;
  if (asset.kind === "document") return <IconDocument size={size} strokeWidth={1.4} />;
  if (asset.kind === "font") return <IconType size={size} strokeWidth={1.4} />;
  return <IconImage size={size} strokeWidth={1.4} />;
}

/** A square tile: the picture (or a kind glyph), hover dim, "AI" for generated pictures. */
export function MediaTile({
  asset,
  tileRef,
  onOpen,
  onContextMenu,
  radius = 8,
  className,
}: {
  asset: Asset;
  tileRef?: (el: HTMLElement | null) => void;
  onOpen(): void;
  onContextMenu(event: React.MouseEvent): void;
  radius?: number;
  className?: string;
}) {
  const image = isImageAsset(asset);
  const name = asset.originalFilename ?? "";
  return (
    <button
      ref={tileRef}
      type="button"
      draggable={image}
      onDragStart={(event) => {
        if (!image) return;
        writeAssetDrag(event.dataTransfer, [assetDragPayload(asset)]);
      }}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      title={name || undefined}
      aria-label={image ? `Görseli aç${name ? `: ${name}` : ""}` : name || "Dosya"}
      data-asset={asset.id}
      className={cn(
        "group relative aspect-square w-full overflow-hidden bg-control",
        !image && "flex items-center justify-center text-icon",
        className,
      )}
      style={{ borderRadius: radius }}
    >
      {image ? (
        <img
          src={assetUrl(asset.id)}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        <span className="flex flex-col items-center gap-1.5 px-2">
          <KindGlyph asset={asset} />
          <span className="max-w-full truncate text-caption text-fg-2">{name}</span>
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/20" />
      {asset.source === "generated" && (
        <span className="pointer-events-none absolute top-1.5 left-1.5 rounded-full bg-black/55 px-1.5 text-caption font-medium leading-4 text-white">
          AI
        </span>
      )}
    </button>
  );
}
