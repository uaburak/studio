// "Şablonlar" on the brand profile (N9): the brand's templates — approved posts saved as layouts
// — as cards (preview, name, type, size, fields, uses, the post it came from) with search,
// "Bu şablonla yeni post", rename, field settings (label, locked, auto-fit) and delete. A template
// is made from a post's "…" menu ("Şablon olarak kaydet").
import type { Brand, ContentTemplate, TemplateField } from "@studio/contract";
import { useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  IconButton,
  SearchField,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import { IconEllipsis, IconLayers } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { Sheet } from "../../components/ui/sheet.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { usePostsStore } from "../posts/store.ts";
import { TemplatePreview, TemplateUseSheet } from "./template-use.tsx";
import { useBrandTemplates, useTemplateActions } from "./templates-data.ts";
import { templateLine, templateMatches, templateUses } from "./templates-model.ts";

export function TemplatesTab({ brand }: { brand: Brand }) {
  const templates = useBrandTemplates(brand.id);
  const actions = useTemplateActions();
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [using, setUsing] = useState<ContentTemplate | null>(null);
  const [editing, setEditing] = useState<ContentTemplate | null>(null);
  const [deleting, setDeleting] = useState<ContentTemplate | null>(null);
  const [removing, setRemoving] = useState(false);
  const list = templates.data ?? [];
  const shown = list.filter((t) => templateMatches(t, query));

  const remove = async () => {
    if (!deleting) return;
    setRemoving(true);
    try {
      await actions.remove(deleting);
      showToast({ message: `“${deleting.name}” şablonu silindi.` });
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
            Şablonlar{list.length > 0 && <span className="text-fg-3"> · {list.length}</span>}
          </h2>
          <p className="text-body text-fg-2">
            Onaylı postlardan kaydedilen yerleşimler: metinler ve görseller değişir, tasarım aynı
            kalır.
          </p>
        </div>
        {list.length > 0 && (
          <SearchField
            aria-label="Şablonlarda ara"
            placeholder="Şablonlarda ara"
            className="w-[240px]"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      {templates.isPending && !templates.error ? (
        <p className="flex items-center gap-2 text-body text-fg-3">
          <Spinner size={12} /> Yükleniyor…
        </p>
      ) : templates.error ? (
        <p className="text-body text-danger" role="alert">
          Şablonlar yüklenemedi: {describeError(templates.error)}
        </p>
      ) : list.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-[12px] bg-field p-5 text-body text-fg-2">
          <span className="text-icon">
            <IconLayers size={20} strokeWidth={1.5} />
          </span>
          <p>Henüz şablon yok.</p>
          <p className="text-footnote text-fg-3">
            Onaylı ya da yayınlanmış bir postu açıp “…” menüsünden “Şablon olarak kaydet” de.
            Başlık, metin, çağrı ve görsel yuvaları doldurulabilir alan olur.
          </p>
        </div>
      ) : shown.length === 0 ? (
        <p className="text-body text-fg-3">“{query.trim()}” için şablon yok.</p>
      ) : (
        <ul
          aria-label="Şablonlar"
          className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4"
        >
          {shown.map((t) => (
            <li key={t.id}>
              <TemplateCard
                template={t}
                onUse={() => setUsing(t)}
                onEdit={() => setEditing(t)}
                onDelete={() => setDeleting(t)}
              />
            </li>
          ))}
        </ul>
      )}

      {using && <TemplateUseSheet template={using} onClose={() => setUsing(null)} />}
      {editing && (
        <TemplateSettingsSheet
          key={editing.id}
          template={editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `“${deleting.name}” şablonu silinsin mi?` : ""}
        message="Bu şablonla yapılan postlar ve plan kalemleri tasarımlarını korur; yalnızca şablon bağlantısı kalkar."
        confirmLabel="Sil"
        destructive
        busy={removing}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function TemplateCard({
  template,
  onUse,
  onEdit,
  onDelete,
}: {
  template: ContentTemplate;
  onUse(): void;
  onEdit(): void;
  onDelete(): void;
}) {
  const source = template.source;
  const menu: MenuEntry[] = [
    { id: "use", label: "Bu şablonla yeni post", onSelect: onUse },
    { id: "edit", label: "Ad ve alanlar…", onSelect: onEdit },
    ...(source.contentId
      ? [
          {
            id: "source",
            label: "Kaynak postu aç",
            onSelect: () => usePostsStore.getState().open(source.contentId as string),
          },
        ]
      : []),
    { type: "separator" },
    { id: "delete", label: "Sil", danger: true, onSelect: onDelete },
  ];
  return (
    <article
      aria-label={template.name}
      className="group relative flex h-full flex-col overflow-hidden rounded-[12px] bg-field shadow-[inset_0_0_0_1px_var(--border-hairline)] transition-colors hover:bg-control"
    >
      <button
        type="button"
        aria-label={`${template.name}: bu şablonla yeni post`}
        onClick={onUse}
        className="flex flex-1 flex-col text-left"
      >
        <TemplatePreview template={template} className="max-h-[260px]" />
        <div className="flex min-w-0 flex-col gap-1 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-body-lg font-medium text-fg">{template.name}</span>
            {template.kind === "canvas" && <TagPill>Tuval</TagPill>}
          </div>
          <span className="truncate text-footnote text-fg-2">{templateLine(template)}</span>
          <span className="truncate text-caption text-fg-3">
            {templateUses(template)} · Kaynak: “{source.title}” v{source.version}
          </span>
        </div>
      </button>
      <div className="absolute top-2 right-2">
        <MenuButton entries={menu} width={210} placement="bottom-end" label={template.name}>
          {({ ref, onClick, onKeyDown, open, ...aria }) => (
            <IconButton
              ref={ref}
              {...aria}
              size={24}
              tooltip={false}
              selected={open}
              label={`${template.name}: seçenekler`}
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

/** Name and fields of a template: a field's label, locked (keeps the template's), auto-fit. */
function TemplateSettingsSheet({
  template,
  onClose,
}: {
  template: ContentTemplate;
  onClose(): void;
}) {
  const actions = useTemplateActions();
  const showToast = useAppStore((s) => s.showToast);
  const [name, setName] = useState(template.name);
  const [fields, setFields] = useState<TemplateField[]>(template.fields);
  const [busy, setBusy] = useState(false);
  const change = (key: string, patch: Partial<TemplateField>) =>
    setFields((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const save = async () => {
    setBusy(true);
    try {
      const changed = fields.filter((f) => {
        const before = template.fields.find((x) => x.key === f.key);
        return (
          before &&
          (before.label !== f.label || before.locked !== f.locked || before.autoFit !== f.autoFit)
        );
      });
      await actions.update(template, {
        ...(name.trim() && name.trim() !== template.name ? { name: name.trim() } : {}),
        fields: changed.map((f) => ({
          key: f.key,
          label: f.label.trim() || f.key,
          locked: f.locked,
          autoFit: f.autoFit,
        })),
      });
      onClose();
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      title="Şablon ayarları"
      width={600}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy ? "Kaydediliyor…" : "Kaydet"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-footnote font-medium text-fg-2">Ad</span>
          <TextField
            aria-label="Şablonun adı"
            className="w-full"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <ul aria-label="Alanlar" className="flex flex-col divide-y divide-hairline">
          {fields.map((f) => (
            <li key={f.key} className="flex flex-col gap-2 py-3">
              <div className="flex items-center gap-2">
                <TextField
                  aria-label={`${f.key}: etiket`}
                  className="min-w-0 flex-1"
                  value={f.label}
                  onChange={(e) => change(f.key, { label: e.target.value })}
                />
                <TagPill>{f.kind === "image" ? "Görsel" : "Metin"}</TagPill>
              </div>
              <p className="truncate text-caption text-fg-3">
                {f.kind === "text" ? `Şablonda: “${f.example}”` : "Görsel yuvası"}
              </p>
              <div className="flex flex-wrap gap-4">
                <Checkbox checked={f.locked} onChange={(locked) => change(f.key, { locked })}>
                  Sabit (şablondaki kalsın)
                </Checkbox>
                {f.kind === "text" && (
                  <Checkbox checked={f.autoFit} onChange={(autoFit) => change(f.key, { autoFit })}>
                    Sığmazsa küçült
                  </Checkbox>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}
