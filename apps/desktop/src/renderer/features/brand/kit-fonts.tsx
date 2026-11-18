// Marka Kiti → Yazı tipleri: uploaded font files and fonts installed on this Mac (picked with the
// FontPicker). An installed font is used by family name when posts are rendered on this Mac; a
// file of the same family is its fallback where the font is not installed.
import { type BrandKitFontRole, kitFontKey } from "@studio/contract";
import { useMemo } from "react";
import { cn, IconButton, TagPill, TextField } from "../../components/ui/controls.tsx";
import { type FontChoice, FontPicker } from "../../components/ui/font-picker.tsx";
import { IconClose, IconLaptop, IconPlus } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { fontFace, isKitFamilyName, useInstalledFonts } from "../../lib/fonts.ts";
import {
  addSystemFont,
  FONT_ROLE_LABEL,
  fallbackFileOf,
  isFallbackFile,
  type KitFont,
  kitStylesLabel,
  toggleSystemFontStyle,
} from "./brand-model.ts";

const KIT_FAMILY_REASON = "Bu ad marka kitinde kullanılamaz (yalnızca harf, rakam, boşluk, tire).";

/** The kit's families, for the picker's "Marka fontları" section. */
export function kitFamilies(fonts: readonly KitFont[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fonts) {
    const k = f.family.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(f.family.trim());
  }
  return out;
}

/** "Mac'ten seç": the FontPicker as a button that adds an installed font to the kit. */
export function AddSystemFontButton({
  fonts,
  onChange,
}: {
  fonts: readonly KitFont[];
  onChange(next: KitFont[]): void;
}) {
  const families = kitFamilies(fonts.filter((f) => f.source === "system"));
  return (
    <FontPicker
      trigger="button"
      label="Mac'teki yazı tiplerinden seç"
      placeholder="Mac'ten seç"
      buttonIcon={<IconLaptop size={12} strokeWidth={2} />}
      value={null}
      pinned={kitFamilies(fonts)}
      marked={families}
      disabledReason={(family) => (isKitFamilyName(family) ? null : KIT_FAMILY_REASON)}
      onChange={(choice: FontChoice) => onChange(addSystemFont(fonts, choice))}
    />
  );
}

