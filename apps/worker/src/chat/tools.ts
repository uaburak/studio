/**
 * Shared, provider-agnostic Studio chat tools.
 *
 * Used identically by:
 * - Direct Gemini API (`functionDeclarations` -> `StudioToolExecutor.execute`),
 * - Claude Code CLI (via local MCP bridge `mcp__studio__*`),
 * - Gemini CLI (via local MCP bridge).
 *
 * Every call emits a `tool_step` part (`running` -> `done` / `error`) on the
 * assistant message. Destructive / publishing actions emit a `consent` card
 * (`state: "pending"`) and poll `workerTurns.message(runId)` until the owner
 * allows or denies it, or the 5-minute consent window expires. `ask_user` holds
 * the call the same way until the owner answers its question (10 minutes).
 * `view_alias`, `list_aliases` (thumbnails) and `view_post` return pictures
 * (`images`), which the MCP server sends as image content blocks (A5).
 */
import path from "node:path";
import {
  type AgentEffort,
  ApiError,
  type ApprovalTarget,
  type Asset,
  AssetOrientation,
  aiCallCostUsd,
  type BrandProduct,
  type Content,
  type ContentGeneratePayload,
  ContentStatus,
  ContentType,
  checkPlanPeriod,
  computeContentHash,
  ESTIMATE_CONFIRM_THRESHOLD,
  engineNotReadyError,
  GenerationEngine,
  isSvgSlideHtml,
  isTerminalJobStatus,
  type Job,
  MAX_GENERATION_VARIANTS,
  type Plan,
  type PlanningContext,
  type PlanProposalPut,
  Platform,
  ProductPosition,
  planItemSimilarities,
  productPhotoAngle,
  type SlotImageRequest,
  slugify,
} from "@studio/contract";
import { readCanvas } from "@studio/design-kit/canvas";
import { z } from "zod";
import type { StudioApi } from "../api.ts";
import { abortableSleep } from "../claude/gate.ts";
import type { TurnWaits } from "../claude/turn-waits.ts";
import { assessPhotoQuality, type PhotoQuality } from "../image/photo-quality.ts";
import { type ProductPhotoRef, selectProductReferences } from "../image/references.ts";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";
import { prepareModelImage } from "../media.ts";
import {
  CANVAS_TOOLS,
  type CanvasToolEnv,
  canvasEditTool,
  canvasOutlineTool,
  canvasScreenshotTool,
} from "./canvas-tools.ts";
import { estimateLine } from "./estimate-text.ts";
import { historyBlock, similarityReport, specialDaysBlock } from "./planning.ts";
import { profileFacts } from "./prompt.ts";
import { PUBLISH_TOOLS, setPublishDetailsTool } from "./publish-tools.ts";
import {
  CHAT_CONTENT_TYPES,
  CHAT_PLATFORMS,
  convertPlan,
  type KnownAlias,
  toQuestionPart,
} from "./schema.ts";
import type { Skill } from "./skills.ts";
import {
  generateFromTemplateTool,
  listTemplatesTool,
  repurposeContentTool,
  TEMPLATE_TOOLS,
  type TemplateToolEnv,
} from "./template-tools.ts";
import { type LedgerEntry, ToolCallLedger, toolCallKey } from "./tool-ledger.ts";
import { conversationWorkDir } from "./workdir.ts";
import { RunClosedError, type TurnWriter } from "./writer.ts";

export interface ToolJsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: readonly string[];
  items?: ToolJsonSchema;
  enum?: readonly string[];
}

export interface StudioToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
}

export const DEFAULT_CONSENT_POLL_MS = 400;
export const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60_000;
/** `ask_user` waits this long for the owner's answer, then the turn ends gracefully. */
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_JOB_POLL_MS = 3_000;

