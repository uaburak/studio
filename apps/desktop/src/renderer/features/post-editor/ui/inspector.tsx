// The Tasarım tab: what is selected and its properties — position and size, text (installed
// and brand fonts, weight, size, leading, tracking, alignment), brand colours and fonts, fill and
// opacity, the picture (replace, fit, crop, adjustments), effects, the safe-area warning and the
// quick AI edits. Every change is one design-kit patch through the draft (instant on the canvas).
import { useEffect, useRef, useState } from "react";
import { Button, cn, IconButton, SegmentedControl } from "../../../components/ui/controls.tsx";
import { FontPicker } from "../../../components/ui/font-picker.tsx";
import { IconEllipsis, IconWarning } from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import type { ComputedLayerStyle } from "../canvas/controller.ts";
import type { RenderKit } from "../model/brand-kit.ts";
import {
  type EditorLayer,
  findLayer,
  layerLabel,
  slideLabel,
  TYPE_LABEL,
} from "../model/document.ts";
import type { SlidePatchInput } from "../model/draft.ts";
import { aabb, resizedKeepingCorner } from "../model/geometry.ts";
import {
  ADJUSTMENT_PRESETS,
  type Adjustments,
  cssColorHex,
  familyCss,
  filterCss,
  parseFilter,
  primaryFamily,
  WEIGHTS,
} from "../model/style-values.ts";
import type { EditorSession } from "../session.ts";
import { Chip, ColorField, NumberField, Section, Slider } from "./fields.tsx";
import {
  IconAlignBottom,
  IconAlignCenter,
  IconAlignLeft,
  IconAlignMiddle,
  IconAlignRight,
  IconAlignTop,
  IconLock,
  IconPlus,
  IconRotate,
  IconTextCenter,
  IconTextLeft,
  IconTextRight,
} from "./glyphs.tsx";
import { layerTitle } from "./left-panel.tsx";

export interface InspectorActions {
  ai(instruction: string, keys: readonly string[]): void;
  replaceImage(key: string): void;
}

const TEXT_AI = ["Kısalt", "Daha vurucu", "Emoji ekle", "İngilizceye çevir"];
const IMAGE_AI = ["Arka planı kaldır", "Görseli genişlet", "Yeniden üret", "Netleştir"];

