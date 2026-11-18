// The post's pictures on the canvas, Studio's side: image slots and the brand's logo.
//
// - `AssetsPanel` sits above Wecra's Design panel (Tasarım): with a slot selected (or a layer in
//   it) "Görsel yuvası · <label> · <ratio>", Boş / Dolu, "Görsel seç" (the brand's media, or a file
//   from the Mac) and "Kaldır"; with nothing selected the post's empty slots (a click selects
//   one); always "Logo ekle" when the brand kit has a logo.
// - `MediaPickerDialog`: the brand's pictures (the Medya pane's tiles) to pick one, or "Bilgisayardan
//   yükle…" (uploaded as the brand's asset first).
// - `useCanvasDrop`: a picture dragged from Medya or a file dropped on the canvas — onto a slot
//   it fills the slot; a Medya picture elsewhere on a slide becomes a picture layer there; a
//   file elsewhere is left to Wecra (it places it as Wecra does).
//
// The pictures go into the document's images, and the session learns which asset they are, so a
// save uploads nothing again (assets.ts `rememberAsset`).
import type { Asset } from "@studio/contract";
import { resolveUsage } from "@studio/design-kit/brand";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorController } from "@/editor/controller";
import { useSelection } from "@/engine/hooks";
import { Button, SearchField } from "../../../components/ui/controls.tsx";
import { Dialog } from "../../../components/ui/dialog.tsx";
import { IconImagePlus } from "../../../components/ui/icons.tsx";
import { assetUrl, describeError, useApi } from "../../../lib/api.ts";
import { hasAssetDrag, readAssetDrag } from "../../../lib/asset-drag.ts";
import { useBrandAssets } from "../../media/media-data.ts";
import { filterAssets, isImageAsset } from "../../media/media-model.ts";
import { MediaTile } from "../../media/media-views.tsx";
import { mediaSource } from "../../posts/slides.ts";
import { assetContentUrl, type RenderKit } from "../model/brand-kit.ts";
import {
  backgroundLuminance,
  type CanvasPicture,
  emptySlot,
  fillSlot,
  frameBox,
  frameOf,
  importPicture,
  insertLogo,
  insertPicture,
  type KitLogo,
  logoBox,
  pickLogo,
  postSlots,
  type SlotInfo,
  slotInfo,
  slotUnder,
} from "../wecra/slots.ts";

