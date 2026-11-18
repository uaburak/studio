/**
 * Converting a post (N10): the `content.generate` job whose payload carries `repurpose`. The
 * source version's texts and pictures (HTML layers, or a canvas version's facts) become
 *
 * - a story: the design pipeline gets a "repurpose" brief — the source's texts slide by slide,
 *   its pictures attached as media — and designs one 1080×1920 slide in the brand's design with
 *   the story preset (its safe areas: the platform UI at the top and the bottom), checked like
 *   any generation;
 * - a Reels: a `motion_graphics` spec straight from the slides (one scene per slide: eyebrow,
 *   headline, subhead; the post's pictures as the scenes' images; the call to action as the
 *   closing card), rendered by the Reels engine without an AI call.
 */
import type {
  Content,
  ContentVersion,
  Platform,
  ReelSpecInput,
  RepurposeSpec,
} from "@studio/contract";
import { getPreset } from "@studio/design-kit/presets";
import {
  type PostSource,
  readPostSource,
  type SourceImage,
  type SourceSlide,
  sourceImages,
} from "@studio/design-kit/template";
import type { AgentDeps } from "../agent.ts";
import { extensionForMime, imageInfo } from "../media.ts";
import { asData } from "../prompt-data.ts";
import type { MediaFile } from "./pipeline.ts";

export interface LoadedRepurpose {
  source: Content;
  version: ContentVersion;
  post: PostSource;
  images: SourceImage[];
}

/** The source post and version of a conversion. */
export async function loadRepurpose(
  deps: AgentDeps,
  spec: RepurposeSpec,
  signal: AbortSignal,
): Promise<LoadedRepurpose> {
  let source: Content;
  let version: ContentVersion;
  try {
    source = await deps.api.client.contents.get(spec.sourceContentId, { signal });
    version = await deps.api.client.contents.versions.get(
      spec.sourceContentId,
      spec.sourceVersion,
      { signal },
    );
  } catch (error) {
    signal.throwIfAborted();
    if ((error as { status?: number }).status === 404)
      throw new Error("Dönüştürülecek post ya da sürümü bulunamadı (silinmiş olabilir).");
    throw error;
  }
  const post = readPostSource(version.slides);
  return { source, version, post, images: sourceImages(post) };
}

const clip = (s: string, max: number) => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/u, "")}…`;
};

/** The source's texts as lines ("Kare 2 · Başlık: …"), data for the prompt. */
export function sourceLines(post: PostSource): string[] {
  const ROLE: Record<string, string> = {
    eyebrow: "Üst başlık",
    headline: "Başlık",
    subhead: "Alt başlık",
    body: "Metin",
    cta: "Çağrı",
    caption: "Not",
    legal: "Yasal metin",
    badge: "Rozet",
  };
  return post.slides.flatMap((s) =>
    s.texts.map(
      (t) =>
        `${post.slides.length > 1 ? `Kare ${s.index + 1} · ` : ""}${ROLE[t.role ?? ""] ?? "Metin"}: ${asData(t.text)}`,
    ),
  );
}

/**
 * The design brief of a story made from a post: what the post says (its texts are the content,
 * adapted, not copied blindly), its pictures, the story's size and safe areas.
 */
export function storyBrief(input: {
  source: Pick<Content, "title" | "type" | "caption">;
  post: PostSource;
  media: readonly { alias: string }[];
  platforms: readonly Platform[];
  instructions?: string | null;
}): { brief: string; instructions: string } {
  const preset =
    getPreset(
      input.platforms.includes("facebook") && !input.platforms.includes("instagram")
        ? "facebook-story"
        : "instagram-story",
    ) ?? null;
  const safe = preset?.safeArea;
  const lines = sourceLines(input.post);
  const brief = [
    `Bu bir dönüştürme: “${asData(input.source.title)}” ${input.source.type === "carousel" ? "carousel" : "postu"} 9:16 story olacak.`,
    "Kaynak postun metinleri (içerik budur; story'ye uyarla, kısalt, gereksizini çıkar, yeni iddia ekleme):",
    ...lines.map((l) => `- ${l}`),
    input.source.caption.trim()
      ? `Kaynak açıklama (bağlam): ${asData(clip(input.source.caption.trim(), 600))}`
      : "",
    input.media.length
      ? `Kaynak postun görselleri ekli: ${input.media.map((m) => `@${m.alias}`).join(", ")}. Görsel yuvası yerine bunları kullan.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const instructions = [
    "Tek kare 1080×1920 story; markanın kaynak postla aynı tasarım dili (renk, font, bileşenler).",
    safe
      ? `Metinleri ve logoyu güvenli alanda tut: üstten ${safe.top} px ve alttan ${safe.bottom} px boş kalsın (platform arayüzü), yanlardan en az ${safe.left} px.`
      : "Metinleri ve logoyu güvenli alanda tut (üst ve alt platform arayüzü).",
    "En çok bir başlık, bir kısa metin ve bir çağrı; carousel'in her karesini ayrı ayrı sığdırmaya çalışma.",
    input.instructions?.trim() ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return { brief, instructions };
}

