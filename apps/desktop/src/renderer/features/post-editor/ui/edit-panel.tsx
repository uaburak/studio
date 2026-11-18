// The right panel on Düzenle: Wecra's properties panel in Studio's controls. Tasarım shows, by
// selection, the header (what is selected, its "…" menu) and the sections Konum, Boyut,
// Görünüm, Metin, Tipografi, Dolgu, Kenarlık, Görsel (Studio: replace, fit, crop, adjustments),
// Efektler and AI ile düzenle; with nothing selected the slide's own: Biçim (preview format,
// safe area), Uyarılar, Kontroller, AI ile düzenle and Dışa aktar. Açıklama is the caption.
// Every change is one design-kit patch through the draft (instant on the canvas).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  cn,
  IconButton,
  SegmentedControl,
  Switch,
} from "../../../components/ui/controls.tsx";
import { FontPicker } from "../../../components/ui/font-picker.tsx";
import {
  IconDownload,
  IconEllipsis,
  IconEye,
  IconEyeOff,
  IconWarning,
} from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import { assetUrl } from "../../../lib/api.ts";
import { ChecksPanel } from "../../checks/checks-panel.tsx";
import {
  type EditorSnapshot,
  editBlocker,
  hasApproval,
  type PostEditor,
} from "../../post-detail/editor.ts";
import type { ComputedLayerStyle } from "../canvas/controller.ts";
import type { RenderKit } from "../model/brand-kit.ts";
import {
  type EditorLayer,
  findLayer,
  layerKey,
  layerLabel,
  slideLabel,
  TYPE_LABEL,
} from "../model/document.ts";
import type { SlidePatchInput } from "../model/draft.ts";
import { aabb, resizedKeepingCorner } from "../model/geometry.ts";
import { presetFor, presetsForSlide } from "../model/safe-areas.ts";
import {
  ADJUSTMENT_PRESETS,
  type Adjustments,
  cssColorAlpha,
  cssColorHex,
  familyCss,
  filterCss,
  parseFilter,
  primaryFamily,
  WEIGHTS,
} from "../model/style-values.ts";
import type { EditorSession } from "../session.ts";
import type { EditTab } from "../workspace-store.ts";
import { CaptionPanel } from "./caption-panel.tsx";
import {
  Body,
  ButtonGroup,
  Chip,
  ColorField,
  NumberField,
  Row,
  Section,
  SelectField,
  Slider,
} from "./fields.tsx";
import {
  IconAlignBottom,
  IconAlignCenter,
  IconAlignLeft,
  IconAlignMiddle,
  IconAlignRight,
  IconAlignTop,
  IconBlend,
  IconCrop,
  IconLock,
  IconRotate,
  IconTextCenter,
  IconTextLeft,
  IconTextRight,
  IconUnlock,
} from "./glyphs.tsx";
import { layerIcon, layerTitle } from "./layers-dock.tsx";

export interface EditActions {
  /** Ask the post's Sohbet (switches to it) with the layers as the scope. */
  ai(instruction: string, keys: readonly string[]): void;
  replaceImage(key: string): void;
}

const TEXT_AI = ["Kısalt", "Daha vurucu", "Emoji ekle", "İngilizceye çevir"];
const IMAGE_AI = ["Arka planı kaldır", "Görseli genişlet", "Yeniden üret", "Netleştir"];
const SLIDE_AI = ["Daha sade", "Başlığı büyüt", "Renkleri canlandır", "Kontrastı artır"];

export function EditPanel({
  tab,
  session,
  kit,
  editor,
  snapshot,
  actions,
}: {
  tab: EditTab;
  session: EditorSession;
  kit: RenderKit;
  editor: PostEditor;
  snapshot: EditorSnapshot;
  actions: EditActions;
}) {
  const blocker = editBlocker(snapshot);
  return (
    <div className="scroll-area min-h-0 flex-1" data-edit-panel={tab}>
      {blocker && snapshot.activity.kind !== "revising" && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-[14px] bg-warning/12 px-3 py-2 text-footnote text-fg-2">
          <IconWarning size={12} className="mt-0.5 shrink-0 text-warning" />
          {blocker}
        </div>
      )}
      {hasApproval(snapshot.content) && !blocker && tab === "design" && (
        <p className="mx-3 mt-3 rounded-[14px] bg-control px-3 py-2 text-footnote text-fg-2">
          Tasarımı değiştirmek yeni bir sürüm oluşturur ve onayı kaldırır; bekleyen zamanlamalar
          iptal olur.
        </p>
      )}
      {tab === "design" ? (
        <DesignTab
          session={session}
          kit={kit}
          editor={editor}
          snapshot={snapshot}
          actions={actions}
        />
      ) : (
        <CaptionPanel snapshot={snapshot} editor={editor} />
      )}
    </div>
  );
}

/** The panel header's tabs on Düzenle. */
export function EditTabs({ tab, onTab }: { tab: EditTab; onTab(tab: EditTab): void }) {
  return (
    <SegmentedControl<EditTab>
      label="Düzenle paneli"
      value={tab}
      onChange={onTab}
      options={[
        { value: "design", label: "Tasarım" },
        { value: "caption", label: "Açıklama" },
      ]}
    />
  );
}

function DesignTab({
  session,
  kit,
  editor,
  snapshot,
  actions,
}: {
  session: EditorSession;
  kit: RenderKit;
  editor: PostEditor;
  snapshot: EditorSnapshot;
  actions: EditActions;
}) {
  const { canvas, canvasState: s } = session;
  const layers = s.selection
    .map((k) => findLayer(canvas.editorSlides, k))
    .filter((l): l is EditorLayer => l !== null);
  // Re-read the computed style when the layout changes (an edit landed).
  void s.layoutRevision;
  if (layers.length === 0)
    return (
      <SlideSections session={session} editor={editor} snapshot={snapshot} actions={actions} />
    );
  return <LayerSections session={session} kit={kit} layers={layers} actions={actions} />;
}