/** What the panel and the drop need from the workspace. */
export interface CanvasAssetsContext {
  ed: EditorController;
  brandId: string;
  kit: Pick<RenderKit, "mode" | "tokens" | "files">;
  readOnly: boolean;
  notify(message: string, tone?: "error" | "notice"): void;
  /** A picture that is this asset of the brand (the save links instead of uploading). */
  rememberAsset(assetId: string, bytes: Uint8Array): void;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function bytesOf(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Görsel okunamadı (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The kit's logos with their files (those the brand has uploaded). */
export function kitLogos(kit: Pick<RenderKit, "tokens" | "files">): KitLogo[] {
  return Object.entries(kit.tokens.logos ?? {}).flatMap(([token, l]) => {
    if (!kit.files[l.path]) return [];
    const aspect = l.aspect ?? (l.intrinsic ? l.intrinsic[0] / l.intrinsic[1] : 3);
    return [{ token, path: l.path, aspect, on: l.on ?? "any" }];
  });
}

/** The brand's slot colour (an emptied slot's fill). */
function slotColor(kit: Pick<RenderKit, "tokens">): string | null {
  try {
    const token = kit.tokens.color[resolveUsage(kit.tokens).slotFill];
    const value = typeof token === "string" ? token : token?.value;
    return value ?? null;
  } catch {
    return null;
  }
}

/** A brand asset as a canvas picture (in the document's images). */
async function assetPicture(
  ctx: CanvasAssetsContext,
  asset: Pick<Asset, "id" | "mimeType" | "originalFilename">,
): Promise<CanvasPicture> {
  const bytes = await bytesOf(assetUrl(asset.id));
  const img = await importPicture(
    ctx.ed,
    bytes,
    asset.originalFilename ?? `gorsel.${MIME_EXT[asset.mimeType] ?? "png"}`,
    asset.mimeType,
  );
  if (!img) throw new Error("Bu görsel tuvale konamıyor (PNG, JPEG, WebP ya da GIF olmalı).");
  ctx.rememberAsset(asset.id, bytes);
  return { ...img, src: mediaSource(asset.id, asset.mimeType) };
}

/** Uploads a file as an asset of the post's brand. */
async function uploadFile(
  api: ReturnType<typeof useApi>,
  brandId: string,
  file: Blob,
  filename: string,
): Promise<Asset> {
  return api.assets.upload({ brandId, kind: "image", file, filename });
}

/** A dragged / picked picture of the media (the fields the canvas needs). */
type MediaRef = Pick<Asset, "id" | "mimeType" | "originalFilename" | "brandId">;

/** The panel's and the drop's actions on the open post (none until the editor is up). */
function useAssetActions(ctx: CanvasAssetsContext | null) {
  const api = useApi();
  /** The asset as one of the post's brand (another brand's picture is copied to it). */
  const ownAsset = useCallback(
    async (asset: MediaRef): Promise<MediaRef> => {
      if (!ctx || asset.brandId === ctx.brandId) return asset;
      const bytes = await bytesOf(assetUrl(asset.id));
      return uploadFile(
        api,
        ctx.brandId,
        new Blob([bytes as BlobPart], { type: asset.mimeType }),
        asset.originalFilename ?? "gorsel",
      );
    },
    [api, ctx],
  );
  const fillWith = useCallback(
    async (slotId: string, asset: MediaRef) => {
      if (!ctx) return;
      try {
        const picture = await assetPicture(ctx, await ownAsset(asset));
        if (!fillSlot(ctx.ed, slotId, picture)) ctx.notify("Yuva doldurulamadı.", "error");
      } catch (e) {
        ctx.notify(describeError(e), "error");
      }
    },
    [ctx, ownAsset],
  );
  const fillWithFile = useCallback(
    async (slotId: string, file: File) => {
      if (!ctx) return;
      try {
        const asset = await uploadFile(api, ctx.brandId, file, file.name);
        await fillWith(slotId, asset);
      } catch (e) {
        ctx.notify(describeError(e), "error");
      }
    },
    [api, ctx, fillWith],
  );
  /** A media picture as a layer of its own on a slide, centred on `world` (page px). */
  const place = useCallback(
    async (asset: MediaRef, frame: string, world: { x: number; y: number }) => {
      if (!ctx) return;
      const box = frameBox(ctx.ed, frame);
      if (!box) return;
      try {
        const picture = await assetPicture(ctx, await ownAsset(asset));
        const w = Math.min(box.width / 2, picture.width);
        const h = (w * picture.height) / Math.max(1, picture.width);
        insertPicture(
          ctx.ed,
          frame,
          picture,
          { x: world.x - box.x - w / 2, y: world.y - box.y - h / 2, w, h },
          "image",
        );
      } catch (e) {
        ctx.notify(describeError(e), "error");
      }
    },
    [ctx, ownAsset],
  );
  const addLogo = useCallback(async () => {
    if (!ctx) return;
    const logos = kitLogos(ctx.kit);
    const frame = frameOf(ctx.ed, ctx.ed.selection[0] ?? null);
    const box = frame ? frameBox(ctx.ed, frame) : null;
    if (!frame || !box || !logos.length) return;
    const margin = ctx.kit.tokens.space?.margin ?? 72;
    const height = ctx.kit.tokens.components?.signOff?.logoHeight ?? 56;
    const first = logos[0] as KitLogo;
    const at = logoBox(box, first.aspect, margin, height);
    // The logo made for the background under where it goes.
    const lum = backgroundLuminance(ctx.ed, frame, { x: at.x + at.w / 2, y: at.y + at.h / 2 });
    const logo = pickLogo(logos, lum) ?? first;
    const placeAt = logoBox(box, logo.aspect, margin, height);
    try {
      const assetId = ctx.kit.files[logo.path] as string;
      const bytes = await bytesOf(assetContentUrl(assetId));
      const mime = logo.path.endsWith(".svg")
        ? "image/svg+xml"
        : logo.path.endsWith(".png")
          ? "image/png"
          : "image/jpeg";
      const img = await importPicture(ctx.ed, bytes, logo.path.split("/").pop() ?? "logo", mime);
      if (!img) throw new Error("Logo dosyası tuvale konamıyor.");
      ctx.rememberAsset(assetId, bytes);
      insertLogo(ctx.ed, frame, { ...img, src: `/brand/${logo.path}` }, placeAt);
    } catch (e) {
      ctx.notify(describeError(e), "error");
    }
  }, [ctx]);
  return { fillWith, fillWithFile, place, addLogo };
}

/** Re-reads `read` whenever the document or the selection changes. */
function useDocumentValue<T>(ed: EditorController, read: () => T): T {
  const [value, setValue] = useState(read);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!ed.engine.destroyed) setValue(latest.current());
      });
    };
    const off = ed.engine.onDocumentChanged(update);
    const offSel = ed.store.subscribe("selection", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      off();
      offSel();
    };
  }, [ed]);
  return value;
}

