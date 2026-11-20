// "Boş tuvalden yeni post" (docs/URETIM-RESIM.md §14, Faz 2): a draft post of the current brand
// whose first version is a blank Wecra document — one white frame per slide in the size picked —
// made by this Mac's canvas runner (`canvas.create`, no AI). The post opens in the post editor
// at once; the canvas comes up when the job has stored the version.
import {
  type ApiClient,
  ARTBOARDS,
  type CanvasCreatePayloadInput,
  type Content,
  type Job,
  SLIDE_LIMITS,
} from "@studio/contract";

export type BlankKind = "post" | "carousel" | "story";
export type BlankSize = "portrait" | "square";

export interface BlankForm {
  title: string;
  kind: BlankKind;
  size: BlankSize;
  /** Carousel only. */
  slides: number;
}

export const BLANK_FORM: BlankForm = { title: "", kind: "post", size: "portrait", slides: 3 };

export const BLANK_KINDS: { value: BlankKind; label: string }[] = [
  { value: "post", label: "Tek görsel" },
  { value: "carousel", label: "Carousel" },
  { value: "story", label: "Story" },
];

export const BLANK_SIZES: { value: BlankSize; label: string }[] = [
  { value: "portrait", label: "4:5 · 1080×1350" },
  { value: "square", label: "1:1 · 1080×1080" },
];

/** The slide size: a story is vertical (1080×1920), a feed post 4:5 or square. */
export function blankFormat(form: Pick<BlankForm, "kind" | "size">): {
  width: number;
  height: number;
} {
  if (form.kind === "story") return { ...ARTBOARDS.vertical };
  return { ...ARTBOARDS[form.size] };
}

export function blankSlides(form: Pick<BlankForm, "kind" | "slides">): number {
  if (form.kind !== "carousel") return 1;
  const { min, max } = SLIDE_LIMITS.carousel;
  return Math.min(max, Math.max(min, Math.round(form.slides) || min));
}

export function blankCanvasJob(form: BlankForm): CanvasCreatePayloadInput {
  const size = blankFormat(form);
  return {
    baseVersion: null,
    slides: blankSlides(form),
    width: size.width,
    height: size.height,
    origin: "manual_edit",
    note: "Boş tuval.",
  };
}

/** The draft post and its `canvas.create` job (the post opens while the job runs). */
export async function createBlankCanvasPost(
  api: Pick<ApiClient, "contents" | "jobs">,
  brandId: string,
  form: BlankForm,
): Promise<{ content: Content; job: Job }> {
  const content = await api.contents.create({
    brandId,
    type: form.kind,
    title: form.title.trim() || "Yeni post",
    brief: "",
    targetPlatforms: ["instagram"],
  });
  const job = await api.jobs.create({
    type: "canvas.create",
    brandId,
    contentId: content.id,
    payload: blankCanvasJob(form) as Record<string, unknown>,
  });
  return { content, job };
}
