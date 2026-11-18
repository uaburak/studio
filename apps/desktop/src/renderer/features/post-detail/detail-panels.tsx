// The opened post's right column parts: the caption (view / edit with platform limits), the
// meta rows, the publish history with logs, the layer editor (Düzenle) and the versions list.
import type {
  Brand,
  ContentVersionOrigin,
  PublishingMode,
  Schedule,
  SocialAccount,
} from "@studio/contract";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  Spinner,
  Switch,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import {
  IconEye,
  IconEyeOff,
  IconImage,
  IconLayers,
  IconRedo,
  IconRestore,
  IconTag,
  IconType,
  IconUndo,
  PlatformIcon,
} from "../../components/ui/icons.tsx";
import { formatAgo } from "../../lib/format.ts";
import { formatText, PLATFORM_LABEL } from "../posts/board.ts";
import { usePublishLogs } from "../posts/data.ts";
import { longDay, shortDayTime } from "../posts/dates.ts";
import {
  editableLayers,
  hexColor,
  LAYER_KIND_LABEL,
  type LayerKind,
  type SlideLayer,
} from "../posts/slides.ts";
import { captionUsage, composeCaption, splitCaption } from "./caption.ts";
import {
  activeVersion,
  canRedo,
  canUndo,
  type EditorSnapshot,
  editBlocker,
  hasApproval,
  isLocked,
  type PostEditor,
  slideLayers,
  slidesOf,
} from "./editor.ts";
import { scheduleDisplay } from "./schedule.ts";

const FIELD =
  "selectable w-full resize-none rounded-[12px] bg-field px-3 py-2 text-body-lg text-fg outline-none shadow-[inset_0_0_0_1px_var(--border-hairline)] placeholder:text-fg-3";

// --- caption ----------------------------------------------------------------------------------

export function CaptionCard({
  snapshot,
  editor,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const { content } = snapshot;
  const [editing, setEditing] = useState(false);
  const parts = splitCaption(content.caption);
  const [body, setBody] = useState(parts.body);
  const [tags, setTags] = useState(parts.hashtags.join(" "));
  const locked = isLocked(content);

  useEffect(() => {
    if (editing) return;
    const fresh = splitCaption(content.caption);
    setBody(fresh.body);
    setTags(fresh.hashtags.join(" "));
  }, [content.caption, editing]);

  if (!editing) {
    return (
      <div className="group relative rounded-[12px] bg-field p-3.5 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        {content.caption.trim() ? (
          <div className="flex flex-col gap-2.5">
            {parts.body && (
              <p className="selectable text-body-lg whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                {parts.body}
              </p>
            )}
            {parts.hashtags.length > 0 && (
              <p className="selectable text-body-lg text-accent-text [overflow-wrap:anywhere]">
                {parts.hashtags.join(" ")}
              </p>
            )}
          </div>
        ) : (
          <p className="text-body-lg text-fg-3">Açıklama yok.</p>
        )}
        {!locked && (
          <Button
            size="sm"
            variant="secondary"
            className="absolute top-2.5 right-2.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setEditing(true)}
          >
            Açıklamayı düzenle
          </Button>
        )}
      </div>
    );
  }

  const caption = composeCaption(body, tags);
  const usage = captionUsage(caption, content.targetPlatforms);
  const save = async () => {
    if (await editor.saveCaption(caption)) setEditing(false);
  };
  return (
    <div className="flex flex-col gap-2 rounded-[12px] bg-field p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
      <textarea
        aria-label="Açıklama"
        className={FIELD}
        rows={6}
        value={body}
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) void save();
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
      />
      <TextField
        aria-label="Etiketler"
        placeholder="#etiket #etiket"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
      />
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-footnote">
        {usage.map((u) => (
          <span key={u.platform} className={u.over ? "text-danger" : "text-fg-3"}>
            {PLATFORM_LABEL[u.platform]} {u.label}
            {u.hashtagLimit !== null && ` · ${u.hashtags}/${u.hashtagLimit} etiket`}
          </span>
        ))}
      </div>
      {hasApproval(content) && (
        <p className="text-footnote text-warning">
          Açıklamayı değiştirmek onayı kaldırır; bekleyen zamanlamalar iptal olur.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={snapshot.savingCaption || caption === content.caption}
          onClick={() => void save()}
        >
          {snapshot.savingCaption ? "Kaydediliyor…" : "Kaydet"}
        </Button>
      </div>
    </div>
  );
}

