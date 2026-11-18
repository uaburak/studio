// "Bu şablonla yeni post" (N9): the template's fields as a form — a text per text field (with
// the template's text as the hint and its rough length), a picture per image field from the
// brand's media — or a subject the AI writes the fields from. Sending makes a draft post whose
// job fills the layout; the post opens. `TemplatePicker` lists a brand's templates first (the
// Postlar title menu's "Şablondan yeni post").
import { type ContentTemplate, fillableFields, type TemplateField } from "@studio/contract";
import { useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  SegmentedControl,
  Spinner,
  TextField,
} from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { IconLayers } from "../../components/ui/icons.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { describeError } from "../../lib/api.ts";
import { thumbUrl } from "../../lib/thumbnail.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useBrandAssets } from "../media/media-data.ts";
import { usePostsStore } from "../posts/store.ts";
import { useBrandTemplates, useTemplateActions } from "./templates-data.ts";
import {
  type FillForm,
  type FillMode,
  fieldCount,
  fillForm,
  fillProblem,
  templateLine,
  templateUseInput,
} from "./templates-model.ts";

/** `/media/<asset>.<ext>` → the asset id. */
function mediaAsset(src: string): string {
  return decodeURIComponent(src.slice("/media/".length).replace(/\.[a-z0-9]+$/i, ""));
}

const AREA =
  "selectable w-full resize-y rounded-[12px] bg-field px-3 py-2 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none placeholder:text-fg-3";

export function TemplatePreview({
  template,
  className,
}: {
  template: ContentTemplate;
  className?: string;
}) {
  const first = template.previewAssetIds.find((id) => id !== null) ?? null;
  return (
    <div
      className={cn("relative w-full overflow-hidden bg-control", className)}
      style={{ aspectRatio: `${template.width} / ${template.height}` }}
    >
      {first ? (
        <img
          src={thumbUrl(first, 320)}
          alt=""
          loading="lazy"
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        <span className="flex size-full items-center justify-center text-fg-3">
          <IconLayers size={28} strokeWidth={1.25} />
        </span>
      )}
      {template.slideCount > 1 && (
        <span className="absolute right-2 bottom-2 rounded-full bg-black/55 px-1.5 text-caption text-white">
          {template.slideCount} kare
        </span>
      )}
    </div>
  );
}