export function Inspector({
  session,
  kit,
  actions,
}: {
  session: EditorSession;
  kit: RenderKit;
  actions: InspectorActions;
}) {
  const { canvas, canvasState: s } = session;
  const layers = s.selection
    .map((k) => findLayer(canvas.editorSlides, k))
    .filter((l): l is EditorLayer => l !== null);
  // Re-read the computed style when the layout changes (an edit landed).
  void s.layoutRevision;
  if (layers.length === 0) return <SlideInspector session={session} actions={actions} />;
  const layer = layers[0] as EditorLayer;
  const single = layers.length === 1;
  const computed = single ? canvas.computed(layer.key) : null;
  const apply = (ops: SlidePatchInput[], name: string) => canvas.applyOps(ops, name);
  const op = <T extends object>(o: T, name: string) =>
    apply(
      layers.map((l) => ({ ...o, layer: l.id, slide: l.slide }) as unknown as SlidePatchInput),
      name,
    );
  const textLayers = layers.filter((l) => l.type === "text" || l.type === "group");
  const collisions = canvas.collisionsOf(layer.slide).filter((c) => s.selection.includes(c.key));
  const slide = canvas.editorSlides[layer.slide];

  const menu: MenuEntry[] = [
    {
      id: "dup",
      label: "Çoğalt",
      shortcut: "⌘D",
      onSelect: () => op({ op: "duplicateLayer", offset: { x: 24, y: 24 } }, "Çoğalt"),
    },
    { id: "fwd", label: "Öne getir", shortcut: "⌘]", onSelect: () => canvas.restack(layer.key, 1) },
    {
      id: "back",
      label: "Arkaya gönder",
      shortcut: "⌘[",
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
      <div className="flex items-start gap-2 border-b border-hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-fg">
            {single ? layerTitle(layer) : `${layers.length} katman seçili`}
          </div>
          <div className="truncate text-footnote text-fg-3">
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
          className="mx-3 mt-3 rounded-[12px] border border-danger/50 bg-danger/8 p-3"
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

      {single && layer.type === "text" && (
        <TextSection
          key={layer.key}
          session={session}
          layer={layer}
          computed={computed}
          kit={kit}
        />
      )}
      {!single && textLayers.length > 0 && (
        <Section title="Metin">
          <p className="text-footnote text-fg-3">
            Birden çok metin seçili: renkler ve marka yazı tipleri hepsine uygulanır.
          </p>
        </Section>
      )}

      {(layer.type === "text" || layer.type === "shape" || layer.type === "group") && (
        <BrandSection layers={layers} kit={kit} apply={apply} />
      )}

      {single && computed && (layer.type === "text" || layer.type === "shape") && (
        <FillSection layer={layer} computed={computed} apply={apply} />
      )}

      {single && (layer.type === "image" || layer.type === "slot" || layer.type === "logo") && (
        <ImageSection session={session} layer={layer} computed={computed} actions={actions} />
      )}

      {single && computed && (
        <EffectsSection key={`fx-${layer.key}`} layer={layer} computed={computed} apply={apply} />
      )}

      <Section title="AI ile düzenle">
        <div className="flex flex-wrap gap-1.5">
          {(layer.type === "image" || layer.type === "slot" ? IMAGE_AI : TEXT_AI).map((label) => (
            <Chip key={label} onClick={() => actions.ai(label, s.selection)}>
              {label}
            </Chip>
          ))}
        </div>
      </Section>
    </div>
  );
}

function SlideInspector({
  session,
  actions,
}: {
  session: EditorSession;
  actions: InspectorActions;
}) {
  const { canvas, canvasState: s } = session;
  const slide = canvas.editorSlides[s.activeSlide];
  const view = session.safeArea(s.activeSlide);
  const collisions = canvas.collisionsOf(s.activeSlide);
  if (!slide) return <p className="p-4 text-body text-fg-3">Henüz bir tasarım yok.</p>;
  return (
    <div className="flex flex-col">
      <div className="border-b border-hairline px-4 py-3">
        <div className="text-body font-semibold text-fg">
          Kare {slide.index + 1} · {slideLabel(slide)}
        </div>
        <div className="text-footnote text-fg-3">
          {slide.width} × {slide.height} · {slide.layers.length} katman
        </div>
      </div>
      <Section title="Biçim">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-footnote">
          <dt className="text-fg-3">Hazır ayar</dt>
          <dd className="text-fg">{view?.preset.label ?? "—"}</dd>
          <dt className="text-fg-3">Güvenli alan</dt>
          <dd className="text-fg tabular-nums">
            {view
              ? `${view.insets.top} · ${view.insets.right} · ${view.insets.bottom} · ${view.insets.left} px`
              : "—"}
          </dd>
        </dl>
        {view?.gridCrop && (
          <p className="mt-2 text-footnote text-fg-3">
            Profil ızgarası 4:5'i 3:4'e kırpar; kenarlardan ~{Math.round(view.gridCrop.x)} px
            görünmez.
          </p>
        )}
      </Section>
      {collisions.length > 0 && (
        <Section title="Uyarılar">
          <ul className="flex flex-col gap-1.5">
            {collisions.map((c) => {
              const layer = canvas.layer(c.key);
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => canvas.selectLayers([c.key])}
                    className="flex w-full items-start gap-2 rounded-[8px] p-1.5 text-left text-footnote hover:bg-control"
                  >
                    <IconWarning size={12} className="mt-0.5 shrink-0 text-danger" />
                    <span className="min-w-0">
                      <span className="block text-fg">{layer ? layerTitle(layer) : c.layerId}</span>
                      <span className="block text-fg-3">{c.message}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <Section title="AI ile düzenle">
        <div className="flex flex-wrap gap-1.5">
          {["Daha sade", "Başlığı büyüt", "Renkleri canlandır", "Kontrastı artır"].map((label) => (
            <Chip key={label} onClick={() => actions.ai(`Kare ${slide.index + 1}: ${label}`, [])}>
              {label}
            </Chip>
          ))}
        </div>
      </Section>
      <p className="px-4 py-3 text-footnote text-fg-3">
        Bir katman seç: tuvalde tıkla, soldaki listeden seç ya da ⌘A ile hepsini seç. Çift tık metni
        düzenler, görselde kırpmayı açar.
      </p>
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
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="flex h-7 items-center justify-around rounded-[8px] bg-field">
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
        </div>
        <div className="flex h-7 items-center justify-around rounded-[8px] bg-field">
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
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
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
        <NumberField
          label="Genişlik"
          prefix="W"
          value={box ? box.w : right - x}
          disabled={!single}
          min={1}
          onCommit={(v) =>
            single && box && canvas.setBox(single.layer.key, resizedKeepingCorner(box, v, box.h))
          }
        />
        <NumberField
          label="Yükseklik"
          prefix="H"
          value={box ? box.h : bottom - y}
          disabled={!single}
          min={1}
          onCommit={(v) =>
            single && box && canvas.setBox(single.layer.key, resizedKeepingCorner(box, box.w, v))
          }
        />
        <NumberField
          label="Açı"
          prefix={<IconRotate size={12} />}
          value={box?.angle ?? 0}
          suffix="°"
          disabled={!single}
          onCommit={(v) => single && canvas.setBox(single.layer.key, { angle: v }, "Döndür")}
        />
        <div className="flex items-center justify-end">
          <IconButton
            size={28}
            icon={<IconLock size={13} />}
            label={locked ? "Kilidi aç" : "Kilitle"}
            selected={locked}
            onClick={() => {
              for (const k of keys) canvas.setLocked(k, !locked);
            }}
          />
        </div>
      </div>
    </Section>
  );
}

function TextSection({
  session,
  layer,
  computed,
  kit,
}: {
  session: EditorSession;
  layer: EditorLayer;
  computed: ComputedLayerStyle | null;
  kit: RenderKit;
}) {
  const { canvas } = session;
  const [text, setText] = useState(layer.text ?? "");
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setText(layer.text ?? "");
  }, [layer.text]);
  const typography = (fields: Record<string, unknown>, name: string) =>
    canvas.applyOps(
      [{ op: "setTypography", layer: layer.id, slide: layer.slide, ...fields } as SlidePatchInput],
      name,
    );
  const family = computed ? primaryFamily(computed.fontFamily) : null;
  const brandFamilies = kit.fonts.map((f) => f.family);
  const align = !computed
    ? null
    : computed.textAlign === "start"
      ? "left"
      : computed.textAlign === "end"
        ? "right"
        : computed.textAlign;

  return (
    <Section title="Metin">
      <textarea
        aria-label="Metin"
        value={text}
        rows={Math.min(5, Math.max(2, text.split("\n").length))}
        onChange={(e) => {
          dirty.current = true;
          setText(e.target.value);
        }}
        className="mb-1.5 w-full resize-none rounded-[8px] bg-field px-2 py-1.5 text-body text-fg outline-none focus:ring-2 focus:ring-focus/60"
      />
      {text !== (layer.text ?? "") && (
        <div className="mb-2 flex justify-end gap-1.5">
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
      {computed && (
        <>
          <FontPicker
            label="Yazı tipi"
            value={family ? { family } : null}
            pinned={brandFamilies}
            className="mb-2 w-full"
            onChange={(choice) => {
              const role = kit.fonts.find(
                (f) => f.family.toLowerCase() === choice.family.toLowerCase(),
              );
              const weight = choice.style?.weight;
              const italic = choice.style?.italic;
              if (role) {
                typography(
                  {
                    fontFamily: role.role,
                    ...(weight ? { fontWeight: weight } : {}),
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
                  ...(weight || italic !== undefined
                    ? [
                        {
                          op: "setTypography",
                          layer: layer.id,
                          slide: layer.slide,
                          ...(weight ? { fontWeight: weight } : {}),
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
          <div className="grid grid-cols-2 gap-2">
            <label className="flex h-7 items-center rounded-[8px] bg-field px-1.5">
              <select
                aria-label="Kalınlık"
                value={Math.round(computed.fontWeight / 100) * 100}
                onChange={(e) => typography({ fontWeight: Number(e.target.value) }, "Kalınlık")}
                className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none"
              >
                {WEIGHTS.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <NumberField
              label="Boyut"
              prefix="T"
              value={computed.fontSize}
              min={1}
              max={1000}
              onCommit={(v) => typography({ fontSize: v }, "Boyut")}
            />
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
          </div>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex h-7 flex-1 items-center justify-around rounded-[8px] bg-field">
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
            </div>
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
                "h-7 rounded-[8px] px-2.5 text-footnote font-semibold",
                computed.textTransform === "uppercase"
                  ? "bg-accent-subtle text-accent-text"
                  : "bg-field text-fg-2",
              )}
              title="Büyük harf"
            >
              AA
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function BrandSection({
  layers,
  kit,
  apply,
}: {
  layers: EditorLayer[];
  kit: RenderKit;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const colorOps = (token: string) =>
    layers.map((l) => ({
      op: "setColor",
      layer: l.id,
      slide: l.slide,
      property: l.type === "shape" ? "background-color" : "color",
      value: { token },
    })) as unknown as SlidePatchInput[];
  const fontOps = (role: string) =>
    layers
      .filter((l) => l.type === "text" || l.type === "group")
      .map((l) => ({
        op: "setTypography",
        layer: l.id,
        slide: l.slide,
        fontFamily: role,
      })) as unknown as SlidePatchInput[];
  return (
    <Section title={kit.mode === "neutral" ? "Marka · nötr varsayılan" : "Marka"}>
      <div className="flex flex-wrap gap-2">
        {kit.swatches.map((sw) => (
          <button
            key={sw.token}
            type="button"
            title={`${sw.token} · ${sw.value}${sw.use ? ` · ${sw.use}` : ""}`}
            aria-label={`Marka rengi ${sw.token}`}
            onClick={() => apply(colorOps(sw.token), "Marka rengi")}
            className="size-6 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.18)] transition-transform hover:scale-110"
            style={{ background: sw.value }}
          />
        ))}
      </div>
      {fontOps("x").length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {kit.fonts.map((f) => (
            <Chip
              key={f.role}
              onClick={() => apply(fontOps(f.role), "Marka yazı tipi")}
              title={`--font-${f.role}`}
            >
              <span style={{ fontFamily: `"${f.family}"` }}>{f.family}</span>
              <span className="text-fg-3">{f.role}</span>
            </Chip>
          ))}
        </div>
      )}
    </Section>
  );
}

function FillSection({
  layer,
  computed,
  apply,
}: {
  layer: EditorLayer;
  computed: ComputedLayerStyle;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const property = layer.type === "shape" ? "background-color" : "color";
  const value = cssColorHex(property === "color" ? computed.color : computed.backgroundColor);
  return (
    <Section title="Dolgu">
      <div className="flex items-center gap-2">
        <ColorField
          label={property === "color" ? "Metin rengi" : "Dolgu rengi"}
          value={value}
          onCommit={(hex) =>
            apply(
              [
                {
                  op: "setColor",
                  layer: layer.id,
                  slide: layer.slide,
                  property,
                  value: { literal: hex },
                } as unknown as SlidePatchInput,
              ],
              "Renk",
            )
          }
        />
        <NumberField
          className="w-[84px] flex-none"
          label="Opaklık"
          prefix="%"
          value={Math.round(computed.opacity * 100)}
          min={0}
          max={100}
          onCommit={(v) =>
            apply(
              [
                {
                  op: "setStyle",
                  layer: layer.id,
                  slide: layer.slide,
                  set: { opacity: v >= 100 ? null : String(v / 100) },
                } as unknown as SlidePatchInput,
              ],
              "Opaklık",
            )
          }
        />
      </div>
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
  actions: InspectorActions;
}) {
  const { canvas } = session;
  const name = (layer.src ?? "").split("/").pop() ?? "";
  const adjustments = parseFilter(layer.style.filter);
  const [adj, setAdj] = useState<Adjustments>(adjustments);
  useEffect(() => setAdj(parseFilter(layer.style.filter)), [layer.style.filter]);
  const commitAdj = (next: Adjustments) =>
    canvas.applyOps(
      [
        {
          op: "setStyle",
          layer: layer.id,
          slide: layer.slide,
          set: { filter: filterCss(next) },
        } as unknown as SlidePatchInput,
      ],
      "Görsel ayarı",
    );
  const fit =
    session.canvasState.cropping === layer.key ? "crop" : (computed?.objectFit ?? "cover");
  const empty = layer.type === "slot" && layer.slotState !== "filled";
  return (
    <>
      <Section title={layer.type === "logo" ? "Logo" : "Görsel"}>
        <div className="mb-2 flex items-center gap-2.5 rounded-[10px] bg-field p-2">
          <span className="size-10 shrink-0 overflow-hidden rounded-[6px] bg-control">
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
        {layer.type !== "logo" ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" onClick={() => actions.replaceImage(layer.key)}>
                {empty ? "Görsel ekle" : "Değiştir"}
              </Button>
              <Button size="sm" onClick={() => actions.ai("Bu görseli yeniden üret", [layer.key])}>
                Görsel üret
              </Button>
            </div>
            {!empty && (
              <SegmentedControl
                className="mt-2 w-full"
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
            )}
          </>
        ) : (
          <p className="text-footnote text-fg-3">
            Logo marka kitinden gelir; boyutu yüksekliğiyle değişir, kırpılmaz ve renklendirilmez.
          </p>
        )}
      </Section>
      {layer.type !== "logo" && !empty && (
        <Section
          title="Ayarlar"
          action={
            adjustments.exposure ||
            adjustments.contrast ||
            adjustments.saturation ||
            adjustments.warmth ? (
              <button
                type="button"
                className="text-footnote text-fg-3 hover:text-fg"
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
                canvas.previewCss(layer.key, { filter: filterCss(next) ?? "none" });
              }}
              onCommit={(v) => commitAdj({ ...adj, [k]: v })}
            />
          ))}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ADJUSTMENT_PRESETS.map((p) => (
              <Chip
                key={p.label}
                onClick={() => commitAdj(p.value)}
                active={JSON.stringify(p.value) === JSON.stringify(adjustments)}
              >
                {p.label}
              </Chip>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function toAsset(src: string): string {
  if (src.startsWith("/media/")) {
    const id = src.slice(7).replace(/\.[A-Za-z0-9]+$/, "");
    return `/api/assets/${encodeURIComponent(decodeURIComponent(id))}/content`;
  }
  return src;
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
];

function EffectsSection({
  layer,
  computed,
  apply,
}: {
  layer: EditorLayer;
  computed: ComputedLayerStyle;
  apply(ops: SlidePatchInput[], name: string): boolean;
}) {
  const [open, setOpen] = useState(
    computed.mixBlendMode !== "normal" || computed.borderRadius > 0 || computed.opacity < 1,
  );
  const set = (prop: string, value: string | null, name: string) =>
    apply(
      [
        {
          op: "setStyle",
          layer: layer.id,
          slide: layer.slide,
          set: { [prop]: value },
        } as unknown as SlidePatchInput,
      ],
      name,
    );
  return (
    <Section
      title="Efektler"
      action={
        <IconButton
          size={24}
          icon={<IconPlus size={13} />}
          label={open ? "Efektleri gizle" : "Efekt ekle"}
          onClick={() => setOpen((o) => !o)}
        />
      }
    >
      {open && (
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 flex h-7 items-center gap-2 rounded-[8px] bg-field px-2 text-body">
            <span className="text-footnote text-fg-3">Karışım</span>
            <select
              aria-label="Karışım modu"
              value={computed.mixBlendMode}
              onChange={(e) =>
                set(
                  "mix-blend-mode",
                  e.target.value === "normal" ? null : e.target.value,
                  "Karışım modu",
                )
              }
              className="min-w-0 flex-1 bg-transparent text-fg outline-none"
            >
              {BLEND.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label="Köşe yarıçapı"
            prefix="◜"
            value={computed.borderRadius}
            min={0}
            onCommit={(v) => set("border-radius", v > 0 ? `${v}px` : null, "Köşe yarıçapı")}
          />
          <NumberField
            label="Saydamlık"
            prefix="%"
            value={Math.round(computed.opacity * 100)}
            min={0}
            max={100}
            onCommit={(v) => set("opacity", v >= 100 ? null : String(v / 100), "Opaklık")}
          />
        </div>
      )}
      {!open && <p className="text-footnote text-fg-3">Karışım modu, köşe yarıçapı, saydamlık.</p>}
    </Section>
  );
}