// --- meta rows --------------------------------------------------------------------------------

export function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-9 items-center border-b border-hairline py-1.5">
      <span className="w-[140px] shrink-0 text-body text-fg-2">{label}</span>
      <span className="selectable min-w-0 flex-1 text-body text-fg">{children}</span>
    </div>
  );
}

const ORIGIN_LABEL: Record<ContentVersionOrigin, string> = {
  generated: "Üretildi",
  manual_edit: "El ile düzenlendi",
  ai_edit: "AI düzenlemesi",
};

export function MetaRows({
  snapshot,
  accounts,
  brand,
  schedule,
  planDate,
}: {
  snapshot: EditorSnapshot;
  accounts: SocialAccount[];
  brand: Brand | undefined;
  schedule: Schedule | null;
  planDate: Date | null;
}) {
  const { content } = snapshot;
  const version = activeVersion(snapshot);
  const platforms = content.targetPlatforms.map((p) => {
    const account = accounts.find((a) => a.brandId === content.brandId && a.platform === p);
    return account ? `${PLATFORM_LABEL[p]} · ${account.handle}` : PLATFORM_LABEL[p];
  });
  const summary = snapshot.summaries.find((s) => s.version === version?.version);
  return (
    <div className="flex flex-col">
      <MetaRow label="Platform">{platforms.join(", ") || "Seçilmedi"}</MetaRow>
      <MetaRow label="Format">{formatText(content.type, slidesOf(snapshot))}</MetaRow>
      <MetaRow label="Yayın">
        {schedule && schedule.status !== "cancelled"
          ? longDay(new Date(schedule.scheduledAt))
          : planDate
            ? `${longDay(planDate, false)} (plan)`
            : "Zamanlanmadı"}
      </MetaRow>
      <MetaRow label="Marka">{brand?.name ?? "—"}</MetaRow>
      <MetaRow label="Sürüm">
        {version ? (
          <>
            v{version.version}
            <span className="text-fg-2">
              {" "}
              · {ORIGIN_LABEL[version.origin]} ·{" "}
              {formatAgo(summary?.createdAt ?? version.createdAt)}
            </span>
          </>
        ) : (
          "Henüz yok"
        )}
      </MetaRow>
    </div>
  );
}

// --- publish history --------------------------------------------------------------------------

export function PublishHistory({
  schedules,
  accounts,
  mode,
}: {
  schedules: Schedule[];
  accounts: SocialAccount[];
  mode: PublishingMode;
}) {
  const visible = [...schedules]
    .filter((s) => s.status !== "cancelled")
    .sort((a, b) => Date.parse(b.scheduledAt) - Date.parse(a.scheduledAt));
  if (visible.length === 0) return null;
  return (
    <section aria-label="Yayın geçmişi" className="flex flex-col gap-1.5">
      <h3 className="text-footnote font-medium text-fg-2">Yayın geçmişi</h3>
      <div className="flex flex-col overflow-hidden rounded-[12px] shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        {visible.map((s, i) => (
          <ScheduleRow
            key={s.id}
            schedule={s}
            account={accounts.find((a) => a.id === s.socialAccountId)}
            mode={mode}
            last={i === visible.length - 1}
          />
        ))}
      </div>
    </section>
  );
}