// --- a selection --------------------------------------------------------------------------------

function LayerSections({
  session,
  kit,
  layers,
  actions,
}: {
  session: EditorSession;
  kit: RenderKit;
  layers: EditorLayer[];
  actions: EditActions;
}) {
  const { canvas, canvasState: s } = session;
  const layer = layers[0] as EditorLayer;
  const single = layers.length === 1;
  const computed = single ? canvas.computed(layer.key) : null;
  const apply = (ops: SlidePatchInput[], name: string) => canvas.applyOps(ops, name);
  const op = <T extends object>(o: T, name: string) =>
    apply(
      layers.map((l) => ({ ...o, layer: l.id, slide: l.slide }) as unknown as SlidePatchInput),
      name,
    );
  const collisions = canvas.collisionsOf(layer.slide).filter((c) => s.selection.includes(c.key));
  const slide = canvas.editorSlides[layer.slide];
  const isImage = layer.type === "image" || layer.type === "slot" || layer.type === "logo";
  const hasText = layers.some((l) => l.type === "text" || l.type === "group");

  const menu: MenuEntry[] = [
    {
      id: "dup",
      label: "Çoğalt",
      shortcut: "⌘D",
      onSelect: () => op({ op: "duplicateLayer", offset: { x: 24, y: 24 } }, "Çoğalt"),
    },
    {
      id: "fwd",
      label: "Öne getir",
      shortcut: "⌥⌘]",
      onSelect: () => canvas.restack(layer.key, 1),
    },
    {
      id: "back",
      label: "Arkaya gönder",
      shortcut: "⌥⌘[",
      onSelect: () => canvas.restack(layer.key, -1),
    },
    { type: "separator" },
    {
      id: "hide",
      label: layer.hidden ? "Göster" : "Gizle",
      onSelect: () =>
        op(
          { op: "setVisibility", hidden: !layer.hidden },
          layer.hidden ? "Katmanı göster" : "Katmanı gizle",
        ),
    },
    {
      id: "lock",
      label: s.locked.includes(layer.key) ? "Kilidi aç" : "Kilitle",
      onSelect: () => canvas.setLocked(layer.key, !s.locked.includes(layer.key)),
    },
    { type: "separator" },
    {
      id: "delete",
      label: "Sil",
      shortcut: "⌫",
      danger: true,
      onSelect: () => op({ op: "deleteLayer" }, "Sil"),
    },
  ];

  return (
    <div className="flex flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-hairline pr-2 pl-4">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-control text-icon">
          {single ? layerIcon(layer.type, 13) : layerIcon("group", 13)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-fg">
            {single ? layerTitle(layer) : `${layers.length} katman seçili`}
          </div>
          <div className="truncate text-caption text-fg-3">
            {single
              ? `${TYPE_LABEL[layer.type]} · Kare ${layer.slide + 1}${slide ? ` · ${slideLabel(slide)}` : ""}`
              : layers.map((l) => layerLabel(l)).join(", ")}
          </div>
        </div>
        <MenuButton entries={menu} label="Katman işlemleri" placement="bottom-end" width={200}>
          {({ ref, onClick, onKeyDown, open, ...aria }) => (
            <IconButton
              ref={ref}
              size={24}
              icon={<IconEllipsis size={14} />}
              label="Katman işlemleri"
              selected={open}
              onClick={onClick}
              onKeyDown={onKeyDown}
              {...aria}
            />
          )}
        </MenuButton>
      </div>

      {collisions.length > 0 && (
        <div
          className="mx-3 mt-3 rounded-[16px] border border-danger/50 bg-danger/8 px-3 py-2.5"
          role="alert"
        >
          <div className="flex items-center gap-1.5 text-body font-semibold text-danger">
            <IconWarning size={13} /> Güvenli alanın dışında
          </div>
          <p className="mt-1 text-footnote text-fg-2">{collisions[0]?.message}</p>
          {collisions.some((c) => c.fix) && (
            <Button
              size="sm"
              className="mt-2"
              onClick={() => {
                for (const c of collisions)
                  if (c.fix) canvas.moveBy([c.key], c.fix.dx, c.fix.dy, "Güvenli alana taşı");
              }}
            >
              Güvenli alana taşı
            </Button>
          )}
        </div>
      )}

      <PositionSection session={session} layers={layers} />
      <SizeSection session={session} layers={layers} />
      {single && computed && (
        <AppearanceSection
          key={`look-${layer.key}`}
          layer={layer}
          computed={computed}
          apply={apply}
          onToggleHidden={() =>
            op(
              { op: "setVisibility", hidden: !layer.hidden },
              layer.hidden ? "Katmanı göster" : "Katmanı gizle",
            )
          }
        />
      )}

      {single && layer.type === "text" && (
        <TextSection key={`text-${layer.key}`} session={session} layer={layer} />
      )}
      {single && layer.type === "text" && computed && (
        <TypographySection session={session} layer={layer} computed={computed} kit={kit} />
      )}
      {!single && hasText && (
        <Section title="Tipografi">
          <Body>
            <p className="text-footnote text-fg-3">
              Birden çok metin seçili: renkler ve marka yazı tipleri hepsine uygulanır.
            </p>
            <BrandFonts layers={layers} kit={kit} apply={apply} />
          </Body>
        </Section>
      )}

      {!isImage && (
        <FillSection
          layers={layers}
          computed={single && (layer.type === "text" || layer.type === "shape") ? computed : null}
          kit={kit}
          apply={apply}
        />
      )}
      {single && computed && !isImage && (
        <StrokeSection layer={layer} computed={computed} apply={apply} />
      )}

      {single && isImage && (
        <ImageSection session={session} layer={layer} computed={computed} actions={actions} />
      )}

      {single && computed && (
        <EffectsSection key={`fx-${layer.key}`} session={session} layer={layer} apply={apply} />
      )}

      <Section title="AI ile düzenle">
        <Body className="flex flex-wrap gap-1.5">
          {(layer.type === "image" || layer.type === "slot" ? IMAGE_AI : TEXT_AI).map((label) => (
            <Chip key={label} onClick={() => actions.ai(label, s.selection)}>
              {label}
            </Chip>
          ))}
        </Body>
      </Section>
    </div>
  );
}

function PositionSection({ session, layers }: { session: EditorSession; layers: EditorLayer[] }) {
  const { canvas } = session;
  const boxes = layers
    .map((l) => ({ layer: l, m: canvas.measureOf(l.key) }))
    .filter((b) => b.m !== null);
  if (boxes.length === 0) return null;
  const rects = boxes.map((b) => aabb((b.m as NonNullable<typeof b.m>).box));
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  const single = boxes.length === 1 ? boxes[0] : null;
  const box = single?.m?.box ?? null;
  const slide = canvas.editorSlides[layers[0]?.slide ?? 0];
  const keys = layers.map((l) => l.key);
  const locked = layers.some((l) => session.canvasState.locked.includes(l.key));

  /** Aligns to the slide (one layer) or to the selection's bounds (several). */
  const align = (edge: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    const W = single ? (slide?.width ?? 0) : right;
    const H = single ? (slide?.height ?? 0) : bottom;
    const X0 = single ? 0 : x;
    const Y0 = single ? 0 : y;
    for (const [i, b] of boxes.entries()) {
      const r = rects[i];
      if (!r) continue;
      const dx =
        edge === "left"
          ? X0 - r.x
          : edge === "right"
            ? W - (r.x + r.w)
            : edge === "center"
              ? X0 + (W - X0) / 2 - (r.x + r.w / 2)
              : 0;
      const dy =
        edge === "top"
          ? Y0 - r.y
          : edge === "bottom"
            ? H - (r.y + r.h)
            : edge === "middle"
              ? Y0 + (H - Y0) / 2 - (r.y + r.h / 2)
              : 0;
      if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05)
        canvas.moveBy([b.layer.key], dx, dy, "Hizala");
    }
  };

  return (
    <Section title="Konum">
      <Row label="Hizalama">
        <ButtonGroup label="Yatay hizalama">
          <IconButton
            size={24}
            icon={<IconAlignLeft size={13} />}
            label="Sola hizala"
            onClick={() => align("left")}
          />
          <IconButton
            size={24}
            icon={<IconAlignCenter size={13} />}
            label="Yatayda ortala"
            onClick={() => align("center")}
          />
          <IconButton
            size={24}
            icon={<IconAlignRight size={13} />}
            label="Sağa hizala"
            onClick={() => align("right")}
          />
        </ButtonGroup>
        <ButtonGroup label="Dikey hizalama">
          <IconButton
            size={24}
            icon={<IconAlignTop size={13} />}
            label="Üste hizala"
            onClick={() => align("top")}
          />
          <IconButton
            size={24}
            icon={<IconAlignMiddle size={13} />}
            label="Dikeyde ortala"
            onClick={() => align("middle")}
          />
          <IconButton
            size={24}
            icon={<IconAlignBottom size={13} />}
            label="Alta hizala"
            onClick={() => align("bottom")}
          />
        </ButtonGroup>
      </Row>
      <Row
        label="Konum"
        action={
          <IconButton
            size={24}
            icon={locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
            label={locked ? "Kilidi aç" : "Kilitle"}
            selected={locked}
            onClick={() => {
              for (const k of keys) canvas.setLocked(k, !locked);
            }}
          />
        }
      >
        <NumberField
          label="X"
          prefix="X"
          value={x}
          onCommit={(v) => canvas.moveBy(keys, v - x, 0)}
        />
        <NumberField
          label="Y"
          prefix="Y"
          value={y}
          onCommit={(v) => canvas.moveBy(keys, 0, v - y)}
        />
      </Row>
      <Row label="Döndürme">
        <NumberField
          label="Açı"
          prefix={<IconRotate size={12} />}
          value={box?.angle ?? 0}
          suffix="°"
          disabled={!single}
          onCommit={(v) => single && canvas.setBox(single.layer.key, { angle: v }, "Döndür")}
        />
        <ButtonGroup label="Hızlı döndürme">
          {[-90, 90].map((d) => (
            <button
              key={d}
              type="button"
              disabled={!single}
              onClick={() =>
                single &&
                canvas.setBox(single.layer.key, { angle: (box?.angle ?? 0) + d }, "Döndür")
              }
              className="h-6 flex-1 rounded-full text-footnote text-fg-2 hover:bg-control hover:text-fg disabled:opacity-40"
            >
              {d > 0 ? "+90°" : "−90°"}
            </button>
          ))}
        </ButtonGroup>
      </Row>
    </Section>
  );
}

function SizeSection({ session, layers }: { session: EditorSession; layers: EditorLayer[] }) {
  const { canvas } = session;
  const boxes = layers.map((l) => canvas.measureOf(l.key)).filter((m) => m !== null);
  if (boxes.length === 0) return null;
  const rects = boxes.map((m) => aabb(m.box));
  const single = layers.length === 1 && boxes.length === 1 ? layers[0] : null;
  const box = single ? (boxes[0]?.box ?? null) : null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
  return (
    <Section title="Boyut">
      <Row>
        <NumberField
          label="Genişlik"
          prefix="W"
          value={box ? box.w : w}
          disabled={!single}
          min={1}
          onCommit={(v) =>
            single && box && canvas.setBox(single.key, resizedKeepingCorner(box, v, box.h))
          }
        />
        <NumberField
          label="Yükseklik"
          prefix="H"
          value={box ? box.h : h}
          disabled={!single}
          min={1}
          onCommit={(v) =>
            single && box && canvas.setBox(single.key, resizedKeepingCorner(box, box.w, v))
          }
        />
      </Row>
      {single?.type === "text" && (
        <Body>
          <p className="pt-1 text-caption text-fg-3">
            Metin yüksekliğini kendisi alır; yalnız dikey sürüklemek sabitler.
          </p>
        </Body>
      )}
    </Section>
  );
}

const BLEND = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-burn",
  "color-dodge",
  "luminosity",
] as const;

