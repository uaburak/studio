/**
 * `brand.analyze` handler (A5 / F1-4 & Faz 6):
 * - Inspects brand metadata, existing approved profile, uploaded brand assets (`logo`, `font`,
 *   `document`, `image` up to 8 visual references), `samplePosts` engagement metrics, and
 *   approved/published content + manual edit history (`PLAN.md` §6 feedback loop),
 * - Calls Gemini (`gemini-flash` / `gemini-pro`) or Claude (`gate.call`) to synthesize
 *   valid `@studio/design-kit` `BrandTokens` (`brand.json`), Turkish `designRules` (`DESIGN.md`),
 *   and Turkish `voice` (`VOICE.md`),
 * - Stores a new draft `BrandProfile` and optionally approves it when `autoApprove: true`.
 */
import {
  ApiError,
  type Asset,
  type Brand,
  BrandAnalyzePayload,
  type BrandProfile,
} from "@studio/contract";
import { parseBrandTokens } from "@studio/design-kit/brand";
import { z } from "zod";
import type { AgentDeps } from "../agent.ts";
import { describeClaudeError, isClaudeError } from "../claude/errors.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import { describeGeminiError, isGeminiError } from "../gemini/errors.ts";
import { callStructuredAi, resolveStructuredRoute } from "../gemini/json-call.ts";
import { fileAssetMap, NEUTRAL_TOKENS } from "../generate/brand.ts";
import { extensionForMime, imageBlock, prepareModelImage } from "../media.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";

const MAX_VISUAL_REFS = 8;

const BrandAnalysisModelOutput = z.object({
  colors: z
    .record(
      z.string(),
      z.union([
        z.string(),
        z.object({
          value: z.string(),
          use: z.string().optional(),
        }),
      ]),
    )
    .default({}),
  displayFontFamily: z.string().default("Helvetica Neue"),
  textFontFamily: z.string().default("Helvetica Neue"),
  marginPx: z.number().min(24).max(160).default(72),
  designRules: z.string().min(1),
  voice: z.string().min(1),
  allowedNumbers: z.array(z.union([z.string(), z.number()])).default([]),
  statements: z.array(z.string()).default([]),
  forbiddenClaims: z.array(z.string()).default([]),
  provisional: z.boolean().default(false),
});

const BRAND_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  required: [
    "colors",
    "displayFontFamily",
    "textFontFamily",
    "marginPx",
    "designRules",
    "voice",
    "allowedNumbers",
    "statements",
    "forbiddenClaims",
    "provisional",
  ],
  properties: {
    colors: {
      type: "object",
      description:
        "Marka renk belirteçleri (kebab-case anahtarlar: paper, mist, ink, graphite, stone, accent, accent-deep vb. -> { value: '#RRGGBB', use: '...' }).",
      additionalProperties: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "string", description: "#RRGGBB hex kodu" },
          use: { type: "string", description: "Kullanım amacı" },
        },
      },
    },
    displayFontFamily: {
      type: "string",
      description: "Başlık yazı tipi ailesi (ör. Montserrat, Archivo, Helvetica Neue).",
    },
    textFontFamily: { type: "string", description: "Gövde yazı tipi ailesi." },
    marginPx: { type: "number", description: "1080px tuvalde kenar boşluğu (tipik 64 veya 72)." },
    designRules: {
      type: "string",
      description:
        "Zengin Türkçe DESIGN.md metni: ızgara/kompozisyon kuralları, tipografik hiyerarşi, renk kullanımı, yapılacaklar/yapılmayacaklar ve geri bildirim kuralları.",
    },
    voice: {
      type: "string",
      description:
        "Zengin Türkçe VOICE.md metni: marka ses tonu, cümle yapısı, kelime dağarcığı, hashtag kuralları, çağrı (CTA) kalıpları ve örnek cümleler.",
    },
    allowedNumbers: {
      type: "array",
      items: { type: "string" },
      description: "Kaynaklarda doğrulanmış izinli rakamlar/değerler (uydurma yok).",
    },
    statements: {
      type: "array",
      items: { type: "string" },
      description: "Kaynaklardan doğrulanmış gerçek marka/ürün bilgileri.",
    },
    forbiddenClaims: {
      type: "array",
      items: { type: "string" },
      description: "Kaçınılması gereken abartılı ya da doğrulanmamış iddialar.",
    },
    provisional: {
      type: "boolean",
      description: "Yalnızca sınırlı örneklerden çıkarıldıysa true, tam marka kitiyse false.",
    },
  },
} as const;

