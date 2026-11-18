// "AI ile görsel üret" (port of StudioMac's AI image sheet): the description, the aspect ratio,
// the resolution, an optional reference picture of the brand and "keep the product label".
// Sends an `image.generate` job; the picture shows up in the library when it is ready.
import type { Asset } from "@studio/contract";
import { useState } from "react";
import { Button, Checkbox, cn, SegmentedControl } from "../../components/ui/controls.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { assetUrl, describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useGenerateImage } from "./media-data.ts";
import {
  ASPECT_RATIOS,
  type AspectRatio,
  IMAGE_SIZES,
  type ImageRequestForm,
  type ImageSize,
  isImageAsset,
} from "./media-model.ts";

export function ImageGeneratorSheet({
  open,
  onClose,
  brandId,
  assets,
}: {
  open: boolean;
  onClose(): void;
  brandId: string;
  assets: readonly Asset[];
}) {
  const generate = useGenerateImage(brandId);
  const showToast = useAppStore((s) => s.showToast);
  const [form, setForm] = useState<ImageRequestForm>({
    prompt: "",
    aspectRatio: "4:5",
    imageSize: "2K",
    referenceAssetId: null,
    preserveProductLabel: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const references = assets.filter((a) => isImageAsset(a) && a.source !== "generated").slice(0, 18);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await generate(form);
      showToast({ message: "Görsel hazırlanıyor; bitince kütüphanede görünecek." });
      setForm((f) => ({ ...f, prompt: "" }));
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="AI ile görsel üret"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            disabled={busy || !form.prompt.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Gönderiliyor…" : "Üret"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">Görsel tarifi</span>
          <textarea
            value={form.prompt}
            rows={4}
            placeholder="Örn. hasat sonrası tarlada toprak, sabah ışığı, yakın plan"
            onChange={(event) => setForm((f) => ({ ...f, prompt: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.metaKey) void submit();
            }}
            className="selectable resize-none rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3"
          />
        </label>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Oran</span>
            <SegmentedControl
              label="Oran"
              value={form.aspectRatio}
              onChange={(value: AspectRatio) => setForm((f) => ({ ...f, aspectRatio: value }))}
              options={ASPECT_RATIOS.map((r) => ({ value: r.value, label: r.label }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Çözünürlük</span>
            <SegmentedControl
              label="Çözünürlük"
              value={form.imageSize}
              onChange={(value: ImageSize) => setForm((f) => ({ ...f, imageSize: value }))}
              options={IMAGE_SIZES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-footnote text-fg-2">Referans ürün fotoğrafı (isteğe bağlı)</span>
          {references.length === 0 ? (
            <p className="text-footnote text-fg-3">Markanın yüklenmiş fotoğrafı yok.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Referans">
              {/* biome-ignore lint/a11y/useSemanticElements: picture tiles acting as radio buttons */}
              <button
                type="button"
                role="radio"
                aria-checked={form.referenceAssetId === null}
                onClick={() => setForm((f) => ({ ...f, referenceAssetId: null }))}
                className={cn(
                  "flex size-14 items-center justify-center rounded-[8px] bg-control text-caption text-fg-2",
                  form.referenceAssetId === null &&
                    "shadow-[inset_0_0_0_2px_var(--accent-default)]",
                )}
              >
                Yok
              </button>
              {references.map((asset) => (
                // biome-ignore lint/a11y/useSemanticElements: picture tiles acting as radio buttons
                <button
                  key={asset.id}
                  type="button"
                  role="radio"
                  aria-checked={form.referenceAssetId === asset.id}
                  aria-label={asset.originalFilename ?? "Referans görsel"}
                  title={asset.originalFilename ?? undefined}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      referenceAssetId: asset.id,
                      // A product photo usually carries a label worth keeping.
                      preserveProductLabel:
                        f.referenceAssetId === null ? true : f.preserveProductLabel,
                    }))
                  }
                  className={cn(
                    "relative size-14 overflow-hidden rounded-[8px] bg-control",
                    form.referenceAssetId === asset.id &&
                      "shadow-[0_0_0_2px_var(--accent-default)]",
                  )}
                >
                  <img
                    src={assetUrl(asset.id)}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        <Checkbox
          checked={form.preserveProductLabel}
          onChange={(checked) => setForm((f) => ({ ...f, preserveProductLabel: checked }))}
        >
          Ürün etiketini bozmadan koru
        </Checkbox>
        {error && (
          <p className="text-footnote text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
