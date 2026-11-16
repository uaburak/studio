import { type ExportFormat, getPreset, type PlatformPreset } from "./platforms.ts";

export interface ExportFile {
  format: ExportFormat;
  /** Pixel size (for PDF: the page raster size). */
  width: number;
  height: number;
  bytes: number;
  /** PDF page count. */
  pages?: number;
  /** Embedded/declared colour space; `srgb` when unknown and untagged. */
  colorSpace?: "srgb" | "display-p3" | "unknown";
}

export interface ExportIssue {
  code:
    | "unknown-preset"
    | "format-not-allowed"
    | "too-large"
    | "large-file"
    | "too-narrow"
    | "too-wide"
    | "aspect-out-of-range"
    | "aspect-mismatch"
    | "too-many-pixels"
    | "too-many-pages"
    | "color-space";
  severity: "error" | "warning";
  message: string;
}

export interface ExportValidation {
  ok: boolean;
  issues: ExportIssue[];
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** Check one exported file against a platform preset's constraints. */
export function validateExport(
  presetOrId: PlatformPreset | string,
  file: ExportFile,
): ExportValidation {
  const preset = typeof presetOrId === "string" ? getPreset(presetOrId) : presetOrId;
  if (!preset)
    return {
      ok: false,
      issues: [
        {
          code: "unknown-preset",
          severity: "error",
          message: `Unknown preset "${String(presetOrId)}".`,
        },
      ],
    };
  const c = preset.export;
  const issues: ExportIssue[] = [];
  const add = (code: ExportIssue["code"], severity: ExportIssue["severity"], message: string) =>
    issues.push({ code, severity, message });

  if (!c.formats.includes(file.format))
    add(
      "format-not-allowed",
      "error",
      `${preset.label} accepts ${c.formats.join("/").toUpperCase()}, not ${file.format.toUpperCase()}.`,
    );
  if (file.bytes > c.maxBytes)
    add("too-large", "error", `${mb(file.bytes)} is over the ${mb(c.maxBytes)} limit.`);
  else if (c.softMaxBytes && file.format === "png" && file.bytes > c.softMaxBytes)
    add(
      "large-file",
      "warning",
      `${mb(file.bytes)} PNG may be recompressed by the platform (keep under ${mb(c.softMaxBytes)} or use JPEG).`,
    );
  if (c.minWidth && file.width < c.minWidth)
    add(
      "too-narrow",
      "warning",
      `${file.width}px is below the ${c.minWidth}px minimum width; the platform upscales it.`,
    );
  if (c.maxWidth && file.width > c.maxWidth)
    add(
      "too-wide",
      "warning",
      `${file.width}px is above the ${c.maxWidth}px maximum width; the platform downscales it (export at device scale ≤ ${(c.maxWidth / preset.width).toFixed(2)}).`,
    );
  const aspect = file.width / file.height;
  if ((c.minAspect && aspect < c.minAspect - 1e-3) || (c.maxAspect && aspect > c.maxAspect + 1e-3))
    add(
      "aspect-out-of-range",
      "error",
      `Aspect ${aspect.toFixed(3)} is outside ${c.minAspect?.toFixed(3) ?? "-"}–${c.maxAspect?.toFixed(3) ?? "-"}.`,
    );
  if (Math.abs(aspect - preset.width / preset.height) > 0.005)
    add(
      "aspect-mismatch",
      "warning",
      `Aspect ${aspect.toFixed(3)} differs from the preset's ${preset.ratio}.`,
    );
  if (c.maxPixels && file.width * file.height > c.maxPixels)
    add("too-many-pixels", "error", `${file.width * file.height} pixels is over ${c.maxPixels}.`);
  if (c.maxPages !== undefined && (file.pages ?? 1) > c.maxPages)
    add("too-many-pages", "error", `${file.pages} pages is over ${c.maxPages}.`);
  if (file.colorSpace && file.colorSpace !== "srgb")
    add("color-space", "warning", `Export in sRGB (got ${file.colorSpace}).`);
  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