/** The brand's pictures to pick one (or a file from the Mac, uploaded as the brand's asset). */
export function MediaPickerDialog({
  open,
  brandId,
  onPick,
  onFile,
  onClose,
}: {
  open: boolean;
  brandId: string;
  onPick(asset: Asset): void;
  onFile(file: File): void;
  onClose(): void;
}) {
  const assets = useBrandAssets(open ? brandId : null);
  const [query, setQuery] = useState("");
  const file = useRef<HTMLInputElement | null>(null);
  const images = useMemo(() => (assets.data ?? []).filter(isImageAsset), [assets.data]);
  const shown = useMemo(() => filterAssets(images, query), [images, query]);
  return (
    <Dialog
      open={open}
      title="Görsel seç"
      onClose={onClose}
      width={560}
      footer={
        <>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) onFile(f);
            }}
          />
          <Button variant="secondary" onClick={() => file.current?.click()}>
            Bilgisayardan yükle…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SearchField
          data-autofocus=""
          className="w-full"
          placeholder="Medyada ara"
          aria-label="Medyada ara"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {assets.error ? (
          <p className="text-footnote text-danger">{describeError(assets.error)}</p>
        ) : assets.isLoading ? (
          <p className="text-footnote text-fg-3">Yükleniyor…</p>
        ) : shown.length === 0 ? (
          <p className="text-footnote text-fg-3">
            {images.length
              ? `“${query}” için görsel yok.`
              : "Bu markanın görseli yok. Bilgisayardan yükleyebilirsin."}
          </p>
        ) : (
          <section className="grid grid-cols-4 gap-2" aria-label="Markanın görselleri">
            {shown.slice(0, 120).map((asset) => (
              <MediaTile
                key={asset.id}
                asset={asset}
                onOpen={() => onPick(asset)}
                onContextMenu={(e) => e.preventDefault()}
              />
            ))}
          </section>
        )}
      </div>
    </Dialog>
  );
}

/** Image slots and the brand's logo, above Wecra's Design panel. */
export function AssetsPanel(ctx: CanvasAssetsContext) {
  const { ed, readOnly } = ctx;
  const selection = useSelection(ed.store);
  const sel = selection.refs.length === 1 ? (selection.refs[0] ?? null) : null;
  const slot = useDocumentValue(ed, () => (sel ? slotInfo(ed, sel) : null));
  const slots = useDocumentValue(ed, () => postSlots(ed));
  const [picking, setPicking] = useState<string | null>(null);
  const actions = useAssetActions(ctx);
  const logos = kitLogos(ctx.kit);
  const empty = slots.filter((s) => !s.filled);
  if (!slot && !logos.length && !empty.length) return null;
  return (
    <section
      aria-label="Görseller"
      data-assets-panel=""
      className="flex flex-col gap-2 border-b border-hairline px-4 py-3"
    >
      {slot ? (
        <SlotRow
          slot={slot}
          readOnly={readOnly}
          onPick={() => setPicking(slot.id)}
          onRemove={() => {
            if (!emptySlot(ed, slot.id, slotColor(ctx.kit)))
              ctx.notify("Yuva boşaltılamadı.", "error");
          }}
        />
      ) : empty.length ? (
        <div className="flex flex-col gap-1">
          <span className="text-footnote text-fg-2">Boş görsel yuvaları</span>
          {empty.map((s) => (
            <button
              key={s.id}
              type="button"
              className="flex items-center gap-2 rounded-full px-2 py-1 text-left text-body text-fg hover:bg-control"
              onClick={() => {
                ed.engine.setSelection([s.id]);
                ed.focusCanvas();
              }}
            >
              <IconImagePlus size={14} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
              <span className="shrink-0 text-footnote text-fg-3">{s.frameName}</span>
            </button>
          ))}
        </div>
      ) : null}
      {logos.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          disabled={readOnly}
          onClick={() => void actions.addLogo()}
        >
          Logo ekle
        </Button>
      )}
      <MediaPickerDialog
        open={picking !== null}
        brandId={ctx.brandId}
        onClose={() => setPicking(null)}
        onPick={(asset) => {
          const id = picking;
          setPicking(null);
          if (id) void actions.fillWith(id, asset);
        }}
        onFile={(file) => {
          const id = picking;
          setPicking(null);
          if (id) void actions.fillWithFile(id, file);
        }}
      />
    </section>
  );
}

