// Brand templates (N9) on the desktop: what a template card says, the "Bu şablonla yeni post"
// form (texts and pictures per field, or a brief for the AI) and what it sends, and when a post
// can be saved as a template or converted (N10).
import {
  type Content,
  type ContentTemplate,
  fillableFields,
  REPURPOSE_LABEL,
  type RepurposeTarget,
  repurposeBlocker,
  TEMPLATE_CONTENT_TYPES,
  TEMPLATE_SOURCE_STATUSES,
  type TemplateField,
  type TemplateUse,
} from "@studio/contract";

const TYPE_LABEL: Record<ContentTemplate["contentType"], string> = {
  post: "Post",
  carousel: "Carousel",
  story: "Story",
  reel: "Reels",
};

/** "Carousel · 4 kare · 1080×1350 · 6 alan" */
export function templateLine(t: ContentTemplate): string {
  const fields = fillableFields(t).length;
  return [
    TYPE_LABEL[t.contentType],
    t.slideCount > 1 ? `${t.slideCount} kare` : null,
    `${t.width}×${t.height}`,
    `${fields} alan`,
    t.kind === "canvas" ? "tuval" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "3 kez kullanıldı" / "Henüz kullanılmadı" */
export function templateUses(t: ContentTemplate): string {
  return t.useCount === 0 ? "Henüz kullanılmadı" : `${t.useCount} kez kullanıldı`;
}

export function templateMatches(t: ContentTemplate, query: string): boolean {
  const q = query.trim().toLocaleLowerCase("tr");
  if (!q) return true;
  return [t.name, t.description, t.source.title, TYPE_LABEL[t.contentType]]
    .join(" ")
    .toLocaleLowerCase("tr")
    .includes(q);
}

// --- the fill form ----------------------------------------------------------------------------

export type FillMode = "manual" | "ai";

export interface FillForm {
  mode: FillMode;
  title: string;
  brief: string;
  /** Text per field key ("" = keep the template's text). */
  values: Record<string, string>;
  /** Picture (asset id) per image field key; missing = keep the template's. */
  images: Record<string, string>;
  autoFit: boolean;
}

export function fillForm(t: ContentTemplate): FillForm {
  return { mode: "manual", title: t.name, brief: "", values: {}, images: {}, autoFit: true };
}

/** Characters typed against the field's hint; over the hint auto-fit (or the checks) take it. */
export function fieldCount(
  field: TemplateField,
  value: string,
): {
  count: number;
  limit: number | null;
  over: boolean;
} {
  const count = Array.from(value).length;
  return {
    count,
    limit: field.maxChars,
    over: field.maxChars !== null && count > field.maxChars,
  };
}

/** Why the form cannot be sent (Turkish), or null. */
export function fillProblem(_t: ContentTemplate, form: FillForm): string | null {
  if (!form.title.trim()) return "Postun başlığını yaz.";
  if (form.mode === "ai") return form.brief.trim() ? null : "AI'ın ne yazacağını (konu) yaz.";
  const texts = Object.values(form.values).some((v) => v.trim());
  const images = Object.keys(form.images).length > 0;
  if (!texts && !images) return "En az bir alanı doldur ya da AI doldursun.";
  return null;
}

/** What the form sends to `POST /api/templates/{id}/use`. */
export function templateUseInput(t: ContentTemplate, form: FillForm): TemplateUse {
  const keys = new Set(fillableFields(t, "text").map((f) => f.key));
  const values = Object.fromEntries(
    Object.entries(form.values)
      .filter(([k, v]) => keys.has(k) && v.trim())
      .map(([k, v]) => [k, v.trim()]),
  );
  const imageKeys = new Set(fillableFields(t, "image").map((f) => f.key));
  const images = Object.fromEntries(Object.entries(form.images).filter(([k]) => imageKeys.has(k)));
  return {
    title: form.title.trim(),
    fill: form.mode,
    autoFit: form.autoFit,
    ...(form.mode === "ai" && form.brief.trim() ? { brief: form.brief.trim() } : {}),
    ...(Object.keys(values).length ? { values } : {}),
    ...(Object.keys(images).length ? { images } : {}),
  };
}

// --- posts ------------------------------------------------------------------------------------

/** Why this post cannot be saved as a template (Turkish), or null. */
export function templateBlocker(
  content: Pick<Content, "type" | "status" | "deletedAt">,
): string | null {
  if (content.deletedAt) return "Post silinmiş.";
  if (!(TEMPLATE_CONTENT_TYPES as readonly string[]).includes(content.type))
    return "Reels şablon olamaz.";
  if (!(TEMPLATE_SOURCE_STATUSES as readonly string[]).includes(content.status))
    return "Önce onayla; şablon onaylı postlardan olur.";
  return null;
}

/** Why this post cannot become a story / Reels (Turkish), or null. */
export function conversionBlocker(content: Content, target: RepurposeTarget): string | null {
  return repurposeBlocker(content, target)?.message ?? null;
}

export function conversionLabel(target: RepurposeTarget): string {
  return target === "story" ? "Story'ye dönüştür" : "Reels'e dönüştür";
}

/** "“Hasat” postundan Story" for the toast. */
export function conversionMade(target: RepurposeTarget, sourceTitle: string): string {
  return `“${sourceTitle}” postundan ${REPURPOSE_LABEL[target]} hazırlanıyor.`;
}