export function KitFontList({
  fonts,
  fileName,
  onChange,
}: {
  fonts: readonly KitFont[];
  fileName(assetId: string): string;
  onChange(next: KitFont[]): void;
}) {
  const installed = useInstalledFonts();
  const byFamily = useMemo(
    () => new Map((installed.data?.families ?? []).map((f) => [f.family.toLowerCase(), f])),
    [installed.data],
  );
  const listed = installed.data !== undefined && installed.data.source !== "sample";
  const pinned = kitFamilies(fonts);

  if (fonts.length === 0) {
    return (
      <p className="text-body text-fg-3">
        Yazı tipi yok; sistem fontu kullanılır. Mac'teki bir yazı tipini seç ya da font dosyası
        yükle.
      </p>
    );
  }

  const update = (index: number, next: KitFont) =>
    onChange(fonts.map((f, i) => (i === index ? next : f)));
  const remove = (index: number) => onChange(fonts.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-2">
      {fonts.map((font, index) => {
        const role = (
          <select
            aria-label="Rol"
            value={font.role}
            onChange={(e) => update(index, { ...font, role: e.target.value as BrandKitFontRole })}
            className="h-7 shrink-0 rounded-full bg-field px-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none"
          >
            {(Object.keys(FONT_ROLE_LABEL) as BrandKitFontRole[]).map((r) => (
              <option key={r} value={r}>
                {FONT_ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        );
        const license = (
          <TextField
            aria-label="Lisans notu"
            className="min-w-[160px] flex-1"
            placeholder="Lisans notu (nereden, ne izin veriyor)"
            value={font.licenseNote}
            onChange={(e) => update(index, { ...font, licenseNote: e.target.value })}
          />
        );
        const removeButton = (
          <IconButton
            icon={<IconClose size={14} strokeWidth={1.75} />}
            label="Yazı tipini kaldır"
            onClick={() => remove(index)}
          />
        );

        if (font.source === "system") {
          const data = byFamily.get(font.family.toLowerCase()) ?? null;
          const missing = listed && !data;
          const fallback = fallbackFileOf(fonts, font);
          const styleEntries = (): MenuEntry[] => [
            { type: "label", label: "Kullanılan stiller (hiçbiri: tümü)" },
            ...(data?.styles ?? []).map((style) => ({
              id: style.postscriptName,
              label: style.name,
              detail: String(style.weight),
              checked: font.styles.some((s) => s.name === style.name),
              onSelect: () => update(index, toggleSystemFontStyle(font, style)),
            })),
          ];
          return (
            <div key={kitFontKey(font)} className="flex flex-wrap items-center gap-2">
              <span className="flex w-[150px] shrink-0 items-center gap-1.5 text-footnote text-fg-3">
                <IconLaptop size={13} strokeWidth={1.75} />
                Mac'te yüklü
              </span>
              <FontPicker
                label="Yazı tipi"
                className="w-[200px]"
                value={{ family: font.family }}
                pinned={pinned}
                disabledReason={(family) => (isKitFamilyName(family) ? null : KIT_FAMILY_REASON)}
                onChange={(choice) => {
                  if (choice.family.toLowerCase() === font.family.toLowerCase()) {
                    if (choice.style) update(index, toggleSystemFontStyle(font, choice.style));
                    return;
                  }
                  const next = addSystemFont([], choice)[0];
                  if (next)
                    update(index, { ...next, role: font.role, licenseNote: font.licenseNote });
                }}
              />
              <MenuButton entries={styleEntries} label="Stiller" width={240}>
                {(props) => (
                  <button
                    type="button"
                    ref={props.ref}
                    onClick={props.onClick}
                    onKeyDown={props.onKeyDown}
                    aria-haspopup={props["aria-haspopup"]}
                    aria-expanded={props["aria-expanded"]}
                    aria-label="Stiller"
                    disabled={!data}
                    title={kitStylesLabel(font)}
                    className={cn(
                      "flex h-7 max-w-[220px] shrink-0 items-center gap-1 rounded-full bg-field px-3 text-body text-fg",
                      "shadow-[inset_0_0_0_1px_var(--border-hairline)] hover:bg-control disabled:opacity-40",
                    )}
                  >
                    <span className="truncate" style={{ fontFamily: fontFace(font.family) }}>
                      {kitStylesLabel(font)}
                    </span>
                    <IconPlus size={11} strokeWidth={2} className="shrink-0 text-fg-3" />
                  </button>
                )}
              </MenuButton>
              {role}
              {license}
              {missing && (
                <span title="Bu Mac'te bu yazı tipi yok; render yedek dosyayla ya da sistem fontuyla yapılır.">
                  <TagPill tone="warning">
                    {fallback ? "Yüklü değil · dosya kullanılır" : "Bu Mac'te yüklü değil"}
                  </TagPill>
                </span>
              )}
              {removeButton}
            </div>
          );
        }

        const name = font.assetId ? fileName(font.assetId) : "";
        return (
          <div key={kitFontKey(font)} className="flex flex-wrap items-center gap-2">
            <span className="w-[150px] shrink-0 truncate text-footnote text-fg-3" title={name}>
              {name || "Font dosyası"}
            </span>
            <TextField
              aria-label="Aile adı"
              className="w-[200px]"
              value={font.family}
              onChange={(e) => update(index, { ...font, family: e.target.value })}
            />
            {role}
            {license}
            {isFallbackFile(fonts, font) && (
              <span title="Aynı aile Mac'te yüklüyse o kullanılır; bu dosya yalnızca yüklü olmadığında devreye girer.">
                <TagPill>Yedek dosya</TagPill>
              </span>
            )}
            {removeButton}
          </div>
        );
      })}
    </div>
  );
}