const BLEND_LABEL: Record<(typeof BLEND)[number], string> = {
  normal: "Normal",
  multiply: "Çoğalt",
  screen: "Ekran",
  overlay: "Kaplama",
  darken: "Koyulaştır",
  lighten: "Açıklaştır",
  "color-burn": "Renk yanması",
  "color-dodge": "Renk soldurma",
  luminosity: "Parlaklık",
};

function setStyleOps(layer: EditorLayer, set: Record<string, string | null>): SlidePatchInput[] {
  return [
    { op: "setStyle", layer: layer.id, slide: layer.slide, set } as unknown as SlidePatchInput,
  ];
}

/** Wecra's Appearance: visibility and blend mode in the header, opacity and corner radius. */
function AppearanceSection({
  layer,
  computed,
  apply,
  onToggleHidden,
}: {
  layer: EditorLayer;
  computed: ComputedLayerStyle;
  apply(ops: SlidePatchInput[], name: string): boolean;
  onToggleHidden(): void;
}) {
  const blend = (BLEND as readonly string[]).includes(computed.mixBlendMode)
    ? (computed.mixBlendMode as (typeof BLEND)[number])
    : "normal";
  const [blendShown, setBlendShown] = useState(blend !== "normal");
  return (
    <Section
      title="Görünüm"
      action={
        <>
          <IconButton
            size={24}
            icon={layer.hidden ? <IconEyeOff size={13} /> : <IconEye size={13} />}
            label={layer.hidden ? "Göster" : "Gizle"}
            selected={layer.hidden}
            onClick={onToggleHidden}
          />
          <IconButton
            size={24}
            icon={<IconBlend size={13} strokeWidth={1.5} />}
            label="Karışım modu"
            selected={blendShown}
            onClick={() => setBlendShown((v) => !v)}
          />
        </>
      }
    >
      {(blendShown || blend !== "normal") && (
        <Row span={2}>
          <SelectField
            label="Karışım modu"
            value={blend}
            options={BLEND.map((b) => ({ value: b, label: BLEND_LABEL[b] }))}
            onChange={(v) =>
              apply(
                setStyleOps(layer, { "mix-blend-mode": v === "normal" ? null : v }),
                "Karışım modu",
              )
            }
          />
        </Row>
      )}
      <Row>
        <NumberField
          label="Opaklık"
          prefix={<OpacityGlyph />}
          value={Math.round(computed.opacity * 100)}
          suffix="%"
          min={0}
          max={100}
          onCommit={(v) =>
            apply(setStyleOps(layer, { opacity: v >= 100 ? null : String(v / 100) }), "Opaklık")
          }
        />
        <NumberField
          label="Köşe yarıçapı"
          prefix={<RadiusGlyph />}
          value={computed.borderRadius}
          min={0}
          onCommit={(v) =>
            apply(setStyleOps(layer, { "border-radius": v > 0 ? `${v}px` : null }), "Köşe yarıçapı")
          }
        />
      </Row>
    </Section>
  );
}

