/**
 * `brand.skill_draft` ("AI ile çıkar" under Marka Kiti → Skill'ler): drafts one brand skill —
 * a Markdown instruction document like Wecra's `mtm` / `partner` skills (format sizes, pixel
 * layout, typography, colour use, tone, do / don't) — from what Studio knows about the brand:
 * the kit (palette, fonts, notes, sample posts with their captions), the current profile
 * (DESIGN / VOICE / facts), approved posts and the skills it already has.
 *
 * Same model routing as `brand.analyze` (Claude, or Gemini when chosen / Claude is limited).
 * The draft is stored as a new skill, switched off (origin `ai_draft`), for the owner to read,
 * edit and switch on.
 */
import {
  ApiError,
  type BrandKit,
  type BrandProfile,
  type BrandSkill,
  BrandSkillDraftPayload,
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  uniqueSkillName,
} from "@studio/contract";
import { z } from "zod";
import type { AgentDeps } from "../agent.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import { describeClaudeError, isClaudeError } from "../claude/errors.ts";
import { limitParkMessage } from "../claude/limit-text.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import { describeGeminiError, isGeminiError } from "../gemini/errors.ts";
import { callStructuredAi, resolveStructuredRoute } from "../gemini/json-call.ts";
import { imageBlock, prepareModelImage } from "../media.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";

/** Sample posts shown to the model (compositions: a small edge is enough). */
const MAX_SAMPLE_IMAGES = 6;
const SAMPLE_MAX_EDGE = 768;

const DraftOutput = z.object({
  name: z.string().default("marka-skill"),
  description: z.string().default(""),
  body: z.string().min(1),
});

const DRAFT_JSON_SCHEMA = {
  type: "object",
  required: ["name", "description", "body"],
  properties: {
    name: {
      type: "string",
      description: "Kısa kebab-case ad (küçük harf, rakam, tire): ör. tek-gorsel-post, carousel.",
    },
    description: {
      type: "string",
      description: "Tek cümle: skill ne zaman kullanılır (en fazla 200 karakter).",
    },
    body: {
      type: "string",
      description:
        "Markdown skill metni: başlıklar, ölçüler (px), yerleşim, tipografi, renk, ton, yapılacaklar / yapılmayacaklar.",
    },
  },
} as const;

