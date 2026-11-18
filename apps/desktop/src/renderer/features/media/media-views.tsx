// Media building blocks shared by the Medya pane and the library page: square thumbnails
// (hover dim, AI badge), click → the image viewer, drag into the composer, right-click menu
// (Önizle, Benzerleri, Sohbete ekle, Farklı kaydet…), tag chips (N12).
import type { Asset } from "@studio/contract";
import { cn } from "../../components/ui/controls.tsx";
import {
  IconAddToChat,
  IconAudio,
  IconDocument,
  IconDownload,
  IconExpand,
  IconImage,
  IconLayers,
  IconTrash,
  IconType,
  IconVideo,
} from "../../components/ui/icons.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { useImageZoom } from "../../components/ui/zoomable-image.tsx";
import { assetUrl } from "../../lib/api.ts";
import { assetDragPayload, requestComposerAttach, writeAssetDrag } from "../../lib/asset-drag.ts";
import { tileUrl } from "../../lib/thumbnail.ts";
import { useAppStore } from "../../state/app-store.ts";
import { analysisTooltip, downloadName, isImageAsset, lightboxImages } from "./media-model.ts";

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

export function mediaMenu(
  asset: Asset,
  preview: () => void,
  /** "Sil": to the trash (refused while a post, product or the kit uses it). */
  remove?: () => void,
  /** "Benzerleri" (N12): the pictures that look like this one. */
  similar?: () => void,
): MenuEntry[] {
  const image = isImageAsset(asset);
  return [
    {
      id: "preview",
      label: "Önizle",
      icon: <IconExpand size={14} strokeWidth={1.5} />,
      disabled: !image,
      onSelect: preview,
    },
    ...(similar
      ? ([
          {
            id: "similar",
            label: "Benzerleri",
            icon: <IconLayers size={14} strokeWidth={1.5} />,
            disabled: !image,
            onSelect: similar,
          },
        ] satisfies MenuEntry[])
      : []),
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
    ...(remove
      ? ([
          { type: "separator" },
          {
            id: "delete",
            label: "Sil",
            danger: true,
            icon: <IconTrash size={14} strokeWidth={1.5} />,
            onSelect: remove,
          },
        ] satisfies MenuEntry[])
      : []),
  ];
}

/**
 * The library's most common Turkish tags (what Vision read, N12) as chips: a click searches for
 * the tag, a second click clears it.
 */
export function TagChips({
  tags,
  query,
  onQuery,
}: {
  tags: readonly { label: string; count: number }[];
  query: string;
  onQuery(next: string): void;
}) {
  if (tags.length === 0) return null;
  const current = query.trim().toLocaleLowerCase("tr-TR");
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0" aria-label="Etiketler">
      {tags.map((tag) => {
        const active = current === tag.label.toLocaleLowerCase("tr-TR");
        return (
          <button
            key={tag.label}
            type="button"
            aria-pressed={active}
            title={`${tag.count} görsel`}
            onClick={() => onQuery(active ? "" : tag.label)}
            className={cn(
              "inline-flex h-6 items-center rounded-full px-2.5 text-footnote transition-colors",
              active ? "bg-accent-subtle text-accent-text" : "bg-control text-fg-2 hover:text-fg",
            )}
          >
            {tag.label}
          </button>
        );
      })}
    </fieldset>
  );
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
      title={[name, analysisTooltip(asset)].filter(Boolean).join("\n") || undefined}
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
          src={tileUrl(asset, 200)}
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