function TextSection({ session, layer }: { session: EditorSession; layer: EditorLayer }) {
  const { canvas } = session;
  const [text, setText] = useState(layer.text ?? "");
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setText(layer.text ?? "");
  }, [layer.text]);
  return (
    <Section title="Metin">
      <Body className="pr-10">
        <textarea
          aria-label="Metin"
          value={text}
          rows={Math.min(5, Math.max(2, text.split("\n").length))}
          onChange={(e) => {
            dirty.current = true;
            setText(e.target.value);
          }}
          className="w-full resize-none rounded-[14px] bg-field px-3 py-1.5 text-body text-fg outline-none focus:ring-2 focus:ring-focus/60"
        />
        {text !== (layer.text ?? "") && (
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                dirty.current = false;
                setText(layer.text ?? "");
              }}
            >
              Vazgeç
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                dirty.current = false;
                canvas.applyOps(
                  [{ op: "setText", layer: layer.id, text, slide: layer.slide } as SlidePatchInput],
                  "Metni değiştir",
                );
              }}
            >
              Metni uygula
            </Button>
          </div>
        )}
      </Body>
    </Section>
  );
}

function TypographySection({
  session,
  layer,
  computed,
  kit,
}: {
  session: EditorSession;
  layer: EditorLayer;
  computed: ComputedLayerStyle;
  kit: RenderKit;
}) {
  const { canvas } = session;
  const typography = (fields: Record<string, unknown>, name: string) =>
    canvas.applyOps(
      [{ op: "setTypography", layer: layer.id, slide: layer.slide, ...fields } as SlidePatchInput],
      name,
    );
  const family = primaryFamily(computed.fontFamily);
  const brandFamilies = kit.fonts.map((f) => f.family);
  const align =
    computed.textAlign === "start"
      ? "left"
      : computed.textAlign === "end"
        ? "right"
        : computed.textAlign;
  const weight = Math.round(computed.fontWeight / 100) * 100;

  return (
    <Section title="Tipografi">
      <Row span={2}>
        <FontPicker
          label="Yazı tipi"
          value={family ? { family } : null}
          pinned={brandFamilies}
          className="w-full"
          onChange={(choice) => {
            const role = kit.fonts.find(
              (f) => f.family.toLowerCase() === choice.family.toLowerCase(),
            );
            const w = choice.style?.weight;
            const italic = choice.style?.italic;
            if (role) {
              typography(
                {
                  fontFamily: role.role,
                  ...(w ? { fontWeight: w } : {}),
                  ...(italic !== undefined ? { fontStyle: italic ? "italic" : "normal" } : {}),
                },
                "Yazı tipi",
              );
              return;
            }
            const css = familyCss(choice.family);
            if (!css) {
              session.notify("Bu yazı tipinin adı tasarımda kullanılamıyor.", "error");
              return;
            }
            canvas.applyOps(
              [
                {
                  op: "setStyle",
                  layer: layer.id,
                  slide: layer.slide,
                  set: { "font-family": css },
                } as SlidePatchInput,
                ...(w || italic !== undefined
                  ? [
                      {
                        op: "setTypography",
                        layer: layer.id,
                        slide: layer.slide,
                        ...(w ? { fontWeight: w } : {}),
                        ...(italic !== undefined
                          ? { fontStyle: italic ? "italic" : "normal" }
                          : {}),
                      } as SlidePatchInput,
                    ]
                  : []),
              ],
              "Yazı tipi",
            );
          }}
        />
      </Row>
      <Row>
        <SelectField
          label="Kalınlık"
          value={weight}
          options={WEIGHTS}
          onChange={(v) => typography({ fontWeight: v }, "Kalınlık")}
        />
        <NumberField
          label="Boyut"
          prefix="T"
          value={computed.fontSize}
          min={1}
          max={1000}
          onCommit={(v) => typography({ fontSize: v }, "Boyut")}
        />
      </Row>
      <Row>
        <NumberField
          label="Satır yüksekliği"
          prefix="↕"
          value={computed.lineHeight === null ? null : Math.round(computed.lineHeight * 100)}
          suffix="%"
          min={50}
          max={400}
          onCommit={(v) => typography({ lineHeight: v / 100 }, "Satır yüksekliği")}
        />
        <NumberField
          label="Harf aralığı"
          prefix="|A|"
          value={Math.round(computed.letterSpacing * 1000) / 10}
          suffix="%"
          step={0.5}
          min={-100}
          max={100}
          onCommit={(v) => typography({ letterSpacing: v / 100 }, "Harf aralığı")}
        />
      </Row>
      <Row
        action={
          <button
            type="button"
            aria-pressed={computed.textTransform === "uppercase"}
            onClick={() =>
              typography(
                { textTransform: computed.textTransform === "uppercase" ? "none" : "uppercase" },
                "Büyük harf",
              )
            }
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-[10px] font-semibold",
              computed.textTransform === "uppercase"
                ? "bg-accent-subtle text-accent-text"
                : "text-fg-2 hover:bg-control",
            )}
            title="Büyük harf"
          >
            AA
          </button>
        }
      >
        <ButtonGroup label="Metin hizalama">
          {(
            [
              ["left", <IconTextLeft key="l" size={13} />, "Sola yasla"],
              ["center", <IconTextCenter key="c" size={13} />, "Ortala"],
              ["right", <IconTextRight key="r" size={13} />, "Sağa yasla"],
            ] as const
          ).map(([value, icon, label]) => (
            <IconButton
              key={value}
              size={24}
              icon={icon}
              label={label}
              selected={align === value}
              onClick={() => typography({ textAlign: value }, "Hizalama")}
            />
          ))}
        </ButtonGroup>
        <span />
      </Row>
      <Body className="pt-1">
        <BrandFonts layers={[layer]} kit={kit} apply={(ops, name) => canvas.applyOps(ops, name)} />
      </Body>
    </Section>
  );
}