export const STUDIO_TOOLS: readonly StudioToolDefinition[] = [
  {
    name: "list_brands",
    description:
      "Stüdyodaki aktif markaları listeler (id, ad, slug, varsayılan dil). Konuşmanın markası yoksa veya marka seçmek gerektiğinde kullan.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_brand_profile",
    description:
      "Bir markanın ayrıntılarını ve onaylı marka profilini (ses tonu, tasarım kuralları, gerçekler/facts) okur.",
    inputSchema: {
      type: "object",
      properties: {
        brandId: {
          type: "string",
          description: "Marka id'si (boş bırakılırsa konuşmanın markası kullanılır).",
        },
      },
    },
  },
  {
    name: "set_conversation_brand",
    description:
      "Henüz markası olmayan bir konuşmaya marka bağlar (yalnızca konuşmanın markası boşken bir kez çağrılabilir).",
    inputSchema: {
      type: "object",
      required: ["brandId"],
      properties: {
        brandId: {
          type: "string",
          description: "Bağlanacak markanın id'si ya da slug'ı.",
        },
      },
    },
  },
  {
    name: "propose_plan",
    description:
      "Belirli bir dönem (hafta/ay) için içerik planı önerir ya da açık planı günceller. Sohbete etkileşimli plan kartı ekler.",
    inputSchema: {
      type: "object",
      required: ["title", "periodStart", "periodEnd", "summary", "items"],
      properties: {
        brandId: {
          type: "string",
          description: "Konuşmanın henüz markası yoksa seçilen markanın id'si.",
        },
        title: {
          type: "string",
          description: "Plan başlığı, ör. 'MTM Agro — Kasım 2026'.",
        },
        periodStart: {
          type: "string",
          description: "Başlangıç tarihi (YYYY-MM-DD).",
        },
        periodEnd: {
          type: "string",
          description: "Bitiş tarihi (YYYY-MM-DD).",
        },
        summary: {
          type: "string",
          description: "Planın stratejik özeti.",
        },
        items: {
          type: "array",
          description: "Plandaki post kalemleri (en az 1, en çok 60).",
          items: {
            type: "object",
            required: ["platforms", "contentType", "title", "brief"],
            properties: {
              date: {
                type: "string",
                description: "Planlanan yayın günü (YYYY-MM-DD).",
              },
              platforms: {
                type: "array",
                items: { type: "string", enum: CHAT_PLATFORMS },
                description: "Hedef platformlar (instagram, facebook, linkedin).",
              },
              contentType: {
                type: "string",
                enum: CHAT_CONTENT_TYPES,
                description: "İçerik türü (post, carousel, story).",
              },
              title: { type: "string", description: "Kısa Türkçe başlık." },
              brief: {
                type: "string",
                description: "Postun ana mesajı, metin yönü ve varsa çağrı (2-4 cümle).",
              },
              pillar: {
                type: "string",
                description: "İçerik sütunu (ör. ürün tanıtımı, uygulama ipuçları).",
              },
              hook: {
                type: "string",
                description:
                  "Postun açılış cümlesi (kanca, tek satır); geçmiş postların kancalarından farklı.",
              },
              imageSlot: {
                type: "string",
                enum: ["none", "user_upload", "ai_generate"],
                description: "Görsel yuvası beklentisi.",
              },
              imageBrief: {
                type: "string",
                description: "Görselin ne göstermesi gerektiği (none ise boş).",
              },
              imageAliases: {
                type: "array",
                items: { type: "string" },
                description: "Kullanıcının istediği @takma adlar (@ olmadan).",
              },
              templateId: {
                type: "string",
                description:
                  "Bu post markanın bir şablonuyla yapılacaksa şablon id'si (list_templates; aynı tür). Yerleşim aynen kalır, AI alanları brief'ten doldurur.",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "get_planning_context",
    description:
      "Bir dönemi planlamadan önce: o dönemin Türkiye özel günlerini (markanın sektör etiketleriyle; önem, hazırlık süresi, ton) ve markanın son üç ayının özetini (postlar, sütunlar, kancalar, reddedilen ve silinen konular) getirir.",
    inputSchema: {
      type: "object",
      required: ["periodStart", "periodEnd"],
      properties: {
        periodStart: { type: "string", description: "Dönem başlangıcı (YYYY-MM-DD)." },
        periodEnd: { type: "string", description: "Dönem sonu (YYYY-MM-DD)." },
        brandId: {
          type: "string",
          description: "Marka id'si (boş bırakılırsa konuşmanın markası kullanılır).",
        },
      },
    },
  },
  {
    name: "ask_user",
    description:
      "Kullanıcıya sohbette tek ve net bir soru sorar (seçenekli kart) ve cevabını bekler; cevap bu aracın sonucu olarak gelir. Yalnızca gerçekten gerekli bir bilgi eksikse kullan. Uzun süre cevap gelmezse sonuç `answered: false` olur: o zaman turu kısa bir cümleyle bitir (cevap gelince yeni tur başlar).",
    inputSchema: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "Sorulacak net Türkçe soru." },
        options: {
          type: "array",
          description: "Seçenekler (en az 2; boşsa serbest metin cevabı beklenir).",
          items: {
            type: "object",
            required: ["label"],
            properties: {
              id: { type: "string", description: "Kısa anahtar (a-z0-9_-); boşsa üretilir." },
              label: { type: "string", description: "Seçenek metni." },
              description: { type: "string", description: "İsteğe bağlı açıklama." },
            },
          },
        },
        multiple: { type: "boolean", description: "Birden fazla seçenek seçilebilsin mi." },
        allowText: {
          type: "boolean",
          description:
            "Seçeneklerin yanında serbest metin cevabına da izin verilsin mi (varsayılan evet).",
        },
      },
    },
  },
  {
    name: "list_aliases",
    description:
      "Sohbete eklenen dosyaları @takma adlarıyla listeler (tür, boyut, dosya adı). `withThumbnails: true` ile görsellerin küçük önizlemelerini de gösterir.",
    inputSchema: {
      type: "object",
      properties: {
        withThumbnails: {
          type: "boolean",
          description: "Görsellerin küçük önizlemeleri de gelsin mi (en fazla 8).",
        },
      },
    },
  },
  {
    name: "view_alias",
    description: "Sohbetteki bir görsele @takma adıyla bakar (görseli gösterir).",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: {
        alias: { type: "string", description: "Takma ad, ör. 'image' ya da '@image-1'." },
      },
    },
  },
  {
    name: "list_contents",
    description: "Markanın son postlarını / içeriklerini durumlarıyla birlikte listeler.",
    inputSchema: {
      type: "object",
      properties: {
        brandId: { type: "string", description: "Marka id'si (boşsa konuşmanın markası)." },
        status: {
          type: "string",
          enum: [
            "draft",
            "in_review",
            "approved",
            "scheduled",
            "publishing",
            "published",
            "failed",
          ],
        },
        type: { type: "string", enum: ["post", "carousel", "story", "reel"] },
        limit: {
          type: "integer",
          description: "En fazla kaç içerik dönsün (1..100, varsayılan 20).",
        },
      },
    },
  },
  {
    name: "get_content",
    description:
      "Tek bir postu ve mevcut tasarım sürümünü (slaytlar, başlık, caption, onay durumu) okur.",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "İçerik id'si." },
        version: { type: "integer", description: "Belirli bir sürüm numarası (boşsa son sürüm)." },
      },
    },
  },
  {
    name: "view_post",
    description:
      "Bir postun render edilmiş slaytlarını görsel olarak gösterir (en fazla 10 slayt). Sürüm verilmezse güncel sürüm.",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "İçerik id'si." },
        version: { type: "integer", description: "Sürüm numarası (boşsa güncel sürüm)." },
      },
    },
  },
  {
    name: "generate_post",
    description:
      "Post tasarım üretimini başlatır (`content.generate` işi kuyruğa alınır; tasarım burada yapılmaz). Ya kabul edilmiş bir plan kalemi (`planItemId`) ya da yeni bir brief ver. Çağırmadan önce kullanıcıya hangi motorla (`engine`) ve kaç varyant (`variants`, en çok 4) üretileceğini sor; kullanıcı söylediyse ya da markanın varsayılan motoru varsa sorma. `html`, `wecra` ve `svg` motorları çalışır (`wecra`: tasarım Mac'teki Wecra tuvalinde boş belgeden Wecra'nın kendi araçlarıyla yapılır, post tuvalde düzenlenebilir; Mac uygulaması açık olmalı. `svg`: her slayt vektör olarak yazılır; hızlı, ucuz, aynı sonuç; post yalnızca sohbetten `revise_post` ile düzenlenir, tuvalde açılmaz; Reels üretmez). Her varyant ayrı bir post ve ayrı bir iştir. Sonuç iş kimliklerini döner; bitmesini `wait_jobs` ile bekle. AI görsel yuvası (`imageSlot: ai_generate`) varsa araç, tasarımla birlikte görseli de üretmek için tek bir ücretli izin kartı gösterir; izin verilirse her postun tasarımı hazır olunca yuvası ürün görseli hattıyla (ürün fotoğraflarından birebir tarif → üretim → yapay zekâ kontrolü) üretilir, görsel sohbete onay kartı olarak düşer ve yuva ancak kullanıcı onaylayınca dolar. İzin verilmezse post yine üretilir, yuva boş kalır.",
    inputSchema: {
      type: "object",
      properties: {
        planItemId: { type: "string", description: "Kabul edilmiş plan kaleminin id'si." },
        brief: { type: "string", description: "Plan kalemi yoksa: postun ana mesajı ve içeriği." },
        title: { type: "string", description: "Kısa başlık." },
        type: { type: "string", enum: ["post", "carousel", "story"] },
        platforms: {
          type: "array",
          items: { type: "string", enum: ["instagram", "facebook", "linkedin"] },
        },
        imageSlot: { type: "string", enum: ["none", "user_upload", "ai_generate"] },
        imageBrief: {
          type: "string",
          description: "Görsel tarifi; kullanıcı görseli için başına @takma-ad yaz.",
        },
        instructions: { type: "string", description: "Bu üretim için ek talimat." },
        engine: {
          type: "string",
          enum: ["wecra", "html", "svg", "code"],
          description:
            "Tasarım motoru: kullanıcının seçtiği (Wecra, HTML, SVG, Kod); boşsa markanın varsayılanı, o da yoksa html. html, wecra ve svg hazır; code 'Bu motor henüz hazır değil' hatası verir.",
        },
        variants: {
          type: "integer",
          description:
            "Kaç varyant üretilsin (1-4, varsayılan 1). Her varyant ayrı bir post olur; yapay zekâ görseli üretilecekse her görsel ücretlidir.",
        },
        products: {
          type: "array",
          items: { type: "string" },
          description:
            "Postun konusu olan ürünler: @ad (ör. 'boro', '@venta-boro') ya da ürün id'si. Ürünlerin bilgileri tasarıma gider; AI görsel yuvası varsa görsel bu ürünlerin fotoğraflarıyla, birebir üretilir.",
        },
        aiImage: {
          type: "boolean",
          description:
            "AI görsel yuvası (imageSlot ai_generate) olan postlarda yuvanın ürün görseli hattıyla doldurulması. Varsayılan true: araç tek bir ücretli izin kartı gösterir ('Ürün görseli de üreteyim mi? Ücretli: …'), kart bütün varyantların yuvalarını kapsar. Kullanıcı görsel istemediğini zaten söylediyse false ver (kart çıkmaz, yuva boş kalır).",
        },
        imageView: {
          type: "string",
          description:
            "AI görseli için ürünün hangi yüzü (ör. 'sola bakan', 'arka', 'önden'); uygun ürün fotoğrafları referans seçilir.",
        },
        imageStyle: {
          type: "string",
          description:
            "AI görselinin stili (ör. 'vintage', 'retro'); boşsa markanın görsel stili ön ayarı, '' = stil yok.",
        },
      },
    },
  },
  {
    name: "list_products",
    description:
      "Markanın ürünlerini @adlarıyla (ör. @boro) listeler: ad, kategori, kısa açıklama, fotoğraf sayısı.",
    inputSchema: {
      type: "object",
      properties: {
        brandId: { type: "string", description: "Marka id'si (boşsa konuşmanın markası)." },
      },
    },
  },
  {
    name: "get_product",
    description:
      "Bir ürünün bütün bilgilerini ve fotoğraflarını (ön, arka, yan etiket… açı ipuçlarıyla) getirir. `withPhotos: true` ile fotoğrafların kendisini de gösterir. İstenen açıya (ör. 'sola bakan') uygun fotoğrafı seçmek için kullan. Her fotoğrafın kalitesi de ölçülür (`quality`: çözünürlük, netlik, ışık); kalitesiz olanlar `lowQualityPhotos`'ta gelir.",
    inputSchema: {
      type: "object",
      required: ["product"],
      properties: {
        product: { type: "string", description: "Ürünün @adı (ör. 'boro') ya da id'si." },
        withPhotos: {
          type: "boolean",
          description: "Fotoğraflar da gösterilsin mi (en fazla 8).",
        },
      },
    },
  },
  {
    name: "upgrade_product_photo",
    description:
      'Kalitesiz bir ürün fotoğrafının (düşük çözünürlük, bulanık, gürültülü, kötü ışık) yerine beyaz zeminde, profesyonel stüdyo ışığında, yüksek çözünürlüklü, kusursuz ayrıntılı yeni bir fotoğraf üretir; ürün birebir korunur (etiket yazısı, renk, şekil) ve yapay zekâ kontrol eder. Yalnızca kullanıcı ask_user ile sorulan "Bu ürünün resmi kalitesiz, kalitesini artırayım mı?" sorusuna evet dedikten sonra çağır. Ücretlidir: izin kartı gösterir. Sonuç sohbete onay kartı olarak düşer; onaylanırsa ürünün fotoğrafı değişir, eskisi 30 gün çöpte durur.',
    inputSchema: {
      type: "object",
      required: ["product"],
      properties: {
        product: { type: "string", description: "Ürünün @adı ya da id'si." },
        assetId: {
          type: "string",
          description:
            "İyileştirilecek fotoğraf (get_product'taki assetId); boşsa ürünün en kalitesiz fotoğrafı.",
        },
        notes: {
          type: "string",
          description: "Kullanıcının ek isteği (ör. 'kapak tarafı da görünsün').",
        },
        repeat: {
          type: "boolean",
          description: "Aynı istek bu sohbette zaten çalıştıysa yine de yeniden üret.",
        },
      },
    },
  },
  {
    name: "wait_jobs",
    description:
      "Kuyruktaki işlerin (ör. generate_post, revise_post) bitmesini bekler ve durumlarını döner. En fazla `timeoutSec` saniye (varsayılan 300, en çok 900).",
    inputSchema: {
      type: "object",
      required: ["jobIds"],
      properties: {
        jobIds: { type: "array", items: { type: "string" } },
        timeoutSec: { type: "integer", description: "En fazla kaç saniye beklensin." },
      },
    },
  },
  {
    name: "generate_reel",
    description:
      "Reels (1080×1920 dikey MP4 + kapak) üretimini başlatır (`content.generate`, tür reel; video burada yapılmaz). Tarifler: `motion_graphics` (marka renk ve fontlarıyla hareketli tipografi), `footage_edit` (kullanıcının @video çekimi üzerine kanca, metin katmanları ve konuşmadan altyazı), `narration` (Türkçe seslendirme + kelime senkron altyazı). Kabul edilmiş bir reel plan kalemi (`planItemId`) ya da brief ver. Video bu tur bittikten sonra Mac'te render edilir (1-3 dk): `wait_jobs` ile bekleme, kullanıcıya Reels'in Postlar'da hazırlandığını söyle. Değişiklik için `revise_post`.",
    inputSchema: {
      type: "object",
      properties: {
        planItemId: { type: "string", description: "Kabul edilmiş reel plan kaleminin id'si." },
        brief: { type: "string", description: "Plan kalemi yoksa: videonun ana mesajı." },
        title: { type: "string", description: "Kısa başlık." },
        recipe: {
          type: "string",
          enum: ["motion_graphics", "footage_edit", "narration"],
          description: "Boşsa brief ve medyadan seçilir (video verilirse footage_edit).",
        },
        clipAlias: { type: "string", description: "Çekim kurgusu için @video takma adı." },
        imageAlias: {
          type: "string",
          description: "Videoda kullanılacak @görsel (ürün fotoğrafı vb.).",
        },
        audioAlias: { type: "string", description: "Müzik ya da hazır ses kaydı (@ses)." },
        durationSec: {
          type: "number",
          description: "Hedef süre (3-90 sn; Facebook Reels en fazla 90 sn).",
        },
        platforms: {
          type: "array",
          items: { type: "string", enum: ["instagram", "facebook", "linkedin"] },
        },
        instructions: { type: "string", description: "Bu üretim için ek talimat." },
      },
    },
  },
  {
    name: "revise_post",
    description:
      "Var olan bir postu verilen talimatla HTML'den yeniden üretir (güncel sürümden başlayan `content.generate` işi kuyruğa alınır). Bitmesini `wait_jobs` ile bekle. SVG motoruyla üretilmiş postlarda değişikliği saklı SVG'den yapar (SVG postları yalnızca böyle düzenlenir). Tuvalde (Wecra) kaydedilmiş postlarda kullanma: onlar `canvas_edit` ile düzenlenir; yalnızca kullanıcı açıkça yeni bir tasarım isterse `newDesign: true` ile.",
    inputSchema: {
      type: "object",
      required: ["contentId", "instruction"],
      properties: {
        contentId: { type: "string", description: "İçerik id'si." },
        instruction: { type: "string", description: "Neyin değişeceği, Türkçe." },
        newDesign: {
          type: "boolean",
          description:
            "Tuval postunda: kullanıcı açıkça yeni bir tasarım / baştan üretim istedi (tuvaldeki elle düzenlemeler yeni sürümde olmaz).",
        },
      },
    },
  },
  {
    name: "list_skills",
    description: "Studio becerilerini (hazır çalışma talimatları) ad ve açıklamalarıyla listeler.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_skill",
    description: "Bir Studio becerisinin tam talimatını getirir; işe uyduğunda okuyup uygula.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", description: "Beceri adı, ör. 'aylik-plan'." } },
    },
  },
  {
    name: "list_social_accounts",
    description: "Markaya bağlı sosyal medya hesaplarını listeler.",
    inputSchema: {
      type: "object",
      properties: {
        brandId: { type: "string", description: "Marka id'si (boşsa konuşmanın markası)." },
        platform: { type: "string", enum: CHAT_PLATFORMS },
      },
    },
  },
  {
    name: "accept_and_generate_plan",
    description:
      "Açık içerik planını kabul eder ve post tasarımlarının üretimini başlatır. Kullanıcıya izin (consent) kartı gösterir ve yanıtını bekler.",
    inputSchema: {
      type: "object",
      properties: {
        planId: {
          type: "string",
          description: "Plan id'si (boşsa konuşmadaki açık plan kullanılır).",
        },
        skipItemIds: {
          type: "array",
          items: { type: "string" },
          description: "Atlanacak plan kalemi id'leri.",
        },
        itemIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Yalnızca belirli kalemleri üretmek için kalem id'leri. Boşsa yalnızca tasarımı olmayan ya da üretimi başarısız olan kalemler üretilir.",
        },
        instructions: {
          type: "string",
          description: "Tasarım üretimi için ek yönerge.",
        },
        force: {
          type: "boolean",
          description:
            "itemIds ile: tasarımı zaten olan kalemleri yeniden üret. Yalnızca kullanıcı üretilmiş postların yeniden üretilmesini açıkça isterse. Elle ya da yapay zekâyla düzenlenmiş ve onaylı postlar yine korunur (onları Studio'da kullanıcı onaylar).",
        },
        aiImages: {
          type: "boolean",
          description:
            "true: AI görsel yuvası (ai_generate) olan kalemlerin görselleri de ürün görseli hattıyla üretilir (ücretli; izin kartında tutarıyla yazar, her görsel onay kartıyla gelir, yuva onaylanınca dolar). Yalnızca kullanıcı görselleri de istediyse.",
        },
      },
    },
  },
  {
    name: "approve_content",
    description:
      "Bir postun son tasarım sürümünü yayına onaylar. Kullanıcıya izin (consent) kartı gösterir ve yanıtını bekler.",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "Onaylanacak içerik id'si." },
      },
    },
  },
  {
    name: "schedule_content",
    description:
      "Onaylanmış bir postu bağlı sosyal medya hesabında ileri bir tarihe zamanlar. Kullanıcıya izin (consent) kartı gösterir ve yanıtını bekler.",
    inputSchema: {
      type: "object",
      required: ["contentId", "socialAccountId", "scheduledAt"],
      properties: {
        contentId: { type: "string", description: "Zamanlanacak onaylı içerik id'si." },
        socialAccountId: { type: "string", description: "Sosyal medya hesabı id'si." },
        scheduledAt: {
          type: "string",
          description: "Yayın zamanı (UTC ISO 8601, ör. '2026-11-20T09:00:00Z').",
        },
        platform: {
          type: "string",
          enum: CHAT_PLATFORMS,
          description: "Hesabın platformu (opsiyonel).",
        },
      },
    },
  },
  {
    name: "create_brand",
    description:
      "Yeni bir marka oluşturur (ad, isteğe bağlı slug ve varsayılan dil). Konuşmanın henüz markası yoksa otomatik olarak bu konuşmaya bağlar.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Marka adı, ör. 'MTM Agro'." },
        slug: {
          type: "string",
          description: "URL uyumlu kısa ad (ör. 'mtm-agro'). Boş bırakılırsa addan türetilir.",
        },
        defaultLanguage: {
          type: "string",
          description: "Varsayılan içerik dili (ör. 'tr' veya 'en'; varsayılan 'tr').",
        },
      },
    },
  },
  {
    name: "analyze_brand",
    description:
      "Markanın yüklenen varlıklarını (logo, font, görseller), örnek postlarını ve onaylı içerik/düzenleme geçmişini analiz ederek yeni bir marka profili (brand.json, DESIGN.md, VOICE.md) üretimi (`brand.analyze`) başlatır.",
    inputSchema: {
      type: "object",
      properties: {
        brandId: {
          type: "string",
          description: "Marka id'si ya da slug'ı (boşsa konuşmanın markası).",
        },
        notes: {
          type: "string",
          description: "Marka tonu, renkler veya kurallar hakkında ek notlar.",
        },
        includeApprovedContentFeedback: {
          type: "boolean",
          description:
            "Onaylı/yayınlanmış postlar ve kullanıcı düzeltmeleri geri beslensin mi (varsayılan true).",
        },
        autoApprove: {
          type: "boolean",
          description:
            "Üretilen marka profili otomatik olarak aktif/onaylı yapılsın mı (varsayılan false).",
        },
      },
    },
  },
  {
    name: "generate_ai_image",
    description:
      "Gemini görsel modeliyle yapay zekâ görseli üretir (`image.generate`). Ücretlidir: kullanıcıya model ve tahmini tutarla izin (consent) kartı gösterir ve yanıtını bekler. Aynı istek bu sohbette zaten çalıştıysa yeni iş açmaz, öncekini döner (`repeat: true` yalnızca kullanıcı bilerek bir kez daha isterse). Ürün görseli için `referenceProducts` ver: ürünün fotoğrafları birebir okunur (etiket yazısı harfi harfine, renk, şekil, kapak, doku) ve prompta yazılır; model yalnızca kadrajı, ortamı, ışığı ve kaliteyi değiştirir. Her görsel bitince yapay zekâ ürünle karşılaştırır ve görsel, kontrol raporuyla birlikte sohbete onay kartı (Onayla / Reddet / Yeniden üret) olarak düşer; hedef post yuvası ancak onaylanınca dolar. Kontrol hata bulsa da kendiliğinden yeniden üretilmez.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        brandId: { type: "string", description: "Marka id'si (boşsa konuşmanın markası)." },
        prompt: { type: "string", description: "Üretilecek sahnenin detaylı tarifi." },
        aspectRatio: {
          type: "string",
          enum: ["4:5", "9:16", "1:1"],
          description: "Görsel oranı (varsayılan '4:5').",
        },
        imageSize: {
          type: "string",
          enum: ["1K", "2K"],
          description: "Çözünürlük (varsayılan '2K').",
        },
        referenceAliases: {
          type: "array",
          items: { type: "string" },
          description: "Sohbetteki referans görsel @takma adları (@ olmadan ya da @ ile).",
        },
        referenceAssetIds: {
          type: "array",
          items: { type: "string" },
          description: "Doğrudan referans varlık (asset) id'leri.",
        },
        referenceProducts: {
          type: "array",
          items: { type: "string" },
          description:
            "Görselde görünecek ürünler: @ad ya da id. Uygun açıdaki fotoğrafı kendin seçtiysen onu referenceAssetIds'e de koy; yoksa istenen açıya (`view` ya da tarifteki 'sola bakan', 'arkadan'…) uyan fotoğraf seçilir, açı belli değilse ilk 3 fotoğraf gider.",
        },
        view: {
          type: "string",
          description:
            "İstenen açı: 'ön', 'arka', 'sol', 'sağ', 'yan', 'üst' (ör. 'sola bakan' için 'sol'). Ürün fotoğrafı seçiminde kullanılır.",
        },
        style: {
          type: "string",
          description:
            "Bu görselin stili (ör. 'vintage', 'retro'); yalnızca sahneye, ışığa ve renk tonuna uygulanır, ürüne asla. Verilmezse markanın görsel stili kullanılır; boş metin ('') stil yok demektir.",
        },
        variants: {
          type: "integer",
          description:
            "Kaç görsel (1-4, varsayılan 1). Her biri ayrı ücretlidir, hazır oldukça ayrı onay kartıyla sohbete düşer.",
        },
        preserveProductLabel: {
          type: "boolean",
          description:
            "Varsayılan false. Yalnızca kullanıcı açıkça 'Etiketi birebir koruyarak yerleştir' isterse true: model yalnızca sahneyi çizer, gerçek ürün fotoğrafı kesilip sahneye yapıştırılır ve etiket sonradan okunarak doğrulanır.",
        },
        productPosition: {
          type: "string",
          enum: ["auto", "center", "bottom-center", "bottom-left", "bottom-right", "left", "right"],
          description:
            "preserveProductLabel ile ürünün yeri (varsayılan 'auto': sahnenin en boş yeri, yoksa alt orta).",
        },
        productScale: {
          type: "number",
          description:
            "preserveProductLabel ile ürünün yüksekliği, görsel yüksekliğinin oranı olarak (0.2–0.9, varsayılan 0.62).",
        },
        labelText: {
          type: "string",
          description:
            "Kullanıcı etiketin metnini verdiyse satır satır, birebir (fotoğraftan okumaktan güvenilirdir); son görselde bununla karşılaştırılır.",
        },
        targetContentId: {
          type: "string",
          description: "Üretilen görselin otomatik yerleştirileceği post id'si (opsiyonel).",
        },
        targetSlotId: {
          type: "string",
          description: "Hedef posttaki görsel yuvası katman id'si (`data-layer`, opsiyonel).",
        },
        repeat: {
          type: "boolean",
          description:
            "Aynı istek bu sohbette zaten çalıştıysa yine de yeniden üret (yalnızca kullanıcı açıkça bir kez daha isterse).",
        },
      },
    },
  },
  {
    name: "search_media",
    description:
      "Markanın medya kütüphanesinde görsel arar: Mac'te Apple Vision ile okunmuş Türkçe etiketler (ör. 'buğday', 'tarla', 'şişe'), görseldeki yazı, renkler, yön ve dosya adı; ya da `similarTo` ile bir görsele benzeyenleri bulur. Sonuçlar veri olarak gelir (assetId, etiketler, okunan yazı, renkler, yön, dekupe/logo). Bir görsel yuvası için uygun görseli kendin seçmek istediğinde kullan; seçtiğin `assetId`'yi `fill_post_slot`'a ya da `generate_ai_image` referansına ver. `withThumbnails: true` ilk sonuçların küçük önizlemelerini de gösterir.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Aranacak kelimeler (hepsi eşleşmeli; Türkçe karakter duyarsız), ör. 'tarla traktör' ya da 'yeşil logo'. Boşsa en yeni görseller.",
        },
        brandId: { type: "string", description: "Marka id'si (boşsa konuşmanın markası)." },
        similarTo: {
          type: "string",
          description:
            "Bu görsele (assetId ya da @takma ad) benzeyenleri getir; query yok sayılır.",
        },
        kind: { type: "string", enum: ["image", "logo"], description: "Yalnızca bu tür." },
        orientation: {
          type: "string",
          enum: ["portrait", "landscape", "square"],
          description: "Yön: dikey, yatay ya da kare.",
        },
        cutoutOnly: {
          type: "boolean",
          description: "Yalnızca arka planı şeffaf (dekupe) görseller.",
        },
        limit: { type: "integer", description: "En fazla kaç sonuç (varsayılan 12, en çok 30)." },
        withThumbnails: {
          type: "boolean",
          description: "İlk sonuçların (en çok 6) küçük önizlemeleri de gelsin.",
        },
      },
    },
  },
  {
    name: "fill_post_slot",
    description:
      "Bir postun görsel yuvasını (`data-layer`) sohbetteki @takma ad veya `assetId` ile doldurur ve yeni sürüm oluşturup JPEG olarak render eder (`content.render`). SVG motoruyla üretilmiş postlarda değişikliği saklı SVG'den yapar (SVG postları yalnızca böyle düzenlenir). Tuvalde (Wecra) kaydedilmiş postlarda kullanma: `canvas_edit` ile `place_image`.",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "Görsel yuvası doldurulacak post id'si." },
        slotId: { type: "string", description: "Görsel yuvasının `data-layer` kimliği." },
        alias: {
          type: "string",
          description: "Sohbetteki görsel @takma adı (ör. 'image' veya '@image').",
        },
        assetId: { type: "string", description: "Doğrudan görsel varlık (asset) id'si." },
        slotAssignments: {
          type: "object",
          description: "Birden fazla yuva için `{ [slotLayerId]: assetId_veya_@alias }` eşlemesi.",
        },
      },
    },
  },
  {
    name: "export_content_pdf",
    description:
      "Bir post veya LinkedIn carousel içeriğini çok sayfalı PDF belgesi olarak dışa aktarır (`content.render` `format: 'pdf'`).",
    inputSchema: {
      type: "object",
      required: ["contentId"],
      properties: {
        contentId: { type: "string", description: "PDF'e aktarılacak içerik id'si." },
        version: {
          type: "integer",
          description: "Belirli sürüm numarası (opsiyonel, varsayılan son sürüm).",
        },
      },
    },
  },
  {
    name: "publish_now",
    description:
      "Bir postu bağlı sosyal medya hesabında hemen yayınlar (`schedule.publish`). Kullanıcıya izin (consent) kartı gösterir ve yanıtını bekler.",
    inputSchema: {
      type: "object",
      required: ["contentId", "socialAccountId"],
      properties: {
        contentId: { type: "string", description: "Yayınlanacak içerik id'si." },
        socialAccountId: { type: "string", description: "Yayınlanacak sosyal medya hesabı id'si." },
        platform: {
          type: "string",
          enum: CHAT_PLATFORMS,
          description: "Hesabın platformu (opsiyonel).",
        },
        scheduleId: {
          type: "string",
          description: "Mevcut bir zamanlama kaydı varsa id'si (opsiyonel).",
        },
      },
    },
  },
  // Posts saved from the Mac's design canvas: their Wecra document (canvas-tools.ts).
  ...CANVAS_TOOLS,
  // Brand templates and repurposing (N9, N10; template-tools.ts).
  ...TEMPLATE_TOOLS,
  // First comment and alt texts (N13; publish-tools.ts).
  ...PUBLISH_TOOLS,
];

// --- input schemas -------------------------------------------------------------------------

const trimmed = (max: number) => z.string().transform((s) => s.trim().slice(0, max));

const ProposePlanInput = z.object({
  brandId: z.string().trim().min(1).optional(),
  title: trimmed(200),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  summary: trimmed(20_000).default(""),
  items: z
    .array(
      z.object({
        date: z.string().nullable().optional(),
        platforms: z.array(z.enum(CHAT_PLATFORMS)).min(1),
        contentType: z.enum(CHAT_CONTENT_TYPES),
        title: trimmed(200),
        brief: trimmed(20_000).default(""),
        pillar: trimmed(120).optional(),
        hook: trimmed(300).optional(),
        imageSlot: z.enum(["none", "user_upload", "ai_generate"]).default("none"),
        imageBrief: trimmed(3_800).optional(),
        imageAliases: z.array(z.string()).default([]),
        templateId: z.string().trim().min(1).max(128).optional(),
      }),
    )
    .min(1),
});