function SlotRow({
  slot,
  readOnly,
  onPick,
  onRemove,
}: {
  slot: SlotInfo;
  readOnly: boolean;
  onPick(): void;
  onRemove(): void;
}) {
  return (
    <div className="flex flex-col gap-2" data-slot-panel={slot.filled ? "filled" : "empty"}>
      <div className="flex items-center gap-2">
        <IconImagePlus size={14} className="shrink-0 text-fg-3" />
        <span className="min-w-0 flex-1 truncate text-body text-fg">
          Görsel yuvası · {slot.label}
          {slot.ratio ? ` · ${slot.ratio}` : ""}
        </span>
        <span className="shrink-0 text-footnote text-fg-3">{slot.filled ? "Dolu" : "Boş"}</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={readOnly} onClick={onPick}>
          Görsel seç
        </Button>
        {slot.filled && (
          <Button size="sm" variant="ghost" disabled={readOnly} onClick={onRemove}>
            Kaldır
          </Button>
        )}
      </div>
      {!slot.filled && (
        <p className="text-footnote text-fg-3">
          Medya'dan sürükleyip bırakabilir ya da bir dosya bırakabilirsin.
        </p>
      )}
    </div>
  );
}

/**
 * Drops on the canvas: a Medya picture or a file onto a slot fills it; a Medya picture elsewhere
 * on a slide becomes a picture layer there; a file elsewhere is Wecra's (not touched here).
 */
export function useCanvasDrop(ctx: CanvasAssetsContext | null) {
  const actions = useAssetActions(ctx);
  const point = (e: DragEvent): { x: number; y: number } | null => {
    const canvas = ctx?.ed.canvas;
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const wanted = (e: DragEvent) =>
    !!ctx &&
    !ctx.readOnly &&
    (hasAssetDrag(e.dataTransfer) || [...e.dataTransfer.types].includes("Files"));
  const onDragOverCapture = (e: DragEvent) => {
    if (!ctx || !wanted(e)) return;
    const at = point(e);
    const slot = at ? slotUnder(ctx.ed, at) : null;
    // Over a slot (or a Medya picture anywhere): Studio takes the drop.
    if (slot || hasAssetDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDropCapture = (e: DragEvent) => {
    if (!ctx || !wanted(e)) return;
    const at = point(e);
    if (!at) return;
    const slot = slotUnder(ctx.ed, at);
    const a = readAssetDrag(e.dataTransfer)[0];
    const asset: MediaRef | null = a
      ? { id: a.assetId, brandId: a.brandId, mimeType: a.mimeType, originalFilename: a.filename }
      : null;
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith("image/"));
    if (slot && (asset || file)) {
      e.preventDefault();
      e.stopPropagation();
      if (asset) void actions.fillWith(slot, asset);
      else if (file) void actions.fillWithFile(slot, file);
      return;
    }
    if (!asset) return; // a file off the slots: Wecra places it
    e.preventDefault();
    e.stopPropagation();
    const frame = frameOf(ctx.ed, ctx.ed.engine.hitTest(at.x, at.y)[0] ?? null);
    if (frame) void actions.place(asset, frame, ctx.ed.engine.screenToWorld(at.x, at.y));
  };
  return { onDragOverCapture, onDropCapture };
}