/** Up to `max` source pictures as media files for the design pipeline (`@kaynak-1` …). */
export async function repurposeMedia(
  deps: AgentDeps,
  images: readonly SourceImage[],
  signal: AbortSignal,
  max = 3,
): Promise<{ files: MediaFile[]; missing: string[] }> {
  const files: MediaFile[] = [];
  const missing: string[] = [];
  for (const img of images) {
    if (files.length >= max) break;
    try {
      const { bytes, contentType } = await deps.api.downloadAsset(img.assetId, {
        maxBytes: deps.settings.imageMaxBytes,
        signal,
      });
      const info = await imageInfo(bytes);
      const mime = contentType.split(";")[0]?.trim() || `image/${info.format}`;
      if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
        missing.push(img.assetId);
        continue;
      }
      const ext = extensionForMime(mime) || `.${info.format === "jpeg" ? "jpg" : info.format}`;
      files.push({
        alias: `kaynak-${files.length + 1}`,
        path: `/media/${encodeURIComponent(img.assetId)}${ext}`,
        width: info.width,
        height: info.height,
        mimeType: mime,
        attached: true,
        bytes,
      });
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`repurpose: could not load ${img.assetId}: ${(error as Error).message}`);
      missing.push(img.assetId);
    }
  }
  return { files, missing };
}

// --- Reels ------------------------------------------------------------------------------------

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function firstOf(slide: SourceSlide, roles: readonly string[]): string {
  for (const role of roles) {
    const t = slide.texts.find((x) => x.role === role);
    if (t) return t.text;
  }
  return "";
}

/** Split a long text at its first sentence (headline, rest). */
function splitSentence(text: string): [string, string] {
  const m = /^(.{8,}?[.!?…])\s+(.+)$/su.exec(text);
  return m ? [m[1] as string, m[2] as string] : [text, ""];
}

/**
 * A `motion_graphics` Reels spec from a post (see the top): one scene per slide (at most 8), the
 * post's pictures on the scenes, its call to action (or the brand) as the closing card.
 */
export function reelSpecFromPost(
  post: PostSource,
  opts: { brandName: string; title: string },
): ReelSpecInput {
  const images = sourceImages(post);
  const scenes: NonNullable<ReelSpecInput["scenes"]> = [];
  let cta = "";
  for (const slide of post.slides) {
    if (scenes.length >= 8) break;
    cta ||= firstOf(slide, ["cta"]);
    const headline =
      firstOf(slide, ["headline"]) ||
      slide.texts.find((t) => t.role !== "cta" && t.role !== "eyebrow")?.text ||
      "";
    if (!headline) continue;
    const eyebrow = firstOf(slide, ["eyebrow"]);
    const sub = firstOf(slide, ["subhead", "body", "caption"]);
    scenes.push({
      eyebrow: clip(eyebrow, 80),
      headline: clip(headline, 160),
      subhead: clip(sub, 240),
      durationMs: 0,
    });
  }
  // A single post: its body is a second scene.
  if (post.slides.length === 1 && scenes.length === 1) {
    const slide = post.slides[0] as SourceSlide;
    const body = firstOf(slide, ["body"]);
    const first = scenes[0] as NonNullable<ReelSpecInput["scenes"]>[number];
    if (body && first.subhead === clip(body, 240)) {
      const [lead, rest] = splitSentence(body);
      first.subhead = "";
      scenes.push({
        eyebrow: "",
        headline: clip(lead, 160),
        subhead: clip(rest, 240),
        durationMs: 0,
      });
    }
  }
  if (scenes.length === 0)
    scenes.push({
      eyebrow: "",
      headline: clip(opts.title || opts.brandName, 160),
      subhead: "",
      durationMs: 0,
    });
  // Reading time: ~2.6 s plus a little per word, 2.2–4.5 s.
  for (const s of scenes)
    s.durationMs = Math.round(
      Math.min(
        4_500,
        Math.max(2_200, 2_200 + 180 * (words(s.headline) + words(s.subhead ?? "") * 0.6)),
      ),
    );
  // Pictures: one per scene in order, the first scene stays a clean hook when there are fewer.
  const offset = images.length > 0 && images.length < scenes.length ? 1 : 0;
  images.slice(0, scenes.length - offset).forEach((img, i) => {
    const scene = scenes[i + offset];
    if (scene) scene.imageAssetId = img.assetId;
  });
  return {
    v: 1,
    recipe: "motion_graphics",
    hook: clip(scenes[0]?.headline ?? opts.title, 140),
    cta: clip(cta || opts.brandName, 100),
    scenes,
    captions: false,
    durationMs: Math.max(
      3_000,
      scenes.reduce((n, s) => n + (s.durationMs ?? 0), 0),
    ),
    heroAssetId: images[0]?.assetId ?? null,
  };
}