function ScheduleRow({
  schedule,
  account,
  mode,
  last,
}: {
  schedule: Schedule;
  account: SocialAccount | undefined;
  mode: PublishingMode;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const display = scheduleDisplay(schedule, mode);
  const logs = usePublishLogs(open ? schedule.id : null);
  return (
    <div className={cn("flex flex-col", !last && "border-b border-hairline")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 items-center gap-2.5 px-3 py-2 text-left hover:bg-control"
      >
        <PlatformIcon platform={schedule.platform} size={15} className="shrink-0 text-icon" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body text-fg">
            {account?.handle ?? PLATFORM_LABEL[schedule.platform]}
            <span className="text-fg-2"> · {shortDayTime(new Date(schedule.scheduledAt))}</span>
          </span>
          {display.detail && (
            <span className="block truncate text-footnote text-fg-2">{display.detail}</span>
          )}
        </span>
        <TagPill tone={display.tone}>{display.label}</TagPill>
      </button>
      {open && (
        <div className="flex flex-col gap-1 px-3 pt-0.5 pb-2.5 pl-[38px]">
          {schedule.permalink && (
            <a
              href={schedule.permalink}
              target="_blank"
              rel="noreferrer"
              className="text-footnote text-accent-text hover:underline"
            >
              Gönderiyi aç
            </a>
          )}
          {logs.isLoading && (
            <span className="flex items-center gap-1.5 text-footnote text-fg-3">
              <Spinner size={11} /> Kayıtlar yükleniyor…
            </span>
          )}
          {logs.data?.length === 0 && (
            <span className="text-footnote text-fg-3">Henüz bir yayın denemesi yok.</span>
          )}
          {logs.data?.map((log) => (
            <div key={log.id} className="text-footnote">
              <span className="text-fg-2">
                Deneme {log.attempt} · {shortDayTime(new Date(log.startedAt))} ·{" "}
              </span>
              <span
                className={
                  log.status === "failed"
                    ? "text-danger"
                    : log.status === "succeeded"
                      ? "text-success"
                      : "text-fg-2"
                }
              >
                {log.status === "failed"
                  ? "Başarısız"
                  : log.status === "succeeded"
                    ? "Yayınlandı"
                    : "Başladı"}
              </span>
              {log.error && <span className="selectable block text-fg-2">{log.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- layer editor (Düzenle) -------------------------------------------------------------------

const KIND_ICON: Record<LayerKind, React.ReactNode> = {
  text: <IconType size={14} strokeWidth={1.5} />,
  image: <IconImage size={14} strokeWidth={1.5} />,
  slot: <IconImage size={14} strokeWidth={1.5} />,
  logo: <IconTag size={14} strokeWidth={1.5} />,
  shape: <IconLayers size={14} strokeWidth={1.5} />,
  group: <IconLayers size={14} strokeWidth={1.5} />,
  other: <IconLayers size={14} strokeWidth={1.5} />,
};

function layerTitle(layer: SlideLayer): string {
  if (layer.kind === "text" && layer.text.trim()) return layer.text.trim().replace(/\s+/g, " ");
  if (layer.kind === "slot" && layer.slotLabel) return layer.slotLabel;
  return `${LAYER_KIND_LABEL[layer.kind]} · ${layer.layerId}`;
}

export function LayerEditor({
  snapshot,
  editor,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const layers = editableLayers(slideLayers(snapshot));
  const blocker = editBlocker(snapshot);
  const selected = layers.find((l) => l.layerId === snapshot.selectedLayerId) ?? null;
  const lastUndo = snapshot.undo.at(-1);
  const lastRedo = snapshot.redo.at(-1);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 text-footnote text-fg-2">
          {blocker ?? "Bir katmanı seç: önizlemede tıkla ya da listeden seç."}
        </span>
        <IconButton
          icon={<IconUndo size={15} strokeWidth={1.5} />}
          label={lastUndo ? `Geri al: ${lastUndo.name}` : "Geri al"}
          shortcut="⌘Z"
          disabled={!canUndo(snapshot)}
          onClick={() => void editor.undo()}
        />
        <IconButton
          icon={<IconRedo size={15} strokeWidth={1.5} />}
          label={lastRedo ? `Yinele: ${lastRedo.name}` : "Yinele"}
          shortcut="⇧⌘Z"
          disabled={!canRedo(snapshot)}
          onClick={() => void editor.redo()}
        />
      </div>
      {!blocker && hasApproval(snapshot.content) && (
        <p className="text-footnote text-warning">
          Tasarımı değiştirmek yeni bir sürüm oluşturur ve onayı kaldırır; bekleyen zamanlamalar
          iptal olur.
        </p>
      )}
      {layers.length === 0 ? (
        <p className="text-body text-fg-3">Bu slaytta düzenlenebilir katman yok.</p>
      ) : (
        <div
          role="listbox"
          aria-label="Katmanlar"
          className="flex flex-col overflow-hidden rounded-[12px] p-1 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
        >
          {layers.map((layer) => {
            const isSelected = layer.layerId === snapshot.selectedLayerId;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are on the listbox owner (the overlay's arrows)
              <div
                key={layer.key}
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onClick={() => editor.selectLayer(isSelected ? null : layer.layerId)}
                className={cn(
                  "group flex h-8 items-center gap-2 rounded-[8px] px-2",
                  isSelected ? "bg-selected" : "hover:bg-control",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-icon">
                  {KIND_ICON[layer.kind]}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-body",
                    layer.hidden ? "text-fg-3 line-through" : "text-fg",
                  )}
                >
                  {layerTitle(layer)}
                </span>
                {layer.kind === "slot" && layer.slotState === "empty" && (
                  <TagPill tone="accent">Boş</TagPill>
                )}
                <IconButton
                  icon={
                    layer.hidden ? (
                      <IconEyeOff size={13} strokeWidth={1.5} />
                    ) : (
                      <IconEye size={13} strokeWidth={1.5} />
                    )
                  }
                  label={layer.hidden ? "Katmanı göster" : "Katmanı gizle"}
                  size={24}
                  disabled={!!blocker}
                  className={cn(!layer.hidden && "opacity-0 group-hover:opacity-100")}
                  onClick={(e) => {
                    e.stopPropagation();
                    editor.setHidden(layer.layerId, !layer.hidden);
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
      {selected && (
        <LayerInspector key={selected.key} layer={selected} snapshot={snapshot} editor={editor} />
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  suffix: string;
  disabled: boolean;
  onCommit(value: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number.parseFloat(draft.replace(",", "."));
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption text-fg-3">{label}</span>
      <TextField
        aria-label={label}
        inputMode="decimal"
        className="w-full"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        leading={<span className="text-caption">{suffix}</span>}
      />
    </div>
  );
}

function LayerInspector({
  layer,
  snapshot,
  editor,
}: {
  layer: SlideLayer;
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const blocker = editBlocker(snapshot);
  const disabled = !!blocker;
  const [text, setText] = useState(layer.text);
  const [color, setColor] = useState(hexColor(layer.color));
  const file = useRef<HTMLInputElement | null>(null);
  const transform = editor.transformOf(layer.layerId);
  useEffect(() => setText(layer.text), [layer.text]);
  useEffect(() => setColor(hexColor(layer.color)), [layer.color]);
  const busy = snapshot.activity.kind !== "idle" && snapshot.activity.kind !== "measuring";

  return (
    <section
      aria-label="Katman ayarları"
      className="flex flex-col gap-3 rounded-[12px] p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg">
          {LAYER_KIND_LABEL[layer.kind]}
          <span className="font-normal text-fg-3"> · {layer.layerId}</span>
        </span>
        <span className="flex items-center gap-2 text-footnote text-fg-2">
          Görünür
          <Switch
            label="Görünür"
            checked={!layer.hidden}
            disabled={disabled}
            onChange={(on) => editor.setHidden(layer.layerId, !on)}
          />
        </span>
      </div>

      {layer.kind === "text" && (
        <>
          <textarea
            aria-label="Metin"
            className={FIELD}
            rows={Math.min(6, Math.max(2, text.split("\n").length + 1))}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) editor.setText(layer.layerId, text);
              if (e.key === "Escape") {
                e.stopPropagation();
                setText(layer.text);
              }
            }}
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-footnote text-fg-2">
              Renk
              <input
                type="color"
                aria-label="Metin rengi"
                value={color}
                disabled={disabled}
                onChange={(e) => setColor(e.target.value)}
                onBlur={() => {
                  if (color !== hexColor(layer.color)) editor.setColor(layer.layerId, color);
                }}
                className="h-6 w-8 cursor-default rounded-[6px] border-0 bg-transparent p-0"
              />
              <span className="font-mono text-caption text-fg-3">
                {layer.color ?? "tasarımdaki"}
              </span>
            </label>
            {layer.color && (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => editor.setColor(layer.layerId, null)}
              >
                Varsayılan renk
              </Button>
            )}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || text === layer.text}
              onClick={() => editor.setText(layer.layerId, text)}
            >
              Metni uygula
            </Button>
          </div>
        </>
      )}

      {(layer.kind === "image" || layer.kind === "slot") && (
        <div className="flex items-center gap-2">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              if (picked) void editor.placeImage(picked, layer.layerId);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || busy}
            onClick={() => file.current?.click()}
          >
            {layer.kind === "slot" && layer.slotState === "empty"
              ? "Görsel yerleştir…"
              : "Görseli değiştir…"}
          </Button>
          {layer.kind === "slot" && layer.slotState === "filled" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => editor.clearSlot(layer.layerId)}
            >
              Yuvayı boşalt
            </Button>
          )}
        </div>
      )}
      {layer.kind === "logo" && (
        <p className="text-footnote text-fg-3">Logo marka kitinden gelir.</p>
      )}

      <div className="grid grid-cols-3 gap-2">
        <NumberField
          label="X"
          suffix="px"
          value={Math.round(transform.translate.x * 10) / 10}
          disabled={disabled}
          onCommit={(x) => editor.setTransform(layer.layerId, { x })}
        />
        <NumberField
          label="Y"
          suffix="px"
          value={Math.round(transform.translate.y * 10) / 10}
          disabled={disabled}
          onCommit={(y) => editor.setTransform(layer.layerId, { y })}
        />
        <NumberField
          label="Ölçek"
          suffix="%"
          value={Math.round(transform.scale * 1000) / 10}
          disabled={disabled}
          onCommit={(percent) =>
            editor.setTransform(layer.layerId, {
              scale: Math.min(2000, Math.max(5, percent)) / 100,
            })
          }
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-caption text-fg-3">
          Önizlemede sürükle, köşeden boyutlandır; ok tuşları 1 px, ⇧ ile 10 px.
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<IconRestore size={12} />}
          disabled={
            disabled ||
            (transform.translate.x === 0 && transform.translate.y === 0 && transform.scale === 1)
          }
          onClick={() => editor.resetTransform(layer.layerId)}
        >
          Konumu sıfırla
        </Button>
      </div>
    </section>
  );
}

// --- versions ---------------------------------------------------------------------------------

export function VersionsList({
  snapshot,
  editor,
}: {
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const shown = activeVersion(snapshot)?.version;
  const current = snapshot.content.currentVersion?.version;
  if (snapshot.summaries.length === 0) {
    return <p className="text-body text-fg-3">Sürümler yükleniyor…</p>;
  }
  return (
    <div role="listbox" aria-label="Sürümler" className="flex flex-col gap-0.5">
      {snapshot.summaries.map((v) => {
        const isShown = v.version === shown;
        return (
          <div
            key={v.id}
            role="option"
            tabIndex={0}
            aria-selected={isShown}
            onClick={() => void editor.selectVersion(v.version)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void editor.selectVersion(v.version);
            }}
            className={cn(
              "flex min-h-12 items-center gap-3 rounded-[10px] px-3 py-2",
              isShown ? "bg-selected" : "hover:bg-control",
            )}
          >
            <span className="w-8 shrink-0 text-body font-semibold text-fg tabular-nums">
              v{v.version}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-fg">
                {ORIGIN_LABEL[v.origin]}
                <span className="text-fg-2">
                  {" "}
                  · {v.slideCount} kare · {formatAgo(v.createdAt)}
                </span>
              </span>
              {v.note && <span className="block truncate text-footnote text-fg-2">{v.note}</span>}
            </span>
            {v.version === current && <TagPill tone="accent">Güncel</TagPill>}
          </div>
        );
      })}
    </div>
  );
}