const SYSTEM = `Sen Studio'nun kıdemli sanat yönetmeni ve Türkçe metin yazarısın. Görevin bir markanın sosyal medya postları için bir "skill" yazmak: tasarım motorunun ve sohbet ajanının o marka için post üretirken birebir uyacağı Markdown talimat belgesi (Wecra'daki mtm / partner skill'leri gibi).

Skill şu bölümleri içerir (gerekmeyeni atla, uydurma):
1. Amaç: skill ne zaman kullanılır (hangi post türü, hangi platform).
2. Formatlar ve ölçüler: tuval boyutu (ör. 1080×1350), kenar boşlukları, ızgara; başlık, gövde, görsel, logo ve diğer öğelerin piksel konumları ve boyutları (1080 px genişliğe göre; örnek postlardan ölçtüğün değerler tahminse "yaklaşık" de).
3. Tipografi: font aileleri ve ağırlıkları, başlık / gövde boyutları, satır aralığı, büyük harf kullanımı.
4. Renk: hangi renk nerede, oranlar, zemin / metin eşleşmeleri (yalnızca verilen palet ve profil renkleri).
5. Ton ve metin: hitap, cümle uzunluğu, başlık kalıpları, açıklama (caption) ve hashtag kuralları, çağrı (CTA).
6. Yapılacaklar / Yapılmayacaklar: kısa maddeler.

Kurallar:
- Yalnızca verilen kaynaklardaki bilgileri kullan; ürün özelliği, rakam, iddia, renk ya da font uydurma.
- Mevcut skill'lerin tekrarını yazma; kullanıcının odak isteği varsa yalnızca ona odaklan.
- Net, uygulanabilir ve kısa yaz (en fazla ~6000 karakter); Türkçe.`;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[… kısaltıldı]`;
}

async function readKit(deps: AgentDeps, brandId: string, signal: AbortSignal) {
  try {
    return await deps.api.client.brandKits.get(brandId, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function readProfile(deps: AgentDeps, brandId: string, signal: AbortSignal) {
  try {
    return await deps.api.client.brandProfiles.current(brandId, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function readSkills(deps: AgentDeps, brandId: string, signal: AbortSignal) {
  try {
    return (await deps.api.client.brandSkills.list(brandId, { limit: 100 }, { signal })).items;
  } catch (error) {
    if (signal.aborted) throw error;
    return [] as BrandSkill[];
  }
}

/** The user-message text for the model (kit, profile, posts, existing skills, focus). */
export function skillDraftPrompt(input: {
  brandName: string;
  language: string;
  focus: string | undefined;
  kit: BrandKit | null;
  profile: BrandProfile | null;
  approved: string[];
  skills: readonly BrandSkill[];
  samplesShown: number;
}): string {
  const { kit, profile } = input;
  const palette = (kit?.palette ?? [])
    .map((c) => `- ${c.name}: ${c.hex.toUpperCase()}${c.use ? ` (${c.use})` : ""}`)
    .join("\n");
  const fonts = (kit?.fonts ?? [])
    .map(
      (f) =>
        `- ${f.family} (${f.role === "display" ? "başlık" : f.role === "text" ? "gövde" : "başlık ve gövde"})${
          f.source === "system"
            ? `, Mac'te yüklü${f.styles.length ? `: ${f.styles.map((s) => `${s.name} ${s.weight}`).join(", ")}` : ""}`
            : ", font dosyası"
        }`,
    )
    .join("\n");
  const captions = (kit?.samples ?? [])
    .map((s, i) => (s.caption?.trim() ? `${i + 1}. ${clip(s.caption.trim(), 400)}` : ""))
    .filter(Boolean)
    .join("\n");
  const tokens = profile ? { ...profile.tokens } : null;
  if (tokens) delete tokens.fileAssets;
  return [
    `Marka: ${input.brandName} (dil: ${input.language})`,
    input.focus
      ? `<odak>\nSkill şunu kapsamalı: ${input.focus}\n</odak>`
      : "<odak>\nOdak verilmedi: markanın en sık kullandığı post formatı için genel bir skill yaz.\n</odak>",
    kit?.notes?.trim()
      ? `<kullanici_notlari>\n${clip(kit.notes.trim(), 3000)}\n</kullanici_notlari>`
      : "",
    palette ? `<palet>\n${palette}\n</palet>` : "",
    fonts ? `<fontlar>\n${fonts}\n</fontlar>` : "",
    profile
      ? `<marka_profili surum="${profile.version}">\n## DESIGN\n${clip(profile.designRules, 5000)}\n\n## VOICE\n${clip(profile.voice, 3000)}\n\n## TOKENS\n${clip(JSON.stringify(tokens), 4000)}\n</marka_profili>`
      : "<marka_profili>(onaylı profil yok)</marka_profili>",
    captions ? `<ornek_post_aciklamalari>\n${captions}\n</ornek_post_aciklamalari>` : "",
    input.approved.length > 0
      ? `<onayli_postlar>\n${input.approved.join("\n")}\n</onayli_postlar>`
      : "",
    input.skills.length > 0
      ? `<mevcut_skiller>\nBunları tekrar etme:\n${input.skills.map((s) => `- ${s.name}: ${s.description || clip(s.body.replace(/\s+/g, " "), 160)}`).join("\n")}\n</mevcut_skiller>`
      : "",
    input.samplesShown > 0
      ? `Ekte ${input.samplesShown} örnek post görseli var; ölçü ve yerleşimi onlardan çıkar.`
      : "Örnek post görseli yok; ölçüleri profil ve kurallardan çıkar, tahmin ettiklerini belirt.",
    "JSON şemasına uyan skill'i üret.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createBrandSkillDraftHandler(deps: AgentDeps) {
  return defineHandler({
    payload: BrandSkillDraftPayload,
    run: async (payload, ctx: JobContext) => {
      const brandId = ctx.job.brandId;
      if (!brandId) throw new Error("brand.skill_draft işi için brandId gerekli.");
      const signal = ctx.signal;
      const init = { signal };
      try {
        ctx.progress(0.05, "Marka kiti ve profili okunuyor");
        const [brand, kit, profile, skills] = await Promise.all([
          deps.api.client.brands.get(brandId, init),
          readKit(deps, brandId, signal),
          readProfile(deps, brandId, signal),
          readSkills(deps, brandId, signal),
        ]);

        const approved = (
          await deps.api.client.contents
            .list({ brandId, limit: 30 }, init)
            .catch(() => ({ items: [] }))
        ).items
          .filter((c) => ["approved", "scheduled", "published"].includes(c.status))
          .slice(0, 8)
          .map((c) => `- [${c.type}] ${c.title}: ${clip(c.caption.replace(/\s+/g, " "), 220)}`);

        ctx.progress(0.2, "Örnek postlar hazırlanıyor");
        const visuals: ClaudeContentBlock[] = [];
        let samplesShown = 0;
        for (const [i, sample] of (kit?.samples ?? []).slice(0, MAX_SAMPLE_IMAGES).entries()) {
          signal.throwIfAborted();
          try {
            const { bytes } = await deps.api.downloadAsset(sample.assetId, {
              maxBytes: deps.settings.imageMaxBytes,
              signal,
            });
            const prepared = await prepareModelImage(bytes, {
              maxEdge: Math.min(deps.settings.imageMaxEdge, SAMPLE_MAX_EDGE),
            });
            if (!prepared) continue;
            visuals.push({ type: "text", text: `Örnek post ${i + 1}:` }, imageBlock(prepared));
            samplesShown++;
          } catch (error) {
            if (signal.aborted) throw error;
            // An unreadable sample is skipped.
          }
        }

        const route = resolveStructuredRoute({
          requestedModel: payload.model,
          requestedEffort: payload.effort,
          defaultEffort: deps.settings.effortDesign,
          defaultGeminiAlias: "gemini-flash",
          settings: deps.settings,
          claudeHealth: deps.health(),
          limitChoice: deps.aiPolicy?.limitChoice(),
        });
        const prompt = skillDraftPrompt({
          brandName: brand.name,
          language: brand.defaultLanguage,
          focus: payload.focus,
          kit,
          profile,
          approved,
          skills,
          samplesShown,
        });

        ctx.progress(0.45, "Skill taslağı yazılıyor");
        const result = await callStructuredAi({
          label: `skill-draft-${brandId.slice(-8)}`,
          system: SYSTEM,
          content: [{ type: "text", text: prompt }, ...visuals],
          schema: DRAFT_JSON_SCHEMA,
          route,
          gate: deps.gate,
          settings: deps.settings,
          timeoutMs: deps.settings.claudeTimeoutMs,
          signal,
          ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
          onGeminiUsage: geminiUsageSink(deps.aiUsage, { kind: "brand", jobId: ctx.jobId }),
          hooks: { onPark: (info) => ctx.progress(0.5, limitParkMessage(info)) },
        });
        const draft = DraftOutput.parse(result.output);

        ctx.progress(0.9, "Skill kaydediliyor");
        const name = uniqueSkillName(
          payload.name ?? draft.name,
          skills.map((s) => s.name),
        );
        const created = await deps.api.client.brandSkills.create(
          brandId,
          {
            name,
            description: draft.description
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, MAX_SKILL_DESCRIPTION_CHARS),
            body: draft.body.trim().slice(0, MAX_SKILL_BODY_CHARS),
            enabled: false,
            origin: "ai_draft",
            note: `AI taslağı${payload.focus ? `: ${payload.focus}` : ""}`.slice(0, 500),
            jobId: ctx.jobId,
          },
          init,
        );

        ctx.progress(1, "Tamamlandı");
        return {
          skillId: created.id,
          name: created.name,
          version: created.version,
          enabled: created.enabled,
          provider: result.provider,
          model: result.model,
          samplesUsed: samplesShown,
          usedProfile: profile ? profile.version : null,
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (isClaudeError(error)) {
          const msg = describeClaudeError(error);
          if (error.code === "transient" || error.code === "timeout") throw new RetryableError(msg);
          throw new Error(msg);
        }
        if (isGeminiError(error)) {
          const msg = describeGeminiError(error);
          if (error.code === "transient" || error.code === "timeout") throw new RetryableError(msg);
          throw new Error(msg);
        }
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      }
    },
  });
}