function ImageField({
  field,
  brandId,
  value,
  onChange,
}: {
  field: TemplateField;
  brandId: string;
  value: string | undefined;
  onChange(assetId: string | null): void;
}) {
  const [picking, setPicking] = useState(false);
  const assets = useBrandAssets(picking ? brandId : null);
  const images = (assets.data ?? []).filter(
    (a) => a.kind === "image" && /^image\/(jpeg|png|webp|gif)$/.test(a.mimeType) && !a.deletedAt,
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <div className="size-14 shrink-0 overflow-hidden rounded-[8px] bg-control">
          {value ? (
            <img src={thumbUrl(value, 112)} alt="" className="size-full object-cover" />
          ) : field.example.startsWith("/media/") ? (
            <img
              src={thumbUrl(mediaAsset(field.example), 112)}
              alt=""
              className="size-full object-cover opacity-60"
            />
          ) : null}
        </div>
        <div className="min-w-0 flex-1 text-footnote text-fg-2">
          {value ? "Yeni görsel seçildi." : "Şablondaki görsel kalır."}
          {field.ratio && <span className="text-fg-3"> · {field.ratio}</span>}
        </div>
        <Button variant="secondary" onClick={() => setPicking((p) => !p)}>
          {picking ? "Kapat" : "Görsel seç"}
        </Button>
        {value && (
          <Button variant="ghost" onClick={() => onChange(null)}>
            Şablondaki kalsın
          </Button>
        )}
      </div>
      {picking && (
        <div
          role="listbox"
          aria-label={`${field.label}: görsel seç`}
          className="grid max-h-[220px] grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-2 overflow-y-auto rounded-[10px] bg-field p-2"
        >
          {assets.isPending ? (
            <span className="flex items-center gap-2 p-2 text-footnote text-fg-3">
              <Spinner size={12} /> Medya yükleniyor…
            </span>
          ) : images.length === 0 ? (
            <span className="p-2 text-footnote text-fg-3">
              Markanın medyasında görsel yok; Medya'dan yükleyin.
            </span>
          ) : (
            images.map((a) => (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={value === a.id}
                aria-label={a.originalFilename ?? "Görsel"}
                onClick={() => {
                  onChange(a.id);
                  setPicking(false);
                }}
                className={cn(
                  "aspect-square overflow-hidden rounded-[8px] bg-control",
                  value === a.id && "ring-2 ring-accent",
                )}
              >
                <img src={thumbUrl(a.id, 144)} alt="" className="size-full object-cover" />
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TextFieldRow({
  field,
  value,
  onChange,
}: {
  field: TemplateField;
  value: string;
  onChange(value: string): void;
}) {
  const { count, limit, over } = fieldCount(field, value);
  const long = field.multiline || field.example.length > 60;
  return (
    <div className="flex flex-col gap-1">
      {long ? (
        <textarea
          aria-label={field.label}
          className={AREA}
          rows={3}
          value={value}
          placeholder={field.example}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <TextField
          aria-label={field.label}
          className="w-full"
          value={value}
          placeholder={field.example}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {value && limit !== null && (
        <span className={cn("text-caption tabular-nums", over ? "text-warning" : "text-fg-3")}>
          {count} / ~{limit} karakter
          {over && " · uzun: sığmazsa küçültülür"}
        </span>
      )}
    </div>
  );
}

export function TemplateUseSheet({
  template,
  onClose,
}: {
  template: ContentTemplate;
  onClose(): void;
}) {
  const actions = useTemplateActions();
  const showToast = useAppStore((s) => s.showToast);
  const [form, setForm] = useState<FillForm>(() => fillForm(template));
  const [busy, setBusy] = useState(false);
  const problem = fillProblem(template, form);
  const texts = fillableFields(template, "text");
  const images = fillableFields(template, "image");
  const set = (change: Partial<FillForm>) => setForm((f) => ({ ...f, ...change }));

  const submit = async () => {
    if (problem) {
      showToast({ message: problem });
      return;
    }
    setBusy(true);
    try {
      const res = await actions.use(template, templateUseInput(template, form));
      showToast({ message: `“${res.content.title}” şablondan hazırlanıyor.` });
      onClose();
      usePostsStore.getState().open(res.content.id);
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      title="Bu şablonla yeni post"
      width={620}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !!problem}>
            {busy ? "Hazırlanıyor…" : "Postu oluştur"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-4">
          <TemplatePreview template={template} className="w-[120px] shrink-0 rounded-[10px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="truncate text-body-lg font-medium text-fg">{template.name}</div>
            <div className="text-footnote text-fg-2">{templateLine(template)}</div>
            <p className="text-footnote text-fg-3">
              Yerleşim aynen kalır; yalnızca metinler ve görseller değişir.
            </p>
            <TextField
              aria-label="Postun başlığı"
              className="w-full"
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
        </div>
        <SegmentedControl<FillMode>
          label="Nasıl doldurulsun"
          value={form.mode}
          onChange={(mode) => set({ mode })}
          options={[
            { value: "manual", label: "Elle doldur" },
            { value: "ai", label: "AI doldursun" },
          ]}
        />
        {form.mode === "ai" ? (
          <div className="flex flex-col gap-1">
            <textarea
              aria-label="Konu"
              className={AREA}
              rows={4}
              value={form.brief}
              placeholder="Post ne anlatsın? Ör. Kış öncesi bor ve çinko hatırlatması, bayilere yönlendir."
              onChange={(e) => set({ brief: e.target.value })}
            />
            <span className="text-caption text-fg-3">
              AI her alanı şablondaki metin uzunluğunda yazar; açıklamayı da yazar.
            </span>
          </div>
        ) : (
          texts.length > 0 && (
            <section aria-label="Metin alanları" className="flex flex-col gap-3">
              {texts.map((f) => (
                <div key={f.key} className="flex flex-col gap-1">
                  <span className="text-footnote font-medium text-fg-2">{f.label}</span>
                  <TextFieldRow
                    field={f}
                    value={form.values[f.key] ?? ""}
                    onChange={(v) => set({ values: { ...form.values, [f.key]: v } })}
                  />
                </div>
              ))}
              <p className="text-caption text-fg-3">Boş bırakılan alan şablondaki metni korur.</p>
            </section>
          )
        )}
        {images.length > 0 && (
          <section aria-label="Görsel alanları" className="flex flex-col gap-3">
            {images.map((f) => (
              <div key={f.key} className="flex flex-col gap-1">
                <span className="text-footnote font-medium text-fg-2">{f.label}</span>
                <ImageField
                  field={f}
                  brandId={template.brandId}
                  value={form.images[f.key]}
                  onChange={(assetId) => {
                    const next = { ...form.images };
                    if (assetId) next[f.key] = assetId;
                    else delete next[f.key];
                    set({ images: next });
                  }}
                />
              </div>
            ))}
          </section>
        )}
        <Checkbox checked={form.autoFit} onChange={(autoFit) => set({ autoFit })}>
          Sığmayan metni küçült (sınırlar içinde)
        </Checkbox>
      </div>
    </Sheet>
  );
}

/** A brand's templates to pick one from, then its fill sheet. */
export function TemplatePicker({ brandId, onClose }: { brandId: string; onClose(): void }) {
  const templates = useBrandTemplates(brandId);
  const [picked, setPicked] = useState<ContentTemplate | null>(null);
  const list = templates.data ?? [];
  if (picked) return <TemplateUseSheet template={picked} onClose={onClose} />;
  return (
    <Dialog open title="Şablondan yeni post" onClose={onClose} width={640}>
      {templates.isPending ? (
        <p className="flex items-center gap-2 text-body text-fg-3">
          <Spinner size={12} /> Şablonlar yükleniyor…
        </p>
      ) : templates.error ? (
        <p role="alert" className="text-body text-danger">
          Şablonlar yüklenemedi: {describeError(templates.error)}
        </p>
      ) : list.length === 0 ? (
        <div className="flex flex-col gap-1 text-body text-fg-2">
          <p>Bu markanın şablonu yok.</p>
          <p className="text-footnote text-fg-3">
            Onaylı bir postu “…” menüsünden “Şablon olarak kaydet” ile şablon yapabilirsin.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Şablonlar"
          className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3"
        >
          {list.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setPicked(t)}
                aria-label={`${t.name}: bu şablonla yeni post`}
                className="flex w-full flex-col overflow-hidden rounded-[12px] bg-field text-left shadow-[inset_0_0_0_1px_var(--border-hairline)] hover:bg-control"
              >
                <TemplatePreview template={t} />
                <span className="truncate px-2.5 pt-2 text-body font-medium text-fg">{t.name}</span>
                <span className="truncate px-2.5 pb-2 text-caption text-fg-3">
                  {templateLine(t)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
