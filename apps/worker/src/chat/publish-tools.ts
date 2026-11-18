/**
 * The chat agent's publish-details tool (N13): `set_publish_details` writes a post's first comment
 * and its slides' alternative texts. Location, collaborators, people tags and the Reels cover stay
 * with the owner (the post detail's "Yayın ayrıntıları"): they name other accounts and places.
 * Saving details does not revoke the approval; a post that is publishing or published refuses.
 */
import {
  type Content,
  PUBLISH_DETAIL_LIMITS,
  type PublishDetails,
  publishDetailIssues,
  selectPublishKind,
} from "@studio/contract";
import { z } from "zod";
import type { StudioApi } from "../api.ts";
import type { StudioToolDefinition } from "./tools.ts";

export const PUBLISH_TOOL_NAMES = ["set_publish_details"] as const;

export const PUBLISH_TOOLS: readonly StudioToolDefinition[] = [
  {
    name: "set_publish_details",
    description:
      "Bir postun yayın ayrıntılarını yazar: ilk yorum (Instagram ve Facebook; yayından hemen sonra postun altına yorum olarak eklenir, ör. hashtag'ler ya da bağlantı bilgisi) ve karelerin alternatif metinleri (görme engelliler için görselin kısa betimi; Instagram görselleri, Facebook fotoğrafları, LinkedIn görselleri). Verilmeyen alan olduğu gibi kalır; boş metin o alanı temizler. Onayı geri almaz. Konum, ortak hesap, kişi etiketi ve Reels kapağı kullanıcıya aittir; bunları yazma.",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "Postun id'si." },
        firstComment: {
          type: "string",
          description: `İlk yorum (Instagram'da en fazla ${PUBLISH_DETAIL_LIMITS.firstComment.instagram} karakter ve 30 hashtag). Boş: temizle.`,
        },
        altTexts: {
          type: "array",
          description: `Kare sırasıyla alternatif metinler (her biri en fazla ${PUBLISH_DETAIL_LIMITS.altText} karakter; görselde ne olduğunu ve üzerindeki yazıyı kısaca anlat). Boş metin o kareyi temizler.`,
          items: { type: "string" },
        },
      },
    },
  },
];

const Input = z.object({
  contentId: z.string().trim().min(1),
  firstComment: z.string().max(PUBLISH_DETAIL_LIMITS.firstComment.facebook).optional(),
  altTexts: z
    .array(z.string().transform((s) => s.trim().slice(0, PUBLISH_DETAIL_LIMITS.altText)))
    .max(PUBLISH_DETAIL_LIMITS.slides)
    .optional(),
});

export interface PublishToolEnv {
  api: StudioApi;
  signal: AbortSignal;
}

/** Merge into the post's details; alt texts written here are marked automatic. */
export async function setPublishDetailsTool(
  env: PublishToolEnv,
  raw: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; summary: string }> {
  const input = Input.parse(raw);
  const init = { signal: env.signal };
  const content: Content = await env.api.client.contents.get(input.contentId, init);
  const current: PublishDetails = content.publishDetails ?? {};
  const slideCount = content.currentVersion
    ? (await env.api.client.contents.versions.get(content.id, content.currentVersion.version, init))
        .slides.length
    : 1;
  const next: PublishDetails = { ...current };
  if (input.firstComment !== undefined) next.firstComment = input.firstComment.trim() || null;
  if (input.altTexts !== undefined) {
    const given = input.altTexts.slice(0, slideCount);
    const length = Math.max(given.length, Math.min(current.altTexts?.length ?? 0, slideCount));
    next.altTexts = Array.from({ length }, (_, i) =>
      i < given.length ? given[i] || null : (current.altTexts?.[i] ?? null),
    );
    next.altTextSources = Array.from({ length }, (_, i) =>
      i < given.length ? (given[i] ? "auto" : null) : (current.altTextSources?.[i] ?? null),
    );
  }
  const saved = await env.api.client.contents.setPublishDetails(input.contentId, next, init);
  const details = saved.publishDetails ?? {};
  const notes = saved.targetPlatforms.flatMap((platform) => {
    const kind = selectPublishKind(platform, saved.type, slideCount);
    const issues = publishDetailIssues(details, kind, slideCount);
    return [...issues.errors, ...issues.warnings].map((i) => i.message);
  });
  const parts = [
    details.firstComment ? "ilk yorum" : null,
    details.altTexts?.some(Boolean)
      ? `${details.altTexts.filter(Boolean).length} alternatif metin`
      : null,
  ].filter(Boolean);
  return {
    data: {
      contentId: saved.id,
      firstComment: details.firstComment ?? null,
      altTexts: details.altTexts ?? [],
      ...(notes.length ? { notes: [...new Set(notes)] } : {}),
    },
    summary: parts.length ? `${parts.join(" ve ")} kaydedildi` : "yayın ayrıntıları temizlendi",
  };
}