const PlanningContextInput = z.object({
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  brandId: z.string().trim().min(1).optional(),
});

const AskQuestionInput = z.object({
  prompt: trimmed(2_000),
  mode: z.enum(["single", "multiple", "text"]),
  options: z
    .array(
      z.object({
        id: z.string(),
        label: trimmed(200),
        description: z.string().optional(),
      }),
    )
    .default([]),
  allowText: z.boolean().default(false),
});

const AskUserInput = z.object({
  question: trimmed(2_000).refine((q) => q.length > 0, "Soru boş olamaz"),
  options: z
    .array(
      z.object({
        id: z.string().optional(),
        label: trimmed(200),
        description: z.string().optional(),
      }),
    )
    .default([]),
  multiple: z.boolean().default(false),
  allowText: z.boolean().default(true),
});

const ListAliasesInput = z.object({ withThumbnails: z.boolean().default(false) });
const ViewAliasInput = z.object({ alias: z.string().trim().min(1) });

const ViewPostInput = z.object({
  contentId: z.string().trim().min(1),
  version: z.coerce.number().int().min(1).optional(),
});

const GeneratePostInput = z
  .object({
    repeat: z.boolean().default(false),
    planItemId: z.string().trim().min(1).optional(),
    brief: trimmed(20_000).optional(),
    title: trimmed(200).optional(),
    type: z.enum(CHAT_CONTENT_TYPES).default("post"),
    platforms: z.array(Platform).min(1).max(3).optional(),
    imageSlot: z.enum(["none", "user_upload", "ai_generate"]).optional(),
    imageBrief: trimmed(4_000).optional(),
    instructions: z.string().max(4_000).optional(),
    engine: GenerationEngine.optional(),
    variants: z.coerce.number().int().min(1).max(MAX_GENERATION_VARIANTS).default(1),
    products: z.array(z.string().trim().min(1)).max(8).default([]),
    aiImage: z.boolean().default(true),
    imageView: trimmed(80).optional(),
    imageStyle: z.string().trim().max(500).optional(),
  })
  .refine((v) => Boolean(v.planItemId || v.brief), "planItemId ya da brief gerekli");

const ListProductsInput = z.object({ brandId: z.string().trim().min(1).optional() });
const GetProductInput = z.object({
  product: z.string().trim().min(1),
  withPhotos: z.boolean().default(false),
});

const UpgradeProductPhotoInput = z.object({
  repeat: z.boolean().default(false),
  product: z.string().trim().min(1),
  /** The photo to improve (default: the product's lowest-quality photo, else its cover). */
  assetId: z.string().trim().min(1).optional(),
  notes: trimmed(1_000).optional(),
});

const GenerateReelInput = z
  .object({
    repeat: z.boolean().default(false),
    planItemId: z.string().trim().min(1).optional(),
    brief: trimmed(20_000).optional(),
    title: trimmed(200).optional(),
    recipe: z.enum(["motion_graphics", "footage_edit", "narration"]).optional(),
    clipAlias: z.string().trim().min(1).optional(),
    imageAlias: z.string().trim().min(1).optional(),
    audioAlias: z.string().trim().min(1).optional(),
    durationSec: z.coerce.number().min(3).max(90).optional(),
    platforms: z.array(Platform).min(1).max(3).optional(),
    instructions: z.string().max(4_000).optional(),
  })
  .refine((v) => Boolean(v.planItemId || v.brief), "planItemId ya da brief gerekli");

const WaitJobsInput = z.object({
  jobIds: z.array(z.string().trim().min(1)).min(1).max(30),
  timeoutSec: z.coerce.number().int().min(1).max(900).default(300),
});

const RevisePostInput = z.object({
  contentId: z.string().trim().min(1),
  instruction: trimmed(4_000).refine((s) => s.length > 0, "Talimat boş olamaz"),
  newDesign: z.boolean().optional(),
});

const GetSkillInput = z.object({ name: z.string().trim().min(1) });