function sanitizeTokenKey(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!cleaned || !/^[a-z][a-z0-9-]{0,47}$/.test(cleaned)) return null;
  return cleaned;
}

function sanitizeHexColor(raw: string): string | null {
  const m = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(raw.trim());
  return m ? m[0].toUpperCase() : null;
}

function sanitizeFontFamily(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9 -]/g, "")
    .trim()
    .slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(cleaned) ? cleaned : fallback;
}

function safeFileSlug(name: string, fallback: string): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || fallback;
}

/**
 * Build guaranteed-valid `@studio/design-kit` `BrandTokens` (`brand.json`) combining
 * AI-extracted palette/typography/facts with uploaded brand logos, fonts, and existing mappings.
 */
export function buildValidatedBrandTokens(input: {
  brand: Brand;
  existingProfile: BrandProfile | null;
  uploadedAssets: readonly Asset[];
  analyzed: z.infer<typeof BrandAnalysisModelOutput>;
}): Record<string, unknown> {
  const existingRaw = input.existingProfile?.tokens ?? {};
  const fileAssets: Record<string, string> = { ...fileAssetMap(existingRaw) };

  const fontFiles: string[] = [];
  const logos: Record<string, Record<string, unknown>> = {};
  const brandImageAssets: Record<string, Record<string, unknown>> = {};

  for (const [i, asset] of input.uploadedAssets.entries()) {
    if (asset.source === "generated") continue;
    if (asset.kind === "font") {
      const extMatch = /\.(woff2|woff|ttf|otf)$/i.exec(asset.originalFilename ?? "");
      const ext = extMatch ? extMatch[0].toLowerCase() : ".woff2";
      const rel = `fonts/${safeFileSlug(asset.originalFilename ?? "", `font-${i + 1}`)}${ext}`;
      fileAssets[rel] = asset.id;
      fontFiles.push(rel);
    } else if (asset.kind === "logo") {
      const ext = extensionForMime(asset.mimeType) || ".png";
      const key =
        sanitizeTokenKey(safeFileSlug(asset.originalFilename ?? "", `logo-${i + 1}`)) ??
        `logo-${i + 1}`;
      const rel = `logos/${key}${ext}`;
      fileAssets[rel] = asset.id;
      logos[key] = {
        path: rel,
        ...(asset.width && asset.height
          ? {
              intrinsic: [asset.width, asset.height],
              aspect: Number((asset.width / asset.height).toFixed(3)),
            }
          : {}),
        on: /white|dark|beyaz/i.test(asset.originalFilename ?? "") ? "dark" : "any",
      };
    } else if (asset.kind === "image" && Object.keys(brandImageAssets).length < 12) {
      const ext = extensionForMime(asset.mimeType) || ".jpg";
      const key = safeFileSlug(asset.originalFilename ?? "", `asset-${i + 1}`);
      const rel = `assets/${key}${ext}`;
      fileAssets[rel] = asset.id;
      brandImageAssets[key] = {
        path: rel,
        ...(asset.originalFilename ? { note: asset.originalFilename } : {}),
      };
    }
  }

  // Merge AI colors over neutral baseline so required usage roles (`paper`, `ink`, `accent`, etc.) always exist
  const colorMap: Record<string, { value: string; use?: string }> = {};
  for (const [k, v] of Object.entries(NEUTRAL_TOKENS.color)) {
    colorMap[k] = { value: v.value, use: v.use };
  }
  for (const [rawKey, rawVal] of Object.entries(input.analyzed.colors)) {
    const key = sanitizeTokenKey(rawKey);
    if (!key) continue;
    const hex = sanitizeHexColor(typeof rawVal === "string" ? rawVal : rawVal.value);
    if (!hex) continue;
    const use = typeof rawVal === "object" && rawVal.use ? rawVal.use : undefined;
    colorMap[key] = use ? { value: hex, use } : { value: hex };
  }

  const displayFamily = sanitizeFontFamily(
    input.analyzed.displayFontFamily,
    fontFiles.length > 0 ? "Brand Display" : "Helvetica Neue",
  );
  const textFamily = sanitizeFontFamily(
    input.analyzed.textFontFamily,
    fontFiles.length > 0 ? "Brand Text" : "Helvetica Neue",
  );

  const candidateTokens: Record<string, unknown> = {
    id: sanitizeTokenKey(input.brand.slug) ?? "brand",
    name: input.brand.name.slice(0, 120),
    version: String((input.existingProfile?.version ?? 0) + 1),
    status: input.analyzed.provisional ? "provisional" : "approved",
    color: colorMap,
    font: {
      display: {
        family: displayFamily,
        files: fontFiles.slice(0, 8),
        fallback: "sans-serif",
        default: { weight: 800, leading: 1.0 },
      },
      text: {
        family: textFamily,
        files: fontFiles.slice(0, 8),
        fallback: "sans-serif",
        default: { weight: 400, leading: 1.38 },
      },
    },
    type: { ...NEUTRAL_TOKENS.type },
    space: {
      ...NEUTRAL_TOKENS.space,
      margin: Math.round(Math.min(140, Math.max(40, input.analyzed.marginPx))),
    },
    radius: { ...NEUTRAL_TOKENS.radius },
    rule: { width: 56, thickness: 6, color: "accent" },
    logos,
    assets: brandImageAssets,
    usage: {
      background: colorMap.paper ? "paper" : Object.keys(colorMap)[0],
      text: colorMap.ink ? "ink" : Object.keys(colorMap)[0],
      accent: colorMap.accent ? "accent" : colorMap.primary ? "primary" : Object.keys(colorMap)[0],
      muted: colorMap.stone ? "stone" : "ink",
      slotFill: colorMap.mist ? "mist" : "paper",
      slotInk: colorMap["accent-deep"] ? "accent-deep" : "accent",
      textFont: "text",
      displayFont: "display",
    },
  };

  // Strict validation via `@studio/design-kit` so invalid tokens can never be saved
  const validated = parseBrandTokens(candidateTokens);

  return {
    ...validated,
    status: input.analyzed.provisional ? "provisional" : "approved",
    ...(Object.keys(fileAssets).length > 0 ? { fileAssets } : {}),
    facts: {
      allowedNumbers: [
        ...new Set(input.analyzed.allowedNumbers.map((n) => String(n).trim()).filter(Boolean)),
      ],
      statements: input.analyzed.statements.slice(0, 40),
      forbidden: input.analyzed.forbiddenClaims.slice(0, 30),
    },
  };
}