/** The brand's font roles (Studio): one click sets the role on the text layers. */
function BrandFonts({
  layers,
  kit,
  apply,
}: {
  layers: EditorLayer[];
  kit: RenderKit;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const texts = layers.filter((l) => l.type === "text" || l.type === "group");
  if (texts.length === 0 || kit.fonts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-caption text-fg-3">Marka</span>
      {kit.fonts.map((f) => (
        <Chip
          key={f.role}
          title={`--font-${f.role}`}
          onClick={() =>
            apply(
              texts.map(
                (l) =>
                  ({
                    op: "setTypography",
                    layer: l.id,
                    slide: l.slide,
                    fontFamily: f.role,
                  }) as unknown as SlidePatchInput,
              ),
              "Marka yazı tipi",
            )
          }
        >
          <span style={{ fontFamily: `"${f.family}"` }}>{f.family}</span>
          <span className="text-fg-3">{f.role}</span>
        </Chip>
      ))}
    </div>
  );
}

/** Dolgu: the colour (and its alpha) of one text or shape, the brand's swatches for any. */
function FillSection({
  layers,
  computed,
  kit,
  apply,
}: {
  layers: EditorLayer[];
  computed: ComputedLayerStyle | null;
  kit: RenderKit;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const layer = layers[0] as EditorLayer;
  const property = (l: EditorLayer) => (l.type === "shape" ? "background-color" : "color");
  const raw = computed
    ? property(layer) === "color"
      ? computed.color
      : computed.backgroundColor
    : null;
  const value = cssColorHex(raw);
  const alpha = cssColorAlpha(raw);
  const colorOps = (value: { token: string } | { literal: string }) =>
    layers.map((l) => ({
      op: "setColor",
      layer: l.id,
      slide: l.slide,
      property: property(l),
      value,
    })) as unknown as SlidePatchInput[];
  return (
    <Section title={kit.mode === "neutral" ? "Dolgu · nötr marka" : "Dolgu"}>
      {computed && (
        <Row span={2}>
          <ColorField
            label={property(layer) === "color" ? "Metin rengi" : "Dolgu rengi"}
            value={value}
            onCommit={(hex) => apply(colorOps({ literal: hex }), "Renk")}
            trailing={
              <span className="shrink-0 text-footnote text-fg-3 tabular-nums">
                {Math.round(alpha * 100)}%
              </span>
            }
          />
        </Row>
      )}
      {kit.swatches.length > 0 && (
        <Body className="flex flex-wrap items-center gap-2 pt-1.5">
          <span className="text-caption text-fg-3">Marka</span>
          {kit.swatches.map((sw) => (
            <button
              key={sw.token}
              type="button"
              title={`${sw.token} · ${sw.value}${sw.use ? ` · ${sw.use}` : ""}`}
              aria-label={`Marka rengi ${sw.token}`}
              onClick={() => apply(colorOps({ token: sw.token }), "Marka rengi")}
              className="size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.18)] transition-transform hover:scale-110"
              style={{ background: sw.value }}
            />
          ))}
        </Body>
      )}
    </Section>
  );
}

/** Kenarlık: the contract has no stroke of its own; a border the design has can be recoloured. */
function StrokeSection({
  layer,
  computed,
  apply,
}: {
  layer: EditorLayer;
  computed: ComputedLayerStyle;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  if (computed.borderWidth <= 0) {
    return (
      <Section
        title="Kenarlık"
        empty
        action={
          <span
            className="text-caption text-fg-3"
            title="Tasarım sözleşmesi kenarlık eklemeye izin vermiyor; Sohbet'ten iste."
          >
            yok
          </span>
        }
      />
    );
  }
  return (
    <Section title="Kenarlık">
      <Row>
        <ColorField
          label="Kenarlık rengi"
          value={cssColorHex(computed.borderColor)}
          onCommit={(hex) =>
            apply(
              [
                {
                  op: "setColor",
                  layer: layer.id,
                  slide: layer.slide,
                  property: "border-color",
                  value: { literal: hex },
                } as unknown as SlidePatchInput,
              ],
              "Kenarlık rengi",
            )
          }
        />
        <span className="flex h-7 items-center rounded-full bg-field px-2.5 text-body text-fg-2 tabular-nums">
          {Math.round(computed.borderWidth)} px
        </span>
      </Row>
    </Section>
  );
}

const FIT_OPTIONS = [
  { value: "cover", label: "Doldur" },
  { value: "contain", label: "Sığdır" },
  { value: "crop", label: "Kırp" },
  { value: "none", label: "Orijinal" },
] as const;

function ImageSection({
  session,
  layer,
  computed,
  actions,
}: {
  session: EditorSession;
  layer: EditorLayer;
  computed: ComputedLayerStyle | null;
  actions: EditActions;
}) {
  const { canvas } = session;
  const name = (layer.src ?? "").split("/").pop() ?? "";
  const filter = layer.style.filter;
  const adjustments = parseFilter(filter);
  const [adj, setAdj] = useState<Adjustments>(adjustments);
  useEffect(() => setAdj(parseFilter(filter)), [filter]);
  const blur = blurOf(filter);
  const commitAdj = (next: Adjustments) =>
    canvas.applyOps(
      [
        {
          op: "setStyle",
          layer: layer.id,
          slide: layer.slide,
          set: { filter: withBlur(filterCss(next), blur) },
        } as unknown as SlidePatchInput,
      ],
      "Görsel ayarı",
    );
  const fit =
    session.canvasState.cropping === layer.key ? "crop" : (computed?.objectFit ?? "cover");
  const empty = layer.type === "slot" && layer.slotState !== "filled";
  const adjusted =
    adjustments.exposure || adjustments.contrast || adjustments.saturation || adjustments.warmth;
  return (
    <>
      <Section title={layer.type === "logo" ? "Logo" : "Görsel"}>
        <Body className="pr-10">
          <div className="flex items-center gap-2.5 rounded-[16px] bg-field p-1.5 pr-3">
            <span className="size-10 shrink-0 overflow-hidden rounded-[10px] bg-control">
              {layer.src && (
                <img src={toAsset(layer.src)} alt="" className="size-full object-cover" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body text-fg">
                {empty ? (layer.slotLabel ?? "Boş görsel yuvası") : name || "Görsel"}
              </span>
              <span className="block text-footnote text-fg-3">
                {computed?.natural?.w
                  ? `${computed.natural.w} × ${computed.natural.h}`
                  : empty
                    ? "Görsel bekliyor"
                    : ""}
              </span>
            </span>
          </div>
        </Body>
        {layer.type !== "logo" ? (
          <>
            <Row
              action={
                !empty ? (
                  <IconButton
                    size={24}
                    icon={<IconCrop size={13} />}
                    label="Kırp"
                    selected={fit === "crop"}
                    onClick={() => {
                      canvas.selectLayers([layer.key]);
                      canvas.startCrop(layer.key);
                    }}
                  />
                ) : undefined
              }
              className="pt-1.5"
            >
              <Button size="md" onClick={() => actions.replaceImage(layer.key)}>
                {empty ? "Görsel ekle" : "Değiştir"}
              </Button>
              <Button size="md" onClick={() => actions.ai("Bu görseli yeniden üret", [layer.key])}>
                Görsel üret
              </Button>
            </Row>
            {!empty && (
              <Body className="pt-1 pr-10">
                <SegmentedControl
                  className="w-full [&>button]:flex-1"
                  label="Ölçekleme"
                  value={fit as (typeof FIT_OPTIONS)[number]["value"]}
                  options={FIT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  onChange={(v) => {
                    if (v === "crop") {
                      canvas.selectLayers([layer.key]);
                      canvas.startCrop(layer.key);
                      return;
                    }
                    canvas.applyOps(
                      [
                        {
                          op: "setImageFit",
                          layer: layer.id,
                          slide: layer.slide,
                          fit: v,
                        } as unknown as SlidePatchInput,
                      ],
                      "Ölçekleme",
                    );
                  }}
                />
              </Body>
            )}
          </>
        ) : (
          <Body className="pt-1.5">
            <p className="text-footnote text-fg-3">
              Logo marka kitinden gelir; boyutu yüksekliğiyle değişir, kırpılmaz ve renklendirilmez.
            </p>
          </Body>
        )}
      </Section>
      {layer.type !== "logo" && !empty && (
        <Section
          title="Ayarlar"
          action={
            adjusted ? (
              <button
                type="button"
                className="h-6 rounded-full px-2 text-footnote text-fg-3 hover:bg-control hover:text-fg"
                onClick={() => commitAdj({ exposure: 0, contrast: 0, saturation: 0, warmth: 0 })}
              >
                Sıfırla
              </button>
            ) : undefined
          }
        >
          {(
            [
              ["exposure", "Pozlama"],
              ["contrast", "Kontrast"],
              ["saturation", "Doygunluk"],
              ["warmth", "Sıcaklık"],
            ] as const
          ).map(([k, label]) => (
            <Slider
              key={k}
              label={label}
              value={adj[k]}
              onPreview={(v) => {
                const next = { ...adj, [k]: v };
                setAdj(next);
                canvas.previewCss(layer.key, { filter: withBlur(filterCss(next), blur) ?? "none" });
              }}
              onCommit={(v) => commitAdj({ ...adj, [k]: v })}
            />
          ))}
          <Body className="flex flex-wrap gap-1.5 pt-1.5">
            {ADJUSTMENT_PRESETS.map((p) => (
              <Chip
                key={p.label}
                onClick={() => commitAdj(p.value)}
                active={JSON.stringify(p.value) === JSON.stringify(adjustments)}
              >
                {p.label}
              </Chip>
            ))}
          </Body>
        </Section>
      )}
    </>
  );
}

/** The layer blur in a `filter` (px; 0: none). */
export function blurOf(filter: string | null | undefined): number {
  const m = /blur\(([\d.]+)px\)/.exec(filter ?? "");
  return m ? Number(m[1]) : 0;
}

/** `filter` with its blur set to `px` (0 removes it); null when nothing is left. */
export function withBlur(filter: string | null | undefined, px: number): string | null {
  const rest = (filter ?? "")
    .replace(/blur\([^)]*\)/g, "")
    .replace(/\bnone\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [rest, px > 0 ? `blur(${Math.round(px * 10) / 10}px)` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** Efektler: the layer blur (the contract's filters have no shadow). */
function EffectsSection({
  session,
  layer,
  apply,
}: {
  session: EditorSession;
  layer: EditorLayer;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const filter = layer.style.filter;
  const blur = blurOf(filter);
  const [open, setOpen] = useState(blur > 0);
  const target = layer.type === "slot";
  if (!open && blur === 0) {
    return (
      <Section
        title="Efektler"
        empty
        action={
          <IconButton
            size={24}
            icon={<span className="text-[15px] leading-none">+</span>}
            label="Katman bulanıklığı ekle"
            onClick={() => setOpen(true)}
          />
        }
      />
    );
  }
  return (
    <Section
      title="Efektler"
      action={
        <IconButton
          size={24}
          icon={<span className="text-[15px] leading-none">−</span>}
          label="Bulanıklığı kaldır"
          onClick={() => {
            setOpen(false);
            if (blur > 0) apply(setStyleOps(layer, { filter: withBlur(filter, 0) }), "Bulanıklık");
          }}
        />
      }
    >
      <Slider
        label="Bulanıklık"
        value={blur}
        min={0}
        max={50}
        format={(v) => `${v} px`}
        onPreview={(v) =>
          session.canvas.previewCss(layer.key, { filter: withBlur(filter, v) ?? "none" }, target)
        }
        onCommit={(v) => apply(setStyleOps(layer, { filter: withBlur(filter, v) }), "Bulanıklık")}
      />
    </Section>
  );
}

function toAsset(src: string): string {
  if (src.startsWith("/media/")) {
    const id = src.slice(7).replace(/\.[A-Za-z0-9]+$/, "");
    return `/api/assets/${encodeURIComponent(decodeURIComponent(id))}/content`;
  }
  return src;
}

// --- nothing selected: the slide ----------------------------------------------------------------

function SlideSections({
  session,
  editor,
  snapshot,
  actions,
}: {
  session: EditorSession;
  editor: PostEditor;
  snapshot: EditorSnapshot;
  actions: EditActions;
}) {
  const { canvas, canvasState: s } = session;
  const slide = canvas.editorSlides[s.activeSlide];
  const view = session.safeArea(s.activeSlide);
  const collisions = canvas.collisionsOf(s.activeSlide);
  const content = snapshot.content;
  const first = canvas.editorSlides[0];
  const presets = first ? presetsForSlide(first) : [];
  const preset = first
    ? presetFor(content.type, content.targetPlatforms, first, session.preset)
    : null;
  // The checks' "show me" selects the layer on the canvas.
  const locator = useMemo(() => {
    let at = 0;
    return {
      selectSlide: (i: number) => {
        at = i;
        canvas.selectSlide(i);
      },
      selectLayer: (id: string | null) => canvas.selectLayers(id ? [layerKey(at, id)] : []),
    };
  }, [canvas]);
  if (!slide) return <p className="p-4 text-body text-fg-3">Henüz bir tasarım yok.</p>;
  return (
    <div className="flex flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-hairline pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-fg">
            Kare {slide.index + 1} · {slideLabel(slide)}
          </div>
          <div className="text-caption text-fg-3">
            {slide.width} × {slide.height} · {slide.layers.length} katman
          </div>
        </div>
      </div>
      <Section title="Biçim">
        {presets.length > 0 && (
          <Row span={2} label="Önizleme biçimi">
            <SelectField
              label="Önizleme biçimi"
              value={preset?.id ?? presets[0]?.id ?? ""}
              options={presets.map((p) => ({ value: p.id, label: p.label }))}
              onChange={(id) => session.setPreset(id)}
            />
          </Row>
        )}
        <Row span={2}>
          <span className="flex h-7 items-center justify-between gap-2 text-body text-fg">
            Güvenli alan
            <Switch
              checked={s.safeArea}
              onChange={(on) => canvas.setSafeArea(on)}
              label="Güvenli alanı göster"
            />
          </span>
        </Row>
        <Body>
          <p className="text-footnote text-fg-3 tabular-nums">
            {view
              ? `Kenar payları ${view.insets.top} · ${view.insets.right} · ${view.insets.bottom} · ${view.insets.left} px`
              : "Bu biçimin güvenli alanı yok."}
          </p>
          {view?.gridCrop && (
            <p className="mt-1 text-footnote text-fg-3">
              Profil ızgarası 4:5'i 3:4'e kırpar; kenarlardan ~{Math.round(view.gridCrop.x)} px
              görünmez.
            </p>
          )}
        </Body>
      </Section>
      {collisions.length > 0 && (
        <Section title="Uyarılar">
          <Body>
            <ul className="flex flex-col gap-0.5">
              {collisions.map((c) => {
                const layer = canvas.layer(c.key);
                return (
                  <li key={c.key}>
                    <button
                      type="button"
                      onClick={() => canvas.selectLayers([c.key])}
                      className="flex w-full items-start gap-2 rounded-[12px] px-2 py-1.5 text-left text-footnote hover:bg-control"
                    >
                      <IconWarning size={12} className="mt-0.5 shrink-0 text-danger" />
                      <span className="min-w-0">
                        <span className="block text-fg">
                          {layer ? layerTitle(layer) : c.layerId}
                        </span>
                        <span className="block text-fg-3">{c.message}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Body>
        </Section>
      )}
      <div className="border-b border-hairline px-4 py-3">
        <ChecksPanel snapshot={snapshot} editor={locator} />
      </div>
      <Section title="AI ile düzenle">
        <Body className="flex flex-wrap gap-1.5">
          {SLIDE_AI.map((label) => (
            <Chip key={label} onClick={() => actions.ai(`Kare ${slide.index + 1}: ${label}`, [])}>
              {label}
            </Chip>
          ))}
        </Body>
      </Section>
      <ExportSection session={session} editor={editor} snapshot={snapshot} />
      <p className="px-4 py-3 text-footnote text-fg-3">
        Bir katman seç: tuvalde tıkla, Katmanlar listesinden seç ya da ⌘A ile karedekilerin hepsini
        seç. Çift tık metni düzenler, görselde kırpmayı açar.
      </p>
    </div>
  );
}

/** Dışa aktar: the slides as the worker rendered them (PNG), saved first when edits wait. */
function ExportSection({
  session,
  editor: _editor,
  snapshot,
}: {
  session: EditorSession;
  editor: PostEditor;
  snapshot: EditorSnapshot;
}) {
  const version = snapshot.displayed ?? snapshot.current;
  const slides = version?.slides ?? [];
  const dirty = session.draftState.pending.length > 0 || !!session.draftState.inflight;
  const download = async (index: number) => {
    if (dirty && !(await session.draft.flush())) return;
    const fresh = snapshot.displayed ?? snapshot.current;
    const id = fresh?.slides[index]?.renderedAssetId;
    if (!id) {
      session.notify("Bu kare henüz render edilmedi.", "error");
      return;
    }
    const a = document.createElement("a");
    a.href = assetUrl(id);
    a.download = `${snapshot.content.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "post"} ${index + 1}.png`;
    document.body.append(a);
    a.click();
    a.remove();
  };
  if (slides.length === 0) return null;
  return (
    <Section title="Dışa aktar">
      {slides.map((sl, i) => (
        <Row
          key={i}
          action={
            <IconButton
              size={24}
              icon={<IconDownload size={13} />}
              label={`Kare ${i + 1} PNG indir`}
              disabled={!sl.renderedAssetId}
              onClick={() => void download(i)}
            />
          }
        >
          <span className="flex h-7 items-center text-body text-fg">Kare {i + 1}</span>
          <span className="flex h-7 items-center justify-end text-footnote text-fg-3 tabular-nums">
            PNG · {sl.width} × {sl.height}
          </span>
        </Row>
      ))}
      {dirty && (
        <Body>
          <p className="pt-1 text-footnote text-fg-3">
            Kaydedilmemiş değişiklikler var: indirmeden önce kaydedilir.
          </p>
        </Body>
      )}
    </Section>
  );
}

function OpacityGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2"
        y="2"
        width="12"
        height="12"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M2 14 14 2v9a3 3 0 0 1-3 3z" fill="currentColor" opacity="0.6" />
    </svg>
  );
}

function RadiusGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 13V8a5 5 0 0 1 5-5h5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