const ListContentsInput = z.object({
  brandId: z.string().trim().min(1).optional(),
  status: ContentStatus.optional(),
  type: ContentType.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const GetContentInput = z.object({
  contentId: z.string().trim().min(1),
  version: z.coerce.number().int().min(1).optional(),
});

const ListSocialAccountsInput = z.object({
  brandId: z.string().trim().min(1).optional(),
  platform: Platform.optional(),
});

const AcceptGeneratePlanInput = z.object({
  planId: z.string().trim().min(1).optional(),
  skipItemIds: z.array(z.string().min(1)).default([]),
  itemIds: z.array(z.string().min(1)).optional(),
  instructions: z.string().max(4_000).optional(),
  force: z.boolean().optional(),
  aiImages: z.boolean().default(false),
});

const ApproveContentInput = z.object({
  contentId: z.string().trim().min(1),
});

const ScheduleContentInput = z.object({
  contentId: z.string().trim().min(1),
  socialAccountId: z.string().trim().min(1),
  scheduledAt: z.iso.datetime(),
  platform: Platform.optional(),
});

const CreateBrandInput = z.object({
  name: trimmed(120).refine((s) => s.length >= 1, "Marka adı boş olamaz"),
  slug: z.string().trim().min(2).max(64).optional(),
  defaultLanguage: z.string().trim().min(2).max(16).default("tr"),
});

const AnalyzeBrandInput = z.object({
  brandId: z.string().trim().min(1).optional(),
  notes: z.string().max(10_000).optional(),
  includeApprovedContentFeedback: z.boolean().default(true),
  autoApprove: z.boolean().default(false),
});

const GenerateAiImageInput = z.object({
  repeat: z.boolean().default(false),
  brandId: z.string().trim().min(1).optional(),
  prompt: trimmed(4_000).refine((s) => s.length >= 1, "Görsel tarifi (prompt) boş olamaz"),
  aspectRatio: z.enum(["4:5", "9:16", "1:1"]).default("4:5"),
  imageSize: z.enum(["1K", "2K"]).default("2K"),
  referenceAliases: z.array(z.string()).default([]),
  referenceAssetIds: z.array(z.string().trim().min(1)).default([]),
  referenceProducts: z.array(z.string().trim().min(1)).max(4).default([]),
  view: trimmed(80).optional(),
  style: trimmed(500).optional(),
  variants: z.coerce.number().int().min(1).max(MAX_GENERATION_VARIANTS).default(1),
  preserveProductLabel: z.boolean().default(false),
  targetContentId: z.string().trim().min(1).optional(),
  targetSlotId: z.string().trim().min(1).max(128).optional(),
  productPosition: ProductPosition.optional(),
  productScale: z.coerce.number().min(0.2).max(0.9).optional(),
  labelText: trimmed(4_000).optional(),
});

/** N12: `search_media`. */
const SearchMediaInput = z.object({
  query: trimmed(200).optional(),
  brandId: z.string().trim().min(1).optional(),
  similarTo: z.string().trim().min(1).optional(),
  kind: z.enum(["image", "logo"]).optional(),
  orientation: AssetOrientation.optional(),
  cutoutOnly: z.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(30).default(12),
  withThumbnails: z.boolean().default(false),
});

const FillPostSlotInput = z.object({
  contentId: z.string().trim().min(1),
  slotId: z.string().trim().min(1).optional(),
  alias: z.string().trim().min(1).optional(),
  assetId: z.string().trim().min(1).optional(),
  slotAssignments: z.record(z.string(), z.string()).optional(),
});

const ExportContentPdfInput = z.object({
  contentId: z.string().trim().min(1),
  version: z.coerce.number().int().min(1).optional(),
});

const PublishNowInput = z.object({
  contentId: z.string().trim().min(1),
  socialAccountId: z.string().trim().min(1),
  platform: Platform.optional(),
  scheduleId: z.string().trim().min(1).optional(),
});

// --- executor ------------------------------------------------------------------------------

/** What the API's approval gate (E7) said: its message and the blocking checks. */
interface ChecksGate {
  message: string;
  issues: string[];
}

/** The approval was refused by the checks (409 about "kontrol"), not by anything else. */
function checksGateOf(error: unknown): ChecksGate | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (error.code !== undefined && error.code !== "conflict") return null;
  if (!/kontrol/i.test(error.message)) return null;
  return {
    message: error.message.replace(/^\/api\/[^:]*: /, ""),
    issues: (error.issues ?? []).map((i) => i.message).slice(0, 10),
  };
}

/** A picture in a tool result (base64), sent to MCP clients as an image content block. */
export interface StudioToolImage {
  mediaType: string;
  data: string;
}

export interface StudioToolExecutionResult {
  data: Record<string, unknown>;
  isError: boolean;
  /** Pictures for the model (view_alias, list_aliases thumbnails, view_post). */
  images?: StudioToolImage[];
}

export interface StudioToolOutcome {
  action: "none" | "plan" | "question";
  planId?: string;
  planItems?: number;
  planNotes?: string[];
  toolCalls: string[];
}

export interface StudioToolExecutorOptions {
  api: StudioApi;
  writer: TurnWriter;
  runId: string;
  conversationId: string;
  initialBrandId: string | null;
  initialOpenPlan: Plan | null;
  aliases: readonly KnownAlias[];
  signal: AbortSignal;
  logger?: Logger;
  /** Passed to `plans.generate` when the chat run picked a Claude model/effort. */
  generationChoice?: {
    model?: "opus" | "sonnet" | "haiku" | undefined;
    effort?: AgentEffort | undefined;
  };
  consentPollIntervalMs?: number;
  consentTimeoutMs?: number;
  /** `ask_user`: how long to wait for the answer (default 10 min). */
  askTimeoutMs?: number;
  /** `wait_jobs`: poll interval (default 3 s). */
  jobPollIntervalMs?: number;
  /** Runtime skills (`list_skills` / `get_skill`). */
  skills?: readonly Skill[];
  /** Long edge of pictures returned to the model (default 1568). */
  imageMaxEdge?: number;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The turn's waits: consent cards, `ask_user` and `wait_jobs` run inside it, so the turn's time
   * cap stops and its Claude slot is free meanwhile (U1, U6).
   */
  waits?: TurnWaits;
  /** Where the conversation's tool ledger lives (idempotent generate tools, U7); none = memory. */
  stateDir?: string;
  /** Gemini image model `image.generate` will use (shown with its estimated cost). */
  imageModel?: string;
}

export class StudioToolExecutor {
  private brandId: string | null;
  private openPlan: Plan | null;
  /** Planning contexts fetched this turn (`brandId|start|end`). */
  private readonly planningContexts = new Map<string, Promise<PlanningContext>>();
  /** `propose_plan` already handed near-duplicates back once this turn (N6). */
  private similarityReturned = false;
  private stepSeq = 0;
  private questionSeq = 0;
  private consentSeq = 0;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly outcome: StudioToolOutcome = {
    action: "none",
    toolCalls: [],
  };

  /** Calls that create work or spend money, per conversation (U7). */
  private readonly ledger: ToolCallLedger;

  constructor(private readonly options: StudioToolExecutorOptions) {
    this.brandId = options.initialBrandId;
    this.openPlan = options.initialOpenPlan;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.ledger = new ToolCallLedger(
      options.stateDir
        ? path.join(
            conversationWorkDir(options.stateDir, options.conversationId),
            "tool-calls.json",
          )
        : undefined,
      () => new Date(),
    );
  }

  /** Run a wait for the owner / other jobs (the turn's clock stops, the Claude slot is free). */
  private idle<T>(fn: () => Promise<T>): Promise<T> {
    return this.options.waits ? this.options.waits.around(fn) : fn();
  }

  /** The earlier identical call of this conversation, as the result to give back (U7). */
  private async earlierCall(
    tool: string,
    key: string,
    repeat: boolean,
  ): Promise<LedgerEntry | null> {
    if (repeat) return null;
    const found = await this.ledger.find(key).catch(() => null);
    if (found) this.logger.info(`tool ${tool}: same call as ${found.at}; not run again`);
    return found;
  }

  toolNames(): string[] {
    return STUDIO_TOOLS.map((t) => t.name);
  }

  mcpTools(): StudioToolDefinition[] {
    return [...STUDIO_TOOLS];
  }

  geminiFunctionDeclarations(): {
    name: string;
    description: string;
    parameters: ToolJsonSchema;
  }[] {
    return STUDIO_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  async execute(
    rawName: string,
    rawArgs: unknown,
    rawCallId?: string,
  ): Promise<StudioToolExecutionResult> {
    const name = rawName.replace(/^mcp__studio__/, "");
    const args =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};
    this.outcome.toolCalls.push(name);
    const stepId = this.makeStepId(rawCallId);

    switch (name) {
      case "list_brands":
        return this.runSafe(stepId, name, "Markalar listeleniyor…", "Markalar okundu", () =>
          this.listBrands(),
        );
      case "get_brand_profile":
        return this.runSafe(stepId, name, "Marka profili okunuyor…", "Marka profili okundu", () =>
          this.getBrandProfile(args),
        );
      case "set_conversation_brand":
        return this.runSafe(
          stepId,
          name,
          "Sohbet markası ayarlanıyor…",
          "Sohbet markası ayarlandı",
          () => this.setConversationBrand(args),
        );
      case "propose_plan":
        return this.runSafe(
          stepId,
          name,
          "İçerik planı hazırlanıyor…",
          "İçerik planı hazırlandı",
          () => this.proposePlan(args),
        );
      case "get_planning_context":
        return this.runSafe(
          stepId,
          name,
          "Özel günler ve geçmiş okunuyor…",
          "Özel günler ve geçmiş okundu",
          () => this.getPlanningContext(args),
        );
      case "ask_question":
        // Older name (no longer listed): adds the card without waiting for the answer.
        return this.runSafe(stepId, name, "Soru hazırlanıyor…", "Soru eklendi", () =>
          this.askQuestion(args),
        );
      case "ask_user":
        return this.runSafe(stepId, name, "Cevabın bekleniyor…", "Cevap alındı", () =>
          this.askUser(args),
        );
      case "list_aliases":
        return this.runSafe(stepId, name, "Görseller listeleniyor…", "Görseller listelendi", () =>
          this.listAliases(args),
        );
      case "search_media":
        return this.runSafe(stepId, name, "Medyada aranıyor…", "Medyada arandı", () =>
          this.searchMedia(args),
        );
      case "view_alias":
        return this.runSafe(stepId, name, "Görsele bakılıyor…", "Görsele bakıldı", () =>
          this.viewAlias(args),
        );
      case "view_post":
        return this.runSafe(stepId, name, "Posta bakılıyor…", "Posta bakıldı", () =>
          this.viewPost(args),
        );
      case "generate_post":
        return this.runSafe(
          stepId,
          name,
          "Post üretimi başlatılıyor…",
          "Post üretimi kuyruğa alındı",
          () => this.generatePost(args, rawCallId, stepId),
        );
      case "list_products":
        return this.runSafe(stepId, name, "Ürünler listeleniyor…", "Ürünler listelendi", () =>
          this.listProducts(args),
        );
      case "get_product":
        return this.runSafe(stepId, name, "Ürün okunuyor…", "Ürün okundu", () =>
          this.getProduct(args),
        );
      case "generate_reel":
        return this.runSafe(
          stepId,
          name,
          "Reels üretimi başlatılıyor…",
          "Reels üretimi kuyruğa alındı",
          () => this.generateReel(args, rawCallId),
        );
      case "wait_jobs":
        return this.runSafe(stepId, name, "Üretim bekleniyor…", "Üretim bitti", () =>
          this.waitJobs(args),
        );
      case "revise_post":
        return this.runSafe(stepId, name, "Düzeltme başlatılıyor…", "Düzeltme kuyruğa alındı", () =>
          this.revisePost(args),
        );
      case "list_skills":
        return this.runSafe(stepId, name, "Beceriler listeleniyor…", "Beceriler listelendi", () =>
          this.listSkills(),
        );
      case "get_skill":
        return this.runSafe(stepId, name, "Beceri okunuyor…", "Beceri okundu", () =>
          this.getSkill(args),
        );
      case "list_contents":
        return this.runSafe(stepId, name, "Postlar listeleniyor…", "Postlar okundu", () =>
          this.listContents(args),
        );
      case "get_content":
        return this.runSafe(stepId, name, "Post inceleniyor…", "Post incelendi", () =>
          this.getContent(args),
        );
      case "list_social_accounts":
        return this.runSafe(
          stepId,
          name,
          "Sosyal hesaplar kontrol ediliyor…",
          "Sosyal hesaplar okundu",
          () => this.listSocialAccounts(args),
        );
      case "create_brand":
        return this.runSafe(stepId, name, "Marka oluşturuluyor…", "Marka oluşturuldu", () =>
          this.createBrand(args),
        );
      case "analyze_brand":
        return this.runSafe(
          stepId,
          name,
          "Marka analizi başlatılıyor…",
          "Marka analizi kuyruğa alındı",
          () => this.analyzeBrand(args),
        );
      case "generate_ai_image":
        return this.generateAiImage(stepId, args, rawCallId);
      case "upgrade_product_photo":
        return this.upgradeProductPhoto(stepId, args, rawCallId);
      case "fill_post_slot":
        return this.runSafe(
          stepId,
          name,
          "Görsel yuvası dolduruluyor…",
          "Görsel yuvası doldurma kuyruğa alındı",
          () => this.fillPostSlot(args),
        );
      case "export_content_pdf":
        return this.runSafe(
          stepId,
          name,
          "PDF dışa aktarımı başlatılıyor…",
          "PDF dışa aktarımı kuyruğa alındı",
          () => this.exportContentPdf(args),
        );
      case "accept_and_generate_plan":
        return this.acceptAndGeneratePlan(stepId, args);
      case "approve_content":
        return this.approveContent(stepId, args);
      case "schedule_content":
        return this.scheduleContent(stepId, args);
      case "publish_now":
        return this.publishNow(stepId, args);
      case "canvas_outline":
        return this.runSafe(stepId, name, "Tuval belgesi okunuyor…", "Tuval belgesi okundu", () =>
          canvasOutlineTool(this.canvasEnv(), args),
        );
      case "canvas_edit":
        return this.runSafe(stepId, name, "Tuvalde düzenleniyor…", "Tuval düzenlendi", async () => {
          const out = await canvasEditTool(this.canvasEnv(), args);
          if (out.version !== undefined) {
            await this.options.writer
              .setPart({
                type: "content_ref",
                contentId: String(out.data.contentId),
                version: out.version,
                note: "Tuvalde düzenlendi",
              })
              .catch((error: unknown) => {
                if (error instanceof RunClosedError) throw error;
              });
          }
          return out;
        });
      case "canvas_screenshot":
        return this.runSafe(stepId, name, "Karelere bakılıyor…", "Karelere bakıldı", () =>
          canvasScreenshotTool(this.canvasEnv(), args),
        );
      case "set_publish_details":
        return this.runSafe(
          stepId,
          name,
          "Yayın ayrıntıları kaydediliyor…",
          "Yayın ayrıntıları kaydedildi",
          () => setPublishDetailsTool({ api: this.options.api, signal: this.options.signal }, args),
        );
      case "list_templates":
        return this.runSafe(stepId, name, "Şablonlar okunuyor…", "Şablonlar okundu", () =>
          listTemplatesTool(this.templateEnv(), args),
        );
      case "generate_from_template":
        return this.runSafe(
          stepId,
          name,
          "Şablonla post başlatılıyor…",
          "Şablonla post kuyruğa alındı",
          () => this.onceThenRef(name, args, rawCallId, generateFromTemplateTool),
        );
      case "repurpose_content":
        return this.runSafe(
          stepId,
          name,
          "Dönüştürme başlatılıyor…",
          "Dönüştürme kuyruğa alındı",
          () => this.onceThenRef(name, args, rawCallId, repurposeContentTool),
        );
      default:
        return {
          data: { ok: false, error: `Bilinmeyen araç: ${name}` },
          isError: true,
        };
    }
  }

  /** A version of a post (null: not there). */
  private async versionOrNull(contentId: string, version: number) {
    try {
      return await this.options.api.client.contents.versions.get(contentId, version, {
        signal: this.options.signal,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** What the template tools use of this turn (template-tools.ts). */
  private templateEnv(): TemplateToolEnv {
    return {
      api: this.options.api,
      signal: this.options.signal,
      conversationId: this.options.conversationId,
      brandId: this.brandId,
      resolveAlias: (alias) => this.resolveAliasToAssetId(alias),
      ...this.generationPayloadExtras(),
    };
  }

  /**
   * A tool that queues work, run once per conversation for the same arguments (U7); the post it
   * made goes into the message as a card.
   */
  private async onceThenRef(
    tool: string,
    args: Record<string, unknown>,
    callId: string | undefined,
    run: (
      env: TemplateToolEnv,
      args: Record<string, unknown>,
    ) => Promise<{ data: Record<string, unknown>; summary: string; contentId: string }>,
  ) {
    const { repeat, ...rest } = args;
    const key = toolCallKey(tool, { ...rest, brandId: this.brandId });
    const earlier = await this.earlierCall(tool, key, repeat === true);
    if (earlier) {
      return {
        data: {
          ...earlier.data,
          duplicate: true,
          note: "Bu istek bu sohbette zaten kuyruğa alınmıştı; ikinci kez açılmadı. Bitmesini wait_jobs ile bekle. Kullanıcı bilerek bir tane daha isterse repeat: true ile çağır.",
        },
        summary: "zaten kuyrukta",
      };
    }
    const out = await run(this.templateEnv(), rest);
    await this.ledger.put({ key, tool, callId: callId ?? null, data: out.data });
    await this.options.writer
      .setPart({ type: "content_ref", contentId: out.contentId, version: null, note: "Üretiliyor" })
      .catch((error: unknown) => {
        if (error instanceof RunClosedError) throw error;
      });
    return { data: out.data, summary: out.summary };
  }

  /** What the canvas tools use of this turn (canvas-tools.ts). */
  private canvasEnv(): CanvasToolEnv {
    return {
      api: this.options.api,
      signal: this.options.signal,
      conversationId: this.options.conversationId,
      sleep: this.sleep,
      pollMs: Math.min(this.options.jobPollIntervalMs ?? DEFAULT_JOB_POLL_MS, 1_500),
      resolveAlias: (alias) => this.resolveAliasToAssetId(alias),
      picture: (assetId, maxEdge) => this.pictureOf(assetId, maxEdge),
      ...(this.options.imageMaxEdge ? { imageMaxEdge: this.options.imageMaxEdge } : {}),
    };
  }

  // --- safe tools --------------------------------------------------------------------------

  private async runSafe(
    stepId: string,
    name: string,
    runningLabel: string,
    doneLabel: string,
    fn: () => Promise<{
      data: Record<string, unknown>;
      summary: string | null;
      images?: StudioToolImage[];
      /** Label of the finished step when it differs from `doneLabel`. */
      label?: string;
    }>,
  ): Promise<StudioToolExecutionResult> {
    this.options.signal.throwIfAborted();
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name,
      label: runningLabel,
      state: "running",
      summary: null,
    });
    try {
      const { data, summary, images, label } = await fn();
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name,
          label: label ?? doneLabel,
          state: "done",
          summary: summary ? summary.slice(0, 300) : null,
        },
        stepIndex,
      );
      return { data, isError: false, ...(images?.length ? { images } : {}) };
    } catch (error) {
      if (this.options.signal.aborted || error instanceof RunClosedError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`tool ${name} failed: ${msg}`);
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name,
          label: runningLabel,
          state: "error",
          summary: msg.slice(0, 300),
        },
        stepIndex,
      );
      return { data: { ok: false, error: msg.slice(0, 1_000) }, isError: true };
    }
  }

  private async listBrands() {
    const res = await this.options.api.client.brands.list(
      { status: "active", limit: 100 },
      { signal: this.options.signal },
    );
    const brands = res.items.map((b) => ({
      id: b.id,
      name: b.name,
      slug: b.slug,
      defaultLanguage: b.defaultLanguage,
    }));
    const summary = brands.length === 0 ? "Aktif marka yok" : `${brands.length} aktif marka`;
    return { data: { ok: true, brands }, summary };
  }

  private async getBrandProfile(args: Record<string, unknown>) {
    const rawId =
      typeof args.brandId === "string" && args.brandId.trim() ? args.brandId.trim() : null;
    const targetId = rawId ?? this.brandId;
    if (!targetId) {
      throw new Error("Marka seçilmedi; brandId verin veya önce list_brands ile markaları okuyun.");
    }
    const brand = await this.resolveBrand(targetId);
    let profile = null;
    try {
      profile = await this.options.api.client.brandProfiles.current(brand.id, {
        signal: this.options.signal,
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    const summary = profile
      ? `${brand.name} (sürüm ${profile.version})`
      : `${brand.name} (onaylı profil yok)`;
    const pf = profile ? profileFacts(profile.tokens) : null;
    return {
      data: {
        ok: true,
        brand: {
          id: brand.id,
          name: brand.name,
          slug: brand.slug,
          defaultLanguage: brand.defaultLanguage,
        },
        profile: profile
          ? {
              version: profile.version,
              status: profile.status,
              provisional: pf?.provisional ?? false,
              voice: profile.voice,
              designRules: profile.designRules,
              facts: pf?.facts ?? null,
            }
          : null,
      },
      summary,
    };
  }

  private async setConversationBrand(args: Record<string, unknown>) {
    const raw = typeof args.brandId === "string" ? args.brandId.trim() : "";
    if (!raw) throw new Error("brandId gerekli.");
    const brand = await this.resolveBrand(raw);
    const updated = await this.options.api.client.conversations.update(
      this.options.conversationId,
      { brandId: brand.id },
      { signal: this.options.signal },
    );
    this.brandId = updated.brandId;
    return {
      data: {
        ok: true,
        conversationId: updated.id,
        brandId: updated.brandId,
        brandName: brand.name,
      },
      summary: brand.name,
    };
  }

  private async proposePlan(args: Record<string, unknown>) {
    const parsed = ProposePlanInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz plan verisi: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const input = parsed.data;
    let explicitBrandId: string | undefined;
    if (!this.brandId) {
      if (input.brandId) {
        const brand = await this.resolveBrand(input.brandId);
        explicitBrandId = brand.id;
      } else {
        const active = (
          await this.options.api.client.brands.list(
            { status: "active", limit: 100 },
            { signal: this.options.signal },
          )
        ).items;
        if (active.length === 1 && active[0]) {
          explicitBrandId = active[0].id;
        } else {
          throw new Error(
            "Konuşmanın henüz markası yok; brandId belirtin ya da ask_user ile hangi marka olduğunu sorun.",
          );
        }
      }
    }
    const { plan, notes } = convertPlan(input, {
      aliases: this.options.aliases,
      ...(explicitBrandId ? { brandId: explicitBrandId } : {}),
    });
    if (notes.length > 0) {
      this.logger.info(`plan fixes (${this.options.runId}): ${notes.join("; ")}`);
    }
    // N6: near-duplicates of the brand's last months (or of each other) go back to the agent once,
    // before the plan is shown; a second proposal is saved and the API marks what is left.
    const brandForCheck = explicitBrandId ?? this.brandId;
    if (brandForCheck && !this.similarityReturned) {
      const marks = await this.nearDuplicates(brandForCheck, plan).catch((error: unknown) => {
        this.logger.warn(`similarity check skipped: ${(error as Error).message}`);
        return null;
      });
      const flagged = marks?.filter((m) => m.length > 0).length ?? 0;
      if (marks && flagged > 0) {
        this.similarityReturned = true;
        return {
          data: {
            ok: false,
            saved: false,
            reason: "similar",
            message: `Plan henüz gösterilmedi: ${flagged} kalem markanın son aylarındaki içeriklere ya da plandaki başka bir kaleme çok benziyor. Bu kalemleri yeni bir konu ya da kancayla değiştirip propose_plan'ı yeniden çağır. Benzerliği bilerek koruyorsan aynı kalemlerle yeniden çağır; plan kaydedilir ve o kalemler "Benzer" diye işaretlenir.`,
            similar: similarityReport(plan.items, marks),
          },
          summary: `${flagged} kalem geçmişe benziyor; plan düzeltiliyor`,
          label: "Benzer kalemler bulundu",
        };
      }
    }
    const saved = await this.options.writer.putPlan(plan);
    this.openPlan = saved.plan;
    this.brandId = saved.plan.brandId;
    this.outcome.action = "plan";
    this.outcome.planId = saved.plan.id;
    this.outcome.planItems = saved.plan.items.length;
    if (notes.length > 0) this.outcome.planNotes = notes;
    return {
      data: {
        ok: true,
        planId: saved.plan.id,
        brandId: saved.plan.brandId,
        revision: saved.plan.revision,
        status: saved.plan.status,
        itemCount: saved.plan.items.length,
        periodStart: saved.plan.periodStart,
        periodEnd: saved.plan.periodEnd,
        notes,
      },
      summary: `${saved.plan.items.length} post önerildi`,
    };
  }

  /** The brand's planning context for a period (cached for the turn). */
  private async planningContextFor(
    brandId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<PlanningContext> {
    const key = `${brandId}|${periodStart}|${periodEnd}`;
    let pending = this.planningContexts.get(key);
    if (!pending) {
      pending = this.options.api.client.planning.context(
        brandId,
        { periodStart, periodEnd },
        { signal: this.options.signal },
      );
      this.planningContexts.set(key, pending);
      pending.catch(() => this.planningContexts.delete(key));
    }
    return pending;
  }

  /** Near-duplicate marks of a proposed plan's items (history + the plan itself). */
  private async nearDuplicates(brandId: string, plan: PlanProposalPut) {
    const ctx = await this.planningContextFor(brandId, plan.periodStart, plan.periodEnd);
    return planItemSimilarities(
      plan.items.map((item) => ({
        title: item.title,
        hook: item.hook ?? null,
        brief: item.brief ?? "",
        date: item.date ?? null,
      })),
      ctx.history.entries,
    );
  }

  private async getPlanningContext(args: Record<string, unknown>) {
    const parsed = PlanningContextInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz dönem: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const input = parsed.data;
    const period = checkPlanPeriod(input.periodStart, input.periodEnd);
    if (period) throw new Error(`Geçersiz dönem: ${period}`);
    const brandId = input.brandId ? (await this.resolveBrand(input.brandId)).id : this.brandId;
    if (!brandId) {
      throw new Error("Konuşmanın markası yok; brandId ver ya da önce markayı belirle.");
    }
    const ctx = await this.planningContextFor(brandId, input.periodStart, input.periodEnd);
    return {
      data: {
        ok: true,
        brandId,
        periodStart: ctx.periodStart,
        periodEnd: ctx.periodEnd,
        specialDays: specialDaysBlock(ctx),
        history: historyBlock(ctx),
      },
      summary: `${ctx.specialDays.length} özel gün, ${ctx.history.entries.length} geçmiş kayıt`,
    };
  }

  private async askQuestion(args: Record<string, unknown>) {
    const parsed = AskQuestionInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz soru verisi: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const n = ++this.questionSeq;
    const suffix = this.options.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(-8) || "run";
    const questionId = n === 1 ? `q-${suffix}` : `q-${suffix}-${n}`;
    const part = toQuestionPart(parsed.data, questionId);
    if (!part) throw new Error("Soru metni boş olamaz.");
    await this.options.writer.setPart(part);
    if (this.outcome.action === "none") this.outcome.action = "question";
    return {
      data: {
        ok: true,
        questionId: part.questionId,
        mode: part.mode,
        optionCount: part.options?.length ?? 0,
      },
      summary: part.prompt.slice(0, 140),
    };
  }

  private async listContents(args: Record<string, unknown>) {
    const parsed = ListContentsInput.parse(args);
    const brandId = parsed.brandId ?? this.brandId ?? undefined;
    const res = await this.options.api.client.contents.list(
      {
        ...(brandId ? { brandId } : {}),
        ...(parsed.status ? { status: parsed.status } : {}),
        ...(parsed.type ? { type: parsed.type } : {}),
        limit: parsed.limit,
      },
      { signal: this.options.signal },
    );
    const contents = res.items.map((c) => ({
      id: c.id,
      brandId: c.brandId,
      type: c.type,
      title: c.title,
      status: c.status,
      targetPlatforms: c.targetPlatforms,
      caption: c.caption.slice(0, 300),
      currentVersion: c.currentVersion,
      approval: c.approval,
      updatedAt: c.updatedAt,
    }));
    const summary = contents.length === 0 ? "Kayıtlı post yok" : `${contents.length} post okundu`;
    return { data: { ok: true, contents }, summary };
  }

  private async getContent(args: Record<string, unknown>) {
    const parsed = GetContentInput.parse(args);
    parsed.contentId = await this.contentRef(parsed.contentId);
    const content = await this.options.api.client.contents.get(parsed.contentId, {
      signal: this.options.signal,
    });
    const verNum = parsed.version ?? content.currentVersion?.version;
    const version = verNum
      ? await this.options.api.client.contents.versions.get(parsed.contentId, verNum, {
          signal: this.options.signal,
        })
      : null;
    const summary = `${content.title} (${content.status}${version ? `, s${version.version}` : ""})`;
    return {
      data: {
        ok: true,
        content,
        version: version
          ? {
              id: version.id,
              version: version.version,
              origin: version.origin,
              contentHash: version.contentHash,
              slideCount: version.slideCount,
              note: version.note,
              slides: version.slides.map((s, i) => ({
                index: i + 1,
                width: s.width,
                height: s.height,
                renderedAssetId: s.renderedAssetId,
                htmlPreview: s.html.slice(0, 1_500),
              })),
            }
          : null,
      },
      summary,
    };
  }

  /** Question card, then wait for the owner's answer (or give up after the timeout). */
  private async askUser(args: Record<string, unknown>) {
    const parsed = AskUserInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz soru verisi: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const input = parsed.data;
    const mode = input.options.length >= 2 ? (input.multiple ? "multiple" : "single") : "text";
    const n = ++this.questionSeq;
    const suffix = this.options.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(-8) || "run";
    const questionId = n === 1 ? `q-${suffix}` : `q-${suffix}-${n}`;
    const part = toQuestionPart(
      {
        prompt: input.question,
        mode,
        options: input.options.map((o, i) => ({
          id: o.id?.trim() || `secenek-${i + 1}`,
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        allowText: mode === "text" ? false : input.allowText,
      },
      questionId,
    );
    if (!part) throw new Error("Soru metni boş olamaz.");
    await this.options.writer.setPart(part);
    if (this.outcome.action === "none") this.outcome.action = "question";

    const pollMs = Math.max(this.options.consentPollIntervalMs ?? 1_000, 100);
    // A wait, not a business date: the real clock (the injected `now` may be frozen in tests).
    const deadline = Date.now() + (this.options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS);
    return this.idle(() => this.pollAnswer(questionId, pollMs, deadline));
  }

  /** `ask_user`'s wait for the answer (a turn wait: U1, U6). */
  private async pollAnswer(questionId: string, pollMs: number, deadline: number) {
    for (;;) {
      this.options.signal.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          data: {
            ok: true,
            answered: false,
            questionId,
            note: "Kullanıcı henüz cevaplamadı. Turu şimdi tek kısa cümleyle bitir; cevap gelince yeni bir tur başlar.",
          },
          summary: "Cevap gelmedi; tur bitiyor",
          label: "Cevap beklenmedi",
        };
      }
      await this.sleep(Math.min(pollMs, remaining), this.options.signal);
      const snapshot = await this.options.api.client.workerTurns.message(this.options.runId, {
        signal: this.options.signal,
      });
      if (["cancelled", "failed", "completed"].includes(snapshot.run.status)) {
        throw new RunClosedError(`run ${this.options.runId} is ${snapshot.run.status}`);
      }
      const card = snapshot.message?.parts.find(
        (p) => p.type === "question" && p.questionId === questionId,
      );
      if (card?.type !== "question" || !card.answer) continue;
      const labels = card.answer.optionIds.map(
        (id) => card.options.find((o) => o.id === id)?.label ?? id,
      );
      const said = [...labels, card.answer.text ?? ""].filter(Boolean).join(", ");
      if (this.outcome.action === "question") this.outcome.action = "none";
      return {
        data: {
          ok: true,
          answered: true,
          questionId,
          optionIds: card.answer.optionIds,
          labels,
          text: card.answer.text,
        },
        summary: said.slice(0, 140) || "Cevap alındı",
      };
    }
  }

  private async aliasList() {
    return (
      await this.options.api.client.conversations.aliases.list(this.options.conversationId, {
        signal: this.options.signal,
      })
    ).items;
  }

  /** Download an asset and shrink it for the model; null when it is not a picture. */
  private async pictureOf(assetId: string, maxEdge: number): Promise<StudioToolImage | null> {
    const { bytes } = await this.options.api.downloadAsset(assetId, {
      maxBytes: 25 * 1024 * 1024,
      signal: this.options.signal,
    });
    const image = await prepareModelImage(bytes, { maxEdge });
    return image
      ? { mediaType: image.mediaType, data: Buffer.from(image.data).toString("base64") }
      : null;
  }

  private async listAliases(args: Record<string, unknown>) {
    const parsed = ListAliasesInput.parse(args);
    const list = await this.aliasList();
    const aliases = list.map((a) => ({
      alias: a.alias,
      previousAliases: a.previousAliases,
      kind: a.kind,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      filename: a.filename,
    }));
    const images: StudioToolImage[] = [];
    const shown: string[] = [];
    if (parsed.withThumbnails) {
      for (const a of list.filter((x) => x.kind === "image").slice(0, 8)) {
        const picture = await this.pictureOf(a.assetId, 384).catch(() => null);
        if (picture) {
          images.push(picture);
          shown.push(a.alias);
        }
      }
    }
    return {
      data: {
        ok: true,
        aliases,
        ...(parsed.withThumbnails ? { thumbnailsInOrder: shown.map((x) => `@${x}`) } : {}),
      },
      summary:
        list.length === 0 ? "Sohbette görsel yok" : list.map((a) => `@${a.alias}`).join(", "),
      images,
    };
  }

  /** N12: the brand's library by Vision tags, text, colours and name (or similar pictures). */
  private async searchMedia(args: Record<string, unknown>) {
    const parsed = SearchMediaInput.parse(args);
    const brandId = parsed.brandId ? (await this.resolveBrand(parsed.brandId)).id : this.brandId;
    if (!brandId) throw new Error("Medya araması için marka seçilmedi; brandId belirtin.");
    const init = { signal: this.options.signal };
    let found: { asset: Asset; similarity?: number }[];
    let note: string | null = null;
    if (parsed.similarTo) {
      const id = parsed.similarTo.startsWith("@")
        ? await this.resolveAliasToAssetId(parsed.similarTo)
        : parsed.similarTo;
      const res = await this.options.api.client.assets.similar(id, { limit: 30 }, init);
      found = res.items.map((i) => ({ asset: i.asset, similarity: i.similarity }));
      note = res.note;
    } else {
      const res = await this.options.api.client.assets.list(
        {
          brandId,
          limit: 100,
          ...(parsed.query ? { q: parsed.query } : {}),
          ...(parsed.kind ? { kind: parsed.kind } : {}),
        },
        init,
      );
      found = res.items.map((asset) => ({ asset }));
    }
    const pictures = found
      .filter(({ asset }) => asset.brandId === brandId)
      .filter(({ asset }) => asset.kind === "image" || asset.kind === "logo")
      .filter(({ asset }) => asset.mimeType.startsWith("image/"))
      .filter(({ asset }) => !parsed.kind || asset.kind === parsed.kind)
      .filter(
        ({ asset }) => !parsed.orientation || asset.analysis?.orientation === parsed.orientation,
      )
      .filter(({ asset }) => !parsed.cutoutOnly || asset.analysis?.isCutout === true)
      .slice(0, parsed.limit);
    const results = pictures.map(({ asset, similarity }) => {
      const a = asset.analysis;
      return {
        assetId: asset.id,
        filename: asset.originalFilename,
        kind: asset.kind,
        source: asset.source,
        width: asset.width,
        height: asset.height,
        createdAt: asset.createdAt,
        ...(similarity !== undefined ? { similarity: Math.round(similarity * 100) / 100 } : {}),
        analyzed: Boolean(a && a.status !== "failed"),
        ...(a
          ? {
              tags: a.tags.slice(0, 8).map((t) => t.label),
              text: a.text.slice(0, 200),
              colors: a.colors.map((c) => c.name),
              orientation: a.orientation,
              isCutout: a.isCutout,
              isLogoLike: a.isLogoLike,
              ...(a.caption ? { caption: a.caption } : {}),
            }
          : {}),
      };
    });
    const images: StudioToolImage[] = [];
    const shown: string[] = [];
    if (parsed.withThumbnails) {
      for (const { asset } of pictures.slice(0, 6)) {
        const picture = await this.pictureOf(asset.id, 384).catch(() => null);
        if (picture) {
          images.push(picture);
          shown.push(asset.id);
        }
      }
    }
    const unanalyzed = results.filter((r) => !r.analyzed).length;
    return {
      data: {
        ok: true,
        brandId,
        ...(parsed.query ? { query: parsed.query } : {}),
        ...(parsed.similarTo ? { similarTo: parsed.similarTo } : {}),
        count: results.length,
        results,
        ...(parsed.withThumbnails ? { thumbnailsInOrder: shown } : {}),
        ...(note ? { note } : {}),
        ...(unanalyzed > 0
          ? {
              hint: `${unanalyzed} görsel henüz okunmadı (etiketsiz); yalnızca dosya adıyla bulunur.`,
            }
          : {}),
      },
      summary:
        results.length === 0
          ? (note ?? "Eşleşen görsel yok")
          : `${results.length} görsel bulundu${parsed.query ? ` (“${parsed.query}”)` : ""}`,
      ...(images.length > 0 ? { images } : {}),
    };
  }

  private async viewAlias(args: Record<string, unknown>) {
    const { alias } = ViewAliasInput.parse(args);
    const cleaned = alias.replace(/^@/, "").toLowerCase();
    const match = (await this.aliasList()).find(
      (a) => a.alias === cleaned || a.previousAliases.includes(cleaned),
    );
    if (!match) throw new Error(`Görsel takma adı bulunamadı: @${cleaned}`);
    const picture = await this.pictureOf(match.assetId, this.options.imageMaxEdge ?? 1568);
    if (!picture) throw new Error(`@${match.alias} bir görsel değil (${match.mimeType}).`);
    return {
      data: {
        ok: true,
        alias: match.alias,
        mimeType: match.mimeType,
        width: match.width,
        height: match.height,
        filename: match.filename,
      },
      summary: `@${match.alias}`,
      label: `@${match.alias} görseline bakıldı`,
      images: [picture],
    };
  }

  private async viewPost(args: Record<string, unknown>) {
    const parsed = ViewPostInput.parse(args);
    parsed.contentId = await this.contentRef(parsed.contentId);
    const content = await this.options.api.client.contents.get(parsed.contentId, {
      signal: this.options.signal,
    });
    const versionNumber = parsed.version ?? content.currentVersion?.version;
    if (!versionNumber) throw new Error(`"${content.title}" postunun henüz tasarımı yok.`);
    const version = await this.options.api.client.contents.versions.get(
      parsed.contentId,
      versionNumber,
      { signal: this.options.signal },
    );
    const images: StudioToolImage[] = [];
    const missing: number[] = [];
    for (const [i, slide] of version.slides.slice(0, 10).entries()) {
      const picture = slide.renderedAssetId
        ? await this.pictureOf(slide.renderedAssetId, 1080).catch(() => null)
        : null;
      if (picture) images.push(picture);
      else missing.push(i + 1);
    }
    return {
      data: {
        ok: true,
        contentId: content.id,
        title: content.title,
        status: content.status,
        version: version.version,
        slideCount: version.slideCount,
        shownSlides: images.length,
        ...(missing.length ? { notRendered: missing } : {}),
        note: version.note,
      },
      summary: `${content.title} · s${version.version} · ${images.length} slayt`,
      images,
    };
  }

  private generationPayloadExtras(): Pick<ContentGeneratePayload, "model" | "effort"> {
    const choice = this.options.generationChoice;
    return {
      ...(choice?.model ? { model: choice.model } : {}),
      ...(choice?.effort ? { effort: choice.effort } : {}),
    };
  }

  private async generatePost(args: Record<string, unknown>, callId?: string, stepId = "step") {
    const parsed = GeneratePostInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz üretim isteği: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const input = parsed.data;
    if (input.planItemId) {
      const has = (p: Plan) => p.items.some((i) => i.id === input.planItemId);
      let plan = this.openPlan && has(this.openPlan) ? this.openPlan : undefined;
      if (!plan) {
        const listed = (
          await this.options.api.client.plans.list(
            { conversationId: this.options.conversationId, limit: 20 },
            { signal: this.options.signal },
          )
        ).items;
        plan = listed.find(has);
      }
      if (!plan) throw new Error(`Plan kalemi bulunamadı: ${input.planItemId}`);
      const item = plan.items.find((i) => i.id === input.planItemId);
      if (plan.status !== "accepted" || item?.status !== "accepted") {
        throw new Error(
          "Plan henüz kabul edilmedi; önce accept_and_generate_plan ile (izin kartıyla) planı kabul et.",
        );
      }
      const planEngine = input.engine
        ? await this.engineFor(plan.brandId, input.engine)
        : undefined;
      // The item's "AI görsel" slot: one paid-consent card, the picture after the design.
      const planSlot =
        item.imageSlot === "ai_generate" && item.contentType !== "reel" && input.aiImage
          ? await this.slotImageConsent(stepId, {
              brandId: plan.brandId,
              posts: 1,
              title: item.title,
              imageBrief: item.imageBrief ?? null,
              products: input.products,
              view: input.imageView,
              style: input.imageStyle,
            })
          : null;
      const gen = await this.options.api.client.plans.generate(
        plan.id,
        {
          itemIds: [input.planItemId],
          ...(input.instructions ? { instructions: input.instructions } : {}),
          ...this.generationPayloadExtras(),
          ...(planEngine ? { engine: planEngine } : {}),
          ...(planSlot?.request ? { slotImage: planSlot.request } : {}),
        },
        { signal: this.options.signal },
      );
      this.openPlan = gen.plan;
      return {
        data: {
          ok: true,
          planId: plan.id,
          contentId: item.contentId,
          jobIds: gen.jobs.map((j) => j.id),
          note:
            gen.jobs.length === 0 ? "Bu kalemin üretimi zaten sürüyor ya da sırada." : undefined,
          ...(planSlot ? { slotImage: planSlot.result } : {}),
        },
        summary: `${item.title} · ${gen.jobs.length} iş`,
      };
    }
    const brandId = this.brandId;
    if (!brandId) throw new Error("Konuşmanın markası yok; önce set_conversation_brand kullan.");
    const engine = await this.engineFor(brandId, input.engine);
    const productIds: string[] = [];
    for (const ref of input.products) {
      const product = await this.productRef(ref, brandId);
      if (!productIds.includes(product.id)) productIds.push(product.id);
    }
    const title = input.title || (input.brief ?? "").split("\n")[0]?.slice(0, 80) || "Yeni post";
    const platforms = input.platforms ?? ["instagram"];
    // The same brief again (a continued turn, a repeated call) does not make a second post (U7).
    const key = toolCallKey("generate_post", {
      brandId,
      type: input.type,
      title,
      brief: input.brief ?? "",
      platforms,
      imageSlot: input.imageSlot,
      imageBrief: input.imageBrief,
      instructions: input.instructions,
      ...(engine ? { engine } : {}),
      ...(input.variants > 1 ? { variants: input.variants } : {}),
      ...(productIds.length ? { productIds } : {}),
      ...(input.imageView ? { imageView: input.imageView } : {}),
      ...(input.imageStyle !== undefined ? { imageStyle: input.imageStyle } : {}),
    });
    const earlier = await this.earlierCall("generate_post", key, input.repeat);
    if (earlier) {
      return {
        data: {
          ...earlier.data,
          duplicate: true,
          note: "Bu post bu sohbette zaten üretime alınmıştı; ikinci kez açılmadı. Bitmesini wait_jobs ile bekle. Kullanıcı bilerek bir tane daha isterse repeat: true ile çağır.",
        },
        summary: `${title} · zaten üretimde`,
      };
    }
    // The "AI görsel" slot: one paid-consent card for every variant's picture (asked with the
    // post request); declined, the posts are made with the slot left empty.
    const slot =
      input.imageSlot === "ai_generate" && input.aiImage
        ? await this.slotImageConsent(stepId, {
            brandId,
            posts: input.variants,
            title,
            imageBrief: input.imageBrief ?? null,
            products: input.products,
            view: input.imageView,
            style: input.imageStyle,
          })
        : null;
    // Each variant is its own post and job; they arrive in the chat one by one.
    const contentIds: string[] = [];
    const jobIds: string[] = [];
    for (let index = 1; index <= input.variants; index++) {
      const variantTitle =
        input.variants > 1 ? `${title} · Varyant ${index}/${input.variants}`.slice(0, 200) : title;
      const content = await this.options.api.client.contents.create(
        {
          brandId,
          type: input.type,
          title: variantTitle,
          brief: input.brief ?? "",
          targetPlatforms: platforms,
        },
        { signal: this.options.signal },
      );
      const payload: ContentGeneratePayload = {
        brandId,
        contentId: content.id,
        title: variantTitle,
        brief: input.brief ?? "",
        type: input.type,
        targetPlatforms: platforms,
        ...(input.imageSlot ? { imageSlot: input.imageSlot } : {}),
        ...(input.imageBrief ? { imageBrief: input.imageBrief } : {}),
        conversationId: this.options.conversationId,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...this.generationPayloadExtras(),
        ...(engine ? { engine } : {}),
        ...(input.variants > 1 ? { variants: input.variants, variantIndex: index } : {}),
        ...(productIds.length ? { productIds } : {}),
        ...(slot?.request ? { slotImage: slot.request } : {}),
      };
      const job = await this.options.api.client.jobs.create(
        { type: "content.generate", brandId, contentId: content.id, payload },
        { signal: this.options.signal },
      );
      contentIds.push(content.id);
      jobIds.push(job.id);
      await this.options.writer
        .setPart({ type: "content_ref", contentId: content.id, version: null, note: "Üretiliyor" })
        .catch((error: unknown) => {
          if (error instanceof RunClosedError) throw error;
        });
    }
    const data = {
      ok: true,
      contentId: contentIds[0],
      jobIds,
      ...(input.variants > 1 ? { contentIds, variants: input.variants } : {}),
      ...(slot ? { slotImage: slot.result } : {}),
    };
    await this.ledger.put({ key, tool: "generate_post", callId: callId ?? null, data });
    return {
      data,
      summary: `${title} · ${jobIds.length} iş`,
    };
  }

  /**
   * The paid "AI görsel" of a post's slot (docs/URETIM-RESIM.md §11): one consent card, asked
   * with the post request, covers every variant's slot picture. Allowed: the `slotImage` request
   * the generation carries (the worker queues the product-image job once the design exists);
   * declined or expired: null, and the slot stays empty.
   */
  private async slotImageConsent(
    stepId: string,
    input: {
      brandId: string;
      posts: number;
      title: string;
      imageBrief: string | null;
      products: readonly string[];
      view?: string | undefined;
      style?: string | undefined;
    },
  ): Promise<{
    request: SlotImageRequest | null;
    result: { consented: boolean; note: string; products?: string[] };
  }> {
    const tool = "generate_post";
    const id = `${stepId}-image`.slice(0, 64);
    const runningLabel = "AI görsel için izin bekleniyor…";
    const doneLabel = "AI görsel izni";
    const products: BrandProduct[] = [];
    for (const ref of input.products) {
      const product = await this.productRef(ref, input.brandId);
      if (!products.some((p) => p.id === product.id)) products.push(product);
    }
    const shown = products.slice(0, 4);
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: null,
    });
    const model = this.options.imageModel ?? "gemini-nano-banana-2.1";
    const decision = await this.awaitConsent({
      tool,
      title:
        shown.length > 0
          ? "Ürün görseli de üreteyim mi? (ücretli)"
          : "Post için AI görsel de üreteyim mi? (ücretli)",
      detail: slotImageConsentDetail({
        model,
        posts: input.posts,
        products: shown.map((p) => p.name),
        prompt: input.imageBrief || input.title,
        references: shown.reduce((n, p) => n + Math.min(3, p.imageAssetIds.length), 0),
      }),
      stepId: id,
      stepIndex,
      doneLabel,
    });
    if (!decision.allowed) {
      return {
        request: null,
        result: { consented: false, note: SLOT_IMAGE_DECLINED_NOTE },
      };
    }
    await this.options.writer.setPart(
      {
        type: "tool_step",
        id,
        name: tool,
        label: doneLabel,
        state: "done",
        summary:
          input.posts > 1
            ? `${input.posts} görsel, tasarımlar hazır olunca üretilecek`
            : "Görsel, tasarım hazır olunca üretilecek",
      },
      stepIndex,
    );
    return {
      request: {
        consented: true,
        ...(shown.length > 0 ? { productIds: shown.map((p) => p.id) } : {}),
        ...(input.view ? { view: input.view } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        conversationId: this.options.conversationId,
      },
      result: {
        consented: true,
        note: SLOT_IMAGE_ALLOWED_NOTE,
        ...(shown.length > 0 ? { products: shown.map((p) => p.name) } : {}),
      },
    };
  }

  /**
   * The engine of a generation: the owner's choice, else the brand's default; undefined = HTML
   * (left out of the payload). A not-ready engine fails here, never falls back to HTML.
   */
  private async engineFor(
    brandId: string,
    requested: GenerationEngine | undefined,
  ): Promise<GenerationEngine | undefined> {
    let engine = requested;
    if (!engine) {
      try {
        const brand = await this.options.api.client.brands.get(brandId, {
          signal: this.options.signal,
        });
        engine = brand.defaultEngine ?? undefined;
      } catch (error) {
        this.options.signal.throwIfAborted();
        this.logger.warn(`brand ${brandId}: default engine unknown (${(error as Error).message})`);
      }
    }
    if (!engine) return undefined;
    const notReady = engineNotReadyError(engine);
    if (notReady) {
      throw new Error(
        `${notReady}. Kullanıcıya söyle ve şimdilik HTML motoruyla üretmeyi öner (engine: "html").`,
      );
    }
    return engine;
  }

  /** The brand's products with their @names (oldest first). */
  private async productsOf(brandId: string): Promise<BrandProduct[]> {
    const out: BrandProduct[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await this.options.api.client.brandProducts.list(
        brandId,
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { signal: this.options.signal },
      );
      out.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  /** A product by `@name`, name or id. */
  private async productRef(raw: string, brandId: string): Promise<BrandProduct> {
    const cleaned = raw.trim().replace(/^@/, "");
    const lower = cleaned.toLocaleLowerCase("tr-TR");
    const products = await this.productsOf(brandId);
    const hit =
      products.find((p) => p.id === cleaned) ??
      products.find((p) => p.slug === lower) ??
      products.find((p) => p.name.toLocaleLowerCase("tr-TR") === lower);
    if (!hit) throw new Error(`Ürün bulunamadı: @${cleaned} (list_products ile bak).`);
    return hit;
  }

  /** A post by `@name` (its mention name) or id; anything else is passed on as an id. */
  private async contentRef(raw: string): Promise<string> {
    const cleaned = raw.trim().replace(/^@/, "");
    if (!this.brandId || !/^[a-z][a-z0-9-]*$/.test(cleaned)) return cleaned;
    try {
      const { items } = await this.options.api.client.brands.mentionCandidates(this.brandId, {
        signal: this.options.signal,
      });
      return items.find((c) => c.kind === "content" && c.slug === cleaned)?.id ?? cleaned;
    } catch (error) {
      this.options.signal.throwIfAborted();
      if (error instanceof ApiError) return cleaned;
      throw error;
    }
  }

  private async listProducts(args: Record<string, unknown>) {
    const parsed = ListProductsInput.parse(args);
    const brandId = parsed.brandId ? (await this.resolveBrand(parsed.brandId)).id : this.brandId;
    if (!brandId) throw new Error("Konuşmanın markası yok; önce set_conversation_brand kullan.");
    const products = await this.productsOf(brandId);
    return {
      data: {
        ok: true,
        products: products.map((p) => ({
          id: p.id,
          mention: p.slug ? `@${p.slug}` : null,
          name: p.name,
          category: p.category,
          description: p.description,
          photos: p.imageAssetIds.length,
        })),
      },
      summary: `${products.length} ürün`,
    };
  }

  private async getProduct(args: Record<string, unknown>) {
    const parsed = GetProductInput.parse(args);
    const brandId = this.brandId;
    if (!brandId) throw new Error("Konuşmanın markası yok; önce set_conversation_brand kullan.");
    const product = await this.productRef(parsed.product, brandId);
    const photos = [];
    const images: StudioToolImage[] = [];
    for (const photo of await this.productPhotoRefs(product)) {
      // Is it good enough to work from (docs/URETIM-RESIM.md §13)? Measured here, on this Mac.
      const quality = await this.photoQuality(photo.assetId);
      photos.push({
        ...photo,
        ...(quality
          ? {
              quality: {
                lowQuality: quality.lowQuality,
                reasons: quality.reasons,
                sharpness: quality.sharpness,
                brightness: quality.brightness,
              },
            }
          : {}),
      });
      if (parsed.withPhotos && images.length < 8) {
        const picture = await this.pictureOf(photo.assetId, 768);
        if (picture) images.push(picture);
      }
    }
    const lowQuality = photos.filter((p) => p.quality?.lowQuality);
    return {
      data: {
        ok: true,
        product: {
          id: product.id,
          mention: product.slug ? `@${product.slug}` : null,
          name: product.name,
          description: product.description,
          category: product.category,
          tags: product.tags,
          notes: product.notes,
        },
        photos,
        ...(lowQuality.length > 0
          ? {
              lowQualityPhotos: lowQuality.map((p) => p.assetId),
              note: `Bu ürünün ${lowQuality.length} fotoğrafı kalitesiz (${[
                ...new Set(lowQuality.flatMap((p) => p.quality?.reasons ?? [])),
              ].join(
                ", ",
              )}). Kullanıcıya ask_user ile "Bu ürünün resmi kalitesiz, kalitesini artırayım mı?" diye sor; evet derse upgrade_product_photo.`,
            }
          : {}),
      },
      summary: `${product.name} · ${photos.length} fotoğraf${lowQuality.length > 0 ? ` · ${lowQuality.length} kalitesiz` : ""}`,
      ...(images.length ? { images } : {}),
    };
  }

  /** A product's photos still in the library, with the side each shows (by file name). */
  private async productPhotoRefs(
    product: BrandProduct,
  ): Promise<
    (ProductPhotoRef & { filename: string | null; width: number | null; height: number | null })[]
  > {
    const out = [];
    for (const [position, assetId] of product.imageAssetIds.entries()) {
      const asset = await this.options.api.client.assets
        .get(assetId, { signal: this.options.signal })
        .catch((error: unknown) => {
          this.options.signal.throwIfAborted();
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        });
      if (!asset || asset.deletedAt) continue;
      out.push({
        assetId,
        position,
        filename: asset.originalFilename ?? null,
        width: asset.width,
        height: asset.height,
        angleHint: productPhotoAngle(asset.originalFilename ?? null),
      });
    }
    return out;
  }

  /** Resolution and sharpness of a photo (null: it could not be read). */
  private async photoQuality(assetId: string): Promise<PhotoQuality | null> {
    try {
      const { bytes } = await this.options.api.downloadAsset(assetId, {
        maxBytes: 25 * 1024 * 1024,
        signal: this.options.signal,
      });
      return await assessPhotoQuality(bytes);
    } catch (error) {
      this.options.signal.throwIfAborted();
      this.logger.warn(`photo quality of ${assetId}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * `upgrade_product_photo` (docs/URETIM-RESIM.md §13): after the owner said yes to "Bu ürünün
   * resmi kalitesiz, kalitesini artırayım mı?", a paid generation (consent card) of the same
   * product on a clean white background in studio light, read and checked like every product
   * picture. Its result is a `product_photo_upgrade` approval request in this chat: approved, it
   * replaces the photo (the old one stays 30 days in the trash).
   */
  private async upgradeProductPhoto(
    stepId: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<StudioToolExecutionResult> {
    const tool = "upgrade_product_photo";
    const runningLabel = "Ürün fotoğrafı iyileştirme için izin bekleniyor…";
    const doneLabel = "Ürün fotoğrafı iyileştirme kuyruğa alındı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: null,
    });
    try {
      const parsed = UpgradeProductPhotoInput.parse(args);
      const brandId = this.brandId;
      if (!brandId) throw new Error("Konuşmanın markası yok; önce set_conversation_brand kullan.");
      const product = await this.productRef(parsed.product, brandId);
      const photos = await this.productPhotoRefs(product);
      if (photos.length === 0) throw new Error(`"${product.name}" ürününün fotoğrafı yok.`);
      let target = parsed.assetId ? photos.find((p) => p.assetId === parsed.assetId) : undefined;
      if (parsed.assetId && !target) {
        throw new Error(`Bu fotoğraf "${product.name}" ürününün değil: ${parsed.assetId}`);
      }
      let quality: PhotoQuality | null = null;
      if (!target) {
        // The worst photo (low quality first, then the least sharp), else the cover.
        let worst: { photo: (typeof photos)[number]; q: PhotoQuality } | null = null;
        for (const photo of photos) {
          const q = await this.photoQuality(photo.assetId);
          if (!q) continue;
          const worse =
            !worst ||
            (q.lowQuality && !worst.q.lowQuality) ||
            (q.lowQuality === worst.q.lowQuality && q.sharpness < worst.q.sharpness);
          if (worse) worst = { photo, q };
        }
        target = worst?.photo ?? photos[0];
        quality = worst?.q ?? null;
      } else {
        quality = await this.photoQuality(target.assetId);
      }
      if (!target) throw new Error(`"${product.name}" ürününün fotoğrafı yok.`);

      const payload = {
        prompt: parsed.notes || "Aynı ürünün profesyonel stüdyo çekimi.",
        aspectRatio: "1:1" as const,
        imageSize: "2K" as const,
        referenceAssetIds: [target.assetId],
        preserveProductLabel: false,
        productIds: [product.id],
        style: "",
        approval: {
          kind: "product_photo_upgrade" as const,
          conversationId: this.options.conversationId,
          productId: product.id,
          replacesAssetId: target.assetId,
        },
      };
      const key = toolCallKey(tool, { brandId, ...payload });
      const earlier = await this.earlierCall(tool, key, parsed.repeat);
      if (earlier) {
        await this.options.writer.setPart(
          {
            type: "tool_step",
            id: stepId,
            name: tool,
            label: "Ürün fotoğrafı zaten iyileştiriliyor",
            state: "done",
            summary: "Aynı istek bu sohbette zaten çalıştı; ikinci kez ücret ödenmedi",
          },
          stepIndex,
        );
        return {
          data: {
            ...earlier.data,
            duplicate: true,
            note: "Bu fotoğraf bu sohbette zaten iyileştirmeye alınmıştı; ikinci kez ücret ödenmedi. Kullanıcı bilerek bir kez daha isterse repeat: true ile çağır.",
          },
          isError: false,
        };
      }

      const model = this.options.imageModel ?? "gemini-nano-banana-2.1";
      const decision = await this.awaitConsent({
        tool,
        title: `"${product.name}" fotoğrafını iyileştir (ücretli)`,
        detail: [
          quality?.lowQuality ? `Fotoğraf kalitesiz: ${quality.reasons.join(", ")}.` : "",
          "Beyaz zeminde, stüdyo ışığında, yüksek çözünürlüklü yeni bir ürün fotoğrafı üretilir; ürün birebir korunur ve yapay zekâ kontrol eder. Onaylarsan ürünün fotoğrafı değişir, eskisi 30 gün çöpte durur.",
          aiImageConsentDetail({
            model,
            prompt: payload.prompt,
            aspectRatio: payload.aspectRatio,
            imageSize: payload.imageSize,
            references: 1,
            preserveLabel: false,
          }),
        ]
          .filter(Boolean)
          .join("\n"),
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) return { data: decision, isError: false };

      const job = await this.options.api.client.jobs.create(
        { type: "image.generate", brandId, payload },
        { signal: this.options.signal },
      );
      const data = {
        ok: true,
        jobId: job.id,
        brandId,
        status: job.status,
        productId: product.id,
        replacesAssetId: target.assetId,
        ...(quality
          ? { quality: { lowQuality: quality.lowQuality, reasons: quality.reasons } }
          : {}),
        note: "Yeni fotoğraf hazır olunca kontrol raporuyla bu sohbete onay kartı olarak düşecek ve kullanıcıya 'Olmuş mu?' diye sorulacak. Onaylanırsa ürünün fotoğrafı değişir.",
      };
      await this.ledger.put({ key, tool, callId: callId ?? null, data });
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: `Ürün fotoğrafı işi (${job.id})`,
        },
        stepIndex,
      );
      return { data: { allowed: true, ...data }, isError: false };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  private async generateReel(args: Record<string, unknown>, callId?: string) {
    const parsed = GenerateReelInput.safeParse(args);
    if (!parsed.success) {
      throw new Error(`Geçersiz Reels isteği: ${z.prettifyError(parsed.error).slice(0, 300)}`);
    }
    const input = parsed.data;
    const recipeWords = {
      motion_graphics: "Reels tarifi: hareketli grafik (motion_graphics).",
      footage_edit: "Reels tarifi: çekim kurgusu (footage).",
      narration: "Reels tarifi: seslendirmeli anlatım (narration).",
    } as const;
    if (input.planItemId) {
      // The plan path creates the job; the recipe travels in the instructions.
      return this.generatePost({
        planItemId: input.planItemId,
        aiImage: false,
        instructions: [input.recipe ? recipeWords[input.recipe] : "", input.instructions ?? ""]
          .filter(Boolean)
          .join(" "),
      });
    }
    const brandId = this.brandId;
    if (!brandId) throw new Error("Konuşmanın markası yok; önce set_conversation_brand kullan.");
    const clipAssetId = input.clipAlias
      ? await this.resolveAliasToAssetId(input.clipAlias)
      : undefined;
    const heroAssetId = input.imageAlias
      ? await this.resolveAliasToAssetId(input.imageAlias)
      : undefined;
    const audioAssetId = input.audioAlias
      ? await this.resolveAliasToAssetId(input.audioAlias)
      : undefined;
    const brief = input.brief ?? "";
    const title = input.title || brief.split("\n")[0]?.slice(0, 80) || "Yeni Reels";
    const platforms = input.platforms ?? ["instagram"];
    // The same Reels brief again does not make a second Reels (U7).
    const key = toolCallKey("generate_reel", {
      brandId,
      title,
      brief,
      platforms,
      recipe: input.recipe,
      clipAssetId,
      heroAssetId,
      audioAssetId,
      durationSec: input.durationSec,
      instructions: input.instructions,
    });
    const earlier = await this.earlierCall("generate_reel", key, input.repeat);
    if (earlier) {
      return {
        data: {
          ...earlier.data,
          duplicate: true,
          note: "Bu Reels bu sohbette zaten üretime alınmıştı; ikinci kez açılmadı. Kullanıcı bilerek bir tane daha isterse repeat: true ile çağır.",
        },
        summary: `${title} · zaten üretimde`,
      };
    }
    const content = await this.options.api.client.contents.create(
      { brandId, type: "reel", title, brief, targetPlatforms: platforms },
      { signal: this.options.signal },
    );
    const payload: ContentGeneratePayload = {
      brandId,
      contentId: content.id,
      title,
      brief,
      type: "reel",
      targetPlatforms: platforms,
      conversationId: this.options.conversationId,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      reel: {
        ...(input.recipe ? { recipe: input.recipe } : {}),
        ...(clipAssetId ? { clipAssetId } : {}),
        ...(heroAssetId ? { heroAssetId } : {}),
        ...(audioAssetId ? { audioAssetId } : {}),
        ...(input.durationSec ? { durationSec: input.durationSec } : {}),
      },
      ...this.generationPayloadExtras(),
    };
    const job = await this.options.api.client.jobs.create(
      { type: "content.generate", brandId, contentId: content.id, payload },
      { signal: this.options.signal },
    );
    const data = {
      ok: true,
      contentId: content.id,
      jobIds: [job.id],
      recipe: input.recipe ?? "otomatik",
    };
    await this.ledger.put({ key, tool: "generate_reel", callId: callId ?? null, data });
    await this.options.writer
      .setPart({
        type: "content_ref",
        contentId: content.id,
        version: null,
        note: "Reels üretiliyor",
      })
      .catch((error: unknown) => {
        if (error instanceof RunClosedError) throw error;
      });
    return {
      data,
      summary: `${title} · Reels · 1 iş`,
    };
  }

  private async waitJobs(args: Record<string, unknown>) {
    // Waiting for other jobs is a turn wait: the clock stops, the Claude slot is free (U1, U6).
    return this.idle(() => this.waitJobsNow(args));
  }

  private async waitJobsNow(args: Record<string, unknown>) {
    const parsed = WaitJobsInput.parse(args);
    const pollMs = this.options.jobPollIntervalMs ?? DEFAULT_JOB_POLL_MS;
    const deadline = Date.now() + parsed.timeoutSec * 1000;
    let jobs: Job[] = [];
    for (;;) {
      this.options.signal.throwIfAborted();
      jobs = await Promise.all(
        parsed.jobIds.map((id) =>
          this.options.api.client.jobs.get(id, { signal: this.options.signal }),
        ),
      );
      if (jobs.every((j) => isTerminalJobStatus(j.status))) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(pollMs, remaining), this.options.signal);
    }
    const done = jobs.filter((j) => j.status === "succeeded").length;
    const finished = jobs.every((j) => isTerminalJobStatus(j.status));
    return {
      data: {
        ok: true,
        finished,
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          contentId: j.contentId ?? null,
          ...(j.progressMessage ? { progress: j.progressMessage } : {}),
          ...(j.error ? { error: j.error.slice(0, 500) } : {}),
          ...(j.output ? { output: j.output } : {}),
        })),
      },
      summary: `${done}/${jobs.length} tamamlandı${finished ? "" : " (süre doldu)"}`,
      label: finished ? "Üretim bitti" : "Üretim sürüyor",
    };
  }

  private async revisePost(args: Record<string, unknown>) {
    const parsed = RevisePostInput.parse(args);
    parsed.contentId = await this.contentRef(parsed.contentId);
    const content = await this.options.api.client.contents.get(parsed.contentId, {
      signal: this.options.signal,
    });
    const current = content.currentVersion?.version;
    if (!current) {
      throw new Error(
        `"${content.title}" postunun düzeltilecek bir tasarımı yok; generate_post kullan.`,
      );
    }
    // A version saved from the canvas: its Wecra document is the design (S1). Regenerating it from
    // HTML drops the hand edits, so only when a new design was asked for — and then from the HTML
    // version the canvas started from (the canvas slide HTML only describes a render).
    let baseVersion: number | undefined = current;
    const shown = await this.versionOrNull(content.id, current);
    if (shown?.editorDocument?.kind === "wecra") {
      if (!parsed.newDesign) {
        throw new Error(
          `"${content.title}" tuvalde düzenlenmiş (v${current}, Wecra belgesi): değişikliği canvas_outline + canvas_edit ile yap. Kullanıcı açıkça yeni bir tasarım istediyse newDesign: true ile çağır (tuvaldeki elle düzenlemeler yeni sürümde olmaz).`,
        );
      }
      const origin = readCanvas(shown.slides[0]?.html);
      const source = origin.kind === "none" ? null : origin.sourceVersion;
      baseVersion = source && source !== current ? source : undefined;
    }
    // An SVG post (Faz 3) is revised by the SVG engine from its stored SVG.
    const svg = !!shown?.slides.length && shown.slides.every((s) => isSvgSlideHtml(s.html));
    const payload: ContentGeneratePayload = {
      ...(svg ? { engine: "svg" as const } : {}),
      brandId: content.brandId,
      contentId: content.id,
      title: content.title,
      brief: content.brief || content.title,
      type: content.type,
      targetPlatforms: content.targetPlatforms,
      ...(baseVersion !== undefined ? { baseVersion } : {}),
      conversationId: this.options.conversationId,
      instructions: parsed.instruction,
      ...this.generationPayloadExtras(),
    };
    const job = await this.options.api.client.jobs.create(
      { type: "content.generate", brandId: content.brandId, contentId: content.id, payload },
      { signal: this.options.signal },
    );
    return {
      data: { ok: true, contentId: content.id, baseVersion: baseVersion ?? null, jobIds: [job.id] },
      summary: baseVersion
        ? `${content.title} · s${baseVersion} üzerinden`
        : `${content.title} · yeni tasarım`,
    };
  }

  private async listSkills() {
    const skills = this.options.skills ?? [];
    return {
      data: { ok: true, skills: skills.map((s) => ({ name: s.name, description: s.description })) },
      summary: skills.length ? skills.map((s) => s.name).join(", ") : "Beceri yok",
    };
  }

  private async getSkill(args: Record<string, unknown>) {
    const { name } = GetSkillInput.parse(args);
    const wanted = name.replace(/^\//, "").toLowerCase();
    const skill = (this.options.skills ?? []).find((s) => s.name === wanted);
    if (!skill) throw new Error(`Beceri bulunamadı: ${name}`);
    return {
      data: {
        ok: true,
        name: skill.name,
        description: skill.description,
        instructions: skill.text,
      },
      summary: skill.name,
      label: `/${skill.name} becerisi okundu`,
    };
  }

  private async listSocialAccounts(args: Record<string, unknown>) {
    const parsed = ListSocialAccountsInput.parse(args);
    const brandId = parsed.brandId ?? this.brandId ?? undefined;
    const res = await this.options.api.client.socialAccounts.list(
      {
        ...(brandId ? { brandId } : {}),
        ...(parsed.platform ? { platform: parsed.platform } : {}),
        limit: 100,
      },
      { signal: this.options.signal },
    );
    const summary =
      res.items.length === 0 ? "Sosyal hesap yok" : `${res.items.length} sosyal hesap`;
    return { data: { ok: true, accounts: res.items }, summary };
  }

  // --- consent-gated tools -----------------------------------------------------------------

  private async acceptAndGeneratePlan(
    stepId: string,
    args: Record<string, unknown>,
  ): Promise<StudioToolExecutionResult> {
    const tool = "accept_and_generate_plan";
    const runningLabel = "Plan onayı ve üretim bekleniyor…";
    const doneLabel = "Plan onaylandı ve üretim başlatıldı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: "Kullanıcı izni bekleniyor…",
    });

    try {
      const parsed = AcceptGeneratePlanInput.parse(args);
      const planId = parsed.planId ?? this.openPlan?.id;
      if (!planId) {
        throw new Error("Bu konuşmada onaylanacak açık bir plan bulunamadı.");
      }
      let plan = await this.options.api.client.plans.get(planId, { signal: this.options.signal });
      if (!["proposed", "draft", "accepted"].includes(plan.status)) {
        throw new Error(`Plan durumu onay için uygun değil: ${plan.status}`);
      }
      const skipSet = new Set(parsed.skipItemIds);
      const count = plan.items.filter((i) => !skipSet.has(i.id)).length;
      // What will be generated (N4): named items, else what still needs a design (the API
      // decides; failed / stopped and never generated items).
      const toGenerate = parsed.itemIds?.length
        ? plan.items.filter((i) => parsed.itemIds?.includes(i.id))
        : plan.items.filter((i) =>
            plan.status === "accepted"
              ? i.status === "accepted" &&
                (i.generation === null ||
                  i.generation.status === "failed" ||
                  i.generation.status === "cancelled")
              : !skipSet.has(i.id),
          );
      let detail = `${plan.title || `${plan.periodStart} – ${plan.periodEnd}`} (${count} post kabul edilecek ve tasarım üretimi kuyruğa alınacak)`;
      if (plan.status === "accepted") {
        detail = `${plan.title || `${plan.periodStart} – ${plan.periodEnd}`} (${toGenerate.length} post için tasarım üretimi kuyruğa alınacak)`;
      }
      if (toGenerate.length > ESTIMATE_CONFIRM_THRESHOLD) {
        try {
          const estimate = await this.options.api.client.estimates.generation(
            {
              count: toGenerate.length,
              brandId: plan.brandId,
              imageSlots: toGenerate.filter((i) => i.imageSlot === "ai_generate").length,
            },
            { signal: this.options.signal },
          );
          detail = `${detail} · ${estimateLine(estimate)}`;
        } catch {
          // An estimate never blocks the card.
        }
      }
      // The items' "AI görsel" slots, when the owner wants the pictures too (paid, same card).
      const slotPosts = parsed.aiImages
        ? toGenerate.filter((i) => i.imageSlot === "ai_generate" && i.contentType !== "reel").length
        : 0;
      if (slotPosts > 0) {
        detail = `${detail}\n${slotImageConsentDetail({
          model: this.options.imageModel ?? "gemini-nano-banana-2.1",
          posts: slotPosts,
          products: [],
          prompt: plan.title || "plan görselleri",
          references: 0,
        })}`;
      }

      const decision = await this.awaitConsent({
        tool,
        title: "Planı onayla ve post üretimini başlat",
        detail,
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) {
        return { data: decision, isError: false };
      }

      if (plan.status !== "accepted") {
        plan = await this.options.api.client.plans.accept(
          plan.id,
          { revision: plan.revision, skipItemIds: parsed.skipItemIds },
          { signal: this.options.signal },
        );
      }
      const choice = this.options.generationChoice;
      const gen = await this.options.api.client.plans.generate(
        plan.id,
        {
          ...(parsed.itemIds?.length ? { itemIds: parsed.itemIds } : {}),
          ...(parsed.itemIds?.length && parsed.force ? { force: true } : {}),
          ...(parsed.instructions ? { instructions: parsed.instructions } : {}),
          ...(choice?.model ? { model: choice.model } : {}),
          ...(choice?.effort ? { effort: choice.effort } : {}),
          ...(slotPosts > 0
            ? { slotImage: { consented: true, conversationId: this.options.conversationId } }
            : {}),
        },
        { signal: this.options.signal },
      );
      this.openPlan = gen.plan;
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: `${gen.jobs.length} post üretimi başlatıldı${gen.skipped.length ? `; ${gen.skipped.length} kalem atlandı` : ""}`,
        },
        stepIndex,
      );
      return {
        data: {
          allowed: true,
          ok: true,
          planId: gen.plan.id,
          status: gen.plan.status,
          queuedJobs: gen.jobs.length,
          jobIds: gen.jobs.map((j) => j.id),
          // generated / edited / approved posts are kept (not regenerated); generating = busy.
          skipped: gen.skipped,
          ...(slotPosts > 0
            ? { slotImage: { consented: true, posts: slotPosts, note: SLOT_IMAGE_ALLOWED_NOTE } }
            : {}),
        },
        isError: false,
      };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  private async approveContent(
    stepId: string,
    args: Record<string, unknown>,
  ): Promise<StudioToolExecutionResult> {
    const tool = "approve_content";
    const runningLabel = "Post yayına onaylanıyor…";
    const doneLabel = "Post yayına onaylandı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: "Kullanıcı izni bekleniyor…",
    });

    try {
      const parsed = ApproveContentInput.parse(args);
      const content = await this.options.api.client.contents.get(parsed.contentId, {
        signal: this.options.signal,
      });
      if (!content.currentVersion) {
        throw new Error("Bu postun henüz üretilmiş bir tasarım sürümü yok.");
      }
      const detail = `"${content.title}" (sürüm ${content.currentVersion.version}, ${content.targetPlatforms.join(", ") || content.type}) yayına onaylanacak.`;

      const decision = await this.awaitConsent({
        tool,
        title: "Postu yayına onayla",
        detail,
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) {
        return { data: decision, isError: false };
      }

      const fresh = await this.options.api.client.contents.get(parsed.contentId, {
        signal: this.options.signal,
      });
      if (!fresh.currentVersion) {
        throw new Error("Postun aktif sürümü bulunamadı.");
      }
      let hash = fresh.currentVersion.contentHash;
      if (!hash) {
        const ver = await this.options.api.client.contents.versions.get(
          parsed.contentId,
          fresh.currentVersion.version,
          { signal: this.options.signal },
        );
        hash = await computeContentHash(ver.slides);
      }
      const outcome = await this.approveThroughChecks(parsed.contentId, hash, {
        tool,
        stepId,
        stepIndex,
        doneLabel,
      });
      if ("blocked" in outcome) return { data: outcome.blocked, isError: false };
      const approved = outcome.approved;
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: `${approved.title} onaylandı${outcome.acknowledged ? " (kontrollere rağmen)" : ""}`,
        },
        stepIndex,
      );
      return {
        data: {
          allowed: true,
          ok: true,
          contentId: approved.id,
          status: approved.status,
          approval: approved.approval,
          ...(outcome.acknowledged ? { approvedDespiteChecks: outcome.acknowledged } : {}),
        },
        isError: false,
      };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  private async scheduleContent(
    stepId: string,
    args: Record<string, unknown>,
  ): Promise<StudioToolExecutionResult> {
    const tool = "schedule_content";
    const runningLabel = "Post zamanlanıyor…";
    const doneLabel = "Post zamanlandı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: "Kullanıcı izni bekleniyor…",
    });

    try {
      const parsed = ScheduleContentInput.parse(args);
      const [content, account] = await Promise.all([
        this.options.api.client.contents.get(parsed.contentId, { signal: this.options.signal }),
        this.options.api.client.socialAccounts.get(parsed.socialAccountId, {
          signal: this.options.signal,
        }),
      ]);
      const detail = `"${content.title}" postu ${account.handle} (${account.platform}) hesabında ${parsed.scheduledAt} zamanında yayınlanacak.`;

      const decision = await this.awaitConsent({
        tool,
        title: "Postu zamanla",
        detail,
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) {
        return { data: decision, isError: false };
      }

      const schedule = await this.options.api.client.schedules.create(
        {
          contentId: parsed.contentId,
          socialAccountId: parsed.socialAccountId,
          ...(parsed.platform ? { platform: parsed.platform } : {}),
          scheduledAt: parsed.scheduledAt,
        },
        { signal: this.options.signal },
      );
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: `${schedule.platform} · ${schedule.scheduledAt}`,
        },
        stepIndex,
      );
      return {
        data: {
          allowed: true,
          ok: true,
          schedule,
        },
        isError: false,
      };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  private async createBrand(args: Record<string, unknown>) {
    const parsed = CreateBrandInput.parse(args);
    const derivedSlug = parsed.slug ? slugify(parsed.slug) : slugify(parsed.name);
    const created = await this.options.api.client.brands.create(
      {
        name: parsed.name,
        ...(derivedSlug.length >= 2 ? { slug: derivedSlug } : {}),
        defaultLanguage: parsed.defaultLanguage,
      },
      { signal: this.options.signal },
    );

    if (!this.brandId) {
      await this.options.api.client.conversations
        .update(
          this.options.conversationId,
          { brandId: created.id },
          { signal: this.options.signal },
        )
        .catch(() => undefined);
      this.brandId = created.id;
    }

    return {
      data: {
        ok: true,
        brand: created,
        attachedToConversation: this.brandId === created.id,
      },
      summary: `${created.name} (${created.slug})`,
    };
  }

  private async analyzeBrand(args: Record<string, unknown>) {
    const parsed = AnalyzeBrandInput.parse(args);
    const targetRef = parsed.brandId ?? this.brandId;
    if (!targetRef) {
      throw new Error("Marka seçilmedi; brandId belirtin ya da önce marka oluşturun.");
    }
    const brand = await this.resolveBrand(targetRef);
    const job = await this.options.api.client.jobs.create(
      {
        type: "brand.analyze",
        brandId: brand.id,
        payload: {
          ...(parsed.notes ? { notes: parsed.notes } : {}),
          includeApprovedContentFeedback: parsed.includeApprovedContentFeedback,
          autoApprove: parsed.autoApprove,
        },
      },
      { signal: this.options.signal },
    );
    return {
      data: {
        ok: true,
        jobId: job.id,
        brandId: brand.id,
        brandName: brand.name,
        status: job.status,
      },
      summary: `${brand.name} analizi (${job.id})`,
    };
  }

  private async resolveAliasToAssetId(rawAlias: string): Promise<string> {
    const cleaned = rawAlias.trim().replace(/^@/, "").toLowerCase();
    const list = (
      await this.options.api.client.conversations.aliases.list(this.options.conversationId, {
        signal: this.options.signal,
      })
    ).items;
    const match = list.find(
      (a) =>
        a.alias.toLowerCase() === cleaned ||
        a.previousAliases.some((old) => old.toLowerCase() === cleaned),
    );
    if (!match) {
      throw new Error(`Görsel takma adı bulunamadı: @${cleaned}`);
    }
    return match.assetId;
  }

  /**
   * `generate_ai_image` (U7): a paid call, so a consent card with the model and the estimated
   * cost comes first; the same request again in this conversation returns the first job instead
   * of paying twice.
   */
  private async generateAiImage(
    stepId: string,
    args: Record<string, unknown>,
    callId?: string,
  ): Promise<StudioToolExecutionResult> {
    const tool = "generate_ai_image";
    const runningLabel = "AI görsel için izin bekleniyor…";
    const doneLabel = "AI görsel üretimi kuyruğa alındı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: null,
    });
    try {
      const parsed = GenerateAiImageInput.parse(args);
      let brandId = parsed.brandId ? (await this.resolveBrand(parsed.brandId)).id : this.brandId;
      if (!brandId && parsed.targetContentId) {
        const targetContent = await this.options.api.client.contents.get(parsed.targetContentId, {
          signal: this.options.signal,
        });
        brandId = targetContent.brandId;
      }
      if (!brandId) {
        throw new Error("Görsel üretimi için marka seçilmedi; brandId belirtin.");
      }

      const referenceAssetIds: string[] = [...parsed.referenceAssetIds];
      for (const aliasName of parsed.referenceAliases) {
        const assetId = await this.resolveAliasToAssetId(aliasName);
        if (!referenceAssetIds.includes(assetId)) referenceAssetIds.push(assetId);
      }
      // `@ürün` references: the photos that show the asked side (else the first few), unless
      // the agent chose some of the product's photos itself.
      const productIds: string[] = [];
      const referenceNotes: string[] = [];
      for (const ref of parsed.referenceProducts) {
        const product = await this.productRef(ref, brandId);
        if (product.imageAssetIds.length === 0) {
          throw new Error(`"${product.name}" ürününün fotoğrafı yok.`);
        }
        if (!productIds.includes(product.id)) productIds.push(product.id);
        if (product.imageAssetIds.some((id) => referenceAssetIds.includes(id))) continue;
        const choice = selectProductReferences(await this.productPhotoRefs(product), {
          prompt: parsed.prompt,
          view: parsed.view ?? null,
        });
        referenceNotes.push(`${product.name}: ${choice.reason}`);
        for (const id of choice.assetIds) {
          if (referenceAssetIds.length < 10 && !referenceAssetIds.includes(id)) {
            referenceAssetIds.push(id);
          }
        }
      }
      const targetContentId = parsed.targetContentId
        ? await this.contentRef(parsed.targetContentId)
        : undefined;
      const payload = {
        prompt: parsed.prompt,
        aspectRatio: parsed.aspectRatio,
        imageSize: parsed.imageSize,
        referenceAssetIds,
        preserveProductLabel: parsed.preserveProductLabel,
        ...(targetContentId ? { targetContentId } : {}),
        ...(parsed.targetSlotId ? { targetSlotId: parsed.targetSlotId } : {}),
        ...(parsed.productPosition ? { productPosition: parsed.productPosition } : {}),
        ...(parsed.productScale !== undefined ? { productScale: parsed.productScale } : {}),
        ...(parsed.labelText ? { labelText: parsed.labelText } : {}),
        ...(productIds.length > 0 ? { productIds } : {}),
        ...(parsed.style !== undefined ? { style: parsed.style } : {}),
      };
      const variants = parsed.variants;

      const key = toolCallKey(tool, {
        brandId,
        ...payload,
        ...(variants > 1 ? { variants } : {}),
      });
      const earlier = await this.earlierCall(tool, key, parsed.repeat);
      if (earlier) {
        await this.options.writer.setPart(
          {
            type: "tool_step",
            id: stepId,
            name: tool,
            label: "AI görsel zaten üretimde",
            state: "done",
            summary: "Aynı istek bu sohbette zaten çalıştı; ikinci kez ücret ödenmedi",
          },
          stepIndex,
        );
        return {
          data: {
            ...earlier.data,
            duplicate: true,
            note: "Bu görsel bu sohbette zaten üretime alınmıştı; ikinci kez ücret ödenmedi. Kullanıcı bilerek bir tane daha isterse repeat: true ile çağır.",
          },
          isError: false,
        };
      }

      const model = this.options.imageModel ?? "gemini-nano-banana-2.1";
      const decision = await this.awaitConsent({
        tool,
        title: "AI görsel üret (ücretli)",
        detail: aiImageConsentDetail({
          model,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          imageSize: parsed.imageSize,
          references: referenceAssetIds.length,
          preserveLabel: parsed.preserveProductLabel,
          variants,
        }),
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) {
        return { data: decision, isError: false };
      }

      // Every picture asks for the owner's word in this chat (docs/URETIM-RESIM.md §12).
      const approval: ApprovalTarget = {
        kind: variants > 1 ? "variant" : "product_image",
        conversationId: this.options.conversationId,
        ...(targetContentId ? { contentId: targetContentId } : {}),
        ...(parsed.targetSlotId ? { slotId: parsed.targetSlotId } : {}),
        ...(productIds[0] ? { productId: productIds[0] } : {}),
      };
      const jobs: Job[] = [];
      for (let index = 1; index <= variants; index++) {
        jobs.push(
          await this.options.api.client.jobs.create(
            {
              type: "image.generate",
              brandId,
              payload: {
                ...payload,
                approval,
                ...(variants > 1 ? { variant: { index, count: variants } } : {}),
              },
            },
            { signal: this.options.signal },
          ),
        );
      }
      const job = jobs[0] as Job;
      const data = {
        ok: true,
        jobId: job.id,
        ...(jobs.length > 1 ? { jobIds: jobs.map((j) => j.id) } : {}),
        brandId,
        status: job.status,
        model,
        referenceAssetIds,
        ...(referenceNotes.length > 0 ? { referenceChoice: referenceNotes } : {}),
        preserveProductLabel: parsed.preserveProductLabel,
        ...(targetContentId ? { targetContentId } : {}),
        ...(parsed.targetSlotId ? { targetSlotId: parsed.targetSlotId } : {}),
        note: "Her görsel hazır olunca yapay zekâ kontrolünün raporuyla bu sohbete onay kartı olarak düşecek (Onayla / Reddet / Yeniden üret); yuva ancak onaylanınca dolar. Kontrol hata bulsa da kendiliğinden yeniden üretilmez.",
      };
      await this.ledger.put({ key, tool, callId: callId ?? null, data });
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: jobs.length > 1 ? `${jobs.length} AI görsel işi` : `AI görsel işi (${job.id})`,
        },
        stepIndex,
      );
      return { data: { allowed: true, ...data }, isError: false };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  private async fillPostSlot(args: Record<string, unknown>) {
    const parsed = FillPostSlotInput.parse(args);
    parsed.contentId = await this.contentRef(parsed.contentId);
    const content = await this.options.api.client.contents.get(parsed.contentId, {
      signal: this.options.signal,
    });
    const current = content.currentVersion?.version;
    if (current) {
      const shown = await this.versionOrNull(content.id, current);
      if (shown?.editorDocument?.kind === "wecra")
        throw new Error(
          `"${content.title}" tuvalde düzenlenmiş (v${current}, Wecra belgesi): görseli canvas_edit ile yerleştir (place_image {nodeId, assetId ya da alias}).`,
        );
    }

    const slotAssignments: Record<string, string> = {};
    if (parsed.slotAssignments) {
      for (const [slotKey, val] of Object.entries(parsed.slotAssignments)) {
        if (val.startsWith("@")) {
          slotAssignments[slotKey] = await this.resolveAliasToAssetId(val);
        } else {
          slotAssignments[slotKey] = val;
        }
      }
    }
    if (parsed.slotId) {
      if (parsed.assetId) {
        slotAssignments[parsed.slotId] = parsed.assetId;
      } else if (parsed.alias) {
        slotAssignments[parsed.slotId] = await this.resolveAliasToAssetId(parsed.alias);
      }
    }

    if (Object.keys(slotAssignments).length === 0) {
      throw new Error(
        "Doldurulacak görsel yuvası belirtilmedi (`slotId` + `alias`/`assetId` ya da `slotAssignments` verin).",
      );
    }

    const job = await this.options.api.client.jobs.create(
      {
        type: "content.render",
        brandId: content.brandId,
        contentId: content.id,
        payload: {
          format: "jpeg",
          slotAssignments,
        },
      },
      { signal: this.options.signal },
    );

    return {
      data: {
        ok: true,
        jobId: job.id,
        contentId: content.id,
        slotAssignments,
        status: job.status,
      },
      summary: `${content.title} (${Object.keys(slotAssignments).join(", ")})`,
    };
  }

  private async exportContentPdf(args: Record<string, unknown>) {
    const parsed = ExportContentPdfInput.parse(args);
    const content = await this.options.api.client.contents.get(parsed.contentId, {
      signal: this.options.signal,
    });
    const job = await this.options.api.client.jobs.create(
      {
        type: "content.render",
        brandId: content.brandId,
        contentId: content.id,
        payload: {
          format: "pdf",
          ...(parsed.version ? { version: parsed.version } : {}),
        },
      },
      { signal: this.options.signal },
    );
    return {
      data: {
        ok: true,
        jobId: job.id,
        contentId: content.id,
        format: "pdf",
        status: job.status,
      },
      summary: `${content.title} PDF (${job.id})`,
    };
  }

  private async publishNow(
    stepId: string,
    args: Record<string, unknown>,
  ): Promise<StudioToolExecutionResult> {
    const tool = "publish_now";
    const runningLabel = "Anında yayın onayı bekleniyor…";
    const doneLabel = "Yayın başlatıldı";
    const stepIndex = await this.options.writer.setPart({
      type: "tool_step",
      id: stepId,
      name: tool,
      label: runningLabel,
      state: "running",
      summary: "Kullanıcı izni bekleniyor…",
    });

    try {
      const parsed = PublishNowInput.parse(args);
      const [content, account] = await Promise.all([
        this.options.api.client.contents.get(parsed.contentId, { signal: this.options.signal }),
        this.options.api.client.socialAccounts.get(parsed.socialAccountId, {
          signal: this.options.signal,
        }),
      ]);
      if (!content.currentVersion) {
        throw new Error("Bu postun henüz yayınlanacak bir tasarım sürümü yok.");
      }

      const detail = `"${content.title}" postu ${account.handle} (${account.platform}) hesabında hemen yayınlanacak.`;
      const decision = await this.awaitConsent({
        tool,
        title: "Postu şimdi yayınla",
        detail,
        stepId,
        stepIndex,
        doneLabel,
      });
      if (!decision.allowed) {
        return { data: decision, isError: false };
      }

      let fresh = await this.options.api.client.contents.get(parsed.contentId, {
        signal: this.options.signal,
      });
      if (!fresh.currentVersion) {
        throw new Error("Postun aktif sürümü bulunamadı.");
      }
      if (fresh.status === "draft" || fresh.status === "in_review") {
        let hash = fresh.currentVersion.contentHash;
        if (!hash) {
          const ver = await this.options.api.client.contents.versions.get(
            parsed.contentId,
            fresh.currentVersion.version,
            { signal: this.options.signal },
          );
          hash = await computeContentHash(ver.slides);
        }
        const outcome = await this.approveThroughChecks(parsed.contentId, hash, {
          tool,
          stepId,
          stepIndex,
          doneLabel,
        });
        if ("blocked" in outcome) return { data: outcome.blocked, isError: false };
        fresh = outcome.approved;
      }

      const schedule = parsed.scheduleId
        ? await this.options.api.client.schedules.get(parsed.scheduleId, {
            signal: this.options.signal,
          })
        : await this.options.api.client.schedules.create(
            {
              contentId: fresh.id,
              socialAccountId: account.id,
              ...(parsed.platform ? { platform: parsed.platform } : {}),
              scheduledAt: new Date(this.now().getTime() + 5_000).toISOString(),
            },
            { signal: this.options.signal },
          );

      const job = await this.options.api.client.jobs.create(
        {
          type: "schedule.publish",
          brandId: fresh.brandId,
          contentId: fresh.id,
          payload: { scheduleId: schedule.id },
        },
        { signal: this.options.signal },
      );

      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: stepId,
          name: tool,
          label: doneLabel,
          state: "done",
          summary: `${account.handle} (${schedule.platform}) · ${job.id}`,
        },
        stepIndex,
      );

      return {
        data: {
          allowed: true,
          ok: true,
          schedule,
          jobId: job.id,
        },
        isError: false,
      };
    } catch (error) {
      return this.failStep(stepId, tool, runningLabel, stepIndex, error);
    }
  }

  /**
   * Approves a post's version (E7). The API refuses (409) while the version's checks hold its
   * approval back (blocking results, or no finished run yet): then the blocking checks go on a
   * consent card of their own ("Kontroller geçmedi"), and only when the owner allows it is the
   * approval sent again with `acknowledgeChecks: true` — the agent never approves past the checks
   * on its own. Otherwise the checks come back to the model (`blocked`) in Turkish.
   */
  private async approveThroughChecks(
    contentId: string,
    hash: string,
    step: { tool: string; stepId: string; stepIndex: number; doneLabel: string },
  ): Promise<
    { approved: Content; acknowledged: ChecksGate | null } | { blocked: Record<string, unknown> }
  > {
    try {
      const approved = await this.options.api.client.contents.approve(contentId, hash, {
        signal: this.options.signal,
      });
      return { approved, acknowledged: null };
    } catch (error) {
      const gate = checksGateOf(error);
      if (!gate) throw error;
      const decision = await this.awaitConsent({
        tool: step.tool,
        title: "Kontroller geçmedi: yine de onaylansın mı?",
        detail: [gate.message, ...gate.issues.map((i) => `• ${i}`)].join("\n").slice(0, 2_000),
        stepId: step.stepId,
        stepIndex: step.stepIndex,
        doneLabel: step.doneLabel,
      });
      if (!decision.allowed) {
        return {
          blocked: {
            allowed: false,
            ok: false,
            approved: false,
            reason: decision.reason,
            checks: { message: gate.message, issues: gate.issues },
            note:
              decision.reason === "denied_by_owner"
                ? "Post onaylanmadı: kontroller geçmedi ve kullanıcı yine de onaylamadı. Sorunları kullanıcıya söyle; düzeltmeyi öner."
                : "Post onaylanmadı: kontroller geçmedi ve kullanıcı onay kartını yanıtlamadı. Sorunları kullanıcıya söyle.",
          },
        };
      }
      const approved = await this.options.api.client.contents.approve(
        contentId,
        { hash, acknowledgeChecks: true },
        { signal: this.options.signal },
      );
      return { approved, acknowledged: gate };
    }
  }

  private async awaitConsent(input: {
    tool: string;
    title: string;
    detail: string | null;
    stepId: string;
    stepIndex: number;
    doneLabel: string;
  }): Promise<{ allowed: true } | { allowed: false; reason: "denied_by_owner" | "expired" }> {
    const suffix = this.options.runId.replace(/[^A-Za-z0-9_-]/g, "").slice(-8) || "run";
    const consentId = `consent-${suffix}-${++this.consentSeq}`;
    const consentIndex = await this.options.writer.setPart({
      type: "consent",
      consentId,
      tool: input.tool,
      title: input.title,
      detail: input.detail,
      state: "pending",
    });

    const pollMs = this.options.consentPollIntervalMs ?? DEFAULT_CONSENT_POLL_MS;
    const timeoutMs = this.options.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
    const deadline = this.now().getTime() + timeoutMs;
    // Waiting for the owner is a turn wait: the clock stops, the Claude slot is free (U1, U6).
    return this.idle(() => this.pollConsent(input, consentId, consentIndex, pollMs, deadline));
  }

  private async pollConsent(
    input: {
      tool: string;
      title: string;
      detail: string | null;
      stepId: string;
      doneLabel: string;
      stepIndex: number;
    },
    consentId: string,
    consentIndex: number,
    pollMs: number,
    deadline: number,
  ): Promise<{ allowed: true } | { allowed: false; reason: "denied_by_owner" | "expired" }> {
    for (;;) {
      this.options.signal.throwIfAborted();
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) {
        await this.options.writer.setPart(
          {
            type: "consent",
            consentId,
            tool: input.tool,
            title: input.title,
            detail: input.detail,
            state: "expired",
          },
          consentIndex,
        );
        await this.options.writer.setPart(
          {
            type: "tool_step",
            id: input.stepId,
            name: input.tool,
            label: input.doneLabel,
            state: "done",
            summary: "Onay süresi doldu",
          },
          input.stepIndex,
        );
        return { allowed: false, reason: "expired" };
      }

      await this.sleep(Math.min(pollMs, remaining), this.options.signal);

      const snapshot = await this.options.api.client.workerTurns.message(this.options.runId, {
        signal: this.options.signal,
      });
      if (
        snapshot.run.status === "cancelled" ||
        snapshot.run.status === "failed" ||
        snapshot.run.status === "completed"
      ) {
        throw new RunClosedError(`run ${this.options.runId} is ${snapshot.run.status}`);
      }
      const card = snapshot.message?.parts.find(
        (p) => p.type === "consent" && p.consentId === consentId,
      );
      if (card?.type !== "consent" || card.state === "pending") continue;
      if (card.state === "allowed") return { allowed: true };
      if (card.state === "denied") {
        await this.options.writer.setPart(
          {
            type: "tool_step",
            id: input.stepId,
            name: input.tool,
            label: input.doneLabel,
            state: "done",
            summary: "Kullanıcı izin vermedi",
          },
          input.stepIndex,
        );
        return { allowed: false, reason: "denied_by_owner" };
      }
      // Already marked expired server-side
      await this.options.writer.setPart(
        {
          type: "tool_step",
          id: input.stepId,
          name: input.tool,
          label: input.doneLabel,
          state: "done",
          summary: "Onay süresi doldu",
        },
        input.stepIndex,
      );
      return { allowed: false, reason: "expired" };
    }
  }

  private async failStep(
    stepId: string,
    tool: string,
    runningLabel: string,
    stepIndex: number,
    error: unknown,
  ): Promise<StudioToolExecutionResult> {
    if (this.options.signal.aborted || error instanceof RunClosedError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    this.logger.warn(`tool ${tool} failed: ${msg}`);
    await this.options.writer.setPart(
      {
        type: "tool_step",
        id: stepId,
        name: tool,
        label: runningLabel,
        state: "error",
        summary: msg.slice(0, 300),
      },
      stepIndex,
    );
    return { data: { ok: false, error: msg.slice(0, 1_000) }, isError: true };
  }

  private async resolveBrand(idOrSlug: string) {
    try {
      return await this.options.api.client.brands.get(idOrSlug, { signal: this.options.signal });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      const list = await this.options.api.client.brands.list(
        { status: "active", limit: 100 },
        { signal: this.options.signal },
      );
      const found = list.items.find(
        (b) => b.id === idOrSlug || b.slug.toLowerCase() === idOrSlug.toLowerCase(),
      );
      if (!found) throw new Error(`Marka bulunamadı: ${idOrSlug}`);
      return found;
    }
  }

  private makeStepId(rawCallId: string | undefined): string {
    const seq = ++this.stepSeq;
    if (rawCallId) {
      const cleaned = rawCallId.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 48);
      if (cleaned) return `${cleaned}-${seq}`;
    }
    return `step-${seq}`;
  }
}

/** What the agent tells the owner after a yes to the slot picture (Turkish). */
const SLOT_IMAGE_ALLOWED_NOTE =
  "Her postun tasarımı hazır olunca AI görsel yuvası ürün görseli hattıyla üretilecek (ürün fotoğraflarından birebir tarif → üretim → yapay zekâ kontrolü). Görsel kontrol raporuyla bu sohbete onay kartı olarak düşer (Onayla / Reddet / Yeniden üret); yuva ancak onaylanınca dolar. O sürede post Postlar'da 'Onay bekliyor' görünür. wait_jobs sonucu `slotImages` alanında görsel işlerini verir.";

/** What the agent tells the owner after a no (Turkish): how to fill the slot later. */
const SLOT_IMAGE_DECLINED_NOTE =
  "Kullanıcı ücretli AI görseline izin vermedi: post üretiliyor, görsel yuvası boş kalacak. Sonra doldurmak için: kendi fotoğrafıyla fill_post_slot, ya da istediğinde (yeni izin kartıyla) generate_ai_image (targetContentId + targetSlotId, ürün varsa referenceProducts).";

/**
 * The consent card's detail for the slot pictures of a post request: how many (one per post /
 * variant), which products, and the cost of them all.
 */
export function slotImageConsentDetail(input: {
  model: string;
  posts: number;
  products: readonly string[];
  prompt: string;
  references: number;
}): string {
  const count = Math.max(1, input.posts);
  const head =
    `Tasarım hazır olunca AI görsel yuvası ürün görseli hattıyla doldurulur: ${count > 1 ? `${count} görsel (her varyanta bir)` : "1 görsel"}` +
    `${input.products.length > 0 ? `, ürün: ${input.products.join(", ")} (fotoğraflarından birebir)` : ", ürünsüz sahne"}.` +
    " Her görsel kontrol raporuyla onay kartı olarak gelir; yuva onaylayınca dolar.";
  return [
    head,
    aiImageConsentDetail({
      model: input.model,
      prompt: input.prompt,
      aspectRatio: "4:5",
      imageSize: "2K",
      references: input.references,
      preserveLabel: false,
      variants: count,
    }),
  ].join("\n");
}

/** Typical image output tokens of one generated picture (Gemini image models, 1K–2K). */
const IMAGE_OUTPUT_TOKENS = 1_290;
/** Typical input tokens of one reference picture. */
const REFERENCE_IMAGE_TOKENS = 560;

/** The consent card's detail for a paid AI image: model, size and the estimated cost (U7). */
export function aiImageConsentDetail(input: {
  model: string;
  prompt: string;
  aspectRatio: string;
  imageSize: string;
  references: number;
  preserveLabel: boolean;
  /** Pictures asked for at once (each paid). */
  variants?: number;
}): string {
  const count = Math.max(1, input.variants ?? 1);
  const one = aiCallCostUsd({
    provider: "gemini",
    model: input.model,
    inputTokens: Math.ceil(input.prompt.length / 4) + input.references * REFERENCE_IMAGE_TOKENS,
    imageOutputTokens: IMAGE_OUTPUT_TOKENS,
  });
  const usd = one === null ? null : one * count;
  const cost =
    usd === null
      ? "tahmini tutar bilinmiyor (model fiyat tablosunda yok)"
      : `tahmini ≈ ${Math.max(usd, 0.001).toFixed(3).replace(".", ",")} $`;
  return [
    `Model: ${input.model} · ${input.imageSize} · ${input.aspectRatio} · ${count > 1 ? `${count} görsel · ` : ""}${cost}`,
    input.references > 0
      ? `${input.references} referans görsel${input.preserveLabel ? " · ürün etiketi korunacak" : ""}`
      : "",
    `Tarif: ${input.prompt.slice(0, 300)}${input.prompt.length > 300 ? "…" : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}