function extractHtmlHeadlinePreview(html: string): string {
  const hMatch = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  const raw = hMatch?.[1] ?? "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

async function collectApprovedContentFeedback(
  deps: AgentDeps,
  brandId: string,
  signal: AbortSignal,
): Promise<{ block: string; count: number }> {
  const init = { signal };
  const all = (await deps.api.client.contents.list({ brandId, limit: 30 }, init)).items;
  const relevant = all.filter(
    (c) => c.status === "approved" || c.status === "scheduled" || c.status === "published",
  );
  if (relevant.length === 0) return { block: "", count: 0 };

  const lines: string[] = [];
  for (const c of relevant.slice(0, 10)) {
    const versions = (
      await deps.api.client.contents.versions.list(c.id, { limit: 10 }, init).catch(() => ({
        items: [],
      }))
    ).items;
    const sorted = [...versions].sort((a, b) => a.version - b.version);
    const firstGen = sorted.find((v) => v.origin === "generated");
    const manualEdits = sorted.filter((v) => v.origin === "manual_edit" || v.origin === "ai_edit");

    let editSummary = "ilk üretim doğrudan onaylandı";
    if (firstGen && manualEdits.length > 0) {
      const latestEdit = manualEdits.at(-1);
      if (latestEdit) {
        const [vFirst, vLast] = await Promise.all([
          deps.api.client.contents.versions.get(c.id, firstGen.version, init).catch(() => null),
          deps.api.client.contents.versions.get(c.id, latestEdit.version, init).catch(() => null),
        ]);
        const h1Before = vFirst?.slides[0] ? extractHtmlHeadlinePreview(vFirst.slides[0].html) : "";
        const h1After = vLast?.slides[0] ? extractHtmlHeadlinePreview(vLast.slides[0].html) : "";
        const diffs: string[] = [`${manualEdits.length} düzenleme turu`];
        if (h1Before && h1After && h1Before !== h1After) {
          diffs.push(`başlık "${h1Before}" -> "${h1After}" olarak düzenlendi`);
        }
        if (latestEdit.note) {
          diffs.push(`not: ${latestEdit.note.slice(0, 140)}`);
        }
        editSummary = diffs.join("; ");
      }
    }

    lines.push(
      `- [${c.status.toUpperCase()} | ${c.type}] "${c.title}" | açıklama: "${c.caption.slice(0, 220)}" | düzenleme geçmişi: ${editSummary}`,
    );
  }

  return {
    block: lines.join("\n"),
    count: Math.min(relevant.length, 10),
  };
}

export function createBrandAnalyzeHandler(deps: AgentDeps) {
  return defineHandler({
    payload: BrandAnalyzePayload,
    run: async (payload, ctx: JobContext) => {
      const brandId = ctx.job.brandId;
      if (!brandId) {
        throw new Error("brand.analyze işi için brandId gerekli.");
      }
      const signal = ctx.signal;
      const init = { signal };

      try {
        ctx.progress(0.05, "Marka bilgileri ve varlıklar okunuyor");
        const brand = await deps.api.client.brands.get(brandId, init);

        let existingProfile: BrandProfile | null = null;
        try {
          existingProfile = await deps.api.client.brandProfiles.current(brandId, init);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }

        const uploadedAssets = (await deps.api.client.assets.list({ brandId, limit: 100 }, init))
          .items;

        // Collect up to 8 visual references (logos + uploaded brand images + samplePost images)
        ctx.progress(0.18, "Görsel referanslar hazırlanıyor");
        const candidateImageIds: { id: string; label: string }[] = [];
        for (const a of uploadedAssets) {
          if (a.source === "generated") continue;
          if (a.kind === "logo" || a.kind === "image") {
            candidateImageIds.push({
              id: a.id,
              label: `${a.kind}: ${a.originalFilename ?? a.id}`,
            });
          }
        }
        for (const [idx, sp] of payload.samplePosts.entries()) {
          if (sp.imageAssetId && !candidateImageIds.some((c) => c.id === sp.imageAssetId)) {
            candidateImageIds.push({
              id: sp.imageAssetId,
              label: `samplePost #${idx + 1} image`,
            });
          }
        }

        const visualBlocks: ClaudeContentBlock[] = [];
        let visualRefsCount = 0;
        for (const ref of candidateImageIds.slice(0, MAX_VISUAL_REFS)) {
          signal.throwIfAborted();
          try {
            const { bytes } = await deps.api.downloadAsset(ref.id, {
              maxBytes: deps.settings.imageMaxBytes,
              signal,
            });
            const prepared = await prepareModelImage(bytes, {
              maxEdge: deps.settings.imageMaxEdge,
            });
            if (!prepared) continue;
            visualBlocks.push({ type: "text", text: `Görsel referans (${ref.label}):` });
            visualBlocks.push(imageBlock(prepared));
            visualRefsCount++;
          } catch {
            // Skip unreadable asset without failing the whole brand analysis
          }
        }

        let feedbackBlock = "";
        let feedbackCount = 0;
        if (payload.includeApprovedContentFeedback) {
          ctx.progress(0.32, "Onaylı içerikler ve düzenleme geri bildirimleri inceleniyor");
          const fb = await collectApprovedContentFeedback(deps, brandId, signal);
          feedbackBlock = fb.block;
          feedbackCount = fb.count;
        }

        const sortedSamples = [...payload.samplePosts].sort(
          (a, b) =>
            (b.likes ?? 0) + (b.comments ?? 0) * 3 - ((a.likes ?? 0) + (a.comments ?? 0) * 3),
        );
        const samplePostsText = sortedSamples
          .map(
            (s, i) =>
              `${i + 1}. Etkileşim: beğeni=${s.likes ?? "?"}, yorum=${s.comments ?? "?"} | Açıklama: ${s.caption}`,
          )
          .join("\n");

        const docAssets = uploadedAssets
          .filter((a) => a.kind === "document" || a.kind === "font")
          .map((a) => `- ${a.kind}: ${a.originalFilename ?? a.id} (${a.mimeType})`)
          .join("\n");

        const route = resolveStructuredRoute({
          requestedModel: payload.model,
          requestedEffort: payload.effort,
          defaultEffort: deps.settings.effortDesign,
          defaultGeminiAlias: "gemini-flash",
          settings: deps.settings,
          claudeHealth: deps.health(),
        });

        const system = `Sen Studio'nun kıdemli marka stratejisti, sanat yönetmeni ve Türkçe metin yazarısın.
Görevin markanın görsel referanslarını, örnek postlarını, onaylanmış içeriklerini ve kullanıcı düzenleme geçmişini analiz ederek kapsamlı bir marka profili üretmektir:
1. \`colors\`: Markanın gerçek renk sistemi (#RRGGBB hex kodları; kontrast kurallarına uygun açık zemin \`paper\`, ikincil yüzey \`mist\`, koyu metin \`ink\`, gövde \`graphite\`, ikincil metin \`stone\`, ana vurgu \`accent\` ve koyu vurgu \`accent-deep\` dahil).
2. \`designRules\` (DESIGN.md): Türkçe; tipografik hiyerarşi, ızgara ve boşluk disiplini, renk oranları, görsel/logo kullanımı, yapılacaklar ve yapılmayacaklar. Kullanıcının geçmişte yaptığı tekrar eden elle düzeltmeler varsa bunları net tasarım kuralına dönüştür.
3. \`voice\` (VOICE.md): Türkçe; ses tonu, cümle uzunluğu, hitap biçimi, yüksek etkileşim alan açıklama kalıpları, hashtag ve CTA kuralları.
4. \`allowedNumbers\`, \`statements\`, \`forbiddenClaims\`: Yalnızca kaynaklarda gerçekten geçen doğrulanmış sayıları ve gerçekleri yaz; asla ürün özelliği ya da rakam uydurma.`;

        const promptSections = [
          `Marka: ${brand.name} (slug: ${brand.slug}, dil: ${brand.defaultLanguage})`,
          payload.notes ? `<kullanici_notlari>\n${payload.notes}\n</kullanici_notlari>` : "",
          docAssets ? `<yuklu_dosyalar>\n${docAssets}\n</yuklu_dosyalar>` : "",
          existingProfile
            ? `<mevcut_profil surum="${existingProfile.version}">\nVOICE:\n${existingProfile.voice.slice(0, 2500)}\n\nDESIGN:\n${existingProfile.designRules.slice(0, 2500)}\n\nFACTS:\n${JSON.stringify(existingProfile.tokens.facts ?? null)}\n</mevcut_profil>`
            : "",
          samplePostsText
            ? `<ornek_postlar_etkilesim_sirali>\n${samplePostsText}\n</ornek_postlar_etkilesim_sirali>`
            : "",
          feedbackBlock
            ? `<onayli_icerik_ve_duzenleme_gecmisi>\n${feedbackBlock}\n</onayli_icerik_ve_duzenleme_gecmisi>`
            : "",
          "Yukarıdaki tüm kanıtları ve ekli görselleri inceleyerek JSON şemasına tam uyan marka profilini üret.",
        ]
          .filter(Boolean)
          .join("\n\n");

        ctx.progress(0.5, "Marka kimliği ve ses tonu sentezleniyor");
        const aiResult = await callStructuredAi({
          label: `brand-analyze-${brandId.slice(-8)}`,
          system,
          content: [{ type: "text", text: promptSections }, ...visualBlocks],
          schema: BRAND_ANALYSIS_JSON_SCHEMA,
          route,
          gate: deps.gate,
          settings: deps.settings,
          timeoutMs: deps.settings.claudeTimeoutMs,
          signal,
          ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
        });

        const parsed = BrandAnalysisModelOutput.parse(aiResult.output);
        const tokens = buildValidatedBrandTokens({
          brand,
          existingProfile,
          uploadedAssets,
          analyzed: parsed,
        });

        ctx.progress(0.85, "Marka profili kaydediliyor");
        let saved = await deps.api.client.brandProfiles.create(
          brandId,
          {
            tokens,
            designRules: parsed.designRules.slice(0, 190_000),
            voice: parsed.voice.slice(0, 190_000),
          },
          init,
        );

        if (payload.autoApprove) {
          ctx.progress(0.94, "Marka profili onaylanıyor");
          saved = await deps.api.client.brandProfiles.approve(brandId, saved.version, init);
        }

        ctx.progress(1, "Tamamlandı");
        return {
          profileId: saved.id,
          version: saved.version,
          status: saved.status,
          provider: aiResult.provider,
          model: aiResult.model,
          visualReferencesUsed: visualRefsCount,
          feedbackItemsAnalyzed: feedbackCount,
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
